export type AgentMode = 'ask' | 'plan' | 'execute';
export type AgentStatus = 'queued' | 'running' | 'awaiting_approval' | 'applying' | 'completed' | 'failed' | 'cancelled';
export const AGENT_MODEL_ALIAS = 'giga-agent-default';
export const RUNTIME_UNAVAILABLE = { code: 'RUNTIME_UNAVAILABLE', message: 'Agent execution runtime is not available' } as const;
export const isTerminal = (status: AgentStatus): boolean => ['completed', 'failed', 'cancelled'].includes(status);

export interface AgentWorkspace {
  readonly id: string;
  readonly name: string;
  readonly sourceKind: 'blank';
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface AgentRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly task: string;
  readonly mode: AgentMode;
  readonly runtime: 'cloud';
  readonly modelId: string;
  readonly status: AgentStatus;
  readonly phase?: 'waiting_runtime';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
  readonly error?: typeof RUNTIME_UNAVAILABLE;
}
export interface RunInput {
  readonly workspaceId: string;
  readonly task: string;
  readonly mode: AgentMode;
  readonly runtime: 'cloud';
  readonly modelId: typeof AGENT_MODEL_ALIAS;
}
export interface AgentEvent {
  readonly sequence: number;
  readonly type: 'run.status' | 'run.failed';
  readonly data: { readonly runId: string; readonly status: AgentStatus; readonly phase?: 'waiting_runtime' }
    | { readonly runId: string; readonly code: 'RUNTIME_UNAVAILABLE'; readonly message: string };
}
export interface AgentCursor {
  readonly kind: 'workspaces' | 'runs';
  readonly workspaceId: string | null;
  readonly createdAt: string;
  readonly id: string;
}
export interface Page<T> { readonly items: readonly T[]; readonly nextCursor: string | null }
export interface ListOptions { readonly limit: number; readonly cursor?: AgentCursor; readonly workspaceId?: string }
