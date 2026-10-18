/** DRAFT / NOT FROZEN. Public Agent wire DTOs only; no worker/runtime internals. */
export type AgentMode = 'ask' | 'plan' | 'execute';
export type AgentStatus = 'queued' | 'running' | 'awaiting_approval' | 'applying' | 'completed' | 'failed' | 'cancelled';
export type VerifiedCheckOutcome = 'passed' | 'failed' | 'not_run';
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
}
export type AgentMessageRole = 'user' | 'assistant' | 'tool_summary';
export interface AgentMessage {
  readonly id: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly role: AgentMessageRole;
  readonly content: string;
  readonly createdAt: string;
}
export interface Page<T> { readonly items: readonly T[]; readonly nextCursor: string | null }
export interface CreateAgentWorkspace { readonly name?: string; readonly source: { readonly kind: 'blank' } }
export interface CreateAgentRun {
  readonly workspaceId: string;
  readonly task: string;
  readonly mode?: AgentMode;
  readonly runtime?: 'cloud';
  readonly modelId?: 'giga-agent-default';
}
export interface CreateAgentMessage { readonly content: string }
export interface AgentWorkspaceResponse { readonly workspace: AgentWorkspace }
export interface AgentRunResponse { readonly run: AgentRun }
export interface AgentMessageResponse { readonly message: AgentMessage }

export const AGENT_CAPABILITY_NAMES: readonly [
  'workspaceManagement', 'runAdmission', 'runHistory', 'runExecution',
  'ask', 'plan', 'execute', 'durableMessages', 'followUp', 'eventReplay',
  'cancellation', 'sandboxFiles', 'artifacts', 'artifactDownload', 'externalApproval', 'cloudRuntime'
];
export type AgentCapabilityName = typeof AGENT_CAPABILITY_NAMES[number];
export type AgentCapabilityReason = 'runtime_unavailable' | 'not_implemented' | 'unknown';
export type AgentCapability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: AgentCapabilityReason };
export interface AgentCapabilities {
  readonly schemaVersion: 1;
  readonly capabilities: Readonly<Record<AgentCapabilityName, AgentCapability>>;
}
export interface RuntimeSchema<T> { parse(value: unknown): T }
export const agentWorkspaceSchema: RuntimeSchema<AgentWorkspace>;
export const agentRunSchema: RuntimeSchema<AgentRun>;
export const agentMessageSchema: RuntimeSchema<AgentMessage>;
/** Requires all known metadata; projects public fields and tolerates additive fields. */
export const agentCapabilitiesSchema: RuntimeSchema<AgentCapabilities>;
/** Consumer boundary: missing/malformed/unknown metadata disables features individually. */
export function readAgentCapabilities(value: unknown): AgentCapabilities;
export function isAgentCapabilityAvailable(value: unknown, name: AgentCapabilityName): boolean;
