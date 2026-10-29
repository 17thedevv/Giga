import type {
  User,
  Conversation,
  Message,
  ChangeProposal,
  SkillListItem,
  SkillDefinition,
  SkillVersion,
  SkillInstallation,
  CreateSkillDto,
  UpdateSkillDto,
  CreateVersionDto,
  InstallSkillDto,
  UpdateInstallationDto,
  UserPreferences,
  UpdatePreferencesDto,
  ChatGeneration,
  ChatTurnVariants,
  ChatStreamEvent,
  ReasoningEffort,
  ModelMetadata,
  ModelsResponse,
  ProviderCredential,
  ChatCredentialPreference,
  SaveCredentialDto,
  SetCredentialPreferenceDto,
} from './types.js';
import { SseStreamParser, validateChatStreamEvent } from './sse-parser.js';
import {
  agentRunSchema,
  agentWorkspaceSchema,
  readAgentCapabilities,
  type AgentCapabilities,
  type AgentRun,
  type AgentWorkspace,
  type CreateAgentRun,
  type CreateAgentWorkspace,
  type Page,
} from './agent-contract.js';
import { extractSensitiveRequestValues, sanitizeUntrustedText, sanitizeUntrustedValue } from '../security/untrusted-content.js';

export const SESSION_EXPIRED_EVENT = 'giga:session-expired';
let sessionGeneration = 0;

/** Return the current client-side authentication generation. */
export function getSessionGeneration(): number {
  return sessionGeneration;
}

/**
 * Fence requests started before login, logout, session invalidation, or an
 * API-mode change. AuthContext uses this same generation for state updates.
 */
export function advanceSessionGeneration(): number {
  sessionGeneration++;
  return sessionGeneration;
}

export function isCurrentSessionGeneration(generation: number): boolean {
  return generation === sessionGeneration;
}

function isSessionExemptPath(path: string): boolean {
  return /\/auth\/(?:login|register)(?:\?|$)/.test(path);
}

function assertSessionEpoch(requestEpoch: number, path: string): void {
  if (requestEpoch !== sessionGeneration && !isSessionExemptPath(path)) {
    throw new ApiException(401, 'SESSION_EXPIRED', 'Session expired; please sign in again');
  }
}

function notifyUnauthorized(requestEpoch: number, path: string, status: number): number | null {
  if (status !== 401 || isSessionExemptPath(path)) return null;
  // Only the first 401 from the current generation invalidates the session.
  // Late responses from an older session must not log out a newer one.
  if (requestEpoch !== sessionGeneration) return null;
  const invalidatedGeneration = advanceSessionGeneration();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
  return invalidatedGeneration;
}

function assertResponseGeneration(requestEpoch: number, path: string, invalidatedGeneration: number | null): void {
  // Preserve the API's first current-session 401 code/message. If another
  // login/logout happens while that error body is being read, treat it as stale.
  if (invalidatedGeneration !== null && invalidatedGeneration === sessionGeneration) return;
  assertSessionEpoch(requestEpoch, path);
}

function safeApiErrorCode(value: unknown, status: number): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value)
    ? sanitizeUntrustedText(value)
    : `HTTP_${status}`;
}

function safeApiErrorMessage(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.slice(0, 2000) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNonEmptyString(value: unknown, maxLength = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function projectUser(value: unknown): User {
  if (!isRecord(value) || !isNonEmptyString(value.id, 256) || !isNonEmptyString(value.email, 320) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) || !isNonEmptyString(value.displayName, 256)) {
    throw invalidDto();
  }
  return { id: value.id, email: value.email, displayName: sanitizeUntrustedText(value.displayName) };
}

function projectUserEnvelope(value: unknown): { user: User } {
  if (!isRecord(value)) throw invalidDto();
  return { user: projectUser(value.user) };
}

function invalidDto(): ApiException {
  return new ApiException(502, 'INVALID_RESPONSE', 'The server returned an invalid response');
}

function projectConversation(value: unknown): Conversation {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 256 ||
      typeof value.title !== 'string' || value.title.length > 500 ||
      typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt)) ||
      typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) {
    throw invalidDto();
  }
  return { id: value.id, title: sanitizeUntrustedText(value.title), createdAt: value.createdAt, updatedAt: value.updatedAt };
}

function projectMessage(value: unknown): Message {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 256 ||
      typeof value.conversationId !== 'string' || value.conversationId.length === 0 ||
      (value.role !== 'user' && value.role !== 'assistant') || typeof value.content !== 'string' ||
      typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt)) ||
      (value.status !== undefined && !['streaming', 'completed', 'failed', 'stopped'].includes(String(value.status))) ||
      (value.isOptimistic !== undefined && typeof value.isOptimistic !== 'boolean')) {
    throw invalidDto();
  }
  return {
    id: value.id,
    conversationId: value.conversationId,
    role: value.role,
    content: sanitizeUntrustedText(value.content),
    createdAt: value.createdAt,
    ...(value.status ? { status: value.status as Message['status'] } : {}),
    ...(typeof value.isOptimistic === 'boolean' ? { isOptimistic: value.isOptimistic } : {}),
  };
}

function projectConversationList(value: unknown): { items: Conversation[]; nextCursor: string | null } {
  if (!isRecord(value) || !Array.isArray(value.items) ||
      (value.nextCursor !== null && typeof value.nextCursor !== 'string')) throw invalidDto();
  return { items: value.items.map(projectConversation), nextCursor: value.nextCursor };
}

