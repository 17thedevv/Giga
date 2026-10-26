import crypto from 'node:crypto';
import type { AgentMode, VerifiedCheck, SandboxSnapshot, SandboxFileEntry, SandboxSessionInfo, DurableSandboxSession } from './types.js';
import { isSafeRelativePath } from './tool-registry.js';
import { redactSensitiveContent, boundUtf8 } from './redaction.js';
import type { ExecutionRuntime, ValidatedToolCall, BoundedToolResult, PrepareRuntimeRequest, PrepareRuntimeResult } from './execution-runtime.js';
import type { AgentRepository } from './repository.js';

export interface SandboxNetworkPolicy {
  readonly egressEnabled: boolean;
  readonly allowlist: readonly string[];
}

export interface CreateSandboxParams {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly timeoutMs: number;
  readonly env?: Record<string, string>;
  readonly networkPolicy: SandboxNetworkPolicy;
  readonly signal?: AbortSignal;
  readonly allocationOperationId?: string;
  readonly attemptGeneration?: string;
}

export type AllocationSettlement =
  | { readonly status: 'pending' }
  | { readonly status: 'ambiguous'; readonly reason: string }
  | { readonly status: 'allocated'; readonly sandboxId: string }
  | { readonly status: 'not_allocated' };

export interface CloudSandboxProviderClient {
  readonly providerName: string;
  readonly providerType?: string;

  createSandbox(params: CreateSandboxParams): Promise<{ readonly sandboxId: string; readonly endpoint?: string }>;

  /** Optional provider-side lookup. `not_allocated` must be definitive for this operation ID. */
  resolveAllocation?(allocationOperationId: string): Promise<AllocationSettlement>;

  executeCommand(sandboxId: string, params: {
    readonly command: string;
    readonly args?: readonly string[];
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly durationMs: number }>;

  readFile(sandboxId: string, path: string): Promise<{ readonly content: string; readonly bytes: number }>;
  writeFile(sandboxId: string, path: string, content: string): Promise<{ readonly bytesWritten: number }>;
  listFiles(sandboxId: string, pathPrefix?: string): Promise<readonly { readonly path: string; readonly size: number }[]>;
  createSnapshot(sandboxId: string): Promise<{ readonly files: readonly { readonly path: string; readonly size: number; readonly sha256?: string }[] }>;
  destroySandbox(sandboxId: string): Promise<void>;
}

export interface CloudSandboxConfig {
  readonly providerClient?: CloudSandboxProviderClient;
  readonly defaultTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly egressAllowlist?: readonly string[];
  readonly egressEnabled?: boolean;
  readonly repository?: AgentRepository;
  readonly allowInMemoryFallback?: boolean;
}

export type DestroyStatus = 'active' | 'destroying' | 'destroyed' | 'destroy_failed';

export interface CloudSessionState {
  readonly sessionId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly mode: AgentMode;
  readonly sandboxId: string;
  readonly attemptGeneration?: string;
  readonly verifiedChecks: Map<string, VerifiedCheck>;
  readonly createdAt: string;
  readonly timeoutMs: number;
  active: boolean;
  destroyStatus: DestroyStatus;
  destroyError?: string;
  destroyAttempts: number;
  readonly activeControllers?: Set<AbortController>;
}

const DEFAULT_SANDBOX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024; // 64 KiB bound per INV-07 / Security spec Section 4
const TRUNCATION_MARKER = '\n... [OUTPUT_TRUNCATED]';
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');

/**
 * Sanitizes output from remote sandbox commands and files.
 * Uses shared canonical redactSensitiveContent and boundUtf8 to prevent credential leakage.
 * Strict byte guarantee: Buffer.byteLength(result, 'utf8') <= maxBytes.
 */
export function sanitizeSandboxOutput(text: string, maxBytes: number): string {
  if (!text || typeof text !== 'string' || maxBytes <= 0) return '';
  const redacted = redactSensitiveContent(text);
  const totalBytes = Buffer.byteLength(redacted, 'utf8');
  if (totalBytes <= maxBytes) {
    return redacted;
  }

  if (maxBytes <= TRUNCATION_MARKER_BYTES) {
    return boundUtf8(redacted, maxBytes);
  }

  const allowedPrefixBytes = maxBytes - TRUNCATION_MARKER_BYTES;
  const boundedPrefix = boundUtf8(redacted, allowedPrefixBytes);
  return boundedPrefix + TRUNCATION_MARKER;
}

/**
 * Isolated Cloud Sandbox Adapter.
 *
 * Implements ExecutionRuntime for remote isolated sandbox providers (e.g. E2B MicroVMs, Fly.io Machines).
 * Key Security Gates:
 * 1. Strict INV-07 adherence: NEVER calls node:child_process or host shell.
 * 2. Host Secret Fencing: Drops all host process.env variables; injects only sanitized workspace context.
 * 3. Server-side Mode Policy: Rejects sandbox writes and command execution in Ask / Plan modes.
 * 4. Path Traversal Fencing: Validates relative paths before contacting remote provider.
 * 5. Network Egress Policy: Default deny-by-default with explicit allowlist forwarding.
 * 6. Post-Allocation Abort Fencing: Cleanly tears down sandbox if caller aborted during allocation.
 * 7. Independent Adapter-Level Wall-Clock Timeout: Never hangs even if remote RPC freezes.
 * 8. Cleanup Failure Tracking & Reconciliation: Sessions with failed destruction are tracked for retry.
 */
export class IsolatedCloudSandboxAdapter implements ExecutionRuntime {
  readonly kind = 'cloud' as const;
  private readonly sessions = new Map<string, CloudSessionState>();
  private readonly inFlightPrepares = new Map<
    string,
    {
      readonly ownerId: string;
      readonly workspaceId: string;
      readonly mode: AgentMode;
      readonly promise: Promise<PrepareRuntimeResult>;
    }
  >();
  private readonly providerClient?: CloudSandboxProviderClient;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly egressEnabled: boolean;
  private readonly egressAllowlist: readonly string[];
  private readonly repository?: AgentRepository;
  private readonly allowInMemoryFallback: boolean;

