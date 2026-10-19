import crypto from 'node:crypto';
import { Sandbox as SdkSandbox } from 'e2b';
import type { CloudSandboxProviderClient, CreateSandboxParams } from './sandbox-adapter.js';
import { isSafeRelativePath } from './tool-registry.js';
import { sanitizeSandboxOutput } from './sandbox-adapter.js';
import { redactSensitiveContent } from './redaction.js';

/**
 * EntryInfo matching the official E2B SDK filesystem type (e2b files.list).
 */
export interface E2bEntryInfo {
  readonly name: string;
  readonly path: string;
  readonly type?: 'file' | 'directory' | 'symlink';
  readonly size?: number;
}

/**
 * Handle representing an active E2B Sandbox session.
 * Maps 1:1 to official E2B SDK methods (`sandbox.commands.run`, `sandbox.files`, `sandbox.kill`).
 */
export interface E2bSandboxHandle {
  readonly sandboxId: string;
  commands: {
    run(
      command: string,
      options?: {
        readonly args?: readonly string[];
        readonly cwd?: string;
        readonly envs?: Record<string, string>;
        readonly timeoutMs?: number;
        readonly signal?: AbortSignal;
        readonly onStdout?: (chunk: string) => void;
        readonly onStderr?: (chunk: string) => void;
      }
    ): Promise<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly durationMs?: number;
      readonly error?: string;
    }>;
  };
  files: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    list(path?: string): Promise<readonly E2bEntryInfo[]>;
  };
  kill(): Promise<void>;
  isOpen?(): boolean;
}

/**
 * Options passed to create an E2B Sandbox.
 */
export interface E2bCreateOptions {
  readonly apiKey: string;
  readonly template: string;
  readonly domain?: string;
  readonly timeoutMs: number;
  readonly envs?: Record<string, string>;
  readonly metadata?: Record<string, string>;
  readonly signal?: AbortSignal;
}

/**
 * Pluggable transport for E2B Sandbox creation.
 * Decouples provider business logic from the network/SDK layer, allowing complete mock injection in tests.
 */
export interface E2bTransport {
  createSandbox(options: E2bCreateOptions): Promise<E2bSandboxHandle>;
}

/**
 * Dependency injection seam for official E2B SDK.
 * Enables validating real transport lifecycle without incurring live cloud calls or credentials in tests.
 */
export interface E2bSdkSeam {
  Sandbox: {
    create(template?: string, opts?: any): Promise<any>;
    kill?(sandboxId: string, opts?: any): Promise<boolean>;
  };
}

/**
 * Creates a real E2B SDK transport backed by the official `e2b` package (or injected SDK seam).
 */
export function createRealE2bTransport(sdkSeam?: E2bSdkSeam): E2bTransport {
  const SandboxClass = sdkSeam?.Sandbox ?? SdkSandbox;

  return {
    async createSandbox(options: E2bCreateOptions): Promise<E2bSandboxHandle> {
      if (options.signal?.aborted) {
        throw new Error('Aborted before sandbox creation');
      }

      const instance = await SandboxClass.create(options.template, {
        apiKey: options.apiKey,
        domain: options.domain,
        timeoutMs: options.timeoutMs,
        envs: options.envs,
        metadata: options.metadata,
      });

      let killed = false;

      return {
        sandboxId: instance.sandboxId,
        commands: {
          async run(
            command: string,
            runOpts?: {
              readonly args?: readonly string[];
              readonly cwd?: string;
              readonly envs?: Record<string, string>;
              readonly timeoutMs?: number;
              readonly signal?: AbortSignal;
              readonly onStdout?: (chunk: string) => void;
              readonly onStderr?: (chunk: string) => void;
            }
          ) {
            if (runOpts?.signal?.aborted) {
              throw new Error('Command was aborted');
            }
            const fullCmd =
              runOpts?.args && runOpts.args.length > 0
                ? `${command} ${runOpts.args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`
                : command;

            const start = Date.now();
            const res = await instance.commands.run(fullCmd, {
              cwd: runOpts?.cwd,
              envs: runOpts?.envs,
              timeoutMs: runOpts?.timeoutMs,
              onStdout: runOpts?.onStdout
                ? (c: any) => runOpts.onStdout!(typeof c === 'string' ? c : c?.line || '')
                : undefined,
              onStderr: runOpts?.onStderr
                ? (c: any) => runOpts.onStderr!(typeof c === 'string' ? c : c?.line || '')
                : undefined,
            });

            return {
              exitCode: res.exitCode,
              stdout: res.stdout ?? '',
              stderr: res.stderr ?? '',
              durationMs: Date.now() - start,
              error: res.error,
            };
          },
        },
        files: {
          async read(path: string): Promise<string> {
            return await instance.files.read(path, { format: 'text' });
          },
          async write(path: string, content: string): Promise<void> {
            await instance.files.write(path, content);
          },
          async list(path?: string): Promise<readonly E2bEntryInfo[]> {
            const entries = await instance.files.list(path ?? '.');
            return entries.map((e: any) => ({
              name: e.name,
              path: e.path,
              type: e.type,
              size: e.size,
            }));
          },
        },
        async kill(): Promise<void> {
          if (killed) return;
          await instance.kill();
          killed = true;
        },
        isOpen(): boolean {
          return !killed;
        },
      };
    },
  };
}

