import type {
  User,
  Conversation,
  Message,
  AgentRun,
  ChangeProposal,
  AgentRunStatus,
} from './types.js';

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
    createdAt: '2026-10-13T03:50:00.000Z',
    updatedAt: '2026-10-13T03:50:42.000Z',
  },
  {
    id: 'run_652c0011-88b9-4112-a002-990a1827ec31',
    status: 'failed',
    task: 'Perform automated refactor of authentication middleware',
    repository: '17thedevv/Giga',
    baseRef: 'main',
    createdAt: '2026-10-12T16:00:00.000Z',
    updatedAt: '2026-10-12T16:02:15.000Z',
    error: {
      code: 'AGENT_STEP_LIMIT_EXCEEDED',
      message: 'Agent exceeded maximum permitted reasoning and tool execution steps (limit: 10 steps)',
    },
  },
];

export const MOCK_PROPOSAL: ChangeProposal = {
  id: 'prop_3b1a8f90-112c-4911-aa90-55e120bc7710',
  runId: 'run_881a29f0-55b1-42e8-912a-33c8b1a9901e',
  baseCommitSha: '4aff64821a8109bfef210087cb1a4901e9121a10',
  files: [
    {
      path: 'apps/api/src/db/client.ts',
      status: 'modified',
      additions: 12,
      deletions: 6,
      unifiedDiff: `--- a/apps/api/src/db/client.ts
+++ b/apps/api/src/db/client.ts
@@ -32,8 +32,14 @@ export function createDbClient() {
     const pool = new Pool({
       connectionString: env.DATABASE_URL,
-      max: 20,
+      max: 10,
+      idleTimeoutMillis: 30000,
     });
+
+    pool.on('error', (err) => {
+      console.error('Unexpected error on idle DB client', err);
+    });
+
     return pool;
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

/**
 * Mock Data Adapter implementing stateful in-memory demo operations.
 */
export class MockDataAdapter {
  private conversations = [...INITIAL_CONVERSATIONS];
  private messages: Record<string, Message[]> = { ...INITIAL_MESSAGES };
  private runs = [...INITIAL_RUNS];
  private proposal = { ...MOCK_PROPOSAL };

  // Auth
  async login(email: string, password: string): Promise<{ user: User }> {
    await this.delay(300);
    if (!email || !password) {
      throw new Error('Email and password required');
    }
    if (email !== 'trangthu@demo.giga.dev' && !email.includes('@')) {
      throw new Error('Invalid email format');
    }
    return { user: { ...MOCK_USER, email } };
  }

  async logout(): Promise<void> {
    await this.delay(100);
  }

  async getMe(): Promise<{ user: User }> {
    await this.delay(150);
    return { user: MOCK_USER };
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
      messages: this.messages[id] ? [...this.messages[id]] : [],
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
      id: `msg_${Date.now()}`,
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

  // Agent Runs
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
      prUrl: 'https://github.com/17thedevv/Giga/pull/12',
      prNumber: 12,
      branch: `agent/fix-db-leak-${runId.slice(-4)}`,
      commitSha: 'e1f98bc4019a28b',
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

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const mockDataAdapter = new MockDataAdapter();
