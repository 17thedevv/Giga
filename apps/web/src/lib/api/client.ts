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
} from './types.js';
import { SseStreamParser, validateChatStreamEvent } from './sse-parser.js';

export class ApiException extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
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
      const errPayload = data as { error?: ApiError } | undefined;
      const code = errPayload?.error?.code ?? `HTTP_${response.status}`;
      const message = errPayload?.error?.message ?? response.statusText ?? 'Request failed';
      const details = errPayload?.error?.details;
      throw new ApiException(response.status, code, message, details);
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
    return this.request<{ items: Conversation[]; nextCursor: string | null }>('/api/v1/conversations', {
      method: 'GET',
    });
  }

  async getConversation(id: string): Promise<{ conversation: Conversation; messages: Message[] }> {
    return this.request<{ conversation: Conversation; messages: Message[] }>(`/api/v1/conversations/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
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

    if (!response.ok) {
      let errPayload: { error?: ApiError; generation?: ChatGeneration } | undefined;
      try {
        errPayload = await response.json();
      } catch {
        // Fallback for non-JSON error
      }
      const code = errPayload?.error?.code ?? `HTTP_${response.status}`;
      const message =
        errPayload?.error?.message ?? response.statusText ?? 'Chat stream request failed';
      throw new ApiException(
        response.status,
        code,
        message,
        errPayload?.error?.details ||
          (errPayload?.generation ? { generation: errPayload.generation } : undefined)
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

    if (!response.ok) {
      let errPayload: { error?: ApiError; generation?: ChatGeneration } | undefined;
      try {
        errPayload = await response.json();
      } catch {
        // Fallback for non-JSON error
      }
      const code = errPayload?.error?.code ?? `HTTP_${response.status}`;
      const message =
        errPayload?.error?.message ?? response.statusText ?? 'Variant stream request failed';
      throw new ApiException(
        response.status,
        code,
        message,
        errPayload?.error?.details ||
          (errPayload?.generation ? { generation: errPayload.generation } : undefined)
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
    return this.request<{ generation: ChatGeneration }>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/generations/${encodeURIComponent(generationId)}`,
      { method: 'GET' }
    );
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

    return this.request<{ generation: ChatGeneration }>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/generations/${encodeURIComponent(generationId)}/cancel`,
      {
        method: 'POST',
        headers,
      }
    );
  }

  async getTurnVariants(conversationId: string, userMessageId: string): Promise<ChatTurnVariants> {
    return this.request<ChatTurnVariants>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(userMessageId)}/generations`
    );
  }

  // Agent Operations
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
}

export const realApiClient = new RealApiClient();
