import crypto from 'node:crypto';
import type { AgentMode, ToolRisk, VerifiedCheck, SandboxSnapshot, SandboxFileEntry, SandboxSessionInfo } from './types.js';
import { isSafeRelativePath } from './tool-registry.js';

export interface ValidatedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly risk: ToolRisk;
  readonly args: Record<string, unknown>;
}

export interface BoundedToolResult {
  readonly success: boolean;
  readonly output: Record<string, unknown>;
  readonly durationMs: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface PrepareRuntimeRequest {
  readonly runId: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly mode: AgentMode;
  readonly task: string;
  readonly modelId: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly workerId?: string;
  readonly leaseToken?: string;
  readonly attemptNumber?: number;
}

export type PrepareRuntimeResult =
  | { readonly available: false; readonly code: 'RUNTIME_UNAVAILABLE' | 'TENANT_MISMATCH'; readonly reason?: string }
  | { readonly available: true; readonly sessionId: string };

/** Future execution-plane port. No host command, filesystem, credential or provider transport belongs here. */
export interface ExecutionRuntime {
  readonly kind: 'cloud' | 'fake';
  prepare(request: PrepareRuntimeRequest): Promise<PrepareRuntimeResult>;
  invoke(sessionId: string, toolCall: ValidatedToolCall, signal: AbortSignal): Promise<BoundedToolResult>;
  getVerificationEvidence(sessionId: string): Promise<readonly VerifiedCheck[]>;
  createSnapshot(sessionId: string): Promise<SandboxSnapshot>;
  stop(sessionId: string): Promise<void>;
  cleanup(sessionId: string): Promise<void>;
  getSession?(sessionId: string): Promise<SandboxSessionInfo | undefined>;
}

/** The default shipped runtime implementation. It allocates nothing and executes nothing. */
export class UnavailableExecutionRuntime implements ExecutionRuntime {
  readonly kind = 'cloud';

  async prepare(): Promise<PrepareRuntimeResult> {
    return { available: false, code: 'RUNTIME_UNAVAILABLE' };
  }

  async invoke(): Promise<BoundedToolResult> {
    return {
      success: false,
      output: {},
      durationMs: 0,
      errorCode: 'RUNTIME_UNAVAILABLE',
      errorMessage: 'Agent execution runtime is not available',
    };
  }

  async getVerificationEvidence(): Promise<readonly VerifiedCheck[]> {
    return [];
  }

  async createSnapshot(sessionId: string): Promise<SandboxSnapshot> {
    return {
      sessionId,
      workspaceId: '',
      capturedAt: new Date().toISOString(),
      files: [],
      totalBytes: 0,
      fileCount: 0,
    };
  }

  async stop(): Promise<void> {}

  async cleanup(): Promise<void> {}

  async getSession(): Promise<SandboxSessionInfo | undefined> {
    return undefined;
  }
}

export interface FakeRuntimeOptions {
  readonly initialFiles?: Record<string, string>;
  readonly shouldFailBuild?: (files: ReadonlyMap<string, string>) => boolean;
  readonly shouldFailTests?: (files: ReadonlyMap<string, string>) => boolean;
  readonly simulatedLatencyMs?: number;
  readonly defaultTimeoutMs?: number;
  readonly customCommandRunner?: (
    command: string,
    args?: readonly string[],
    files?: Map<string, string>
  ) => { exitCode: number; stdout: string; stderr: string };
}

interface FakeSessionState {
  readonly sessionId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly mode: AgentMode;
  readonly files: Map<string, string>;
  readonly verifiedChecks: Map<string, VerifiedCheck>;
  readonly env: ReadonlyMap<string, string>;
  readonly createdAt: string;
  readonly timeoutMs?: number;
  active: boolean;
}

/**
 * Deterministic in-memory fake execution runtime for tests only.
 * Guaranteed completely isolated:
 * - No child_process
 * - No host shell
 * - No host filesystem access (node:fs)
 * - Pure in-memory Map storage
 * - Server-side mode policy gate (ask/plan denies writes and execution)
 * - Path traversal fencing
 * - Secret fencing (no host process.env exposed)
 */
export class DeterministicFakeExecutionRuntime implements ExecutionRuntime {
  readonly kind = 'fake';
  private readonly sessions = new Map<string, FakeSessionState>();

  constructor(private readonly options: FakeRuntimeOptions = {}) {}

  async prepare(request: PrepareRuntimeRequest): Promise<PrepareRuntimeResult> {
    if (request.signal.aborted) {
      return { available: false, code: 'RUNTIME_UNAVAILABLE', reason: 'Preparation aborted' };
    }

    const sessionId = `fake-session-${request.runId}`;

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
        return { available: true, sessionId };
      }
    }

