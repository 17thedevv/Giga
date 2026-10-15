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
  isOptimistic?: boolean;
  status?: 'streaming' | 'completed' | 'failed' | 'stopped';
}

// ==========================================
// GigaChat Runtime & Streaming Types (Task 17T-33 / GigaChat v0.2)
// ==========================================

export type GenerationStatus =
  | 'pending'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'stopped';

export type ChatFinishReason = 'stop' | 'length' | 'other' | 'cancelled';

export interface ChatGeneration {
  readonly id: string;
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly assistantMessageId?: string;
  readonly modelId: string;
  readonly status: GenerationStatus;
  readonly partialContent: string;
  readonly finishReason?: ChatFinishReason;
  readonly error?: { readonly code: string; readonly message: string };
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly cancelRequestedAt?: string;
}

export interface StreamChatRequest {
  readonly content: string;
  readonly modelId?: string;
}

export interface MessageStartedEventData {
  readonly messageId: string;
  readonly generationId: string;
  readonly conversationId: string;
}

export interface MessageDeltaEventData {
  readonly messageId: string;
  readonly generationId: string;
  readonly text: string;
}

export interface MessageCompletedEventData {
  readonly messageId: string;
  readonly generationId: string;
  readonly createdAt?: string;
  readonly finishReason?: string;
}

export interface StreamErrorEventData {
  readonly messageId: string;
  readonly generationId: string;
  readonly error: { readonly code: string; readonly message: string };
}

export interface MessageFailedEventData {
  readonly messageId: string;
  readonly generationId: string;
  readonly error: { readonly code: string; readonly message: string };
}

export interface MessageStoppedEventData {
  readonly messageId: string;
  readonly generationId: string;
  readonly finishReason?: 'cancelled' | string;
}

export type ChatStreamEvent =
  | { readonly event: 'message.started'; readonly data: MessageStartedEventData }
  | { readonly event: 'message.delta'; readonly data: MessageDeltaEventData }
  | { readonly event: 'message.completed'; readonly data: MessageCompletedEventData }
  | { readonly event: 'stream.error'; readonly data: StreamErrorEventData }
  | { readonly event: 'message.failed'; readonly data: MessageFailedEventData }
  | { readonly event: 'message.stopped'; readonly data: MessageStoppedEventData };

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

// ==========================================
// Skills & Personalization Types (Task 17T-30 / 17T-29 API Contract)
// ==========================================

export type ProductTarget = 'chat' | 'agent';
export type SkillVisibility = 'built_in' | 'private';

export interface SkillDefinition {
  id: ID;
  ownerId: ID | null;
  slug: string;
  title: string;
  description: string;
  visibility: SkillVisibility;
  supportedProducts: ProductTarget[];
  revision?: number;
  createdAt: ISODateTime;
}

export interface SkillVersion {
  id: ID;
  skillId: ID;
  versionNumber: number;
  contentHash: string;
  instructions: string;
  createdAt: ISODateTime;
}

export interface SkillInstallation {
  id: ID;
  userId: ID;
  skillId: ID;
  selectedVersionId: ID;
  enabled: boolean;
  installedAt: ISODateTime;
}

export interface SkillListItem {
  id: ID;
  ownerId: ID | null;
  slug: string;
  title: string;
  description: string;
  visibility: SkillVisibility;
  supportedProducts: ProductTarget[];
  revision?: number;
  createdAt: ISODateTime;
  installed: boolean;
  enabled: boolean;
  selectedVersionId: ID | null;
}

export interface CreateSkillDto {
  slug: string;
  title: string;
  description: string;
  supportedProducts?: ProductTarget[];
  instructions?: string;
}

export interface UpdateSkillDto {
  title?: string;
  description?: string;
  supportedProducts?: ProductTarget[];
  expectedRevision: number;
}

export interface CreateVersionDto {
  instructions: string;
}

export interface InstallSkillDto {
  versionId?: string;
  enabled?: boolean;
}

export interface UpdateInstallationDto {
  enabled?: boolean;
  selectedVersionId?: string;
}

export interface UserPreferences {
  revision: number;
  preferredLanguage?: string | null;
  responseLength: 'concise' | 'balanced' | 'detailed';
  responseStyle: 'professional' | 'casual' | 'technical';
  customInstructions: string;
}

export interface UpdatePreferencesDto {
  expectedRevision: number;
  preferredLanguage?: string | null;
  responseLength?: 'concise' | 'balanced' | 'detailed';
  responseStyle?: 'professional' | 'casual' | 'technical';
  customInstructions?: string;
}