/**
 * Configuration options for E2B Cloud Sandbox Provider.
 */
export interface E2bProviderConfig {
  /**
   * Explicit feature gate flag.
   * MUST be true to allow E2B sandbox creation.
   * Defaults to false (disabled).
   */
  readonly enabled?: boolean;

  /**
   * E2B API Key (e.g. from E2B_API_KEY).
   * Required when enabled is true.
   */
  readonly apiKey?: string;

  /**
   * E2B Template ID (default: 'base').
   */
  readonly template?: string;

  /**
   * E2B Domain / endpoint URL (default: 'https://api.e2b.dev').
   * Must be a vetted *.e2b.dev HTTPS endpoint.
   */
  readonly domain?: string;

  /**
   * Default timeout in ms for operations. Defaults to 60_000 (60s).
   */
  readonly defaultTimeoutMs?: number;

  /**
   * Maximum allowed combined output bytes (stdout + stderr). Defaults to 65,536 (64 KiB).
   */
  readonly maxOutputBytes?: number;

  /**
   * Hardware / VPC Network Isolation Guarantee.
   * Public E2B sandboxes have unrestricted outbound internet egress by default.
   * If egressEnabled is requested as false or allowlists are required, but
   * networkIsolationGuaranteed is not explicitly true (backed by auditable networkIsolationProof),
   * sandbox creation fails closed to prevent accidental data exfiltration.
   */
  readonly networkIsolationGuaranteed?: boolean;

  /**
   * Auditable identifier of the verified Enterprise VPC gateway or egress firewall (e.g. vpc-gw-...).
   * Required when networkIsolationGuaranteed is true.
   */
  readonly networkIsolationProof?: string;

  /**
   * Optional injected transport for SDK interaction.
   * Enables complete in-memory mocking in tests without network or credentials.
   * When omitted, defaults to createRealE2bTransport().
   */
  readonly transport?: E2bTransport;
}

export type E2bProviderErrorCode =
  | 'FEATURE_GATE_DISABLED'
  | 'MISSING_API_KEY'
  | 'INVALID_CONFIG'
  | 'NETWORK_ISOLATION_UNSUPPORTED'
  | 'SECURITY_VIOLATION'
  | 'SANDBOX_NOT_FOUND'
  | 'EXECUTION_TIMEOUT'
  | 'EXECUTION_ABORTED'
  | 'PROVIDER_ERROR';

export class E2bProviderError extends Error {
  constructor(
    readonly code: E2bProviderErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'E2bProviderError';
  }
}

const FORBIDDEN_ENV_KEYS = new Set([
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'JWT_SECRET',
  'SESSION_SECRET',
  'CREDENTIAL_ENCRYPTION_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'GITHUB_PAT',
  'E2B_API_KEY',
]);

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024; // 64 KiB bound per INV-07 / Security spec

/**
 * Validates E2B provider configuration.
 * Fails closed on any invalid or missing required field.
 */
