import type {
  User,
  Conversation,
  Message,
  AgentRun,
  ChangeProposal,
  AgentRunStatus,
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
  ChatStreamEvent,
  ChatGeneration,
  ChatTurnVariants,
  ModelMetadata,
  ModelsResponse,
  ReasoningEffort,
  ProviderCredential,
  ChatCredentialPreference,
  SaveCredentialDto,
  SetCredentialPreferenceDto,
} from './types.js';
import { ApiException } from './client.js';
import { readAgentCapabilities, type AgentCapabilities } from './agent-contract.js';
import agentContractFixture from '../../../../../packages/contracts/fixtures/agent.json';

export const MOCK_AUTH_STORAGE_KEY = 'giga_mock_auth_active';

export const INITIAL_MODELS: ModelMetadata[] = [
  {
    id: 'giga-chat-default',
    capabilities: ['text', 'streaming'],
    reasoning: {
      supported: true,
      efforts: ['low', 'medium', 'high'],
    },
  },
  {
    id: 'giga-fast',
    capabilities: ['text', 'streaming'],
    reasoning: {
      supported: false,
      efforts: [],
    },
  },
  {
    id: 'giga-reasoning-preview',
    capabilities: ['text', 'streaming'],
    reasoning: {
      supported: true,
      efforts: ['low', 'medium'],
    },
  },
];

// Pre-loaded fixture data based on apps/web/mocks
export const MOCK_USER: User = {
  id: 'usr_9b1c7a82-4f32-4e58-9a67-8c3b7a5d1092',
  email: 'trangthu@demo.giga.dev',
  displayName: 'Tráng A Thư (Demo User)',
};

export const INITIAL_CONVERSATIONS: Conversation[] = [
  {
    id: 'conv_8f3a1d94-3201-44dc-98ef-c1192da0e521',
    title: 'Refactor Database Pool Connection in Hono',
    createdAt: '2026-10-13T03:15:00.000Z',
    updatedAt: '2026-10-13T03:42:10.000Z',
  },
  {
    id: 'conv_5c2b8e10-1122-48df-89aa-0987fe43dc12',
    title: 'Fix CORS & Cookie Configuration for Render API',
    createdAt: '2026-10-12T14:20:00.000Z',
    updatedAt: '2026-10-12T15:10:00.000Z',
  },
];

export const INITIAL_MESSAGES: Record<string, Message[]> = {
  'conv_8f3a1d94-3201-44dc-98ef-c1192da0e521': [
    {
      id: 'msg_901a1c32-11a2-48fb-b289-56d019f2a001',
      conversationId: 'conv_8f3a1d94-3201-44dc-98ef-c1192da0e521',
      role: 'user',
      content: 'How do we ensure Neon PostgreSQL connections don\'t leak during serverless cold starts in Hono?',
      createdAt: '2026-10-13T03:15:10.000Z',
    },
    {
      id: 'msg_901a1c32-11a2-48fb-b289-56d019f2a002',
      conversationId: 'conv_8f3a1d94-3201-44dc-98ef-c1192da0e521',
      role: 'assistant',
      content: 'In Hono with Neon serverless driver, you should use the `@neondatabase/serverless` connection pooler over WebSockets with explicit timeouts:\n\n```typescript\nimport { Pool } from \'@neondatabase/serverless\';\n\nexport const pool = new Pool({\n  connectionString: env.DATABASE_URL,\n  max: 10,\n  idleTimeoutMillis: 30000,\n});\n```\n\nThis prevents ephemeral instances from exhausting the server pool quota.',
      createdAt: '2026-10-13T03:15:25.000Z',
    },
  ],
};

export const INITIAL_RUNS: AgentRun[] = [
  {
    id: 'run_881a29f0-55b1-42e8-912a-33c8b1a9901e',
    status: 'awaiting_approval',
    task: 'Refactor Neon database client pool initialization in apps/api/src/db/client.ts to handle connection error events and set idleTimeoutMillis.',
    repository: '17thedevv/Giga',
    baseRef: 'main',
    createdAt: '2026-10-13T03:45:00.000Z',
    updatedAt: '2026-10-13T03:50:30.000Z',
  },
  {
    id: 'run_4f1a0293-1992-49aa-9b11-739c901a88b2',
    status: 'completed',
    task: 'Add strict authentication guard and session check endpoint /api/v1/auth/me to API routes.',
    repository: '17thedevv/Giga',
    baseRef: 'main',
    createdAt: '2026-10-12T16:10:00.000Z',
    updatedAt: '2026-10-12T16:18:22.000Z',
    result: {
      prUrl: 'https://github.com/17thedevv/Giga/pull/7',
      prNumber: 7,
      branch: 'agent/fix-auth-guard',
      commitSha: '7f918e2a',
    },
  },
];

