import type {
  User,
  ApiError,
  Conversation,
  Message,
  AgentRun,
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
  ModelsResponse,
  ProviderCredential,
  ChatCredentialPreference,
  SaveCredentialDto,
  SetCredentialPreferenceDto,
} from './types.js';
import { SseStreamParser, validateChatStreamEvent } from './sse-parser.js';
import { readAgentCapabilities, type AgentCapabilities } from './agent-contract.js';
import { extractSensitiveRequestValues, sanitizeUntrustedText, sanitizeUntrustedValue } from '../security/untrusted-content.js';

export const SESSION_EXPIRED_EVENT = 'giga:session-expired';

function notifyUnauthorized(path: string, status: number): void {
  if (status !== 401 || /\/auth\/(?:login|register)(?:\?|$)/.test(path) || typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
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
    this.details = details ? sanitizeUntrustedValue(details, knownSecrets) as Record<string, unknown> : undefined;
    this.name = 'ApiException';
  }
}

export class RealApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
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
    notifyUnauthorized(path, response.status);

    if (response.status === 204) {
      return null as T;
    }

    const contentType = response.headers.get('content-type') ?? '';
    let data: unknown;

    if (contentType.includes('application/json')) {
      try {
        data = await response.json();
      } catch {
        throw new ApiException(response.status, 'PARSE_ERROR', 'Failed to parse JSON response');
      }
    } else {
      data = await response.text();
    }

    if (!response.ok) {
      const errPayload = isRecord(data) ? data as { error?: ApiError } : undefined;
      const code = safeApiErrorCode(errPayload?.error?.code, response.status);
      const message = safeApiErrorMessage(errPayload?.error?.message, response.statusText || 'Request failed');
      const details = projectGenerationErrorDetails(errPayload?.error?.details);
      throw new ApiException(response.status, code, message, details, extractSensitiveRequestValues(options.body));
    }

    return data as T;
  }

  // Auth Operations
  async login(email: string, password: string): Promise<{ user: User }> {
    return this.request<{ user: User }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }

  async logout(): Promise<void> {
    await this.request<void>('/api/v1/auth/logout', {
      method: 'POST',
    });
  }

  async getMe(): Promise<{ user: User }> {
    return this.request<{ user: User }>('/api/v1/auth/me', {
      method: 'GET',
    });
  }

  async register(email: string, password: string, displayName: string): Promise<{ user: User }> {
    return this.request<{ user: User }>('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    });
  }

  // Conversation & Chat Operations
  async listConversations(): Promise<{ items: Conversation[]; nextCursor: string | null }> {
    const response = await this.request<unknown>('/api/v1/conversations', {
      method: 'GET',
    });
    return projectConversationList(response);
  }

  async getConversation(id: string): Promise<{ conversation: Conversation; messages: Message[] }> {
    const response = await this.request<unknown>(`/api/v1/conversations/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
    if (!isRecord(response) || !Array.isArray(response.messages)) throw invalidDto();
    return { conversation: projectConversation(response.conversation), messages: response.messages.map(projectMessage) };
  }

  async createConversation(title?: string): Promise<{ conversation: Conversation }> {
    return this.request<{ conversation: Conversation }>('/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
  }

  async deleteConversation(id: string): Promise<void> {
    await this.request<void>(`/api/v1/conversations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  // Model Capabilities Discovery (Task 17T-41 / 17T-42)
  async listModels(): Promise<ModelsResponse> {
    return this.request<ModelsResponse>('/api/v1/models', {
      method: 'GET',
    });
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
    notifyUnauthorized(url, response.status);

    if (!response.ok) {
      let errPayload: { error?: ApiError; generation?: ChatGeneration } | undefined;
      try {
        errPayload = await response.json();
      } catch {
        // Fallback for non-JSON error
      }
      const code = safeApiErrorCode(errPayload?.error?.code, response.status);
      const message = safeApiErrorMessage(errPayload?.error?.message, response.statusText || 'Chat stream request failed');
      throw new ApiException(
        response.status,
        code,
        message,
        projectGenerationErrorDetails(errPayload?.error?.details, errPayload?.generation),
        extractSensitiveRequestValues(JSON.stringify(body))
      );
    }

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
        if (done) {
          parser.flush();
          break;
        }
        if (value) {
          parser.feedBytes(value);
        }
      }
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
    notifyUnauthorized(url, response.status);

    if (!response.ok) {
      let errPayload: { error?: ApiError; generation?: ChatGeneration } | undefined;
      try {
        errPayload = await response.json();
      } catch {
        // Fallback for non-JSON error
      }
      const code = safeApiErrorCode(errPayload?.error?.code, response.status);
      const message = safeApiErrorMessage(errPayload?.error?.message, response.statusText || 'Variant stream request failed');
      throw new ApiException(
        response.status,
        code,
        message,
        projectGenerationErrorDetails(errPayload?.error?.details, errPayload?.generation),
        extractSensitiveRequestValues(JSON.stringify(body))
      );
    }

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
        if (done) {
          parser.flush();
          break;
        }
        if (value) {
          parser.feedBytes(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async getGeneration(
    conversationId: string,
    generationId: string
  ): Promise<{ generation: ChatGeneration }> {
    return projectGenerationEnvelope(await this.request<unknown>(
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

    return projectGenerationEnvelope(await this.request<unknown>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/generations/${encodeURIComponent(generationId)}/cancel`,
      {
        method: 'POST',
        headers,
      }
    ));
  }

  async getTurnVariants(conversationId: string, userMessageId: string): Promise<ChatTurnVariants> {
    return projectChatTurnVariants(await this.request<unknown>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(userMessageId)}/generations`
    ));
  }

  // Agent Operations
  async getAgentCapabilities(): Promise<AgentCapabilities> {
    return readAgentCapabilities(await this.request<unknown>('/api/v1/agent/capabilities'));
  }

  async createAgentRun(task: string, repository: string, baseRef?: string): Promise<{ run: AgentRun }> {
    return this.request<{ run: AgentRun }>('/api/v1/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ task, repository, baseRef }),
    });
  }

  async getAgentRun(id: string): Promise<{ run: AgentRun }> {
    return this.request<{ run: AgentRun }>(`/api/v1/agent/runs/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
  }

  async getRun(id: string): Promise<{ run: AgentRun }> {
    return this.getAgentRun(id);
  }

  async getProposal(runId: string): Promise<{ proposal: ChangeProposal }> {
    return this.request<{ proposal: ChangeProposal }>(`/api/v1/agent/runs/${encodeURIComponent(runId)}/proposal`, {
      method: 'GET',
    });
  }

  async submitDecision(runId: string, proposalId: string, decision: 'approve' | 'reject'): Promise<{ run: AgentRun }> {
    return this.request<{ run: AgentRun }>(`/api/v1/agent/runs/${encodeURIComponent(runId)}/decision`, {
      method: 'POST',
      body: JSON.stringify({ proposalId, decision }),
    });
  }

  async cancelAgentRun(runId: string): Promise<{ run: AgentRun }> {
    return this.request<{ run: AgentRun }>(`/api/v1/agent/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    });
  }

  // ==========================================
  // Skills & Personalization Operations (17T-29 / 17T-30)
  // ==========================================

  // User Preferences
  async getPreferences(): Promise<{ preferences: UserPreferences }> {
    return this.request<{ preferences: UserPreferences }>('/api/v1/me/preferences', {
      method: 'GET',
    });
  }

  async updatePreferences(dto: UpdatePreferencesDto): Promise<{ preferences: UserPreferences }> {
    return this.request<{ preferences: UserPreferences }>('/api/v1/me/preferences', {
      method: 'PATCH',
      body: JSON.stringify(dto),
    });
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

    return this.request<{ items: SkillListItem[]; nextCursor: string | null }>(`/api/v1/skills${qs}`, {
      method: 'GET',
    });
  }

  async createSkill(dto: CreateSkillDto): Promise<{ skill: SkillDefinition }> {
    return this.request<{ skill: SkillDefinition }>('/api/v1/skills', {
      method: 'POST',
      body: JSON.stringify(dto),
    });
  }

  async getSkill(
    id: string
  ): Promise<{ skill: SkillDefinition & { versions?: SkillVersion[]; installation?: SkillInstallation } }> {
    return this.request<{ skill: SkillDefinition & { versions?: SkillVersion[]; installation?: SkillInstallation } }>(
      `/api/v1/skills/${encodeURIComponent(id)}`,
      {
        method: 'GET',
      }
    );
  }

  async updateSkill(id: string, dto: UpdateSkillDto): Promise<{ skill: SkillDefinition }> {
    return this.request<{ skill: SkillDefinition }>(`/api/v1/skills/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    });
  }

  async deleteSkill(id: string): Promise<void> {
    await this.request<void>(`/api/v1/skills/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async publishSkillVersion(id: string, dto: CreateVersionDto): Promise<{ version: SkillVersion }> {
    return this.request<{ version: SkillVersion }>(`/api/v1/skills/${encodeURIComponent(id)}/versions`, {
      method: 'POST',
      body: JSON.stringify(dto),
    });
  }

  async installSkill(id: string, dto?: InstallSkillDto): Promise<{ installation: SkillInstallation }> {
    return this.request<{ installation: SkillInstallation }>(`/api/v1/skills/${encodeURIComponent(id)}/install`, {
      method: 'POST',
      body: JSON.stringify(dto || {}),
    });
  }

  async updateInstallation(id: string, dto: UpdateInstallationDto): Promise<{ installation: SkillInstallation }> {
    return this.request<{ installation: SkillInstallation }>(`/api/v1/skills/${encodeURIComponent(id)}/installation`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    });
  }

  // ==========================================
  // Provider Credentials & BYOK (Task 17T-37 / 17T-39)
  // ==========================================

  async getProviderCredentials(): Promise<{ items: ProviderCredential[] }> {
    const response = await this.request<unknown>('/api/v1/me/provider-credentials', {
      method: 'GET',
    });
    return projectCredentialEnvelope(response, 'items');
  }

  async saveProviderCredential(dto: SaveCredentialDto): Promise<{ credential: ProviderCredential }> {
    const response = await this.request<unknown>('/api/v1/me/provider-credentials', {
      method: 'POST',
      body: JSON.stringify(dto),
    });
    return projectCredentialEnvelope(response, 'credential');
  }

  async deleteProviderCredential(id: string): Promise<void> {
    await this.request<void>(`/api/v1/me/provider-credentials/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async validateProviderCredential(id: string): Promise<{ credential: ProviderCredential }> {
    const response = await this.request<unknown>(
      `/api/v1/me/provider-credentials/${encodeURIComponent(id)}/validate`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      }
    );
    return projectCredentialEnvelope(response, 'credential');
  }

  async getChatCredentialPreference(): Promise<ChatCredentialPreference> {
    return this.request<ChatCredentialPreference>('/api/v1/me/chat-credential-preference', {
      method: 'GET',
    });
  }

  async setChatCredentialPreference(dto: SetCredentialPreferenceDto): Promise<ChatCredentialPreference> {
    return this.request<ChatCredentialPreference>('/api/v1/me/chat-credential-preference', {
      method: 'PUT',
      body: JSON.stringify(dto),
    });
  }
}

export const realApiClient = new RealApiClient();