function projectConversationEnvelope(value: unknown): { conversation: Conversation } {
  if (!isRecord(value)) throw invalidDto();
  return { conversation: projectConversation(value.conversation) };
}

const MODEL_CAPABILITIES = ['text', 'streaming', 'structured', 'embeddings', 'tool_calling'] as const;

function projectModelsResponse(value: unknown): ModelsResponse {
  if (!isRecord(value) || !Array.isArray(value.models)) throw invalidDto();
  return {
    models: value.models.map((item): ModelMetadata => {
      if (!isRecord(item) || !isNonEmptyString(item.id, 256)) throw invalidDto();
      const capabilities = Array.isArray(item.capabilities)
        ? item.capabilities.filter((capability): capability is ModelMetadata['capabilities'][number] =>
            typeof capability === 'string' && MODEL_CAPABILITIES.includes(capability as typeof MODEL_CAPABILITIES[number]))
        : [];
      const reasoning = isRecord(item.reasoning) ? item.reasoning : {};
      const efforts = Array.isArray(reasoning.efforts)
        ? reasoning.efforts.filter((effort): effort is ReasoningEffort =>
            typeof effort === 'string' && REASONING_EFFORTS.includes(effort as typeof REASONING_EFFORTS[number]))
        : [];
      const supported = reasoning.supported === true && efforts.length > 0;
      return {
        id: sanitizeUntrustedText(item.id),
        capabilities,
        reasoning: { supported, efforts: supported ? efforts : [] },
      };
    }),
  };
}

const GENERATION_STATUSES = ['pending', 'queued', 'streaming', 'running', 'completed', 'failed', 'interrupted', 'stopped'] as const;
const REASONING_EFFORTS = ['low', 'medium', 'high'] as const;

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function projectChatGeneration(value: unknown): ChatGeneration {
  if (!isRecord(value) ||
      typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 256 ||
      typeof value.conversationId !== 'string' || value.conversationId.length === 0 ||
      typeof value.userMessageId !== 'string' || value.userMessageId.length === 0 ||
      typeof value.modelId !== 'string' || value.modelId.length === 0 ||
      typeof value.status !== 'string' || !GENERATION_STATUSES.includes(value.status as typeof GENERATION_STATUSES[number]) ||
      typeof value.partialContent !== 'string' || !isDateString(value.createdAt) ||
      (value.assistantMessageId !== undefined && typeof value.assistantMessageId !== 'string') ||
      (value.reasoningEffort !== undefined && !REASONING_EFFORTS.includes(value.reasoningEffort as typeof REASONING_EFFORTS[number])) ||
      (value.finishReason !== undefined && !['stop', 'length', 'other', 'cancelled'].includes(String(value.finishReason))) ||
      (value.startedAt !== undefined && !isDateString(value.startedAt)) ||
      (value.finishedAt !== undefined && !isDateString(value.finishedAt)) ||
      (value.cancelRequestedAt !== undefined && !isDateString(value.cancelRequestedAt)) ||
      (value.error !== undefined && (!isRecord(value.error) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string'))) {
    throw invalidDto();
  }

  return {
    id: value.id,
    conversationId: value.conversationId,
    userMessageId: value.userMessageId,
    ...(typeof value.assistantMessageId === 'string' ? { assistantMessageId: value.assistantMessageId } : {}),
    modelId: value.modelId,
    ...(typeof value.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort as ReasoningEffort } : {}),
    status: value.status as ChatGeneration['status'],
    partialContent: sanitizeUntrustedText(value.partialContent),
    ...(typeof value.finishReason === 'string' ? { finishReason: value.finishReason as ChatGeneration['finishReason'] } : {}),
    ...(isRecord(value.error) ? {
      error: {
        code: safeApiErrorCode(value.error.code, 502),
        message: sanitizeUntrustedText(value.error.message as string).slice(0, 500),
      },
    } : {}),
    createdAt: value.createdAt,
    ...(typeof value.startedAt === 'string' ? { startedAt: value.startedAt } : {}),
    ...(typeof value.finishedAt === 'string' ? { finishedAt: value.finishedAt } : {}),
    ...(typeof value.cancelRequestedAt === 'string' ? { cancelRequestedAt: value.cancelRequestedAt } : {}),
  };
}

function projectGenerationEnvelope(value: unknown): { generation: ChatGeneration } {
  if (!isRecord(value)) throw invalidDto();
  return { generation: projectChatGeneration(value.generation) };
}

function projectGenerationErrorDetails(details: unknown, topLevelGeneration?: unknown): Record<string, unknown> | undefined {
  const nestedGeneration = isRecord(details) ? details.generation : undefined;
  const candidate = topLevelGeneration ?? nestedGeneration;
  if (!candidate) return undefined;
  try {
    return { generation: projectChatGeneration(candidate) };
  } catch {
    return undefined;
  }
}

function readApiError(value: unknown, status: number, fallback: string): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  const envelope = isRecord(value) ? value : undefined;
  const error = envelope && isRecord(envelope.error) ? envelope.error : undefined;
  return {
    code: safeApiErrorCode(error?.code, status),
    message: safeApiErrorMessage(error?.message, fallback),
    ...(error ? { details: projectGenerationErrorDetails(error.details, envelope?.generation) } : {}),
  };
}

