import type { AgentMode, ToolRisk, VerifiedCheck } from './types.js';

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
}

export type PrepareRuntimeResult =
  | { readonly available: false; readonly code: 'RUNTIME_UNAVAILABLE' }
  | { readonly available: true; readonly sessionId: string };

/** Future execution-plane port. No host command, filesystem, credential or provider transport belongs here. */
export interface ExecutionRuntime {
  readonly kind: 'cloud' | 'fake';
  prepare(request: PrepareRuntimeRequest): Promise<PrepareRuntimeResult>;
  invoke(sessionId: string, toolCall: ValidatedToolCall, signal: AbortSignal): Promise<BoundedToolResult>;
  getVerificationEvidence(sessionId: string): Promise<readonly VerifiedCheck[]>;
  stop(sessionId: string): Promise<void>;
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
  async stop(): Promise<void> {}
}

export interface FakeRuntimeOptions {
  readonly initialFiles?: Record<string, string>;
  readonly shouldFailBuild?: (files: ReadonlyMap<string, string>) => boolean;
  readonly shouldFailTests?: (files: ReadonlyMap<string, string>) => boolean;
  readonly simulatedLatencyMs?: number;
}

interface FakeSessionState {
  readonly sessionId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly mode: AgentMode;
  readonly files: Map<string, string>;
  readonly verifiedChecks: Map<string, VerifiedCheck>;
  active: boolean;
}

/**
 * Deterministic in-memory fake execution runtime for tests only.
 * Guaranteed completely isolated:
 * - No child_process
 * - No host shell
 * - No host filesystem access (node:fs)
 * - Pure in-memory Map storage
 */
export class DeterministicFakeExecutionRuntime implements ExecutionRuntime {
  readonly kind = 'fake';
  private readonly sessions = new Map<string, FakeSessionState>();

  constructor(private readonly options: FakeRuntimeOptions = {}) {}

  async prepare(request: PrepareRuntimeRequest): Promise<PrepareRuntimeResult> {
    if (request.signal.aborted) {
      return { available: false, code: 'RUNTIME_UNAVAILABLE' };
    }

    const sessionId = `fake-session-${request.runId}`;
    const files = new Map<string, string>();
    if (this.options.initialFiles) {
      for (const [p, content] of Object.entries(this.options.initialFiles)) {
        files.set(p, content);
      }
    }

    this.sessions.set(sessionId, {
      sessionId,
      runId: request.runId,
      workspaceId: request.workspaceId,
      ownerId: request.ownerId,
      mode: request.mode,
      files,
      verifiedChecks: new Map<string, VerifiedCheck>(),
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

    if (this.options.simulatedLatencyMs && this.options.simulatedLatencyMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.options.simulatedLatencyMs);
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
        return {
          success: true,
          output: { path: filePath, replacements: 1 },
          durationMs: Date.now() - start,
        };
      }

      case 'run_build': {
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

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.active = false;
    }
  }

  // Test inspection helper (in-memory only)
  getFile(sessionId: string, path: string): string | undefined {
    return this.sessions.get(sessionId)?.files.get(path);
  }
}
