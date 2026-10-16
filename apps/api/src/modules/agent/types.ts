export type AgentMode = 'ask' | 'plan' | 'execute';
export type AgentStatus = 'queued' | 'running' | 'awaiting_approval' | 'applying' | 'completed' | 'failed' | 'cancelled';
export type ToolRisk = 'read' | 'sandbox_write' | 'sandbox_execute';
export type VerifiedCheckOutcome = 'passed' | 'failed' | 'not_run';

export const AGENT_MODEL_ALIAS = 'giga-agent-default';
export const RUNTIME_UNAVAILABLE = { code: 'RUNTIME_UNAVAILABLE', message: 'Agent execution runtime is not available' } as const;
export const isTerminal = (status: AgentStatus): boolean => ['completed', 'failed', 'cancelled'].includes(status);

export const AGENT_ERROR_CODES = [
  'RUNTIME_UNAVAILABLE',
  'STEP_LIMIT_EXCEEDED',
  'TOOL_ERROR',
  'EXECUTION_FAILED',
  'VERIFICATION_FAILED',
  'CANCELLED',
  'UNKNOWN_TOOL',
  'INVALID_ARGUMENTS',
  'POLICY_VIOLATION',
  'INTERNAL_ERROR',
  'ABORTED',
  'PERMANENT_ERROR',
] as const;
export type AgentErrorCode = typeof AGENT_ERROR_CODES[number];

export interface VerifiedCheck {
  readonly name: string;
  readonly outcome: VerifiedCheckOutcome;
  readonly summary?: string;
}

export interface AgentRunResult {
  readonly summary: string;
  readonly artifactIds: readonly string[];
  readonly verifiedChecks: readonly VerifiedCheck[];
}

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
  readonly phase?: 'waiting_runtime' | 'planning' | 'executing' | 'observing' | 'verifying';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly result?: AgentRunResult;
  readonly workerId?: string;
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: string;
  readonly attemptCount?: number;
}

export interface RunInput {
  readonly workspaceId: string;
  readonly task: string;
  readonly mode: AgentMode;
  readonly runtime: 'cloud';
  readonly modelId: typeof AGENT_MODEL_ALIAS;
}

export type StepStatus = 'running' | 'completed' | 'failed';

export interface AgentStep {
  readonly id: string;
  readonly runId: string;
  readonly stepNumber: number;
  readonly status: StepStatus;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly toolRisk: ToolRisk;
  readonly arguments: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly durationMs?: number;
  readonly createdAt: string;
  readonly completedAt?: string;
}

export type AgentEventType =
  | 'run.status'
  | 'plan.updated'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'run.completed'
  | 'run.failed';

export type AgentEventData =
  | { readonly runId: string; readonly status: AgentStatus; readonly phase?: string }
  | { readonly runId: string; readonly version: number; readonly steps: readonly string[] }
  | { readonly runId: string; readonly toolCallId: string; readonly name: string; readonly stepNumber: number }
  | { readonly runId: string; readonly toolCallId: string; readonly outcome: 'success'; readonly durationMs: number; readonly summary?: string }
  | { readonly runId: string; readonly toolCallId: string; readonly code: string; readonly summary: string }
  | { readonly runId: string; readonly artifactIds: readonly string[]; readonly verifiedChecks: readonly VerifiedCheck[]; readonly summary?: string }
  | { readonly runId: string; readonly code: string; readonly message: string };

export interface AgentEvent {
  readonly sequence: number;
  readonly type: AgentEventType;
  readonly data: AgentEventData;
}

export interface AgentCursor {
  readonly kind: 'workspaces' | 'runs';
  readonly workspaceId: string | null;
  readonly createdAt: string;
  readonly id: string;
}

export interface Page<T> { readonly items: readonly T[]; readonly nextCursor: string | null }
export interface ListOptions { readonly limit: number; readonly cursor?: AgentCursor; readonly workspaceId?: string }