function projectChatTurnVariants(value: unknown): ChatTurnVariants {
  if (!isRecord(value) || typeof value.userMessageId !== 'string' || value.userMessageId.length === 0 ||
      (value.selectedGenerationId !== null && typeof value.selectedGenerationId !== 'string') ||
      !Array.isArray(value.items)) throw invalidDto();

  const items = value.items.map((item): ChatTurnVariants['items'][number] => {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0 ||
        !['new_prompt', 'retry', 'regenerate'].includes(String(item.action)) ||
        typeof item.modelId !== 'string' || typeof item.status !== 'string' ||
        !GENERATION_STATUSES.includes(item.status as typeof GENERATION_STATUSES[number]) ||
        !isDateString(item.createdAt) ||
        (item.assistantMessageId !== undefined && typeof item.assistantMessageId !== 'string') ||
        (item.content !== undefined && typeof item.content !== 'string') ||
        (item.finishedAt !== undefined && !isDateString(item.finishedAt)) ||
        (item.reasoningEffort !== undefined && !REASONING_EFFORTS.includes(item.reasoningEffort as typeof REASONING_EFFORTS[number]))) {
      throw invalidDto();
    }
    return {
      id: item.id,
      action: item.action as ChatTurnVariants['items'][number]['action'],
      modelId: item.modelId,
      status: item.status as ChatTurnVariants['items'][number]['status'],
      ...(typeof item.assistantMessageId === 'string' ? { assistantMessageId: item.assistantMessageId } : {}),
      ...(item.status === 'completed' && typeof item.content === 'string' ? { content: sanitizeUntrustedText(item.content) } : {}),
      createdAt: item.createdAt,
      ...(typeof item.finishedAt === 'string' ? { finishedAt: item.finishedAt } : {}),
      ...(typeof item.reasoningEffort === 'string' ? { reasoningEffort: item.reasoningEffort as ReasoningEffort } : {}),
    };
  });
  return { userMessageId: value.userMessageId, selectedGenerationId: value.selectedGenerationId, items };
}

function projectAgentWorkspace(value: unknown): AgentWorkspace {
  try {
    const workspace = agentWorkspaceSchema.parse(value);
    return { ...workspace, name: sanitizeUntrustedText(workspace.name) };
  } catch {
    throw invalidDto();
  }
}

function projectAgentWorkspaceEnvelope(value: unknown): { workspace: AgentWorkspace } {
  if (!isRecord(value)) throw invalidDto();
  return { workspace: projectAgentWorkspace(value.workspace) };
}

function projectAgentPage<T>(value: unknown, project: (item: unknown) => T): Page<T> {
  if (!isRecord(value) || !Array.isArray(value.items) ||
      (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || value.nextCursor.length > 1024))) {
    throw invalidDto();
  }
  return { items: value.items.map(project), nextCursor: value.nextCursor as string | null };
}

function projectAgentRun(value: unknown): AgentRun {
  try {
    const parsed = agentRunSchema.parse(value);
    return {
      ...parsed,
      task: sanitizeUntrustedText(parsed.task),
      ...(parsed.error ? { error: { code: safeApiErrorCode(parsed.error.code, 502), message: sanitizeUntrustedText(parsed.error.message).slice(0, 500) } } : {}),
      ...(parsed.result ? {
        result: {
          summary: sanitizeUntrustedText(parsed.result.summary),
          artifactIds: [...parsed.result.artifactIds],
          verifiedChecks: parsed.result.verifiedChecks.map(check => ({
            name: sanitizeUntrustedText(check.name),
            outcome: check.outcome,
            ...(check.summary !== undefined ? { summary: sanitizeUntrustedText(check.summary) } : {}),
          })),
        },
      } : {}),
    };
  } catch {
    throw invalidDto();
  }
}

function projectAgentRunEnvelope(value: unknown): { run: AgentRun } {
  if (!isRecord(value)) throw invalidDto();
  return { run: projectAgentRun(value.run) };
}

function generateAgentIdempotencyKey(): string {
  const randomId = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `agent-${randomId}`;
}

function isUncertainAdmissionFailure(error: unknown): boolean {
  return !(error instanceof ApiException) || error.status >= 500;
}

function projectChangeProposalEnvelope(value: unknown): { proposal: ChangeProposal } {
  if (!isRecord(value) || !isRecord(value.proposal)) throw invalidDto();
  const proposal = value.proposal;
  if (!isNonEmptyString(proposal.id, 256) || !isNonEmptyString(proposal.runId, 256) ||
      !isNonEmptyString(proposal.baseCommitSha, 256) || !isDateString(proposal.createdAt) ||
      !Array.isArray(proposal.files)) throw invalidDto();
  return {
    proposal: {
      id: proposal.id,
      runId: proposal.runId,
      baseCommitSha: proposal.baseCommitSha,
      createdAt: proposal.createdAt,
      files: proposal.files.map((file): ChangeProposal['files'][number] => {
        if (!isRecord(file) || !isNonEmptyString(file.path, 4096) ||
            !['added', 'modified', 'deleted'].includes(String(file.status)) ||
            typeof file.unifiedDiff !== 'string' ||
            (file.additions !== undefined && (!Number.isSafeInteger(file.additions) || Number(file.additions) < 0)) ||
            (file.deletions !== undefined && (!Number.isSafeInteger(file.deletions) || Number(file.deletions) < 0))) {
          throw invalidDto();
        }
        return {
          path: sanitizeUntrustedText(file.path),
          status: file.status as ChangeProposal['files'][number]['status'],
          unifiedDiff: sanitizeUntrustedText(file.unifiedDiff),
          ...(typeof file.additions === 'number' ? { additions: file.additions } : {}),
          ...(typeof file.deletions === 'number' ? { deletions: file.deletions } : {}),
        };
      }),
    },
  };
}

const PRODUCT_TARGETS = ['chat', 'agent'] as const;