export function validateE2bConfig(
  config: E2bProviderConfig
): { valid: true } | { valid: false; code: E2bProviderErrorCode; reason: string } {
  if (!config.enabled) {
    return {
      valid: false,
      code: 'FEATURE_GATE_DISABLED',
      reason: 'E2B cloud sandbox provider is disabled by feature gate',
    };
  }

  if (!config.apiKey || typeof config.apiKey !== 'string' || config.apiKey.trim().length === 0) {
    return {
      valid: false,
      code: 'MISSING_API_KEY',
      reason: 'E2B API key is required when provider is enabled',
    };
  }

  if (config.apiKey.includes('\n') || config.apiKey.includes('\r')) {
    return {
      valid: false,
      code: 'INVALID_CONFIG',
      reason: 'E2B API key contains invalid newline characters',
    };
  }

  if (
    config.defaultTimeoutMs !== undefined &&
    (!Number.isFinite(config.defaultTimeoutMs) || config.defaultTimeoutMs <= 0 || config.defaultTimeoutMs > 600_000)
  ) {
    return {
      valid: false,
      code: 'INVALID_CONFIG',
      reason: 'Invalid defaultTimeoutMs: must be a positive integer <= 600000',
    };
  }

  if (
    config.maxOutputBytes !== undefined &&
    (!Number.isFinite(config.maxOutputBytes) || config.maxOutputBytes <= 0 || config.maxOutputBytes > 10 * 1024 * 1024)
  ) {
    return {
      valid: false,
      code: 'INVALID_CONFIG',
      reason: 'Invalid maxOutputBytes: must be a positive integer <= 10MB',
    };
  }

  if (
    config.template !== undefined &&
    (!/^[a-zA-Z0-9_.-]+$/.test(config.template) || config.template.length > 128)
  ) {
    return {
      valid: false,
      code: 'INVALID_CONFIG',
      reason: 'Invalid template name: must be alphanumeric (allowing _, -, .) <= 128 chars',
    };
  }

  if (config.domain !== undefined) {
    try {
      const u = new URL(config.domain);
      if (u.protocol !== 'https:') {
        return {
          valid: false,
          code: 'SECURITY_VIOLATION',
          reason: 'Insecure HTTP domain not permitted for E2B credentials; HTTPS is strictly required',
        };
      }
      const hostname = u.hostname.toLowerCase();
      const isApprovedHost = hostname === 'api.e2b.dev' || hostname.endsWith('.e2b.dev');
      if (!isApprovedHost) {
        return {
          valid: false,
          code: 'SECURITY_VIOLATION',
          reason: `Unapproved E2B endpoint host '${hostname}'; only vetted *.e2b.dev HTTPS endpoints are permitted`,
        };
      }
    } catch (err) {
      return {
        valid: false,
        code: 'INVALID_CONFIG',
        reason: `Invalid domain URL: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (config.networkIsolationGuaranteed) {
    if (
      !config.networkIsolationProof ||
      typeof config.networkIsolationProof !== 'string' ||
      config.networkIsolationProof.trim().length === 0
    ) {
      return {
        valid: false,
        code: 'INVALID_CONFIG',
        reason: 'networkIsolationGuaranteed requires auditable networkIsolationProof (e.g. verified Enterprise VPC gateway ID)',
      };
    }
  }

  return { valid: true };
}

/**
 * Loads E2B configuration from environment variables.
 * Default is strictly disabled (enabled: false) even if E2B_API_KEY is present.
 */
export function loadE2bConfigFromEnv(env: NodeJS.ProcessEnv = process.env): E2bProviderConfig {
  const enabled = env.GIGA_AGENT_E2B_ENABLED === 'true' || env.E2B_SANDBOX_ENABLED === 'true';
  const apiKey = env.E2B_API_KEY?.trim();
  const template = env.E2B_TEMPLATE?.trim() || 'base';
  const domain = env.E2B_DOMAIN?.trim() || 'https://api.e2b.dev';

  // Auditable deployment configuration: requires verified VPC gateway ID and firewall verification
  const networkIsolationProof = env.E2B_VPC_GATEWAY_ID?.trim() || env.E2B_NETWORK_ISOLATION_PROOF?.trim();
  const networkIsolationGuaranteed = Boolean(
    networkIsolationProof &&
    env.E2B_EGRESS_FIREWALL_VERIFIED === 'true'
  );

  let defaultTimeoutMs: number | undefined;
  if (env.E2B_TIMEOUT_MS) {
    const parsed = Number(env.E2B_TIMEOUT_MS);
    if (Number.isFinite(parsed) && parsed > 0) {
      defaultTimeoutMs = parsed;
    }
  }

  let maxOutputBytes: number | undefined;
  if (env.E2B_MAX_OUTPUT_BYTES) {
    const parsed = Number(env.E2B_MAX_OUTPUT_BYTES);
    if (Number.isFinite(parsed) && parsed > 0) {
      maxOutputBytes = parsed;
    }
  }

  return {
    enabled,
    apiKey,
    template,
    domain,
    defaultTimeoutMs,
    maxOutputBytes,
    networkIsolationGuaranteed,
    networkIsolationProof,
  };
}

interface ActiveSandboxEntry {
  readonly handle: E2bSandboxHandle;
  readonly createdAt: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  destroyed: boolean;
  destroyAttempts: number;
  lastDestroyError?: string;
}

/**
 * Bounds combined stdout and stderr to a shared byte budget.
 * Guarantee: Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') <= maxCombinedBytes.
 * Enforces credential redaction across both streams before and after bounding.
 */
export function boundCombinedOutput(
  rawStdout: string,
  rawStderr: string,
  maxCombinedBytes: number
): { stdout: string; stderr: string } {
  if (maxCombinedBytes <= 0) {
    return { stdout: '', stderr: '' };
  }

  // 1. Initial redaction on both streams
  const cleanStdout = redactSensitiveContent(rawStdout || '');
  const cleanStderr = redactSensitiveContent(rawStderr || '');

  const stdoutBytes = Buffer.byteLength(cleanStdout, 'utf8');
  const stderrBytes = Buffer.byteLength(cleanStderr, 'utf8');

  // If combined output fits entirely within budget, return as is
  if (stdoutBytes + stderrBytes <= maxCombinedBytes) {
    return { stdout: cleanStdout, stderr: cleanStderr };
  }

  const halfBudget = Math.floor(maxCombinedBytes / 2);

  let finalStdout: string;
  let finalStderr: string;

  if (stdoutBytes <= halfBudget) {
    finalStdout = cleanStdout;
    const remainingForStderr = maxCombinedBytes - stdoutBytes;
    finalStderr = sanitizeSandboxOutput(cleanStderr, remainingForStderr);
  } else if (stderrBytes <= halfBudget) {
    finalStderr = cleanStderr;
    const remainingForStdout = maxCombinedBytes - stderrBytes;
    finalStdout = sanitizeSandboxOutput(cleanStdout, remainingForStdout);
  } else {
    const stdoutBudget = halfBudget;
    const stderrBudget = maxCombinedBytes - halfBudget;
    finalStdout = sanitizeSandboxOutput(cleanStdout, stdoutBudget);
    finalStderr = sanitizeSandboxOutput(cleanStderr, stderrBudget);
  }

  // Double-check invariant (accounting for any truncation marker edge cases)
  const total = Buffer.byteLength(finalStdout, 'utf8') + Buffer.byteLength(finalStderr, 'utf8');
  if (total > maxCombinedBytes) {
    const excess = total - maxCombinedBytes;
    const currentStderrBytes = Buffer.byteLength(finalStderr, 'utf8');
    const allowedStderr = Math.max(0, currentStderrBytes - excess);
    finalStderr = sanitizeSandboxOutput(finalStderr, allowedStderr);
  }

  return { stdout: finalStdout, stderr: finalStderr };
}

/**
 * E2B Cloud Sandbox Provider Client.
 *
 * Implements the provider-agnostic `CloudSandboxProviderClient` interface for E2B Firecracker MicroVMs.
 * Key Safety & Isolation Features:
 * 1. Disabled by Default: Feature gate requires explicit `enabled: true`.
 * 2. Fail-Closed Configuration: Missing or malformed keys, invalid timeouts or templates fail closed.
 * 3. Network Isolation Policy Gate: Fails closed when egress isolation or allowlist is required without VPC proof.
 * 4. Zero Host Shell / Invariant INV-07: Never calls child_process or host terminal.
 * 5. Secret Fencing: Rejects any attempt to forward host database, JWT, or model provider credentials.
 * 6. Bounded Output: All outputs (stdout/stderr/files) bounded with canonical redaction and truncation.
 * 7. Duplicate Destroy Idempotency: Tolerates duplicate stop/destroy calls safely.
 * 8. Pure Dependency Injection: Fully testable with in-memory MockE2bTransport without network access.
 */
export class E2bCloudSandboxProviderClient implements CloudSandboxProviderClient {
  readonly providerName = 'e2b';
  private readonly config: E2bProviderConfig;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly activeSandboxes = new Map<string, ActiveSandboxEntry>();
  private readonly recentlyDestroyed = new Set<string>();

  constructor(config: E2bProviderConfig = {}) {
    this.config = config;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  get isEnabled(): boolean {
    return this.config.enabled === true;
  }

  get isConfigured(): boolean {
    return this.config.enabled === true && Boolean(this.config.apiKey?.trim());
  }

  get activeSandboxCount(): number {
    return Array.from(this.activeSandboxes.values()).filter((s) => !s.destroyed).length;
  }

  getSandboxStatus(sandboxId: string): 'active' | 'destroyed' | 'unknown' {
    if (this.recentlyDestroyed.has(sandboxId)) return 'destroyed';
    const sbx = this.activeSandboxes.get(sandboxId);
    if (!sbx) return 'unknown';
    if (sbx.destroyed) return 'destroyed';
    if (sbx.handle.isOpen && !sbx.handle.isOpen()) return 'destroyed';
    return 'active';
  }

  async createSandbox(
    params: CreateSandboxParams
  ): Promise<{ readonly sandboxId: string; readonly endpoint?: string }> {
    // 1. Feature Gate Check (Must be explicitly enabled)
    if (!this.config.enabled) {
      throw new E2bProviderError(
        'FEATURE_GATE_DISABLED',
        'E2B cloud sandbox provider is disabled by feature gate'
      );
    }

    // 2. Validate Configuration
    const validation = validateE2bConfig(this.config);
    if (!validation.valid) {
      throw new E2bProviderError(validation.code, validation.reason);
    }

    // 3. Network Isolation Policy Gate:
    // If the caller requests disabled egress or specific domain allowlists, but the provider configuration
    // does not guarantee hardware/VPC egress firewalling, fail closed!
    if (!params.networkPolicy.egressEnabled || (params.networkPolicy.allowlist && params.networkPolicy.allowlist.length > 0)) {
      if (!this.config.networkIsolationGuaranteed) {
        throw new E2bProviderError(
          'NETWORK_ISOLATION_UNSUPPORTED',
          'E2B sandbox cannot satisfy network egress isolation policy without enterprise VPC / custom isolation guarantee'
        );
      }
    }

    // 4. Secret Fencing: Validate environment variables passed to sandbox
    if (params.env) {
      for (const key of Object.keys(params.env)) {
        if (FORBIDDEN_ENV_KEYS.has(key)) {
          throw new E2bProviderError(
            'SECURITY_VIOLATION',
            `Attempted to pass sensitive environment variable '${key}' into E2B sandbox`
          );
        }
      }
    }

    // 5. Abort check
    if (params.signal?.aborted) {
      throw new E2bProviderError('EXECUTION_ABORTED', 'Execution was aborted before sandbox creation');
    }

    // 6. Transport check (Blocker 1: fallback to real E2B SDK transport when transport is omitted)
    const transport = this.config.transport ?? createRealE2bTransport();

    const template = this.config.template || 'base';
    const domain = this.config.domain;
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;

    try {
      const handle = await transport.createSandbox({
        apiKey: this.config.apiKey!,
        template,
        domain,
        timeoutMs,
        envs: params.env,
        metadata: {
          workspaceId: params.workspaceId,
          ownerId: params.ownerId,
        },
        signal: params.signal,
      });

      if (!handle || typeof handle.sandboxId !== 'string' || !handle.sandboxId) {
        throw new E2bProviderError('PROVIDER_ERROR', 'E2B transport returned invalid sandbox handle');
      }

      this.activeSandboxes.set(handle.sandboxId, {
        handle,
        createdAt: new Date().toISOString(),
        workspaceId: params.workspaceId,
        ownerId: params.ownerId,
        destroyed: false,
        destroyAttempts: 0,
      });

      return {
        sandboxId: handle.sandboxId,
        endpoint: domain,
      };
    } catch (err) {
      if (err instanceof E2bProviderError) throw err;
      const rawMessage = err instanceof Error ? err.message : String(err);
      const safeMessage = sanitizeSandboxOutput(rawMessage, 1024);
      throw new E2bProviderError('PROVIDER_ERROR', `Failed to create E2B sandbox: ${safeMessage}`);
    }
  }

  async executeCommand(
    sandboxId: string,
    params: {
      readonly command: string;
      readonly args?: readonly string[];
      readonly cwd?: string;
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    }
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly durationMs: number }> {
    const start = Date.now();

    if (!this.config.enabled) {
      throw new E2bProviderError('FEATURE_GATE_DISABLED', 'E2B cloud sandbox provider is disabled by feature gate');
    }

    const sbx = this.activeSandboxes.get(sandboxId);
    if (!sbx || sbx.destroyed) {
      throw new E2bProviderError('SANDBOX_NOT_FOUND', `E2B sandbox '${sandboxId}' not found or destroyed`);
    }

    if (params.signal?.aborted) {
      throw new E2bProviderError('EXECUTION_ABORTED', 'Execution was aborted');
    }

    const effectiveTimeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    const fullCommand = params.args && params.args.length > 0
      ? `${params.command} ${params.args.join(' ')}`
      : params.command;

    try {
      const result = await sbx.handle.commands.run(fullCommand, {
        args: params.args,
        cwd: params.cwd,
        timeoutMs: effectiveTimeoutMs,
        signal: params.signal,
      });

      const durationMs = result.durationMs ?? (Date.now() - start);
      const { stdout, stderr } = boundCombinedOutput(
        result.stdout ?? '',
        result.stderr ?? '',
        this.maxOutputBytes
      );

      return {
        exitCode: result.exitCode ?? 0,
        stdout,
        stderr,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const raw = err instanceof Error ? err.message : String(err);
      const safe = sanitizeSandboxOutput(raw, 1024);
      const lower = raw.toLowerCase();

      if (params.signal?.aborted || lower.includes('abort')) {
        throw new E2bProviderError('EXECUTION_ABORTED', 'Execution was aborted');
      }
      if (lower.includes('timeout') || lower.includes('timed out') || durationMs >= effectiveTimeoutMs) {
        throw new E2bProviderError('EXECUTION_TIMEOUT', `Command timed out after ${effectiveTimeoutMs}ms`);
      }
      throw new E2bProviderError('PROVIDER_ERROR', `Command execution failed: ${safe}`);
    }
  }

  async readFile(
    sandboxId: string,
    path: string
  ): Promise<{ readonly content: string; readonly bytes: number }> {
    const sbx = this.activeSandboxes.get(sandboxId);
    if (!sbx || sbx.destroyed) {
      throw new E2bProviderError('SANDBOX_NOT_FOUND', `E2B sandbox '${sandboxId}' not found or destroyed`);
    }

    if (!isSafeRelativePath(path)) {
      throw new E2bProviderError('SECURITY_VIOLATION', `Path traversal or invalid path: '${path}'`);
    }

    try {
      const content = await sbx.handle.files.read(path);
      const sanitized = sanitizeSandboxOutput(content ?? '', this.maxOutputBytes);
      return {
        content: sanitized,
        bytes: Buffer.byteLength(sanitized, 'utf8'),
      };
    } catch (err) {
      if (err instanceof E2bProviderError) throw err;
      const raw = err instanceof Error ? err.message : String(err);
      const safe = sanitizeSandboxOutput(raw, 1024);
      throw new E2bProviderError('PROVIDER_ERROR', `Failed to read file '${path}': ${safe}`);
    }
  }

  async writeFile(
    sandboxId: string,
    path: string,
    content: string
  ): Promise<{ readonly bytesWritten: number }> {
    const sbx = this.activeSandboxes.get(sandboxId);
    if (!sbx || sbx.destroyed) {
      throw new E2bProviderError('SANDBOX_NOT_FOUND', `E2B sandbox '${sandboxId}' not found or destroyed`);
    }

    if (!isSafeRelativePath(path)) {
      throw new E2bProviderError('SECURITY_VIOLATION', `Path traversal or invalid path: '${path}'`);
    }

    try {
      await sbx.handle.files.write(path, content);
      return {
        bytesWritten: Buffer.byteLength(content, 'utf8'),
      };
    } catch (err) {
      if (err instanceof E2bProviderError) throw err;
      const raw = err instanceof Error ? err.message : String(err);
      const safe = sanitizeSandboxOutput(raw, 1024);
      throw new E2bProviderError('PROVIDER_ERROR', `Failed to write file '${path}': ${safe}`);
    }
  }

  async listFiles(
    sandboxId: string,
    pathPrefix = ''
  ): Promise<readonly { readonly path: string; readonly size: number }[]> {
    const sbx = this.activeSandboxes.get(sandboxId);
    if (!sbx || sbx.destroyed) {
      throw new E2bProviderError('SANDBOX_NOT_FOUND', `E2B sandbox '${sandboxId}' not found or destroyed`);
    }

    try {
      const entries = await sbx.handle.files.list(pathPrefix || undefined);
      const results: { path: string; size: number }[] = [];

      for (const entry of entries) {
        if (entry.type === 'directory') continue;
        const entryPath = entry.path || entry.name;
        if (!pathPrefix || entryPath.startsWith(pathPrefix)) {
          results.push({
            path: entryPath,
            size: entry.size ?? 0,
          });
        }
      }

      results.sort((a, b) => a.path.localeCompare(b.path));
      return results;
    } catch (err) {
      if (err instanceof E2bProviderError) throw err;
      const raw = err instanceof Error ? err.message : String(err);
      const safe = sanitizeSandboxOutput(raw, 1024);
      throw new E2bProviderError('PROVIDER_ERROR', `Failed to list files: ${safe}`);
    }
  }

  async createSnapshot(
    sandboxId: string
  ): Promise<{ readonly files: readonly { readonly path: string; readonly size: number; readonly sha256?: string }[] }> {
    const sbx = this.activeSandboxes.get(sandboxId);
    if (!sbx || sbx.destroyed) {
      throw new E2bProviderError('SANDBOX_NOT_FOUND', `E2B sandbox '${sandboxId}' not found or destroyed`);
    }

    try {
      const fileList = await this.listFiles(sandboxId);
      const files: { path: string; size: number; sha256?: string }[] = [];

      for (const item of fileList) {
        try {
          const { content } = await this.readFile(sandboxId, item.path);
          const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
          files.push({
            path: item.path,
            size: Buffer.byteLength(content, 'utf8'),
            sha256,
          });
        } catch {
          files.push({
            path: item.path,
            size: item.size,
          });
        }
      }

      files.sort((a, b) => a.path.localeCompare(b.path));
      return { files };
    } catch (err) {
      if (err instanceof E2bProviderError) throw err;
      const raw = err instanceof Error ? err.message : String(err);
      const safe = sanitizeSandboxOutput(raw, 1024);
      throw new E2bProviderError('PROVIDER_ERROR', `Failed to snapshot E2B sandbox: ${safe}`);
    }
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    const sbx = this.activeSandboxes.get(sandboxId);
    // Duplicate destroy idempotency: if not found or already destroyed, safely return without throwing
    if (!sbx) {
      return;
    }

    sbx.destroyAttempts = (sbx.destroyAttempts ?? 0) + 1;
    try {
      await sbx.handle.kill();
      sbx.destroyed = true;
      this.recentlyDestroyed.add(sandboxId);
      this.activeSandboxes.delete(sandboxId);
    } catch (err) {
      // Blocker 2 fix: Do NOT mark destroyed or delete entry on failure!
      // Keep entry in registry so a subsequent retry can re-attempt kill()
      sbx.lastDestroyError = err instanceof Error ? err.message : String(err);
      const safe = sanitizeSandboxOutput(sbx.lastDestroyError, 1024);
      throw new E2bProviderError('PROVIDER_ERROR', `Failed to destroy E2B sandbox: ${safe}`);
    }
  }
}

/**
 * In-memory Mock E2B Transport for testing.
 * Guarantees zero network calls, zero child_process, and zero cloud resource creation.
 */
export class MockE2bTransport implements E2bTransport {
  public createdCount = 0;
  public killedCount = 0;
  public simulateCreateError?: Error;
  public simulateCommandError?: Error;
  public simulateKillError?: Error;
  public failKillAttempts = 0;
  public simulateTimeoutMs = 0;
  public simulateLateCompletionMs = 0;
  public simulateDisconnect = false;
  public lastCreateOptions?: E2bCreateOptions;

  private readonly sandboxes = new Map<string, {
    readonly files: Map<string, string>;
    killed: boolean;
  }>();

  async createSandbox(options: E2bCreateOptions): Promise<E2bSandboxHandle> {
    if (this.simulateCreateError) {
      throw this.simulateCreateError;
    }
    if (this.simulateDisconnect) {
      throw new Error('ECONNRESET: Connection reset by peer (api.e2b.dev:443)');
    }
    this.createdCount++;
    this.lastCreateOptions = options;

    const sandboxId = `e2b-sbx-${crypto.randomUUID()}`;
    const files = new Map<string, string>();
    this.sandboxes.set(sandboxId, { files, killed: false });

    const transport = this;

    const handle: E2bSandboxHandle = {
      sandboxId,
      commands: {
        async run(command: string, opts?: { timeoutMs?: number; signal?: AbortSignal }) {
          const entry = transport.sandboxes.get(sandboxId);
          if (!entry || entry.killed) {
            throw new Error(`Sandbox '${sandboxId}' is not running`);
          }

          if (transport.simulateDisconnect) {
            throw new Error('ECONNRESET: Connection reset by peer (api.e2b.dev:443)');
          }

          if (transport.simulateCommandError) {
            throw transport.simulateCommandError;
          }

          if (opts?.signal?.aborted) {
            throw new Error('Command was aborted');
          }

          if (transport.simulateTimeoutMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, transport.simulateTimeoutMs));
            throw new Error('Sandbox command execution timed out');
          }

          if (transport.simulateLateCompletionMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, transport.simulateLateCompletionMs));
          }

          if (command.includes('fail-command') || command.includes('syntax-error')) {
            return {
              exitCode: 1,
              stdout: '',
              stderr: 'Command failed with exit code 1',
            };
          }

          return {
            exitCode: 0,
            stdout: `Mock E2B executed: ${command}`,
            stderr: '',
          };
        },
      },
      files: {
        async read(path: string): Promise<string> {
          const entry = transport.sandboxes.get(sandboxId);
          if (!entry || entry.killed) throw new Error(`Sandbox '${sandboxId}' is not running`);
          const content = entry.files.get(path);
          if (content === undefined) throw new Error(`File '${path}' not found`);
          return content;
        },
        async write(path: string, content: string): Promise<void> {
          const entry = transport.sandboxes.get(sandboxId);
          if (!entry || entry.killed) throw new Error(`Sandbox '${sandboxId}' is not running`);
          entry.files.set(path, content);
        },
        async list(pathPrefix?: string): Promise<readonly E2bEntryInfo[]> {
          const entry = transport.sandboxes.get(sandboxId);
          if (!entry || entry.killed) throw new Error(`Sandbox '${sandboxId}' is not running`);
          const results: E2bEntryInfo[] = [];
          for (const [p, content] of entry.files.entries()) {
            if (!pathPrefix || p.startsWith(pathPrefix)) {
              results.push({
                name: p.split('/').pop() || p,
                path: p,
                type: 'file',
                size: Buffer.byteLength(content, 'utf8'),
              });
            }
          }
          return results;
        },
      },
      async kill(): Promise<void> {
        if (transport.simulateKillError) {
          throw transport.simulateKillError;
        }
        if (transport.failKillAttempts > 0) {
          transport.failKillAttempts--;
          throw new Error('E2B API gateway 502 Bad Gateway during sandbox kill');
        }
        const entry = transport.sandboxes.get(sandboxId);
        if (entry) {
          entry.killed = true;
        }
        transport.killedCount++;
      },
      isOpen(): boolean {
        const entry = transport.sandboxes.get(sandboxId);
        return entry ? !entry.killed : false;
      },
    };

    return handle;
  }

  getSandboxFiles(sandboxId: string): Map<string, string> | undefined {
    return this.sandboxes.get(sandboxId)?.files;
  }
}