  constructor(config: CloudSandboxConfig = {}) {
    this.providerClient = config.providerClient;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
    this.maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.egressEnabled = config.egressEnabled ?? false; // Deny-by-default
    this.egressAllowlist = config.egressAllowlist ?? [];
    this.repository = config.repository;
    this.allowInMemoryFallback = config.allowInMemoryFallback ?? false;
  }

  get isConfigured(): boolean {
    return this.providerClient !== undefined;
  }

  get providerName(): string | undefined {
    return this.providerClient?.providerName;
  }

  async prepare(request: PrepareRuntimeRequest): Promise<PrepareRuntimeResult> {
    if (!this.providerClient) {
      return {
        available: false,
        code: 'RUNTIME_UNAVAILABLE',
        reason: 'No isolated cloud sandbox provider configured',
      };
    }

    if (this.providerClient && 'isEnabled' in this.providerClient && !(this.providerClient as { isEnabled?: boolean }).isEnabled) {
      return {
        available: false,
        code: 'RUNTIME_UNAVAILABLE',
        reason: 'E2B cloud sandbox provider is disabled by feature gate (GIGA_AGENT_E2B_ENABLED=false)',
      };
    }

    const canPersist = this.repository && (await this.repository.canPersistSandboxSessions());
    if (canPersist) {
      return this.prepareDurable(request);
    }

    // Fail closed when durable persistence is unavailable:
    // A configured real cloud provider must not silently fall back to in-memory session tracking.
    const isRealCloudProvider = Boolean(
      (this.providerClient as { isRealCloudProvider?: boolean }).isRealCloudProvider
    );

    if (isRealCloudProvider && !this.allowInMemoryFallback) {
      return {
        available: false,
        code: 'RUNTIME_UNAVAILABLE',
        reason: 'Durable sandbox session persistence is unavailable; in-memory fallback is disabled for configured cloud sandbox provider',
      };
    }

    if (request.signal?.aborted) {
      return {
        available: false,
        code: 'RUNTIME_UNAVAILABLE',
        reason: 'Execution was aborted before sandbox allocation',
      };
    }

    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const sessionId = `cloud-session-${request.runId}`;

    // 1. Sequential idempotency check with tenant and mode boundary validation:
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.ownerId !== request.ownerId || existing.workspaceId !== request.workspaceId) {
        return {
          available: false,
          code: 'TENANT_MISMATCH',
          reason: `Session for run '${request.runId}' belongs to another owner or workspace`,
        };
      }

      if (existing.active) {
        if (existing.mode !== request.mode) {
          return {
            available: false,
            code: 'TENANT_MISMATCH',
            reason: `Active session for run '${request.runId}' was prepared in '${existing.mode}' mode, cannot reuse in '${request.mode}' mode`,
          };
        }
        // Active session already allocated and ready for this runId with matching tenant and mode.
        return { available: true, sessionId };
      }

      // Previous session exists but is inactive / destroyed / failed.
      if (existing.destroyStatus !== 'destroyed') {
        try {
          await this.cleanup(sessionId);
        } catch {
          return {
            available: false,
            code: 'RUNTIME_UNAVAILABLE',
            reason: `Previous sandbox session for run '${request.runId}' could not be cleaned up`,
          };
        }
      }
    }

    // 2. Concurrent prepare deduplication with tenant and mode boundary validation:
    const inFlight = this.inFlightPrepares.get(request.runId);
    if (inFlight) {
      if (
        inFlight.ownerId !== request.ownerId ||
        inFlight.workspaceId !== request.workspaceId ||
        inFlight.mode !== request.mode
      ) {
        return {
          available: false,
          code: 'TENANT_MISMATCH',
          reason: `Concurrent prepare for run '${request.runId}' has conflicting tenant or mode identity`,
        };
      }
      return await inFlight.promise;
    }

    const preparePromise = (async (): Promise<PrepareRuntimeResult> => {
      try {
        // Secret Fencing: Host process.env is NEVER forwarded to the remote sandbox.
        const safeEnv: Record<string, string> = {
          GIGA_SANDBOX: '1',
          GIGA_WORKSPACE_ID: request.workspaceId,
          GIGA_RUN_ID: request.runId,
          NODE_ENV: 'production',
        };

        const networkPolicy: SandboxNetworkPolicy = {
          egressEnabled: this.egressEnabled,
          allowlist: this.egressAllowlist,
        };

        const { sandboxId } = await this.providerClient!.createSandbox({
          workspaceId: request.workspaceId,
          ownerId: request.ownerId,
          timeoutMs,
          env: safeEnv,
          networkPolicy,
          signal: request.signal,
        });

        // Post-Allocation Abort Fencing:
        // If the caller aborted while sandbox allocation was in flight, destroy it or queue for reconciliation!
        if (request.signal?.aborted) {
          const abortedSession: CloudSessionState = {
            sessionId,
            runId: request.runId,
            workspaceId: request.workspaceId,
            ownerId: request.ownerId,
            mode: request.mode,
            sandboxId,
            verifiedChecks: new Map<string, VerifiedCheck>(),
            createdAt: new Date().toISOString(),
            timeoutMs,
            active: false,
            destroyStatus: 'destroying',
            destroyAttempts: 1,
            activeControllers: new Set(),
          };

          try {
            await this.providerClient!.destroySandbox(sandboxId);
            abortedSession.destroyStatus = 'destroyed';
          } catch (destroyErr) {
            abortedSession.destroyStatus = 'destroy_failed';
            const rawErr = destroyErr instanceof Error ? destroyErr.message : String(destroyErr);
            abortedSession.destroyError = sanitizeSandboxOutput(rawErr, 1024);
            this.sessions.set(sessionId, abortedSession);
          }

          return {
            available: false,
            code: 'RUNTIME_UNAVAILABLE',
            reason: 'Execution was aborted during sandbox allocation',
          };
        }

        this.sessions.set(sessionId, {
          sessionId,
          runId: request.runId,
          workspaceId: request.workspaceId,
          ownerId: request.ownerId,
          mode: request.mode,
          sandboxId,
          verifiedChecks: new Map<string, VerifiedCheck>(),
          createdAt: new Date().toISOString(),
          timeoutMs,
          active: true,
          destroyStatus: 'active',
          destroyAttempts: 0,
          activeControllers: new Set(),
        });

        return { available: true, sessionId };
      } catch (err) {
        const rawReason = err instanceof Error ? err.message : 'Failed to allocate cloud sandbox';
        const reason = sanitizeSandboxOutput(rawReason, 1024);
        return {
          available: false,
          code: 'RUNTIME_UNAVAILABLE',
          reason,
        };
      }
    })();