function projectSkillDefinition(value: unknown): SkillDefinition {
  if (!isRecord(value) || !isNonEmptyString(value.id, 256) ||
      (value.ownerId !== null && !isNonEmptyString(value.ownerId, 256)) ||
      !isNonEmptyString(value.slug, 128) || !isNonEmptyString(value.title, 256) ||
      typeof value.description !== 'string' || !['built_in', 'private'].includes(String(value.visibility)) ||
      !Array.isArray(value.supportedProducts) ||
      value.supportedProducts.some(product => !PRODUCT_TARGETS.includes(product as typeof PRODUCT_TARGETS[number])) ||
      !isDateString(value.createdAt) ||
      (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1))) {
    throw invalidDto();
  }
  return {
    id: value.id,
    ownerId: value.ownerId,
    slug: sanitizeUntrustedText(value.slug),
    title: sanitizeUntrustedText(value.title),
    description: sanitizeUntrustedText(value.description),
    visibility: value.visibility as SkillDefinition['visibility'],
    supportedProducts: [...value.supportedProducts] as SkillDefinition['supportedProducts'],
    ...(typeof value.revision === 'number' ? { revision: value.revision } : {}),
    createdAt: value.createdAt,
  };
}

function projectSkillListItem(value: unknown): SkillListItem {
  if (!isRecord(value) || typeof value.installed !== 'boolean' || typeof value.enabled !== 'boolean' ||
      (value.selectedVersionId !== null && !isNonEmptyString(value.selectedVersionId, 256))) throw invalidDto();
  const definition = projectSkillDefinition(value);
  return {
    ...definition,
    installed: value.installed,
    enabled: value.enabled,
    selectedVersionId: value.selectedVersionId,
  };
}

function projectSkillVersion(value: unknown): SkillVersion {
  if (!isRecord(value) || !isNonEmptyString(value.id, 256) || !isNonEmptyString(value.skillId, 256) ||
      !Number.isSafeInteger(value.versionNumber) || Number(value.versionNumber) < 1 ||
      !isNonEmptyString(value.contentHash, 256) || typeof value.instructions !== 'string' || !isDateString(value.createdAt)) {
    throw invalidDto();
  }
  return {
    id: value.id,
    skillId: value.skillId,
    versionNumber: Number(value.versionNumber),
    contentHash: value.contentHash,
    instructions: sanitizeUntrustedText(value.instructions),
    createdAt: value.createdAt,
  };
}

function projectSkillInstallation(value: unknown): SkillInstallation {
  if (!isRecord(value) || !isNonEmptyString(value.id, 256) || !isNonEmptyString(value.userId, 256) ||
      !isNonEmptyString(value.skillId, 256) || !isNonEmptyString(value.selectedVersionId, 256) ||
      typeof value.enabled !== 'boolean' || !isDateString(value.installedAt)) throw invalidDto();
  return {
    id: value.id,
    userId: value.userId,
    skillId: value.skillId,
    selectedVersionId: value.selectedVersionId,
    enabled: value.enabled,
    installedAt: value.installedAt,
  };
}

function projectSkillListEnvelope(value: unknown): { items: SkillListItem[]; nextCursor: string | null } {
  if (!isRecord(value) || !Array.isArray(value.items) ||
      (value.nextCursor !== null && typeof value.nextCursor !== 'string')) throw invalidDto();
  return { items: value.items.map(projectSkillListItem), nextCursor: value.nextCursor };
}

function projectSkillEnvelope(value: unknown): { skill: SkillDefinition } {
  if (!isRecord(value)) throw invalidDto();
  return { skill: projectSkillDefinition(value.skill) };
}

function projectSkillDetailEnvelope(value: unknown): { skill: SkillDefinition & { versions?: SkillVersion[]; installation?: SkillInstallation } } {
  if (!isRecord(value) || !isRecord(value.skill)) throw invalidDto();
  const skill = value.skill;
  const definition = projectSkillDefinition(skill);
  if ((skill.versions !== undefined && !Array.isArray(skill.versions)) ||
      (skill.installation !== undefined && skill.installation !== null && !isRecord(skill.installation))) throw invalidDto();
  return {
    skill: {
      ...definition,
      ...(Array.isArray(skill.versions) ? { versions: skill.versions.map(projectSkillVersion) } : {}),
      ...(isRecord(skill.installation) ? { installation: projectSkillInstallation(skill.installation) } : {}),
    },
  };
}

function projectSkillVersionEnvelope(value: unknown): { version: SkillVersion } {
  if (!isRecord(value)) throw invalidDto();
  return { version: projectSkillVersion(value.version) };
}

function projectSkillInstallationEnvelope(value: unknown): { installation: SkillInstallation } {
  if (!isRecord(value)) throw invalidDto();
  return { installation: projectSkillInstallation(value.installation) };
}

function projectPreferencesEnvelope(value: unknown): { preferences: UserPreferences } {
  if (!isRecord(value) || !isRecord(value.preferences)) throw invalidDto();
  const preferences = value.preferences;
  if (!Number.isSafeInteger(preferences.revision) || Number(preferences.revision) < 0 ||
      !['concise', 'balanced', 'detailed'].includes(String(preferences.responseLength)) ||
      !['professional', 'casual', 'technical'].includes(String(preferences.responseStyle)) ||
      typeof preferences.customInstructions !== 'string' ||
      (preferences.preferredLanguage !== undefined && preferences.preferredLanguage !== null && typeof preferences.preferredLanguage !== 'string')) {
    throw invalidDto();
  }
  return {
    preferences: {
      revision: Number(preferences.revision),
      ...(preferences.preferredLanguage !== undefined ? { preferredLanguage: preferences.preferredLanguage as string | null } : {}),
      responseLength: preferences.responseLength as UserPreferences['responseLength'],
      responseStyle: preferences.responseStyle as UserPreferences['responseStyle'],
      customInstructions: sanitizeUntrustedText(preferences.customInstructions),
    },
  };
}

