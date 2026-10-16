import type { AgentMode } from './types.js';

/** Future execution-plane port. No host command, filesystem, credential or provider transport belongs here. */
export interface ExecutionRuntime {
  readonly kind: 'cloud';
  prepare(request: {
    readonly runId: string;
    readonly workspaceId: string;
    readonly ownerId: string;
    readonly mode: AgentMode;
    readonly task: string;
    readonly modelId: string;
    readonly signal: AbortSignal;
  }): Promise<
    | { readonly available: false; readonly code: 'RUNTIME_UNAVAILABLE' }
    | { readonly available: true; readonly sessionId: string }
  >;
}

/** The only shipped runtime implementation. It allocates nothing and executes nothing. */
export class UnavailableExecutionRuntime implements ExecutionRuntime {
  readonly kind = 'cloud';
  async prepare(): Promise<{ readonly available: false; readonly code: 'RUNTIME_UNAVAILABLE' }> {
    return { available: false, code: 'RUNTIME_UNAVAILABLE' };
  }
}
