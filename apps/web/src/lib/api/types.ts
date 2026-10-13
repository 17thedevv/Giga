export type ID = string;
export type ISODateTime = string;

export interface User {
  id: ID;
  email: string;
  displayName: string;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

export interface Conversation {
  id: ID;
  title: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface Message {
  id: ID;
  conversationId: ID;
  role: 'user' | 'assistant';
  content: string;
  createdAt: ISODateTime;
}

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'applying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentRunResult {
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  commitSha?: string;
}

export interface AgentRun {
  id: ID;
  status: AgentRunStatus;
  task: string;
  repository: string;
  baseRef?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  error?: ApiError;
  result?: AgentRunResult;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  unifiedDiff: string;
  additions?: number;
  deletions?: number;
}

export interface ChangeProposal {
  id: ID;
  runId: ID;
  baseCommitSha: string;
  files: ChangedFile[];
  createdAt: ISODateTime;
}

export interface ToolCallStep {
  id: string;
  tool: string;
  status: 'pending' | 'running' | 'success' | 'error';
  stepNumber: number;
  path?: string;
  query?: string;
  args?: Record<string, unknown>;
  summary?: string;
  durationMs?: number;
  outputPreview?: string;
}

export type ApiMode = 'real' | 'mock';