    this.inFlightPrepares.set(request.runId, {
      ownerId: request.ownerId,
      workspaceId: request.workspaceId,
      mode: request.mode,
      promise: preparePromise,
    });
    try {
      return await preparePromise;
    } finally {
      this.inFlightPrepares.delete(request.runId);
    }
  }

  private async prepareDurable(request: PrepareRuntimeRequest): Promise<PrepareRuntimeResult> {
    if (!this.providerClient) {
      return {
        available: false,
        code: 'RUNTIME_UNAVAILABLE',
        reason: 'No isolated cloud sandbox provider configured',
      };
    }

    if (request.signal?.aborted) {
      return {
        available: false,
        code: 'RUNTIME_UNAVAILABLE',
        reason: 'Execution was aborted before sandbox allocation',
      };
    }

    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const workerId = request.workerId ?? `worker-${crypto.randomUUID()}`;
    const leaseToken = request.leaseToken ?? `lease-${crypto.randomUUID()}`;
    const attemptNumber = request.attemptNumber ?? 1;

    // 1. Create allocation intent in PostgreSQL
    let allocationIntent: { session: DurableSandboxSession; duplicate: boolean };
    try {
      allocationIntent = await this.repository!.createSandboxAllocationIntent({
        ownerId: request.ownerId,
        workspaceId: request.workspaceId,
        runId: request.runId,
        attemptNumber,
        mode: request.mode,
        providerType: this.providerClient.providerName,
        workerId,
        leaseToken,
        allocationTimeoutMs: timeoutMs,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('TENANT_MISMATCH')) {
        return {
          available: false,
          code: 'TENANT_MISMATCH',
          reason: message,
        };
      }
      return {
        available: false,
        code: 'RUNTIME_UNAVAILABLE',
        reason: message,
      };
    }

    const durableSession = allocationIntent.session;
    const sessionId = durableSession.id;

    // If duplicate active session was returned idempotently:
    if (allocationIntent.duplicate && durableSession.lifecycleState === 'active') {
      return { available: true, sessionId };
    }

    // 2. Abort check before calling provider
    if (request.signal?.aborted) {
      await this.repository!.recordSandboxAllocationFailed(
        sessionId,
        'Execution was aborted before sandbox allocation'
      ).catch(() => {});
      return {
        available: false,
        code: 'RUNTIME_UNAVAILABLE',
        reason: 'Execution was aborted before sandbox allocation',
      };
    }

    let allocationStarted: boolean;
    try {
      allocationStarted = await this.repository!.beginSandboxAllocationOperation(
        sessionId, durableSession.attemptGeneration
      );
    } catch (err) {
      return {
        available: false,
        code: 'RUNTIME_UNAVAILABLE',
        reason: err instanceof Error ? err.message : 'Sandbox allocation was fenced before provider submission',
      };
    }
    if (!allocationStarted) {
      return {
        available: false,
        code: 'RUNTIME_UNAVAILABLE',
        reason: 'Provider allocation was already submitted or its outcome is ambiguous',
      };
    }

    // 3. Allocate sandbox at remote provider
    const safeEnv: Record<string, string> = {
      GIGA_SANDBOX: '1',
      GIGA_WORKSPACE_ID: request.workspaceId,
      GIGA_RUN_ID: request.runId,
      NODE_ENV: 'production',
    };

    const networkPolicy: SandboxNetworkPolicy = {
      egressEnabled: this.egressEnabled,
      allowlist: this.egressAllowlist,
    };

    let sandboxId: string;
    try {
      const res = await this.providerClient.createSandbox({
        workspaceId: request.workspaceId,
        ownerId: request.ownerId,
        timeoutMs,
        env: safeEnv,
        networkPolicy,
        signal: request.signal,
        allocationOperationId: durableSession.allocationIntentId,
        attemptGeneration: durableSession.attemptGeneration,
      });
      sandboxId = res.sandboxId;
    } catch (createErr: unknown) {
      const errMsg = createErr instanceof Error ? createErr.message : String(createErr);
      await this.repository!.markSandboxAllocationAmbiguous(sessionId, errMsg).catch(() => {});
      return {
        available: false,
        code: 'RUNTIME_UNAVAILABLE',
        reason: errMsg,
      };
    }

    // Persist every returned provider identity before attempting cleanup or activation.
    // A late callback is associated with its original generation and cannot revive it.
    try {
      const committed = await this.repository!.commitSandboxSessionAllocated({
        sessionId,
        ownerId: request.ownerId,
        runId: request.runId,
        leaseToken,
        providerSessionId: sandboxId,
      });
      if (committed.lifecycleState !== 'active' || request.signal?.aborted) {
        try {
          await this.providerClient.destroySandbox(sandboxId);
          await this.repository!.markSandboxDestroyed(sessionId, sandboxId);
        } catch (destroyErr: unknown) {
          const rawErr = destroyErr instanceof Error ? destroyErr.message : String(destroyErr);
          await this.repository!.recordSandboxAllocationCleanupPending(
            sessionId, sandboxId, `Fenced allocation destroy failed: ${rawErr}`
          );
        }
        return {
          available: false,
          code: 'RUNTIME_UNAVAILABLE',
          reason: request.signal?.aborted ? 'Execution was aborted during sandbox allocation' : 'Attempt was fenced during sandbox allocation',
        };
      }
    } catch (commitErr: unknown) {
      // Persist the late provider ID before compensation whenever PostgreSQL is available.
      // If this write fails, retain the unresolved operation so quota reconciliation fails closed.
      const commitMessage = commitErr instanceof Error ? commitErr.message : String(commitErr);
      await this.repository!.recordSandboxAllocationCleanupPending(
        sessionId, sandboxId, `Allocation callback persistence failed: ${commitMessage}`
      ).catch(() => {});
      try {
        await this.providerClient.destroySandbox(sandboxId);
        await this.repository!.markSandboxDestroyed(sessionId, sandboxId).catch(() => {});
      } catch (destroyErr: unknown) {
        const rawErr = destroyErr instanceof Error ? destroyErr.message : String(destroyErr);
        await this.repository!.recordSandboxAllocationCleanupPending(
          sessionId,
          sandboxId,
          `Commit failed (${commitMessage}), destroy compensation failed: ${rawErr}`
        ).catch(() => {});
      }
      return {
        available: false,
        code: 'RUNTIME_UNAVAILABLE',
        reason: commitMessage,
      };
    }

    // Store in-memory handle for fast cancellation controller routing and verifiedChecks
    this.sessions.set(sessionId, {
      sessionId,
      runId: request.runId,
      workspaceId: request.workspaceId,
      ownerId: request.ownerId,
      mode: request.mode,
      sandboxId,
      attemptGeneration: durableSession.attemptGeneration,
      verifiedChecks: new Map(),
      createdAt: durableSession.createdAt,
      timeoutMs,
      active: true,
      destroyStatus: 'active',
      destroyAttempts: 0,
      activeControllers: new Set(),
    });

    return { available: true, sessionId };
  }

  async invoke(sessionId: string, toolCall: ValidatedToolCall, signal: AbortSignal): Promise<BoundedToolResult> {
    const start = Date.now();
    const session = this.sessions.get(sessionId);

    if (!session || !session.active) {
      return {
        success: false,
        output: {},
        durationMs: 0,
        errorCode: 'SESSION_NOT_FOUND',
        errorMessage: 'Execution session is not active or does not exist',
      };
    }

    if (signal.aborted) {
      return {
        success: false,
        output: {},
        durationMs: 0,
        errorCode: 'ABORTED',
        errorMessage: 'Execution was aborted',
      };
    }

    // 1. Server-side Mode Policy Gate (Defense-in-depth)
    if (session.mode === 'ask' || session.mode === 'plan') {
      if (
        toolCall.risk !== 'read' ||
        ['write_file', 'edit_file', 'run_build', 'run_tests', 'run_command'].includes(toolCall.toolName)
      ) {
        return {
          success: false,
          output: {},
          durationMs: Date.now() - start,
          errorCode: 'POLICY_VIOLATION',
          errorMessage: `Tool '${toolCall.toolName}' with risk '${toolCall.risk}' is not permitted in '${session.mode}' mode`,
        };
      }
    }

    // 2. Path Traversal & Host Boundary Fencing
    if (typeof toolCall.args?.path === 'string') {
      const targetPath = toolCall.args.path;
      if (!isSafeRelativePath(targetPath)) {
        return {
          success: false,
          output: {},
          durationMs: Date.now() - start,
          errorCode: 'SECURITY_VIOLATION',
          errorMessage: `Path traversal or invalid path detected: '${targetPath}'`,
        };
      }
    }

    if (!this.providerClient) {
      return {
        success: false,
        output: {},
        durationMs: Date.now() - start,
        errorCode: 'RUNTIME_UNAVAILABLE',
        errorMessage: 'Provider client disconnected',
      };
    }

    let lifecycleOperationId: string | undefined;
    if (this.repository && session.attemptGeneration) {
      try {
        lifecycleOperationId = await this.repository.beginSandboxRuntimeOperation(
          sessionId, session.attemptGeneration, 'tool', toolCall.toolName
        );
      } catch (err) {
        return {
          success: false,
          output: {},
          durationMs: Date.now() - start,
          errorCode: 'SESSION_NOT_FOUND',
          errorMessage: err instanceof Error ? err.message : 'Sandbox attempt is durably fenced',
        };
      }
    }

    // 3. Independent Adapter-Level Wall-Clock Timeout & Immediate Cancellation
    const effectiveTimeoutMs = Math.min(session.timeoutMs, this.defaultTimeoutMs);
    const timeoutController = new AbortController();
    session.activeControllers?.add(timeoutController);
    let timeoutTimer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    let internalStopHandler: (() => void) | undefined;
    let isCompletedOrTimedOut = false;
    let didTimeout = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        didTimeout = true;
        isCompletedOrTimedOut = true;
        timeoutController.abort();
        reject(new Error(`Sandbox execution timed out after ${effectiveTimeoutMs}ms`));
      }, effectiveTimeoutMs);
    });

    const abortPromise = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        timeoutController.abort();
        reject(new Error('Execution was aborted'));
        return;
      }
      if (!session.active || timeoutController.signal.aborted) {
        reject(new Error('Execution was stopped: session is not active'));
        return;
      }

      abortHandler = () => {
        timeoutController.abort();
        reject(new Error('Execution was aborted'));
      };
      signal.addEventListener('abort', abortHandler, { once: true });

      internalStopHandler = () => {
        // Triggered when adapter.stop() aborts session.activeControllers
        if (!didTimeout && !signal.aborted && !isCompletedOrTimedOut) {
          reject(new Error('Execution was stopped: session terminated'));
        }
      };
      timeoutController.signal.addEventListener('abort', internalStopHandler, { once: true });
    });

    // Fencing helper: Discards results if invocation timed out, was cancelled, or session stopped
    const isFenced = () => !session.active || signal.aborted || timeoutController.signal.aborted || isCompletedOrTimedOut;

    const executionPromise = (async (): Promise<BoundedToolResult> => {
      switch (toolCall.toolName) {
        case 'list_files': {
          const pathPrefix = (toolCall.args.path as string | undefined)?.trim() ?? '';
          const files = await this.providerClient!.listFiles(session.sandboxId, pathPrefix);
          if (isFenced()) {
            return {
              success: false,
              output: {},
              durationMs: Date.now() - start,
              errorCode: signal.aborted ? 'ABORTED' : 'TIMEOUT',
              errorMessage: 'List files completed after deadline or cancellation; result discarded',
            };
          }
          return {
            success: true,
            output: { files, count: files.length },
            durationMs: Date.now() - start,
          };
        }

        case 'read_file': {
          const filePath = toolCall.args.path as string;
          const { content, bytes } = await this.providerClient!.readFile(session.sandboxId, filePath);
          if (isFenced()) {
            return {
              success: false,
              output: {},
              durationMs: Date.now() - start,
              errorCode: signal.aborted ? 'ABORTED' : 'TIMEOUT',
              errorMessage: 'Read file completed after deadline or cancellation; result discarded',
            };
          }
          const sanitizedContent = sanitizeSandboxOutput(content, this.maxOutputBytes);
          return {
            success: true,
            output: { path: filePath, content: sanitizedContent, bytes },
            durationMs: Date.now() - start,
          };
        }

        case 'write_file': {
          const filePath = toolCall.args.path as string;
          const content = toolCall.args.content as string;
          const { bytesWritten } = await this.providerClient!.writeFile(session.sandboxId, filePath, content);
          if (isFenced()) {
            return {
              success: false,
              output: {},
              durationMs: Date.now() - start,
              errorCode: signal.aborted ? 'ABORTED' : 'TIMEOUT',
              errorMessage: 'Write file completed after deadline or cancellation; result discarded',
            };
          }
          // File modification invalidates previous verification checks
          session.verifiedChecks.clear();
          return {
            success: true,
            output: { path: filePath, bytesWritten },
            durationMs: Date.now() - start,
          };
        }

        case 'edit_file': {
          const filePath = toolCall.args.path as string;
          const find = toolCall.args.find as string;
          const replace = toolCall.args.replace as string;
          const { content } = await this.providerClient!.readFile(session.sandboxId, filePath);
          if (isFenced()) {
            return {
              success: false,
              output: {},
              durationMs: Date.now() - start,
              errorCode: signal.aborted ? 'ABORTED' : 'TIMEOUT',
              errorMessage: 'Edit file completed after deadline or cancellation; result discarded',
            };
          }
          if (!content.includes(find)) {
            return {
              success: false,
              output: {},
              durationMs: Date.now() - start,
              errorCode: 'FIND_NOT_FOUND',
              errorMessage: `Target string not found in '${filePath}'`,
            };
          }
          const updated = content.replace(find, replace);
          await this.providerClient!.writeFile(session.sandboxId, filePath, updated);
          if (isFenced()) {
            return {
              success: false,
              output: {},
              durationMs: Date.now() - start,
              errorCode: signal.aborted ? 'ABORTED' : 'TIMEOUT',
              errorMessage: 'Edit file write completed after deadline or cancellation; result discarded',
            };
          }
          // File modification invalidates previous verification checks
          session.verifiedChecks.clear();
          return {
            success: true,
            output: { path: filePath, replacements: 1 },
            durationMs: Date.now() - start,
          };
        }

        case 'run_build': {
          // Delete prior build check at start of new verification attempt
          session.verifiedChecks.delete('run_build');
          const buildCmd = (toolCall.args.command as string | undefined)?.trim() || 'npm run build';
          const res = await this.providerClient!.executeCommand(session.sandboxId, {
            command: buildCmd,
            timeoutMs: effectiveTimeoutMs,
            signal: timeoutController.signal,
          });

          // Late result fencing: If invocation timed out, was aborted, or session stopped, DISCARD!
          if (isFenced()) {
            return {
              success: false,
              output: {},
              durationMs: Date.now() - start,
              errorCode: signal.aborted ? 'ABORTED' : 'TIMEOUT',
              errorMessage: 'Build completed after deadline or cancellation; late verification discarded',
            };
          }

          const stdout = sanitizeSandboxOutput(res.stdout, this.maxOutputBytes);
          const stderr = sanitizeSandboxOutput(res.stderr, this.maxOutputBytes);

          if (res.exitCode === 0) {
            session.verifiedChecks.set('run_build', {
              name: 'run_build',
              outcome: 'passed',
              summary: 'Build succeeded with exit code 0',
            });
            return {
              success: true,
              output: { exitCode: 0, stdout },
              durationMs: res.durationMs,
            };
          } else {
            session.verifiedChecks.set('run_build', {
              name: 'run_build',
              outcome: 'failed',
              summary: `Build failed with exit code ${res.exitCode}`,
            });
            return {
              success: false,
              output: { exitCode: res.exitCode, stderr },
              durationMs: res.durationMs,
              errorCode: 'BUILD_FAILED',
              errorMessage: `Build failed with exit code ${res.exitCode}`,
            };
          }
        }

        case 'run_tests': {
          // Delete prior test check at start of new verification attempt
          session.verifiedChecks.delete('run_tests');
          const filter = (toolCall.args.testFilter as string | undefined)?.trim();
          const testCmd = filter ? `npm test -- -t "${filter}"` : 'npm test';
          const res = await this.providerClient!.executeCommand(session.sandboxId, {
            command: testCmd,
            timeoutMs: effectiveTimeoutMs,
            signal: timeoutController.signal,
          });

          // Late result fencing: If invocation timed out, was aborted, or session stopped, DISCARD!
          if (isFenced()) {
            return {
              success: false,
              output: {},
              durationMs: Date.now() - start,
              errorCode: signal.aborted ? 'ABORTED' : 'TIMEOUT',
              errorMessage: 'Tests completed after deadline or cancellation; late verification discarded',
            };
          }

          const stdout = sanitizeSandboxOutput(res.stdout, this.maxOutputBytes);
          const stderr = sanitizeSandboxOutput(res.stderr, this.maxOutputBytes);

          if (res.exitCode === 0) {
            session.verifiedChecks.set('run_tests', {
              name: 'run_tests',
              outcome: 'passed',
              summary: 'All tests passed with exit code 0',
            });
            return {
              success: true,
              output: { exitCode: 0, stdout },
              durationMs: res.durationMs,
            };
          } else {
            session.verifiedChecks.set('run_tests', {
              name: 'run_tests',
              outcome: 'failed',
              summary: `Tests failed with exit code ${res.exitCode}`,
            });
            return {
              success: false,
              output: { exitCode: res.exitCode, stderr },
              durationMs: res.durationMs,
              errorCode: 'TESTS_FAILED',
              errorMessage: `Tests failed with exit code ${res.exitCode}`,
            };
          }
        }

        case 'run_command': {
          // Verification freshness: Any command execution can alter workspace filesystem state,
          // so existing verification evidence (run_build / run_tests) must be invalidated.
          session.verifiedChecks.clear();

          const command = (toolCall.args.command as string | undefined)?.trim() ?? '';
          const args = Array.isArray(toolCall.args.args) ? (toolCall.args.args as string[]) : undefined;

          const res = await this.providerClient!.executeCommand(session.sandboxId, {
            command,
            args,
            timeoutMs: effectiveTimeoutMs,
            signal: timeoutController.signal,
          });

          // Late result fencing: If invocation timed out, was aborted, or session stopped, DISCARD!
          if (isFenced()) {
            return {
              success: false,
              output: {},
              durationMs: Date.now() - start,
              errorCode: signal.aborted ? 'ABORTED' : 'TIMEOUT',
              errorMessage: 'Command completed after deadline or cancellation; result discarded',
            };
          }

          const stdout = sanitizeSandboxOutput(res.stdout, this.maxOutputBytes);
          const stderr = sanitizeSandboxOutput(res.stderr, this.maxOutputBytes);

          return {
            success: res.exitCode === 0,
            output: { exitCode: res.exitCode, stdout, stderr },
            durationMs: res.durationMs,
            errorCode: res.exitCode === 0 ? undefined : 'COMMAND_FAILED',
            errorMessage: res.exitCode === 0 ? undefined : `Command exited with code ${res.exitCode}`,
          };
        }

        default:
          return {
            success: false,
            output: {},
            durationMs: Date.now() - start,
            errorCode: 'UNSUPPORTED_TOOL',
            errorMessage: `Sandbox does not support tool '${toolCall.toolName}'`,
          };
      }
    })();

    // Promise.race can return on timeout while the provider request is still running.
    // Settle the durable operation only when the underlying provider promise itself ends.
    if (lifecycleOperationId && this.repository) {
      void executionPromise.then(
        () => this.repository!.settleSandboxRuntimeOperation(lifecycleOperationId!),
        () => this.repository!.markSandboxRuntimeOperationAmbiguous(lifecycleOperationId!)
      ).catch(() => { /* unresolved durable state makes the fence fail closed */ });
    }

    try {
      return await Promise.race([executionPromise, timeoutPromise, abortPromise]);
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const rawMessage = err instanceof Error ? err.message : 'Cloud sandbox execution failed';
      const message = sanitizeSandboxOutput(rawMessage, 2048);
      const lower = rawMessage.toLowerCase();
      const isTimeout = lower.includes('timeout') || lower.includes('timed out') || durationMs >= effectiveTimeoutMs;

      // Ensure failed/timed out verification attempt invalidates any prior check
      if (toolCall.toolName === 'run_build') {
        session.verifiedChecks.delete('run_build');
      } else if (toolCall.toolName === 'run_tests') {
        session.verifiedChecks.delete('run_tests');
      }

      if (signal.aborted) {
        return {
          success: false,
          output: {},
          durationMs,
          errorCode: 'ABORTED',
          errorMessage: 'Execution was aborted',
        };
      }

      if (!session.active || rawMessage.includes('session terminated') || rawMessage.includes('session is not active')) {
        return {
          success: false,
          output: {},
          durationMs,
          errorCode: 'SESSION_NOT_FOUND',
          errorMessage: 'Execution was stopped: session is no longer active',
        };
      }

      return {
        success: false,
        output: {},
        durationMs,
        errorCode: isTimeout ? 'TIMEOUT' : 'EXECUTION_FAILED',
        errorMessage: message,
      };
    } finally {
      isCompletedOrTimedOut = true;
      session.activeControllers?.delete(timeoutController);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (abortHandler) signal.removeEventListener('abort', abortHandler);
      if (internalStopHandler) timeoutController.signal.removeEventListener('abort', internalStopHandler);
    }
  }

  async getVerificationEvidence(sessionId: string): Promise<readonly VerifiedCheck[]> {
    const session = this.sessions.get(sessionId);
    return session ? Array.from(session.verifiedChecks.values()) : [];
  }

  async createSnapshot(sessionId: string): Promise<SandboxSnapshot> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) {
      throw new Error(`Execution session '${sessionId}' not found or inactive`);
    }

    if (!this.providerClient) {
      throw new Error('Cloud sandbox provider client is not available');
    }

    const lifecycleOperationId = this.repository && session.attemptGeneration
      ? await this.repository.beginSandboxRuntimeOperation(sessionId, session.attemptGeneration, 'snapshot', 'create_snapshot')
      : undefined;
    let remoteFiles: readonly { path: string; size: number; sha256?: string }[];
    try {
      ({ files: remoteFiles } = await this.providerClient.createSnapshot(session.sandboxId));
      if (lifecycleOperationId && this.repository) await this.repository.settleSandboxRuntimeOperation(lifecycleOperationId);
    } catch (error) {
      if (lifecycleOperationId && this.repository) {
        await this.repository.markSandboxRuntimeOperationAmbiguous(lifecycleOperationId).catch(() => {});
      }
      throw error;
    }

    let totalBytes = 0;
    const files: SandboxFileEntry[] = remoteFiles.map((f) => {
      totalBytes += f.size;
      return {
        path: f.path,
        size: f.size,
        sha256: f.sha256,
      };
    });

    files.sort((a, b) => a.path.localeCompare(b.path));

    return {
      sessionId,
      workspaceId: session.workspaceId,
      capturedAt: new Date().toISOString(),
      files,
      totalBytes,
      fileCount: files.length,
    };
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      const wasActive = session.active;
      session.active = false;

      if (session.activeControllers) {
        for (const ctrl of session.activeControllers) {
          try {
            ctrl.abort();
          } catch {
            // ignore
          }
        }
        session.activeControllers.clear();
      }

      if (this.repository && (await this.repository.canPersistSandboxSessions())) {
        try {
          await this.repository.markSandboxStopping(session.ownerId, sessionId);
        } catch (error) {
          session.active = wasActive;
          throw error;
        }
      }

      if (this.providerClient && session.destroyStatus !== 'destroyed') {
        session.destroyStatus = 'destroying';
        session.destroyAttempts++;
        try {
          await this.providerClient.destroySandbox(session.sandboxId);
          session.destroyStatus = 'destroyed';
          session.destroyError = undefined;
          if (this.repository && (await this.repository.canPersistSandboxSessions())) {
            await this.repository.markSandboxDestroyed(sessionId, session.sandboxId).catch(() => {});
          }
        } catch (err) {
          session.destroyStatus = 'destroy_failed';
          const rawErr = err instanceof Error ? err.message : String(err);
          session.destroyError = sanitizeSandboxOutput(rawErr, 1024);
          if (this.repository && (await this.repository.canPersistSandboxSessions())) {
            await this.repository.markSandboxCleanupPending(sessionId, rawErr).catch(() => {});
          }
          throw err;
        }
      }
      return;
    }

    if (this.repository && (await this.repository.canPersistSandboxSessions())) {
      const durable = await this.repository.getSandboxSessionById(sessionId);
      if (durable && durable.lifecycleState !== 'destroyed') {
        await this.repository.markSandboxStopping(durable.ownerId, sessionId);
        if (durable.providerSessionId && this.providerClient) {
          try {
            await this.providerClient.destroySandbox(durable.providerSessionId);
            await this.repository.markSandboxDestroyed(sessionId, durable.providerSessionId);
          } catch (err: unknown) {
            const rawErr = err instanceof Error ? err.message : String(err);
            await this.repository.markSandboxCleanupPending(sessionId, rawErr);
            throw err;
          }
        } else if (!durable.providerSessionId) {
          const state = await this.repository.getSandboxAttemptLifecycle({
            ownerId: durable.ownerId, workspaceId: durable.workspaceId,
            runId: durable.runId, attemptNumber: durable.attemptNumber,
          });
          const allocation = state.operations.find((operation) => operation.kind === 'allocation');
          if (allocation?.state === 'settled' && allocation.outcome === 'no_resource') {
            await this.repository.recordSandboxAllocationFailed(sessionId, 'Allocation was confirmed not to have started');
          } else {
            throw new Error('Sandbox allocation outcome is unresolved; refusing to mark the session destroyed');
          }
        }
      }
    }
  }

  async cleanup(sessionId: string, options: { force?: boolean } = {}): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        await this.stop(sessionId);
      } catch (err) {
        if (!options.force) {
          // Keep session recorded in this.sessions so reconciliation worker can retry!
          const rawErr = err instanceof Error ? err.message : String(err);
          const safeErr = sanitizeSandboxOutput(rawErr, 1024);
          throw new Error(
            `Failed to destroy sandbox '${session.sandboxId}': ${safeErr}. Session retained for reconciliation.`
          );
        }
      }

      if (session.destroyStatus === 'destroyed' || options.force) {
        this.sessions.delete(sessionId);
      }
      return;
    }

    if (this.repository && (await this.repository.canPersistSandboxSessions())) {
      try {
        await this.stop(sessionId);
      } catch (err) {
        if (!options.force) {
          const rawErr = err instanceof Error ? err.message : String(err);
          const safeErr = sanitizeSandboxOutput(rawErr, 1024);
          throw new Error(
            `Failed to destroy sandbox '${sessionId}': ${safeErr}. Session retained for reconciliation.`
          );
        }
      }
    }
  }

  async getSession(sessionId: string): Promise<SandboxSessionInfo | undefined> {
    const session = this.sessions.get(sessionId);
    if (session) {
      return {
        sessionId: session.sessionId,
        runId: session.runId,
        workspaceId: session.workspaceId,
        ownerId: session.ownerId,
        mode: session.mode,
        active: session.active,
        createdAt: session.createdAt,
        timeoutMs: session.timeoutMs,
      };
    }
    if (this.repository && (await this.repository.canPersistSandboxSessions())) {
      const durable = await this.repository.getSandboxSessionById(sessionId);
      if (durable) {
        return {
          sessionId: durable.id,
          runId: durable.runId,
          workspaceId: durable.workspaceId,
          ownerId: durable.ownerId,
          mode: durable.mode,
          active: durable.lifecycleState === 'active',
          createdAt: durable.createdAt,
        };
      }
    }
    return undefined;
  }

  getPendingDestructions(): readonly CloudSessionState[] {
    return Array.from(this.sessions.values()).filter((s) => s.destroyStatus === 'destroy_failed');
  }

  async retryDestroy(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.providerClient) return false;
    session.destroyAttempts++;
    try {
      await this.providerClient.destroySandbox(session.sandboxId);
      session.destroyStatus = 'destroyed';
      session.destroyError = undefined;
      return true;
    } catch (err) {
      session.destroyStatus = 'destroy_failed';
      const rawErr = err instanceof Error ? err.message : String(err);
      session.destroyError = sanitizeSandboxOutput(rawErr, 1024);
      return false;
    }
  }
}