    const files = new Map<string, string>();
    if (this.options.initialFiles) {
      for (const [p, content] of Object.entries(this.options.initialFiles)) {
        files.set(p, content);
      }
    }

    // Secret Fencing: The sandbox session receives ONLY isolated, safe workspace identifiers.
    // Host process environment variables (such as DATABASE_URL, JWT_SECRET, etc.) are strictly excluded.
    const isolatedEnv = new Map<string, string>([
      ['GIGA_SANDBOX', '1'],
      ['GIGA_WORKSPACE_ID', request.workspaceId],
      ['GIGA_RUN_ID', request.runId],
      ['NODE_ENV', 'test'],
    ]);

    this.sessions.set(sessionId, {
      sessionId,
      runId: request.runId,
      workspaceId: request.workspaceId,
      ownerId: request.ownerId,
      mode: request.mode,
      files,
      verifiedChecks: new Map<string, VerifiedCheck>(),
      env: isolatedEnv,
      createdAt: new Date().toISOString(),
      timeoutMs: request.timeoutMs ?? this.options.defaultTimeoutMs,
      active: true,
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

    // Server-side Mode Policy Enforcement (Defense-in-depth gate)
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

    // Path Traversal and Host Escape Fencing
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

    const effectiveTimeoutMs = session.timeoutMs ?? this.options.defaultTimeoutMs;

    if (this.options.simulatedLatencyMs && this.options.simulatedLatencyMs > 0) {
      const latency = this.options.simulatedLatencyMs;
      if (effectiveTimeoutMs && latency > effectiveTimeoutMs) {
        // Latency exceeds allowed timeout
        await new Promise((resolve) => setTimeout(resolve, Math.min(effectiveTimeoutMs, 20)));
        return {
          success: false,
          output: {},
          durationMs: effectiveTimeoutMs,
          errorCode: 'TIMEOUT',
          errorMessage: `Execution timed out after ${effectiveTimeoutMs}ms`,
        };
      }

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, latency);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Aborted during execution'));
        }, { once: true });
      }).catch(() => {
        return {
          success: false,
          output: {},
          durationMs: Date.now() - start,
          errorCode: 'ABORTED',
          errorMessage: 'Execution was aborted',
        };
      });

      if (signal.aborted) {
        return {
          success: false,
          output: {},
          durationMs: Date.now() - start,
          errorCode: 'ABORTED',
          errorMessage: 'Execution was aborted',
        };
      }
    }

    switch (toolCall.toolName) {
      case 'list_files': {
        const pathPrefix = (toolCall.args.path as string | undefined)?.trim() ?? '';
        const items: Array<{ path: string; size: number }> = [];
        for (const [p, content] of session.files.entries()) {
          if (!pathPrefix || p.startsWith(pathPrefix)) {
            items.push({ path: p, size: Buffer.byteLength(content, 'utf8') });
          }
        }
        items.sort((a, b) => a.path.localeCompare(b.path));
        return {
          success: true,
          output: { files: items, count: items.length },
          durationMs: Date.now() - start,
        };
      }

      case 'read_file': {
        const filePath = toolCall.args.path as string;
        const content = session.files.get(filePath);
        if (content === undefined) {
          return {
            success: false,
            output: {},
            durationMs: Date.now() - start,
            errorCode: 'FILE_NOT_FOUND',
            errorMessage: `File '${filePath}' not found in workspace`,
          };
        }
        return {
          success: true,
          output: { path: filePath, content, bytes: Buffer.byteLength(content, 'utf8') },
          durationMs: Date.now() - start,
        };
      }

      case 'write_file': {
        const filePath = toolCall.args.path as string;
        const content = toolCall.args.content as string;
        session.files.set(filePath, content);
        session.verifiedChecks.clear();
        return {
          success: true,
          output: { path: filePath, bytesWritten: Buffer.byteLength(content, 'utf8') },
          durationMs: Date.now() - start,
        };
      }

      case 'edit_file': {
        const filePath = toolCall.args.path as string;
        const find = toolCall.args.find as string;
        const replace = toolCall.args.replace as string;
        const content = session.files.get(filePath);
        if (content === undefined) {
          return {
            success: false,
            output: {},
            durationMs: Date.now() - start,
            errorCode: 'FILE_NOT_FOUND',
            errorMessage: `File '${filePath}' not found in workspace`,
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
        session.files.set(filePath, updated);
        session.verifiedChecks.clear();
        return {
          success: true,
          output: { path: filePath, replacements: 1 },
          durationMs: Date.now() - start,
        };
      }

      case 'run_build': {
        session.verifiedChecks.delete('run_build');
        const fail =
          this.options.shouldFailBuild?.(session.files) ??
          Array.from(session.files.values()).some((c) => c.includes('SYNTAX_ERROR'));
        if (fail) {
          session.verifiedChecks.set('run_build', {
            name: 'run_build',
            outcome: 'failed',
            summary: 'Build failed: syntax error detected in workspace source',
          });
          return {
            success: false,
            output: { exitCode: 1, stderr: 'error TS1005: Syntax error in file' },
            durationMs: Date.now() - start,
            errorCode: 'BUILD_FAILED',
            errorMessage: 'Fake build failed with exit code 1',
          };
        }
        session.verifiedChecks.set('run_build', {
          name: 'run_build',
          outcome: 'passed',
          summary: 'Build succeeded with exit code 0',
        });
        return {
          success: true,
          output: { exitCode: 0, stdout: 'Build output: 0 errors' },
          durationMs: Date.now() - start,
        };
      }

      case 'run_tests': {
        session.verifiedChecks.delete('run_tests');
        const fail =
          this.options.shouldFailTests?.(session.files) ??
          Array.from(session.files.values()).some((c) => c.includes('TEST_FAILURE'));
        if (fail) {
          session.verifiedChecks.set('run_tests', {
            name: 'run_tests',
            outcome: 'failed',
            summary: '1 test failed',
          });
          return {
            success: false,
            output: { exitCode: 1, stderr: 'FAIL: Expected true but received false' },
            durationMs: Date.now() - start,
            errorCode: 'TESTS_FAILED',
            errorMessage: 'Fake tests failed with exit code 1',
          };
        }
        session.verifiedChecks.set('run_tests', {
          name: 'run_tests',
          outcome: 'passed',
          summary: 'All 3 tests passed with exit code 0',
        });
        return {
          success: true,
          output: { exitCode: 0, stdout: 'PASS: 3 tests passed' },
          durationMs: Date.now() - start,
        };
      }

      case 'run_command': {
        // Verification freshness: Any command execution can alter workspace filesystem state,
        // so existing verification evidence (run_build / run_tests) must be invalidated.
        session.verifiedChecks.clear();

        const command = (toolCall.args.command as string | undefined)?.trim() ?? '';
        const args = Array.isArray(toolCall.args.args) ? (toolCall.args.args as string[]) : undefined;

        if (this.options.customCommandRunner) {
          const res = this.options.customCommandRunner(command, args, session.files);
          return {
            success: res.exitCode === 0,
            output: { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr },
            durationMs: Date.now() - start,
            errorCode: res.exitCode === 0 ? undefined : 'COMMAND_FAILED',
            errorMessage: res.exitCode === 0 ? undefined : `Command exited with code ${res.exitCode}`,
          };
        }

        return {
          success: true,
          output: {
            exitCode: 0,
            stdout: `Fake command '${command}' executed successfully in isolated sandbox`,
            stderr: '',
          },
          durationMs: Date.now() - start,
        };
      }

      default:
        return {
          success: false,
          output: {},
          durationMs: Date.now() - start,
          errorCode: 'UNSUPPORTED_TOOL',
          errorMessage: `Runtime does not emulate tool '${toolCall.toolName}'`,
        };
    }
  }

  async getVerificationEvidence(sessionId: string): Promise<readonly VerifiedCheck[]> {
    const session = this.sessions.get(sessionId);
    return session ? Array.from(session.verifiedChecks.values()) : [];
  }

  async createSnapshot(sessionId: string): Promise<SandboxSnapshot> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Execution session '${sessionId}' not found`);
    }

    const files: SandboxFileEntry[] = [];
    let totalBytes = 0;

    for (const [p, content] of session.files.entries()) {
      const size = Buffer.byteLength(content, 'utf8');
      const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
      files.push({ path: p, size, sha256 });
      totalBytes += size;
    }

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
      session.active = false;
    }
  }

  async cleanup(sessionId: string): Promise<void> {
    await this.stop(sessionId);
  }

  async getSession(sessionId: string): Promise<SandboxSessionInfo | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
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

  // Inspection helpers for testing
  getFile(sessionId: string, path: string): string | undefined {
    return this.sessions.get(sessionId)?.files.get(path);
  }

  getEnvironment(sessionId: string): ReadonlyMap<string, string> | undefined {
    return this.sessions.get(sessionId)?.env;
  }

  assertTenantAccess(sessionId: string, callerOwnerId: string, callerWorkspaceId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.ownerId === callerOwnerId && session.workspaceId === callerWorkspaceId;
  }
}