export const MOCK_PROPOSAL: ChangeProposal = {
  id: 'prop_9a12c840-77a1-4322-98ab-4172a912ef01',
  runId: 'run_881a29f0-55b1-42e8-912a-33c8b1a9901e',
  baseCommitSha: '4aff64893b1c7a8291f089e1732a1019f2a912b0',
  files: [
    {
      path: 'apps/api/src/db/client.ts',
      status: 'modified',
      additions: 12,
      deletions: 6,
      unifiedDiff: `--- a/apps/api/src/db/client.ts
+++ b/apps/api/src/db/client.ts
@@ -10,12 +10,18 @@ export function createDbClient(databaseUrl: string) {
-  const pool = new Pool({ connectionString: databaseUrl });
+  const pool = new Pool({
+    connectionString: databaseUrl,
+    max: 10,
+    idleTimeoutMillis: 30000,
+    connectionTimeoutMillis: 5000,
+  });
+
+  pool.on('error', (err) => {
+    console.error('Unexpected idle client error on Neon pool', err);
+  });
   return drizzle(pool);
 }`,
    },
    {
      path: 'apps/api/tests/db.test.ts',
      status: 'added',
      additions: 12,
      deletions: 0,
      unifiedDiff: `--- /dev/null
+++ b/apps/api/tests/db.test.ts
@@ -0,0 +1,12 @@
+import { describe, it, expect } from 'vitest';
+import { createDbClient } from '../src/db/client';
+
+describe('createDbClient', () => {
+  it('should initialize pool with 30s idle timeout', () => {
+    const client = createDbClient();
+    expect(client).toBeDefined();
+  });
+});`,
    },
  ],
  createdAt: '2026-10-13T03:50:40.000Z',
 };

// ==========================================
// Skills & Personalization Initial Fixtures (17T-30)
// ==========================================

export const INITIAL_PREFERENCES: UserPreferences = {
  revision: 1,
  preferredLanguage: 'en',
  responseLength: 'balanced',
  responseStyle: 'technical',
  customInstructions: 'Focus on production-grade TypeScript strict patterns, explicit error handling, and minimal dependencies.',
};

export const INITIAL_SKILLS: SkillListItem[] = [
  {
    id: 'skl_11111111-1111-4111-8111-111111111111',
    ownerId: null,
    slug: 'giga-code-explainer',
    title: 'Explain Code & Architecture',
    description: 'Breaks down complex code, explains control flows, and details architecture decisions.',
    visibility: 'built_in',
    supportedProducts: ['chat', 'agent'],
    createdAt: '2026-10-10T08:00:00.000Z',
    installed: true,
    enabled: true,
    selectedVersionId: 'ver_11111111-1111-4111-8111-111111111111',
  },
  {
    id: 'skl_22222222-2222-4222-8222-222222222222',
    ownerId: null,
    slug: 'security-auditor',
    title: 'Security & Invariant Auditor',
    description: 'Audits endpoints and database queries for SQL injection, CSRF, and authorization leaks.',
    visibility: 'built_in',
    supportedProducts: ['chat', 'agent'],
    createdAt: '2026-10-11T09:00:00.000Z',
    installed: true,
    enabled: true,
    selectedVersionId: 'ver_22222222-2222-4222-8222-222222222222',
  },
  {
    id: 'skl_33333333-3333-4333-8333-333333333333',
    ownerId: null,
    slug: 'test-generator',
    title: 'Automated Test Generator',
    description: 'Synthesizes rigorous regression unit and integration tests using Vitest and testing-library.',
    visibility: 'built_in',
    supportedProducts: ['chat', 'agent'],
    createdAt: '2026-10-12T10:00:00.000Z',
    installed: false,
    enabled: false,
    selectedVersionId: null,
  },
  {
    id: 'skl_44444444-4444-4444-8444-444444444444',
    ownerId: 'usr_9b1c7a82-4f32-4e58-9a67-8c3b7a5d1092',
    slug: 'neon-hono-patterns',
    title: 'Neon & Hono Cloud Standards',
    description: 'Enforces Neon WebSocket pooling, Hono middleware lifecycle, and transaction rollback rules.',
    visibility: 'private',
    supportedProducts: ['chat', 'agent'],
    revision: 2,
    createdAt: '2026-10-13T12:00:00.000Z',
    installed: true,
    enabled: true,
    selectedVersionId: 'ver_44444444-4444-4444-8444-444444444442',
  },
];