/**
 * Deterministic In-Memory Simulation of a Cloud Sandbox Provider.
 * Used exclusively for verification, regression, and security testing of the Cloud Sandbox Adapter.
 * Guarantees zero host process execution, zero network access, and zero external costs.
 */
export class SimulatedCloudSandboxProviderClient implements CloudSandboxProviderClient {
  readonly providerName = 'simulated-cloud-microvm';
  private readonly sandboxes = new Map<string, {
    readonly sandboxId: string;
    readonly workspaceId: string;
    readonly ownerId: string;
    readonly env: Record<string, string>;
    readonly networkPolicy: SandboxNetworkPolicy;
    readonly files: Map<string, string>;
    destroyed: boolean;
  }>();

  public simulateTimeout = false;
  public simulateHangingCommand = false;
  public simulateNetworkCrash = false;
  public simulateBuildFailure = false;
  public simulateTestFailure = false;
  public simulateDestroyFailure = false;
  public simulateLateAllocationMs = 0;
  public simulateIgnoreAbortSignalAndCompleteLateMs = 0;
  public simulateAllocationErrorWithSecret?: string;
  public simulateCommandErrorWithSecret?: string;
  public lastReceivedEnv?: Record<string, string>;
  public lastReceivedNetworkPolicy?: SandboxNetworkPolicy;