function projectChatCredentialPreference(value: unknown): ChatCredentialPreference {
  if (!isRecord(value) || !['platform', 'byok'].includes(String(value.mode)) ||
      (value.credentialId !== null && !isNonEmptyString(value.credentialId, 256))) throw invalidDto();
  return { mode: value.mode as ChatCredentialPreference['mode'], credentialId: value.credentialId };
}

function projectProviderCredential(value: unknown): ProviderCredential {
  if (!isRecord(value)) throw new ApiException(502, 'INVALID_CREDENTIAL_RESPONSE', 'Credential response was invalid');
  const validDate = (date: unknown): date is string => typeof date === 'string' && !Number.isNaN(Date.parse(date));
  if (
    typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 256 ||
    value.provider !== 'gemini' ||
    typeof value.displayHint !== 'string' || !/^[•*]{4}[A-Za-z0-9]{4}$/.test(value.displayHint) ||
    !['unverified', 'valid', 'invalid'].includes(String(value.status)) ||
    !validDate(value.createdAt) || !validDate(value.updatedAt) ||
    (value.lastValidatedAt !== null && !validDate(value.lastValidatedAt))
  ) {
    throw new ApiException(502, 'INVALID_CREDENTIAL_RESPONSE', 'Credential response was invalid');
  }
  return {
    id: value.id,
    provider: 'gemini',
    displayHint: value.displayHint,
    status: value.status as ProviderCredential['status'],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastValidatedAt: value.lastValidatedAt,
  };
}

function projectCredentialEnvelope(value: unknown, key: 'credential'): { credential: ProviderCredential };
function projectCredentialEnvelope(value: unknown, key: 'items'): { items: ProviderCredential[] };
function projectCredentialEnvelope(value: unknown, key: 'credential' | 'items'): { credential: ProviderCredential } | { items: ProviderCredential[] } {
  if (!isRecord(value)) throw new ApiException(502, 'INVALID_CREDENTIAL_RESPONSE', 'Credential response was invalid');
  if (key === 'items') {
    if (!Array.isArray(value.items)) throw new ApiException(502, 'INVALID_CREDENTIAL_RESPONSE', 'Credential response was invalid');
    return { items: value.items.map(projectProviderCredential) };
  }
  return { credential: projectProviderCredential(value.credential) };
}

export class ApiException extends Error {
  public readonly details?: Record<string, unknown>;
  public readonly code: string;
  constructor(
    public readonly status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    knownSecrets: readonly string[] = []
  ) {
    super(sanitizeUntrustedText(message, knownSecrets));
    this.code = sanitizeUntrustedText(code, knownSecrets).slice(0, 80);
    const sanitizedDetails = details ? sanitizeUntrustedValue(details, knownSecrets) : undefined;
    this.details = isRecord(sanitizedDetails) ? sanitizedDetails : undefined;
    this.name = 'ApiException';
  }

  get generation(): ChatGeneration | undefined {
    if (!this.details || this.details.generation === undefined) return undefined;
    try {
      return projectChatGeneration(this.details.generation);
    } catch {
      return undefined;
    }
  }
}

