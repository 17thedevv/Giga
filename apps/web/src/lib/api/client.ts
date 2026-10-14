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
} from './types.js';

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