  async createSandbox(params: CreateSandboxParams): Promise<{ sandboxId: string }> {
    if (this.simulateAllocationErrorWithSecret) {
      throw new Error(this.simulateAllocationErrorWithSecret);
    }
    if (this.simulateNetworkCrash) {
      throw new Error('Simulated network crash during sandbox creation');
    }
    if (this.simulateLateAllocationMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.simulateLateAllocationMs));
    }
    const sandboxId = `sbx-${crypto.randomUUID()}`;
    const files = new Map<string, string>();
    this.lastReceivedEnv = params.env;
    this.lastReceivedNetworkPolicy = params.networkPolicy;

    this.sandboxes.set(sandboxId, {
      sandboxId,
      workspaceId: params.workspaceId,
      ownerId: params.ownerId,
      env: params.env ?? {},
      networkPolicy: params.networkPolicy,
      files,
      destroyed: false,
    });
    return { sandboxId };
  }

  async executeCommand(sandboxId: string, params: {
    command: string;
    args?: readonly string[];
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
    const sbx = this.sandboxes.get(sandboxId);
    if (!sbx || sbx.destroyed) {
      throw new Error(`Sandbox '${sandboxId}' not found or destroyed`);
    }

    if (this.simulateCommandErrorWithSecret) {
      throw new Error(this.simulateCommandErrorWithSecret);
    }

    if (this.simulateIgnoreAbortSignalAndCompleteLateMs > 0) {
      // Deliberately delay resolution and ignore abort signal to simulate late completing RPC
      await new Promise((resolve) => setTimeout(resolve, this.simulateIgnoreAbortSignalAndCompleteLateMs));
      return {
        exitCode: 0,
        stdout: `Simulated late output for '${params.command}'`,
        stderr: '',
        durationMs: this.simulateIgnoreAbortSignalAndCompleteLateMs,
      };
    }

    if (this.simulateHangingCommand) {
      // Simulate hanging RPC that never resolves unless signal is aborted
      return new Promise((_, reject) => {
        params.signal?.addEventListener('abort', () => {
          reject(new Error('Command aborted during hanging execution'));
        }, { once: true });
      });
    }

    if (this.simulateTimeout) {
      throw new Error('Sandbox command timed out');
    }

    if (this.simulateNetworkCrash) {
      throw new Error('Simulated connection reset by peer');
    }

    if (params.command.includes('npm run build') && this.simulateBuildFailure) {
      return { exitCode: 1, stdout: '', stderr: 'SyntaxError: Unexpected token in index.ts', durationMs: 25 };
    }

    if (params.command.includes('npm test') && this.simulateTestFailure) {
      return { exitCode: 1, stdout: '', stderr: 'FAIL: 1 of 5 tests failed', durationMs: 30 };
    }

    return {
      exitCode: 0,
      stdout: `Simulated remote output for '${params.command}'`,
      stderr: '',
      durationMs: 15,
    };
  }

  async readFile(sandboxId: string, path: string): Promise<{ content: string; bytes: number }> {
    const sbx = this.sandboxes.get(sandboxId);
    if (!sbx || sbx.destroyed) throw new Error(`Sandbox '${sandboxId}' not found or destroyed`);
    const content = sbx.files.get(path);
    if (content === undefined) throw new Error(`File '${path}' not found in remote sandbox`);
    return { content, bytes: Buffer.byteLength(content, 'utf8') };
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<{ bytesWritten: number }> {
    const sbx = this.sandboxes.get(sandboxId);
    if (!sbx || sbx.destroyed) throw new Error(`Sandbox '${sandboxId}' not found or destroyed`);
    sbx.files.set(path, content);
    return { bytesWritten: Buffer.byteLength(content, 'utf8') };
  }

  async listFiles(sandboxId: string, pathPrefix = ''): Promise<readonly { path: string; size: number }[]> {
    const sbx = this.sandboxes.get(sandboxId);
    if (!sbx || sbx.destroyed) throw new Error(`Sandbox '${sandboxId}' not found or destroyed`);
    const results: { path: string; size: number }[] = [];
    for (const [p, content] of sbx.files.entries()) {
      if (!pathPrefix || p.startsWith(pathPrefix)) {
        results.push({ path: p, size: Buffer.byteLength(content, 'utf8') });
      }
    }
    return results;
  }

  async createSnapshot(sandboxId: string): Promise<{ files: readonly { path: string; size: number; sha256?: string }[] }> {
    const sbx = this.sandboxes.get(sandboxId);
    if (!sbx || sbx.destroyed) throw new Error(`Sandbox '${sandboxId}' not found or destroyed`);
    const files: { path: string; size: number; sha256?: string }[] = [];
    for (const [p, content] of sbx.files.entries()) {
      const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
      files.push({ path: p, size: Buffer.byteLength(content, 'utf8'), sha256 });
    }
    return { files };
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    const sbx = this.sandboxes.get(sandboxId);
    if (!sbx) throw new Error(`Sandbox '${sandboxId}' not found`);
    if (this.simulateDestroyFailure) {
      throw new Error(`Simulated failure destroying sandbox '${sandboxId}' (network timeout or provider 500)`);
    }
    sbx.destroyed = true;
  }

  getSandboxCount(): number {
    return Array.from(this.sandboxes.values()).filter((s) => !s.destroyed).length;
  }

  getRawSandbox(sandboxId: string) {
    return this.sandboxes.get(sandboxId);
  }
}

export {
  E2bCloudSandboxProviderClient,
  E2bProviderError,
  MockE2bTransport,
  validateE2bConfig,
  loadE2bConfigFromEnv,
  type E2bProviderConfig,
  type E2bProviderErrorCode,
  type E2bTransport,
  type E2bSandboxHandle,
  type E2bEntryInfo,
  type E2bCreateOptions,
} from './e2b-provider.js';