export const INITIAL_SKILL_VERSIONS: Record<string, SkillVersion[]> = {
  'skl_11111111-1111-4111-8111-111111111111': [
    {
      id: 'ver_11111111-1111-4111-8111-111111111111',
      skillId: 'skl_11111111-1111-4111-8111-111111111111',
      versionNumber: 1,
      contentHash: 'hash-code-explainer-v1',
      instructions: '# Code Explainer\n\nWhen explaining code:\n1. Provide high-level context before line-by-line inspection.\n2. Highlight non-obvious design decisions.\n3. Mention performance implications and edge cases.',
      createdAt: '2026-10-10T08:00:00.000Z',
    },
  ],
  'skl_22222222-2222-4222-8222-222222222222': [
    {
      id: 'ver_22222222-2222-4222-8222-222222222222',
      skillId: 'skl_22222222-2222-4222-8222-222222222222',
      versionNumber: 1,
      contentHash: 'hash-security-auditor-v1',
      instructions: '# Security Auditor\n\nAlways verify:\n1. Input validation on boundaries.\n2. Authentication and authorization checks on all mutating routes.\n3. Safe SQL query parameterization.',
      createdAt: '2026-10-11T09:00:00.000Z',
    },
  ],
  'skl_33333333-3333-4333-8333-333333333333': [
    {
      id: 'ver_33333333-3333-4333-8333-333333333333',
      skillId: 'skl_33333333-3333-4333-8333-333333333333',
      versionNumber: 1,
      contentHash: 'hash-test-generator-v1',
      instructions: '# Test Generator\n\nGuidelines for tests:\n1. Use Vitest and React Testing Library.\n2. Write isolated unit tests and integration tests.\n3. Assert edge cases, error conditions, and concurrency.',
      createdAt: '2026-10-12T10:00:00.000Z',
    },
  ],
  'skl_44444444-4444-4444-8444-444444444444': [
    {
      id: 'ver_44444444-4444-4444-8444-444444444441',
      skillId: 'skl_44444444-4444-4444-8444-444444444444',
      versionNumber: 1,
      contentHash: 'hash-neon-hono-v1',
      instructions: '# Neon & Hono Standards v1\n\nInitial rules for database pooling in Hono.',
      createdAt: '2026-10-13T12:00:00.000Z',
    },
    {
      id: 'ver_44444444-4444-4444-8444-444444444442',
      skillId: 'skl_44444444-4444-4444-8444-444444444444',
      versionNumber: 2,
      contentHash: 'hash-neon-hono-v2',
      instructions: '# Neon & Hono Standards v2\n\n1. Always set idleTimeoutMillis: 30000 on Pool.\n2. Handle connection error events to prevent process crash.\n3. Execute database transactions with atomic rollback.',
      createdAt: '2026-10-13T14:30:00.000Z',
    },
  ],
};

/**
 * Mock Data Adapter implementing stateful in-memory demo operations.
 */
export class MockDataAdapter {
  private generations = new Map<string, ChatGeneration & { action: 'new_prompt' | 'retry' | 'regenerate' }>();
  private selections = new Map<string, string>();
  private currentUser: User | null = null;
  private conversations = [...INITIAL_CONVERSATIONS];
  private messages: Record<string, Message[]> = { ...INITIAL_MESSAGES };
  private runs = [...INITIAL_RUNS];
  private proposal = { ...MOCK_PROPOSAL };

  // Skills & Personalization State
  private preferences: UserPreferences = { ...INITIAL_PREFERENCES };
  private skills: SkillListItem[] = INITIAL_SKILLS.map((s) => ({ ...s }));
  private skillVersions: Record<string, SkillVersion[]> = JSON.parse(JSON.stringify(INITIAL_SKILL_VERSIONS));
  private models: ModelMetadata[] = [...INITIAL_MODELS];