export class RealApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
  }

  private async request(path: string, options: RequestInit = {}): Promise<unknown> {
    const requestEpoch = sessionGeneration;
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(options.headers);

    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'include', // Ensure session cookie is sent and received
    });
    const invalidatedGeneration = notifyUnauthorized(requestEpoch, path, response.status);

    // Check before consuming an untrusted response body and again after its
    // asynchronous read so stale protected data can never reach a caller.
    assertResponseGeneration(requestEpoch, path, invalidatedGeneration);

    if (response.status === 204) {
      return null;
    }

    const contentType = response.headers.get('content-type') ?? '';
    let data: unknown;

    if (contentType.includes('application/json')) {
      try {
        data = await response.json();
      } catch {
        assertResponseGeneration(requestEpoch, path, invalidatedGeneration);
        throw new ApiException(response.status, 'PARSE_ERROR', 'Failed to parse JSON response');
      }
    } else {
      data = await response.text();
    }

    assertResponseGeneration(requestEpoch, path, invalidatedGeneration);

    if (!response.ok) {
      const error = readApiError(data, response.status, response.statusText || 'Request failed');
      throw new ApiException(response.status, error.code, error.message, error.details, extractSensitiveRequestValues(options.body));
    }

    return data;
  }

  // Auth Operations
  async login(email: string, password: string): Promise<{ user: User }> {
    const generation = advanceSessionGeneration();
    const result = projectUserEnvelope(await this.request('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }));
    if (!isCurrentSessionGeneration(generation)) {
      throw new ApiException(401, 'SESSION_EXPIRED', 'Session changed during sign in; please try again');
    }
    return result;
  }

  async logout(): Promise<void> {
    advanceSessionGeneration();
    await this.request('/api/v1/auth/logout', {
      method: 'POST',
    });
  }

  async getMe(): Promise<{ user: User }> {
    return projectUserEnvelope(await this.request('/api/v1/auth/me', {
      method: 'GET',
    }));
  }

  async register(email: string, password: string, displayName: string): Promise<{ user: User }> {
    return projectUserEnvelope(await this.request('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    }));
  }

  // Conversation & Chat Operations
  async listConversations(): Promise<{ items: Conversation[]; nextCursor: string | null }> {
    const response = await this.request('/api/v1/conversations', {
      method: 'GET',
    });
    return projectConversationList(response);
  }

  async getConversation(id: string): Promise<{ conversation: Conversation; messages: Message[] }> {
    const response = await this.request(`/api/v1/conversations/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
    if (!isRecord(response) || !Array.isArray(response.messages)) throw invalidDto();
    return { conversation: projectConversation(response.conversation), messages: response.messages.map(projectMessage) };
  }

  async createConversation(title?: string): Promise<{ conversation: Conversation }> {
    return projectConversationEnvelope(await this.request('/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }));
  }

  async deleteConversation(id: string): Promise<void> {
    await this.request(`/api/v1/conversations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  // Model Capabilities Discovery (Task 17T-41 / 17T-42)
  async listModels(): Promise<ModelsResponse> {
    return projectModelsResponse(await this.request('/api/v1/models', {
      method: 'GET',
    }));
  }

  // Streaming Chat & Generation Operations
  async streamMessage(
    conversationId: string,
    content: string,
    onEvent: (event: ChatStreamEvent) => void,
    options?: {
      signal?: AbortSignal;
      idempotencyKey?: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort;
    }
  ): Promise<void> {
    const requestEpoch = sessionGeneration;
    const url = `${this.baseUrl}/api/v1/conversations/${encodeURIComponent(conversationId)}/messages:stream`;
    const headers = new Headers();
    headers.set('Content-Type', 'application/json');

    const key =
      options?.idempotencyKey ||
      (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `chat_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);
    headers.set('Idempotency-Key', key);

    const body: {
      content: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort;
    } = { content };
    if (options?.modelId) {
      body.modelId = options.modelId;
    }
    if (options?.reasoningEffort) {
      body.reasoningEffort = options.reasoningEffort;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials: 'include',
      signal: options?.signal,
    });
    const invalidatedGeneration = notifyUnauthorized(requestEpoch, url, response.status);
    assertResponseGeneration(requestEpoch, url, invalidatedGeneration);

    if (!response.ok) {
      let errPayload: unknown;
      try {
        errPayload = await response.json();
      } catch {
        // Fallback for non-JSON error
      }
      const error = readApiError(errPayload, response.status, response.statusText || 'Chat stream request failed');
      throw new ApiException(
        response.status,
        error.code,
        error.message,
        error.details,
        extractSensitiveRequestValues(JSON.stringify(body))
      );
    }

    assertResponseGeneration(requestEpoch, url, invalidatedGeneration);

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      throw new ApiException(
        response.status,
        'INVALID_CONTENT_TYPE',
        `Expected 'text/event-stream' response but received '${contentType}'`
      );
    }

    if (!response.body) {
      throw new ApiException(500, 'NO_STREAM_BODY', 'Response stream body is empty');
    }

    const reader = response.body.getReader();
    const parser = new SseStreamParser(
      (sseEvent) => {
        const validated = validateChatStreamEvent(sseEvent.event, sseEvent.data);
        if (validated) {
          onEvent(validated);
        }
      },
      { enforceTerminalIdempotency: true }
    );

    try {
      while (true) {
        if (options?.signal?.aborted) {
          try {
            await reader.cancel();
          } catch {
            // Ignore cancel error on abort
          }
          break;
        }

        const { done, value } = await reader.read();
        assertSessionEpoch(requestEpoch, url);
        if (done) {
          parser.flush();
          break;
        }
        if (value) {
          parser.feedBytes(value);
        }
      }
    } catch (error: unknown) {
      try {
        await reader.cancel();
      } catch {
        // Ignore stream cleanup errors; preserve the parser/request failure.
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  // Streaming Generation Variant (Retry / Regenerate)
  async streamVariant(
    conversationId: string,
    userMessageId: string,
    action: 'retry' | 'regenerate',
    onEvent: (event: ChatStreamEvent) => void,
    options?: {
      signal?: AbortSignal;
      idempotencyKey?: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort;
    }
  ): Promise<void> {
    const requestEpoch = sessionGeneration;
    const url = `${this.baseUrl}/api/v1/conversations/${encodeURIComponent(conversationId)}/generations:stream`;
    const headers = new Headers();
    headers.set('Content-Type', 'application/json');

    const key =
      options?.idempotencyKey ||
      (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `variant_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);
    headers.set('Idempotency-Key', key);

    const body: {
      userMessageId: string;
      action: 'retry' | 'regenerate';
      modelId?: string;
      reasoningEffort?: ReasoningEffort;
    } = { userMessageId, action };
    if (options?.modelId) {
      body.modelId = options.modelId;
    }
    if (options?.reasoningEffort) {
      body.reasoningEffort = options.reasoningEffort;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials: 'include',
      signal: options?.signal,
    });
    const invalidatedGeneration = notifyUnauthorized(requestEpoch, url, response.status);
    assertResponseGeneration(requestEpoch, url, invalidatedGeneration);

    if (!response.ok) {
      let errPayload: unknown;
      try {
        errPayload = await response.json();
      } catch {
        // Fallback for non-JSON error
      }
      const error = readApiError(errPayload, response.status, response.statusText || 'Variant stream request failed');
      throw new ApiException(
        response.status,
        error.code,
        error.message,
        error.details,
        extractSensitiveRequestValues(JSON.stringify(body))
      );
    }

    assertResponseGeneration(requestEpoch, url, invalidatedGeneration);

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      throw new ApiException(
        response.status,
        'INVALID_CONTENT_TYPE',
        `Expected 'text/event-stream' response but received '${contentType}'`
      );
    }

    if (!response.body) {
      throw new ApiException(500, 'NO_STREAM_BODY', 'Response stream body is empty');
    }

    const reader = response.body.getReader();
    const parser = new SseStreamParser(
      (sseEvent) => {
        const validated = validateChatStreamEvent(sseEvent.event, sseEvent.data);
        if (validated) {
          onEvent(validated);
        }
      },
      { enforceTerminalIdempotency: true }
    );

    try {
      while (true) {
        if (options?.signal?.aborted) {
          try {
            await reader.cancel();
          } catch {
            // Ignore cancel error on abort
          }
          break;
        }

        const { done, value } = await reader.read();
        assertSessionEpoch(requestEpoch, url);
        if (done) {
          parser.flush();
          break;
        }
        if (value) {
          parser.feedBytes(value);
        }
      }
    } catch (error: unknown) {
      try {
        await reader.cancel();
      } catch {
        // Ignore stream cleanup errors; preserve the parser/request failure.
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async getGeneration(
    conversationId: string,
    generationId: string
  ): Promise<{ generation: ChatGeneration }> {
    return projectGenerationEnvelope(await this.request(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/generations/${encodeURIComponent(generationId)}`,
      { method: 'GET' }
    ));
  }

  async cancelGeneration(
    conversationId: string,
    generationId: string,
    idempotencyKey?: string
  ): Promise<{ generation: ChatGeneration }> {
    const headers = new Headers();
    const key =
      idempotencyKey ||
      (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `cancel_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);
    headers.set('Idempotency-Key', key);

    return projectGenerationEnvelope(await this.request(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/generations/${encodeURIComponent(generationId)}/cancel`,
      {
        method: 'POST',
        headers,
      }
    ));
  }

  async getTurnVariants(conversationId: string, userMessageId: string): Promise<ChatTurnVariants> {
    return projectChatTurnVariants(await this.request(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(userMessageId)}/generations`
    ));
  }

  // Agent Operations
  async getAgentCapabilities(): Promise<AgentCapabilities> {
    return readAgentCapabilities(await this.request('/api/v1/agent/capabilities'));
  }

  async createAgentWorkspace(input: CreateAgentWorkspace): Promise<{ workspace: AgentWorkspace }> {
    return projectAgentWorkspaceEnvelope(await this.request('/api/v1/agent/workspaces', {
      method: 'POST',
      body: JSON.stringify(input),
    }));
  }

  async listAgentWorkspaces(options?: { limit?: number; cursor?: string }): Promise<Page<AgentWorkspace>> {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.cursor !== undefined) params.set('cursor', options.cursor);
    const query = params.toString();
    return projectAgentPage(await this.request(`/api/v1/agent/workspaces${query ? `?${query}` : ''}`), projectAgentWorkspace);
  }

  async getAgentWorkspace(id: string): Promise<{ workspace: AgentWorkspace }> {
    return projectAgentWorkspaceEnvelope(await this.request(`/api/v1/agent/workspaces/${encodeURIComponent(id)}`));
  }

  async createAgentRun(
    input: CreateAgentRun,
    options?: { idempotencyKey?: string }
  ): Promise<{ run: AgentRun }> {
    const key = options?.idempotencyKey ?? generateAgentIdempotencyKey();
    const headers = new Headers();
    headers.set('Idempotency-Key', key);
    const requestOptions: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    };
    try {
      return projectAgentRunEnvelope(await this.request('/api/v1/agent/runs', requestOptions));
    } catch (error) {
      if (!isUncertainAdmissionFailure(error)) throw error;

      // Admission can commit before a transport/5xx failure reaches the browser.
      // Replay the exact request with the same key: the backend returns the
      // durable run for an exact duplicate, or creates it if the first request
      // never committed. Never guess from a task/workspace tuple in run history.
      let replay: { run: AgentRun };
      try {
        replay = projectAgentRunEnvelope(await this.request('/api/v1/agent/runs', requestOptions));
      } catch (reconciliationError) {
        // A definite response (especially session expiry or a key conflict) is
        // more actionable than the original uncertain transport/5xx failure.
        if (reconciliationError instanceof ApiException && reconciliationError.status < 500) throw reconciliationError;
        throw error;
      }

      const authoritative = await this.getAgentRun(replay.run.id);
      const expectedMode = input.mode ?? 'ask';
      if (authoritative.run.id !== replay.run.id || authoritative.run.workspaceId !== input.workspaceId ||
          authoritative.run.task !== input.task.trim() || authoritative.run.mode !== expectedMode ||
          authoritative.run.runtime !== (input.runtime ?? 'cloud') ||
          authoritative.run.modelId !== (input.modelId ?? 'giga-agent-default')) {
        throw invalidDto();
      }
      return authoritative;
    }
  }

  async listAgentRuns(options?: { limit?: number; cursor?: string; workspaceId?: string }): Promise<Page<AgentRun>> {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.cursor !== undefined) params.set('cursor', options.cursor);
    if (options?.workspaceId !== undefined) params.set('workspaceId', options.workspaceId);
    const query = params.toString();
    return projectAgentPage(await this.request(`/api/v1/agent/runs${query ? `?${query}` : ''}`), projectAgentRun);
  }

  async getAgentRun(id: string): Promise<{ run: AgentRun }> {
    return projectAgentRunEnvelope(await this.request(`/api/v1/agent/runs/${encodeURIComponent(id)}`, {
      method: 'GET',
    }));
  }

  async getRun(id: string): Promise<{ run: AgentRun }> {
    return this.getAgentRun(id);
  }

  async getProposal(runId: string): Promise<{ proposal: ChangeProposal }> {
    return projectChangeProposalEnvelope(await this.request(`/api/v1/agent/runs/${encodeURIComponent(runId)}/proposal`, {
      method: 'GET',
    }));
  }

  async submitDecision(runId: string, proposalId: string, decision: 'approve' | 'reject'): Promise<{ run: AgentRun }> {
    return projectAgentRunEnvelope(await this.request(`/api/v1/agent/runs/${encodeURIComponent(runId)}/decision`, {
      method: 'POST',
      body: JSON.stringify({ proposalId, decision }),
    }));
  }

  async cancelAgentRun(runId: string): Promise<{ run: AgentRun }> {
    return projectAgentRunEnvelope(await this.request(`/api/v1/agent/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    }));
  }

  // ==========================================
  // Skills & Personalization Operations (17T-29 / 17T-30)
  // ==========================================

  // User Preferences
  async getPreferences(): Promise<{ preferences: UserPreferences }> {
    return projectPreferencesEnvelope(await this.request('/api/v1/me/preferences', {
      method: 'GET',
    }));
  }

  async updatePreferences(dto: UpdatePreferencesDto): Promise<{ preferences: UserPreferences }> {
    return projectPreferencesEnvelope(await this.request('/api/v1/me/preferences', {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }));
  }

  // Skills Catalog & Management
  async listSkills(options?: {
    scope?: 'installed' | 'builtIn';
    limit?: number;
    cursor?: string;
  }): Promise<{ items: SkillListItem[]; nextCursor: string | null }> {
    const params = new URLSearchParams();
    if (options?.scope) params.set('scope', options.scope);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.cursor) params.set('cursor', options.cursor);
    const qs = params.toString() ? `?${params.toString()}` : '';

    return projectSkillListEnvelope(await this.request(`/api/v1/skills${qs}`, {
      method: 'GET',
    }));
  }

  async createSkill(dto: CreateSkillDto): Promise<{ skill: SkillDefinition }> {
    return projectSkillEnvelope(await this.request('/api/v1/skills', {
      method: 'POST',
      body: JSON.stringify(dto),
    }));
  }

  async getSkill(
    id: string
  ): Promise<{ skill: SkillDefinition & { versions?: SkillVersion[]; installation?: SkillInstallation } }> {
    return projectSkillDetailEnvelope(await this.request(
      `/api/v1/skills/${encodeURIComponent(id)}`,
      {
        method: 'GET',
      }
    ));
  }

  async updateSkill(id: string, dto: UpdateSkillDto): Promise<{ skill: SkillDefinition }> {
    return projectSkillEnvelope(await this.request(`/api/v1/skills/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }));
  }

  async deleteSkill(id: string): Promise<void> {
    await this.request(`/api/v1/skills/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async publishSkillVersion(id: string, dto: CreateVersionDto): Promise<{ version: SkillVersion }> {
    return projectSkillVersionEnvelope(await this.request(`/api/v1/skills/${encodeURIComponent(id)}/versions`, {
      method: 'POST',
      body: JSON.stringify(dto),
    }));
  }

  async installSkill(id: string, dto?: InstallSkillDto): Promise<{ installation: SkillInstallation }> {
    return projectSkillInstallationEnvelope(await this.request(`/api/v1/skills/${encodeURIComponent(id)}/install`, {
      method: 'POST',
      body: JSON.stringify(dto || {}),
    }));
  }

  async updateInstallation(id: string, dto: UpdateInstallationDto): Promise<{ installation: SkillInstallation }> {
    return projectSkillInstallationEnvelope(await this.request(`/api/v1/skills/${encodeURIComponent(id)}/installation`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }));
  }

  // ==========================================
  // Provider Credentials & BYOK (Task 17T-37 / 17T-39)
  // ==========================================

  async getProviderCredentials(): Promise<{ items: ProviderCredential[] }> {
    const response = await this.request('/api/v1/me/provider-credentials', {
      method: 'GET',
    });
    return projectCredentialEnvelope(response, 'items');
  }

  async saveProviderCredential(dto: SaveCredentialDto): Promise<{ credential: ProviderCredential }> {
    const response = await this.request('/api/v1/me/provider-credentials', {
      method: 'POST',
      body: JSON.stringify(dto),
    });
    return projectCredentialEnvelope(response, 'credential');
  }

  async deleteProviderCredential(id: string): Promise<void> {
    await this.request(`/api/v1/me/provider-credentials/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async validateProviderCredential(id: string): Promise<{ credential: ProviderCredential }> {
    const response = await this.request(
      `/api/v1/me/provider-credentials/${encodeURIComponent(id)}/validate`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      }
    );
    return projectCredentialEnvelope(response, 'credential');
  }

  async getChatCredentialPreference(): Promise<ChatCredentialPreference> {
    return projectChatCredentialPreference(await this.request('/api/v1/me/chat-credential-preference', {
      method: 'GET',
    }));
  }

  async setChatCredentialPreference(dto: SetCredentialPreferenceDto): Promise<ChatCredentialPreference> {
    return projectChatCredentialPreference(await this.request('/api/v1/me/chat-credential-preference', {
      method: 'PUT',
      body: JSON.stringify(dto),
    }));
  }
}

export const realApiClient = new RealApiClient();