  constructor(initialUser: User | null = null) {
    if (initialUser) {
      this.currentUser = initialUser;
    } else if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        if (window.sessionStorage.getItem(MOCK_AUTH_STORAGE_KEY) === 'true') {
          this.currentUser = { ...MOCK_USER };
        }
      } catch {
        // Ignore storage access errors in sandboxed environments
      }
    }
  }

  // Auth
  async login(email: string, password: string): Promise<{ user: User }> {
    await this.delay(300);
    if (!email || !password) {
      throw new Error('Email and password required');
    }
    if (email !== 'trangthu@demo.giga.dev' && !email.includes('@')) {
      throw new Error('Invalid email format');
    }
    const user: User = { ...MOCK_USER, email };
    this.currentUser = user;
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        window.sessionStorage.setItem(MOCK_AUTH_STORAGE_KEY, 'true');
      } catch {
        // Ignore storage errors
      }
    }
    return { user };
  }

  async logout(): Promise<void> {
    await this.delay(100);
    this.currentUser = null;
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        window.sessionStorage.removeItem(MOCK_AUTH_STORAGE_KEY);
      } catch {
        // Ignore storage errors
      }
    }
  }

  async getMe(): Promise<{ user: User }> {
    await this.delay(150);
    if (!this.currentUser) {
      if (typeof window !== 'undefined') {
        const hasDemoParam = typeof window.location !== 'undefined' && window.location.search?.includes('demo=1');
        const hasSession = window.sessionStorage?.getItem(MOCK_AUTH_STORAGE_KEY) === 'true';
        if (hasDemoParam || hasSession) {
          this.currentUser = { ...MOCK_USER };
          return { user: this.currentUser };
        }
      }
      throw new ApiException(401, 'UNAUTHORIZED', 'No active mock session. Please sign in.');
    }
    return { user: this.currentUser };
  }

  // Test helper to explicitly configure mock session
  setMockSession(user: User | null): void {
    this.currentUser = user;
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        if (user) {
          window.sessionStorage.setItem(MOCK_AUTH_STORAGE_KEY, 'true');
        } else {
          window.sessionStorage.removeItem(MOCK_AUTH_STORAGE_KEY);
        }
      } catch {
        // Ignore
      }
    }
  }

  // Reset skills and preferences for test isolation
  resetSkillsAndPreferences(): void {
    this.preferences = { ...INITIAL_PREFERENCES };
    this.skills = INITIAL_SKILLS.map((s) => ({ ...s }));
    this.skillVersions = JSON.parse(JSON.stringify(INITIAL_SKILL_VERSIONS));
  }

  // Provider Credentials & BYOK State (17T-39)
  private credentials: ProviderCredential[] = [];
  private credentialPreference: ChatCredentialPreference = { mode: 'platform', credentialId: null };
  public mockValidateBehavior: 'normal' | 'invalid' | 'rate_limit' | 'transient_error' = 'normal';

  // Reset credentials and BYOK preferences for test isolation
  resetCredentials(): void {
    this.credentials = [];
    this.credentialPreference = { mode: 'platform', credentialId: null };
    this.mockValidateBehavior = 'normal';
  }

  // Conversations
  async listConversations(): Promise<{ items: Conversation[]; nextCursor: string | null }> {
    await this.delay(150);
    return { items: [...this.conversations], nextCursor: null };
  }

  async getConversation(id: string): Promise<{ conversation: Conversation; messages: Message[] }> {
    await this.delay(150);
    const conv = this.conversations.find((c) => c.id === id);
    if (!conv) {
      throw new Error('Conversation not found');
    }
    return {
      conversation: conv,
      messages: (this.messages[id] || []).filter(message => {
        const generation = [...this.generations.values()].find(g => g.assistantMessageId === message.id);
        return !generation || this.selections.get(generation.userMessageId) === generation.id;
      }),
    };
  }

  async createConversation(title?: string): Promise<{ conversation: Conversation }> {
    await this.delay(200);
    const id = `conv_${Date.now()}`;
    const newConv: Conversation = {
      id,
      title: title?.trim() || 'New Discussion',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.conversations.unshift(newConv);
    this.messages[id] = [];
    return { conversation: newConv };
  }

  async deleteConversation(id: string): Promise<void> {
    await this.delay(150);
    this.conversations = this.conversations.filter((c) => c.id !== id);
    delete this.messages[id];
  }

  async addMessage(conversationId: string, role: 'user' | 'assistant', content: string): Promise<Message> {
    const msg: Message = {
      id: `msg_${crypto.randomUUID()}`,
      conversationId,
      role,
      content,
      createdAt: new Date().toISOString(),
    };
    if (!this.messages[conversationId]) {
      this.messages[conversationId] = [];
    }
    this.messages[conversationId].push(msg);
    return msg;
  }

  // Simulated Chat Streaming
  async simulateChatStream(
    _prompt: string,
    onChunk: (textDelta: string) => void,
    onComplete: () => void,
    signal?: AbortSignal
  ): Promise<void> {
    const fullAnswer =
      "This is a **[DEMO / MOCK]** response.\n\n" +
      "The Giga Coding Agent enforces a human-in-the-loop gate governed by Architecture Invariant `INV-07`.\n\n" +
      "1. Read-only tools analyze the codebase.\n" +
      "2. A stable unified diff proposal is synthesized.\n" +
      "3. Remote writes are strictly executed only after authenticated owner confirmation.";

    const chunks = fullAnswer.match(/.{1,12}/g) || [fullAnswer];

    for (const chunk of chunks) {
      if (signal?.aborted) {
        return;
      }
      await this.delay(80);
      onChunk(chunk);
    }

    onComplete();
  }

  // Model Capabilities Discovery
  async listModels(): Promise<ModelsResponse> {
    await this.delay(50);
    return { models: [...this.models] };
  }

  setModels(models: ModelMetadata[]): void {
    this.models = [...models];
  }

  async streamMessage(
    conversationId: string, content: string, onEvent: (event: ChatStreamEvent) => void,
    options?: { signal?: AbortSignal; idempotencyKey?: string; modelId?: string; reasoningEffort?: ReasoningEffort }
  ): Promise<void> {
    const user = await this.addMessage(conversationId, 'user', content);
    return this.runMockGeneration(conversationId, user.id, 'new_prompt', content, onEvent, options);
  }

  async streamVariant(
    conversationId: string, userMessageId: string, action: 'retry' | 'regenerate',
    onEvent: (event: ChatStreamEvent) => void,
    options?: { signal?: AbortSignal; idempotencyKey?: string; modelId?: string; reasoningEffort?: ReasoningEffort }
  ): Promise<void> {
    const user = (this.messages[conversationId] || []).filter(m => m.role === 'user').at(-1);
    if (!user || user.id !== userMessageId) throw new Error('Only the latest turn can be retried or regenerated');
    return this.runMockGeneration(conversationId, userMessageId, action, user.content, onEvent, options);
  }

  private async runMockGeneration(
    conversationId: string, userMessageId: string, action: 'new_prompt' | 'retry' | 'regenerate',
    content: string, onEvent: (event: ChatStreamEvent) => void,
    options?: { signal?: AbortSignal; modelId?: string; reasoningEffort?: ReasoningEffort }
  ): Promise<void> {
    const id = 'mock_' + crypto.randomUUID();
    let generation: ChatGeneration & { action: typeof action } = {
      id, conversationId, userMessageId, action, modelId: options?.modelId || 'giga-chat-default',
      reasoningEffort: options?.reasoningEffort, status: 'streaming', partialContent: '', createdAt: new Date().toISOString(),
    };
    this.generations.set(id, generation);
    onEvent({ event: 'message.started', data: { messageId: id, generationId: id, conversationId } });
    let complete = false;
    try {
      await this.simulateChatStream(content, text => {
        if (options?.signal?.aborted || this.generations.get(id)?.status === 'stopped') return;
        generation = { ...generation, partialContent: generation.partialContent + text };
        this.generations.set(id, generation);
        onEvent({ event: 'message.delta', data: { messageId: id, generationId: id, text } });
      }, () => { complete = true; }, options?.signal);
      if (this.generations.get(id)?.status === 'stopped') {
        generation = { ...generation, status: 'stopped', finishReason: 'cancelled', finishedAt: new Date().toISOString() };
        this.generations.set(id, generation);
        onEvent({ event: 'message.stopped', data: { messageId: id, generationId: id, finishReason: 'cancelled' } });
      } else if (options?.signal?.aborted) {
        generation = { ...generation, status: 'interrupted', finishReason: 'other', finishedAt: new Date().toISOString() };
        this.generations.set(id, generation);
        onEvent({ event: 'message.failed', data: { messageId: id, generationId: id, error: { code: 'INTERRUPTED', message: 'Stream interrupted' } } });
      } else if (complete) {
        const message: Message = { id, conversationId, role: 'assistant', content: generation.partialContent, createdAt: new Date().toISOString(), status: 'completed' };
        this.messages[conversationId].push(message);
        generation = { ...generation, status: 'completed', assistantMessageId: id, finishedAt: message.createdAt };
        this.generations.set(id, generation);
        this.selections.set(userMessageId, id);
        onEvent({ event: 'message.completed', data: { messageId: id, generationId: id, createdAt: message.createdAt } });
      } else {
        throw new Error('Mock stream interrupted');
      }
    } catch (err) {
      const error = { code: 'GENERATION_FAILED', message: err instanceof Error ? err.message : 'Mock generation failed' };
      this.generations.set(id, { ...generation, status: 'failed', error });
      onEvent({ event: 'stream.error', data: { messageId: id, generationId: id, error } });
      onEvent({ event: 'message.failed', data: { messageId: id, generationId: id, error } });
    }
  }

  async getTurnVariants(conversationId: string, userMessageId: string): Promise<ChatTurnVariants> {
    // Seed legacy demo answers so a successful regeneration selects only its new answer.
    if (![...this.generations.values()].some(g => g.userMessageId === userMessageId)) {
      const messages = this.messages[conversationId] || [];
      const userIndex = messages.findIndex(m => m.id === userMessageId && m.role === 'user');
      const answer = userIndex >= 0 ? messages[userIndex + 1] : undefined;
      if (answer?.role === 'assistant' && (!answer.status || answer.status === 'completed')) {
        const id = 'legacy_' + answer.id;
        this.generations.set(id, {
          id, conversationId, userMessageId, action: 'new_prompt', modelId: 'giga-chat-default',
          status: 'completed', assistantMessageId: answer.id, partialContent: answer.content, createdAt: answer.createdAt,
        });
        this.selections.set(userMessageId, id);
      }
    }
    return {
      userMessageId, selectedGenerationId: this.selections.get(userMessageId) || null,
      items: [...this.generations.values()].filter(g => g.conversationId === conversationId && g.userMessageId === userMessageId).map(g => ({
        id: g.id, action: g.action, modelId: g.modelId, status: g.status,
        assistantMessageId: g.assistantMessageId, content: g.status === 'completed' ? g.partialContent : undefined,
        createdAt: g.createdAt, finishedAt: g.finishedAt, reasoningEffort: g.reasoningEffort,
      })),
    };
  }

  async getGeneration(conversationId: string, generationId: string): Promise<{ generation: ChatGeneration }> {
    const generation = this.generations.get(generationId);
    if (!generation || generation.conversationId !== conversationId) throw new Error('Generation not found');
    return { generation };
  }

  async cancelGeneration(conversationId: string, generationId: string, _idempotencyKey?: string): Promise<{ generation: ChatGeneration }> {
    const { generation } = await this.getGeneration(conversationId, generationId);
    if (generation.status === 'streaming' || generation.status === 'pending') {
      const stopped = { ...generation, status: 'stopped' as const, finishReason: 'cancelled' as const, cancelRequestedAt: new Date().toISOString() };
      this.generations.set(generationId, { ...this.generations.get(generationId)!, ...stopped });
      return { generation: stopped };
    }
    return { generation };
  }

  // Agent Runs
  async getAgentCapabilities(): Promise<AgentCapabilities> {
    return readAgentCapabilities(agentContractFixture.capabilities);
  }

  async listRuns(): Promise<{ items: AgentRun[] }> {
    await this.delay(150);
    return { items: [...this.runs] };
  }

  async getRun(id: string): Promise<{ run: AgentRun }> {
    await this.delay(100);
    const run = this.runs.find((r) => r.id === id);
    if (!run) {
      throw new Error('Agent run not found');
    }
    return { run: { ...run } };
  }

  async createRun(task: string, repository: string, baseRef = 'main'): Promise<{ run: AgentRun }> {
    await this.delay(250);
    const id = `run_${Date.now()}`;
    const newRun: AgentRun = {
      id,
      status: 'queued',
      task,
      repository,
      baseRef,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.runs.unshift(newRun);
    return { run: newRun };
  }

  async updateRunStatus(id: string, status: AgentRunStatus, result?: AgentRun['result']): Promise<AgentRun> {
    const run = this.runs.find((r) => r.id === id);
    if (!run) {
      throw new Error('Run not found');
    }
    run.status = status;
    run.updatedAt = new Date().toISOString();
    if (result) {
      run.result = result;
    }
    return { ...run };
  }

  async getProposal(runId: string): Promise<{ proposal: ChangeProposal }> {
    await this.delay(150);
    return {
      proposal: {
        ...this.proposal,
        runId,
      },
    };
  }

  async submitDecision(runId: string, _proposalId: string, decision: 'approve' | 'reject'): Promise<{ run: AgentRun }> {
    await this.delay(200);
    const run = this.runs.find((r) => r.id === runId);
    if (!run) {
      throw new Error('Run not found');
    }

    if (decision === 'reject') {
      run.status = 'cancelled';
      return { run: { ...run } };
    }

    // Strict rule: first transition to applying!
    run.status = 'applying';
    return { run: { ...run } };
  }

  async finalizeApprovedRun(runId: string): Promise<AgentRun> {
    await this.delay(800);
    const run = this.runs.find((r) => r.id === runId);
    if (!run) {
      throw new Error('Run not found');
    }
    run.status = 'completed';
    run.result = {
      prUrl: 'https://demo.giga.dev/simulated-pr',
      prNumber: 9999,
      branch: `agent/simulated-branch-${runId.slice(-4)}`,
      commitSha: 'simulated-commit-sha',
    };
    return { ...run };
  }

  async cancelRun(runId: string): Promise<{ run: AgentRun }> {
    await this.delay(150);
    const run = this.runs.find((r) => r.id === runId);
    if (!run) {
      throw new Error('Run not found');
    }
    run.status = 'cancelled';
    return { run: { ...run } };
  }

  // ==========================================
  // Skills & Personalization Operations (17T-30)
  // ==========================================

  // User Preferences
  async getPreferences(): Promise<{ preferences: UserPreferences }> {
    await this.delay(120);
    return { preferences: { ...this.preferences } };
  }

  async updatePreferences(dto: UpdatePreferencesDto): Promise<{ preferences: UserPreferences }> {
    await this.delay(200);
    if (dto.expectedRevision !== this.preferences.revision) {
      throw new ApiException(
        409,
        'VERSION_CONFLICT',
        `Preferences revision conflict: expected revision ${dto.expectedRevision} but current revision on server is ${this.preferences.revision}.`
      );
    }

    const nextRevision = this.preferences.revision + 1;
    this.preferences = {
      ...this.preferences,
      ...dto,
      revision: nextRevision,
    };
    return { preferences: { ...this.preferences } };
  }

  // Skills Operations
  async listSkills(options?: {
    scope?: 'installed' | 'builtIn';
    limit?: number;
    cursor?: string;
  }): Promise<{ items: SkillListItem[]; nextCursor: string | null }> {
    await this.delay(120);
    let items = this.skills.map((s) => ({ ...s }));
    if (options?.scope === 'installed') {
      items = items.filter((s) => s.installed);
    } else if (options?.scope === 'builtIn') {
      items = items.filter((s) => s.visibility === 'built_in');
    }
    return { items, nextCursor: null };
  }

  async getSkill(
    id: string
  ): Promise<{ skill: SkillDefinition & { versions?: SkillVersion[]; installation?: SkillInstallation } }> {
    await this.delay(100);
    const skill = this.skills.find((s) => s.id === id);
    if (!skill) {
      throw new ApiException(404, 'SKILL_NOT_FOUND', `Skill with ID '${id}' was not found.`);
    }

    const versions = this.skillVersions[id] || [];
    const installation: SkillInstallation | undefined = skill.installed
      ? {
          id: `inst_${id.slice(-6)}`,
          userId: this.currentUser?.id || MOCK_USER.id,
          skillId: id,
          selectedVersionId: skill.selectedVersionId || (versions[0]?.id ?? 'ver_default'),
          enabled: skill.enabled,
          installedAt: skill.createdAt,
        }
      : undefined;

    return {
      skill: {
        ...skill,
        versions,
        installation,
      },
    };
  }

  async createSkill(dto: CreateSkillDto): Promise<{ skill: SkillDefinition }> {
    await this.delay(250);
    if (!dto.title.trim()) {
      throw new ApiException(400, 'VALIDATION_ERROR', 'Title is required');
    }
    const cleanSlug = dto.slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-') || `skill-${Date.now().toString().slice(-4)}`;
    const skillId = `skl_${Date.now()}`;
    const versionId = `ver_${Date.now()}`;

    const newSkill: SkillListItem = {
      id: skillId,
      ownerId: this.currentUser?.id || MOCK_USER.id,
      slug: cleanSlug,
      title: dto.title.trim(),
      description: dto.description.trim(),
      visibility: 'private',
      supportedProducts: dto.supportedProducts && dto.supportedProducts.length > 0 ? dto.supportedProducts : ['chat', 'agent'],
      revision: 1,
      createdAt: new Date().toISOString(),
      installed: true,
      enabled: true,
      selectedVersionId: versionId,
    };

    const initialVersion: SkillVersion = {
      id: versionId,
      skillId,
      versionNumber: 1,
      contentHash: `hash-${cleanSlug}-v1`,
      instructions: dto.instructions?.trim() || `# ${dto.title}\n\nCustom instructions for ${dto.title}.`,
      createdAt: new Date().toISOString(),
    };

    this.skills.unshift(newSkill);
    this.skillVersions[skillId] = [initialVersion];

    return { skill: newSkill };
  }

  async updateSkill(id: string, dto: UpdateSkillDto): Promise<{ skill: SkillDefinition }> {
    await this.delay(200);
    const skillIndex = this.skills.findIndex((s) => s.id === id);
    if (skillIndex === -1) {
      throw new ApiException(404, 'SKILL_NOT_FOUND', `Skill with ID '${id}' not found.`);
    }

    const currentSkill = this.skills[skillIndex];
    const currentRevision = currentSkill.revision ?? 1;

    // Strict CAS check
    if (dto.expectedRevision !== currentRevision) {
      throw new ApiException(
        409,
        'VERSION_CONFLICT',
        `Skill metadata revision conflict: expected revision ${dto.expectedRevision} but current revision is ${currentRevision}.`
      );
    }

    const updatedSkill: SkillListItem = {
      ...currentSkill,
      title: dto.title !== undefined ? dto.title.trim() : currentSkill.title,
      description: dto.description !== undefined ? dto.description.trim() : currentSkill.description,
      supportedProducts: dto.supportedProducts || currentSkill.supportedProducts,
      revision: currentRevision + 1,
    };

    this.skills[skillIndex] = updatedSkill;
    return { skill: updatedSkill };
  }

  async deleteSkill(id: string): Promise<void> {
    await this.delay(150);
    const skill = this.skills.find((s) => s.id === id);
    if (!skill) {
      throw new ApiException(404, 'SKILL_NOT_FOUND', `Skill with ID '${id}' not found.`);
    }
    if (skill.visibility === 'built_in') {
      throw new ApiException(403, 'FORBIDDEN', 'Built-in skills cannot be deleted.');
    }

    this.skills = this.skills.filter((s) => s.id !== id);
    delete this.skillVersions[id];
  }

  async publishSkillVersion(id: string, dto: CreateVersionDto): Promise<{ version: SkillVersion }> {
    await this.delay(200);
    const skill = this.skills.find((s) => s.id === id);
    if (!skill) {
      throw new ApiException(404, 'SKILL_NOT_FOUND', `Skill with ID '${id}' not found.`);
    }

    const existingVersions = this.skillVersions[id] || [];
    const nextNumber = existingVersions.length + 1;
    const newVersion: SkillVersion = {
      id: `ver_${id.slice(-6)}_${nextNumber}`,
      skillId: id,
      versionNumber: nextNumber,
      contentHash: `hash-${skill.slug}-v${nextNumber}`,
      instructions: dto.instructions.trim(),
      createdAt: new Date().toISOString(),
    };

    existingVersions.unshift(newVersion);
    this.skillVersions[id] = existingVersions;
    skill.selectedVersionId = newVersion.id;

    return { version: newVersion };
  }

  async installSkill(id: string, dto?: InstallSkillDto): Promise<{ installation: SkillInstallation }> {
    await this.delay(150);
    const skill = this.skills.find((s) => s.id === id);
    if (!skill) {
      throw new ApiException(404, 'SKILL_NOT_FOUND', `Skill with ID '${id}' not found.`);
    }

    skill.installed = true;
    skill.enabled = dto?.enabled !== undefined ? dto.enabled : true;
    if (dto?.versionId) {
      skill.selectedVersionId = dto.versionId;
    } else if (!skill.selectedVersionId && this.skillVersions[id]?.length > 0) {
      skill.selectedVersionId = this.skillVersions[id][0].id;
    }

    const installation: SkillInstallation = {
      id: `inst_${id.slice(-6)}`,
      userId: this.currentUser?.id || MOCK_USER.id,
      skillId: id,
      selectedVersionId: skill.selectedVersionId || 'ver_default',
      enabled: skill.enabled,
      installedAt: new Date().toISOString(),
    };

    return { installation };
  }

  async updateInstallation(id: string, dto: UpdateInstallationDto): Promise<{ installation: SkillInstallation }> {
    await this.delay(120);
    const skill = this.skills.find((s) => s.id === id);
    if (!skill) {
      throw new ApiException(404, 'SKILL_NOT_FOUND', `Skill with ID '${id}' not found.`);
    }

    if (dto.enabled !== undefined) {
      skill.enabled = dto.enabled;
    }
    if (dto.selectedVersionId !== undefined) {
      skill.selectedVersionId = dto.selectedVersionId;
    }

    const installation: SkillInstallation = {
      id: `inst_${id.slice(-6)}`,
      userId: this.currentUser?.id || MOCK_USER.id,
      skillId: id,
      selectedVersionId: skill.selectedVersionId || 'ver_default',
      enabled: skill.enabled,
      installedAt: new Date().toISOString(),
    };

    return { installation };
  }

  // ==========================================
  // Provider Credentials & BYOK Operations (17T-39)
  // ==========================================

  async getProviderCredentials(): Promise<{ items: ProviderCredential[] }> {
    await this.delay(100);
    if (!this.currentUser) {
      throw new ApiException(401, 'UNAUTHORIZED', 'Session required');
    }
    return { items: this.credentials.map((c) => ({ ...c })) };
  }

  async saveProviderCredential(dto: SaveCredentialDto): Promise<{ credential: ProviderCredential }> {
    await this.delay(150);
    if (!this.currentUser) {
      throw new ApiException(401, 'UNAUTHORIZED', 'Session required');
    }
    if (dto.provider !== 'gemini' || typeof dto.apiKey !== 'string' || !/^[\x21-\x7e]{16,512}$/.test(dto.apiKey)) {
      throw new ApiException(400, 'VALIDATION_ERROR', 'Expected Gemini provider and a printable credential of 16 to 512 characters');
    }

    const id = `cred_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const displayHint = `••••${dto.apiKey.slice(-4)}`;
    const now = new Date().toISOString();

    const newCred: ProviderCredential = {
      id,
      provider: 'gemini',
      displayHint,
      status: 'unverified',
      createdAt: now,
      updatedAt: now,
      lastValidatedAt: null,
    };

    // Atomically replace existing credentials (1 per user)
    this.credentials = [newCred];

    // If currently in BYOK mode, rebind preference to new credential ID!
    if (this.credentialPreference.mode === 'byok') {
      this.credentialPreference = { mode: 'byok', credentialId: id };
    }

    return { credential: { ...newCred } };
  }

  async deleteProviderCredential(id: string): Promise<void> {
    await this.delay(120);
    if (!this.currentUser) {
      throw new ApiException(401, 'UNAUTHORIZED', 'Session required');
    }
    const index = this.credentials.findIndex((c) => c.id === id);
    if (index === -1) {
      throw new ApiException(404, 'NOT_FOUND', 'Credential not found');
    }

    this.credentials.splice(index, 1);

    // If currently in BYOK mode and selected credential was deleted, set credentialId to null while keeping mode 'byok'
    if (this.credentialPreference.mode === 'byok' && this.credentialPreference.credentialId === id) {
      this.credentialPreference = { mode: 'byok', credentialId: null };
    }
  }

  async validateProviderCredential(id: string): Promise<{ credential: ProviderCredential }> {
    await this.delay(200);
    if (!this.currentUser) {
      throw new ApiException(401, 'UNAUTHORIZED', 'Session required');
    }
    const cred = this.credentials.find((c) => c.id === id);
    if (!cred) {
      throw new ApiException(404, 'NOT_FOUND', 'Credential not found');
    }

    const index = this.credentials.findIndex((c) => c.id === id);
    if (this.mockValidateBehavior === 'transient_error') {
      const now = new Date().toISOString();
      this.credentials[index] = { ...cred, lastValidatedAt: now, updatedAt: now };
      throw new ApiException(503, 'PROVIDER_UNAVAILABLE', 'Credential validation is temporarily unavailable');
    }

    if (this.mockValidateBehavior === 'rate_limit') {
      const now = new Date().toISOString();
      this.credentials[index] = { ...cred, lastValidatedAt: now, updatedAt: now };
      throw new ApiException(429, 'PROVIDER_RATE_LIMIT', 'Credential validation is temporarily unavailable');
    }

    const isInvalid = this.mockValidateBehavior === 'invalid' || cred.displayHint.endsWith('0000');
    const newStatus = isInvalid ? 'invalid' : 'valid';
    const now = new Date().toISOString();

    const updatedCred: ProviderCredential = {
      ...cred,
      status: newStatus,
      lastValidatedAt: now,
      updatedAt: now,
    };

    this.credentials[index] = updatedCred;

    return { credential: { ...updatedCred } };
  }

  async getChatCredentialPreference(): Promise<ChatCredentialPreference> {
    await this.delay(80);
    if (!this.currentUser) {
      throw new ApiException(401, 'UNAUTHORIZED', 'Session required');
    }
    return { ...this.credentialPreference };
  }

  async setChatCredentialPreference(dto: SetCredentialPreferenceDto): Promise<ChatCredentialPreference> {
    await this.delay(120);
    if (!this.currentUser) {
      throw new ApiException(401, 'UNAUTHORIZED', 'Session required');
    }
    if (
      (dto.mode !== 'platform' && dto.mode !== 'byok') ||
      (dto.mode === 'platform' && dto.credentialId !== undefined && dto.credentialId !== null) ||
      (dto.mode === 'byok' && typeof dto.credentialId !== 'string')
    ) {
      throw new ApiException(400, 'VALIDATION_ERROR', 'Invalid Chat credential preference');
    }

    if (dto.mode === 'byok') {
      const exists = this.credentials.some((c) => c.id === dto.credentialId);
      if (!exists) {
        throw new ApiException(404, 'NOT_FOUND', 'Selected credential does not exist');
      }
    }

    this.credentialPreference = {
      mode: dto.mode,
      credentialId: dto.mode === 'byok' ? (dto.credentialId as string) : null,
    };

    return { ...this.credentialPreference };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const mockDataAdapter = new MockDataAdapter();
