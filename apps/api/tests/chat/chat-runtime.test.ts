import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { createApp } from '../../src/app/create-app.js';
import { createTestDatabase, type TestDbInstance } from '../test-db-helper.js';
import { MIGRATIONS, runMigrations } from '../../src/db/migrate.js';
import { SessionRepository } from '../../src/db/repositories/session-repository.js';
import { UserRepository } from '../../src/db/repositories/user-repository.js';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../../src/modules/auth/session.js';
import { ChatRuntime, CHAT_MODEL_ALIAS, type RuntimeOptions } from '../../src/modules/chat/chat-runtime.js';
import { PostgresGenerationRepository } from '../../src/modules/chat/generation-repository.js';
import type { ChatEvent, ChatGeneration } from '../../src/modules/chat/types.js';
import { LLMEngine, ModelRegistry, type LLMRequest, type LLMStreamEvent } from '../../src/modules/llm/index.js';
import { FakeProvider, type FakeProviderOptions } from '../../src/modules/llm/testing/fake-provider.js';

const origin = 'http://localhost:3000';
function engineFor(provider: FakeProvider): LLMEngine {
  const registry = new ModelRegistry();
  registry.registerAdapter(provider);
  registry.registerAlias({ alias: CHAT_MODEL_ALIAS, providerId: provider.providerId, modelId: 'test-model', requiredCapabilities: ['streaming'], maxOutputTokensLimit: 2048 });
  return new LLMEngine(registry);
}
function eventsFrom(text: string): ChatEvent[] {
  return text.trim().split('\n\n').map((frame) => {
    const [event, data] = frame.split('\n');
    assert.ok(event?.startsWith('event: '));
    assert.ok(data?.startsWith('data: '));
    return { event: event!.slice(7), data: JSON.parse(data!.slice(6)) } as ChatEvent;
  });
}

describe('Persisted Chat Runtime', { timeout: 30000 }, () => {
  let db: TestDbInstance;
  let owner: string;
  let other: string;
  let conversationId: string;
  let cookie: string;
  let otherCookie: string;
  let repository: PostgresGenerationRepository;
  let provider: FakeProvider;
  let runtime: ChatRuntime;
  let app: ReturnType<typeof createApp>;

  function setup(options: FakeProviderOptions = {}, repo = repository, runtimeOptions: RuntimeOptions = {}): void {
    provider = new FakeProvider(options);
    const engine = engineFor(provider);
    runtime = new ChatRuntime(repo, engine, runtimeOptions);
    app = createApp({ pool: db.pool, chatRuntime: runtime, config: { allowedOrigins: [origin] } });
  }
  const path = (): string => `/api/v1/conversations/${conversationId}/messages:stream`;
  async function post(key: string | undefined = randomUUID(), body: unknown = { content: 'Hello' }, headers: Record<string, string> = {}): Promise<Response> {
    return app.request(path(), { method: 'POST', headers: {
      Origin: origin, Cookie: cookie, 'Content-Type': 'application/json',
      ...(key === undefined ? {} : { 'Idempotency-Key': key }), ...headers,
    }, body: JSON.stringify(body) });
  }
  async function collect(response: Response): Promise<ChatEvent[]> {
    assert.equal(response.status, 200, await (response.status !== 200 ? response.text() : Promise.resolve('')));
    assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    return eventsFrom(await response.text());
  }
  async function generation(): Promise<ChatGeneration> {
    const rows = await db.pool.query<{ id: string }>('SELECT id FROM chat_generations WHERE conversation_id = $1', [conversationId]);
    assert.equal(rows.rows.length, 1);
    return repository.get(owner, conversationId, rows.rows[0]!.id);
  }
  async function messageCount(role: 'user' | 'assistant'): Promise<number> {
    const result = await db.pool.query('SELECT id FROM messages WHERE conversation_id = $1 AND role = $2', [conversationId, role]);
    return result.rows.length;
  }

  before(async () => { db = await createTestDatabase(); });
  after(async () => { await db.cleanup(); await db.pool.end(); });
  beforeEach(async () => {
    await db.cleanup();
    const users = new UserRepository(db.pool);
    const sessions = new SessionRepository(db.pool);
    async function user(): Promise<{ id: string; cookie: string }> {
      const created = await users.createUser({ email: `${randomUUID()}@example.com`, displayName: 'Chat test', passwordHash: 'unused-test-hash' });
      const token = generateSessionToken();
      await sessions.createSession({ userId: created.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60000) });
      return { id: created.id, cookie: `${SESSION_COOKIE_NAME}=${token}` };
    }
    const a = await user(); const b = await user();
    owner = a.id; other = b.id; cookie = a.cookie; otherCookie = b.cookie;
    conversationId = randomUUID();
    await db.pool.query('INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, $3)', [conversationId, owner, 'Chat test']);
    repository = new PostgresGenerationRepository(db.pool);
    setup();
  });

  it('CHAT-01/02 streams persisted completion and reconciles after a new app instance', async () => {
    const events = await collect(await post());
    assert.deepEqual(events.map((e) => e.event), ['message.started', 'message.delta', 'message.delta', 'message.completed']);
    const stored = await generation();
    assert.equal(stored.status, 'completed');
    assert.equal(stored.partialContent, 'Hello world!');
    assert.equal(events[0]!.data.messageId, stored.assistantMessageId);
    assert.equal(events.at(-1)!.data.createdAt, stored.finishedAt);
    const assistant = await db.pool.query('SELECT content FROM messages WHERE id = $1', [stored.assistantMessageId]);
    assert.equal(assistant.rows[0].content, stored.partialContent);
    const refreshed = createApp({ pool: db.pool }); // GET works even with no provider configured.
    const response = await refreshed.request(`/api/v1/conversations/${conversationId}/generations/${stored.id}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { generation: stored });
    assert.equal(provider.callCount, 1);
    const serialized = JSON.stringify(stored);
    for (const secret of ['owner_id', 'fingerprint', 'idempotency', 'providerId', 'test-model']) assert.ok(!serialized.includes(secret));
  });

  it('CHAT-05/06 duplicate key reconciles; changed payload conflicts without another call', async () => {
    const key = randomUUID();
    await collect(await post(key));
    const duplicate = await post(key, { content: 'Hello', modelId: CHAT_MODEL_ALIAS });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json() as { generation: ChatGeneration }).generation.id, (await generation()).id);
    assert.equal((await post(key, { content: 'Changed' })).status, 409);
    assert.equal(provider.callCount, 1);
    assert.equal(await messageCount('user'), 1);
    assert.equal(await messageCount('assistant'), 1);
  });

  it('CHAT-07 admits only one provider while another request is active', { timeout: 5000 }, async () => {
    setup({ delayBeforeFirstTokenMs: 80 });
    const first = await post();
    const reader = first.body!.getReader();
    const started = await reader.read();
    assert.match(new TextDecoder().decode(started.value), /message.started/);
    const second = await post();
    assert.equal(second.status, 409);
    while (!(await reader.read()).done) { /* consume bounded provider stream */ }
    assert.equal(provider.callCount, 1);
    assert.equal(await messageCount('user'), 1);
  });

  it('serializes truly concurrent admission on Real PostgreSQL', { timeout: 5000 }, async (t) => {
    if (db.isMemory) return t.skip('pg-mem does not implement concurrent row locks/transaction isolation');
    const responses = await Promise.all([post(), post()]);
    assert.equal(responses.filter((r) => r.status === 200).length, 1);
    assert.equal(responses.filter((r) => r.status === 409).length, 1);
    await collect(responses.find((r) => r.status === 200)!);
    assert.equal(await messageCount('user'), 1);
    assert.equal(provider.callCount, 1);
  });

  it('concurrent identical keys return the same generation on Real PostgreSQL', { timeout: 5000 }, async (t) => {
    if (db.isMemory) return t.skip('pg-mem does not implement concurrent row locks/transaction isolation');
    const key = randomUUID();
    const results = await Promise.all([
      runtime.admit(owner, conversationId, { content: 'A' }, key),
      runtime.admit(owner, conversationId, { content: 'A' }, key),
    ]);
    assert.equal(results[0].generation.id, results[1].generation.id);
    assert.equal(results.filter((r) => !r.duplicate).length, 1);
    assert.equal(await messageCount('user'), 1);
  });

  for (const partial of [false, true]) {
    it(partial ? 'CHAT-09 preserves partial and sends diagnostic immediately before failure' : 'CHAT-08 fails before first token without fabricated assistant', async () => {
      const sensitive = new Error('SECRET_PROVIDER_TOKEN private prompt');
      setup(partial ? { chunks: ['partial', 'discarded'], errorAfterTokens: { count: 1, error: sensitive } } : { errorBeforeFirstToken: sensitive });
      const events = await collect(await post());
      assert.deepEqual(events.map((e) => e.event), ['message.started', ...(partial ? ['message.delta'] : []), 'stream.error', 'message.failed']);
      const stored = await generation();
      assert.equal(stored.status, 'failed');
      assert.equal(stored.partialContent, partial ? 'partial' : '');
      assert.equal(await messageCount('assistant'), 0);
      assert.equal(stored.assistantMessageId, undefined);
      assert.ok(!JSON.stringify([events, stored]).includes('SECRET_PROVIDER_TOKEN'));
    });
  }

  it('CHAT-12 cross-owner conversation and generation IDs are nondisclosing 404', async () => {
    assert.equal((await post(randomUUID(), { content: 'Hello' }, { Cookie: otherCookie })).status, 404);
    assert.equal(provider.callCount, 0);
    assert.equal(await messageCount('user'), 0);
    const admission = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    const get = await app.request(`/api/v1/conversations/${conversationId}/generations/${admission.generation.id}`, { headers: { Cookie: otherCookie } });
    assert.equal(get.status, 404);
    await assert.rejects(repository.get(other, conversationId, admission.generation.id), { statusCode: 404 });
    assert.equal(provider.callCount, 0);
  });

  it('CHAT-19 rolls back an assistant insert failure inside final transaction; emits no completion', async () => {
    class FailingRepository extends PostgresGenerationRepository {
      protected override async insertAssistant(client: pg.PoolClient, item: ChatGeneration, text: string): Promise<void> {
        await super.insertAssistant(client, item, text);
        throw new Error('injected final transaction failure');
      }
    }
    setup({}, new FailingRepository(db.pool));
    const events = await collect(await post());
    assert.equal(events.at(-1)!.event, 'message.failed');
    assert.ok(!events.some((e) => e.event === 'message.completed'));
    assert.equal((await generation()).status, 'failed');
    assert.equal(await messageCount('assistant'), 0);
  });

  it('CHAT-20 terminal delivery failure leaves committed GET state completed', async () => {
    const admission = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    const delivered: ChatEvent[] = [];
    await runtime.run(owner, admission.generation, async (event) => {
      // Observe DB during delivery: completion must already be durable.
      if (event.event === 'message.completed') {
        assert.equal((await generation()).status, 'completed');
        throw new Error('terminal transport unavailable');
      }
      delivered.push(event);
    }, new AbortController().signal);
    assert.equal((await generation()).status, 'completed');
    assert.equal(await messageCount('assistant'), 1);
    assert.ok(!delivered.some((e) => e.event === 'message.failed'));
    assert.equal(provider.callCount, 1);
  });

  it('rejects invalid models, payloads, malformed/missing keys before provider admission', async () => {
    for (const body of [{ content: 'Hello', modelId: 'vendor/raw-model' }, { content: 'Hello', modelId: null }, { content: '' }, { content: 'a'.repeat(16385) }, { content: '🙂'.repeat(4097) }, { content: 'Hello', apiKey: 'x' }, []]) {
      assert.equal((await post(randomUUID(), body)).status, 400);
    }
    for (const key of ['', 'with spaces', 'x'.repeat(129)]) assert.equal((await post(key)).status, 400);
    const missing = await app.request(path(), { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Hello' }) });
    assert.equal(missing.status, 400);
    assert.equal(provider.callCount, 0);
    assert.equal(await messageCount('user'), 0);
  });

  it('keeps authentication and strict Origin/CSRF checks on both routes', async () => {
    assert.equal((await post(randomUUID(), { content: 'Hello' }, { Cookie: '' })).status, 401);
    assert.equal((await post(randomUUID(), { content: 'Hello' }, { Origin: '' })).status, 403);
    assert.equal((await post(randomUUID(), { content: 'Hello' }, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await app.request(`/api/v1/conversations/${conversationId}/generations/${randomUUID()}`)).status, 401);
    assert.equal(provider.callCount, 0);
  });

  it('fails closed without an injected engine and never uses a FakeProvider fallback', async () => {
    app = createApp({ pool: db.pool, config: { allowedOrigins: [origin] } });
    const result = await post();
    assert.equal(result.status, 503);
    assert.equal(await messageCount('user'), 0);
    assert.equal(provider.callCount, 0);
  });

  it('returns a started/error/failed sequence if the streaming transition fails', async () => {
    class FailingStart extends PostgresGenerationRepository {
      override async start(): Promise<void> { throw new Error('injected transition failure'); }
    }
    setup({}, new FailingStart(db.pool));
    const events = await collect(await post());
    assert.deepEqual(events.map((e) => e.event), ['message.started', 'stream.error', 'message.failed']);
    assert.equal((await generation()).status, 'failed');
    assert.equal(provider.callCount, 0);
  });

  it('rejects premature upstream termination without completing an assistant message', async () => {
    setup({ omitCompleted: true });
    const events = await collect(await post());
    assert.equal(events.at(-1)!.event, 'message.failed');
    assert.equal((await generation()).partialContent, 'Hello world!');
    assert.equal(await messageCount('assistant'), 0);
  });

  it('scopes idempotency fingerprints to the conversation and hides mismatched GET paths', async () => {
    const key = randomUUID();
    await collect(await post(key));
    const stored = await generation();
    const sibling = randomUUID();
    await db.pool.query('INSERT INTO conversations (id,user_id,title) VALUES ($1,$2,$3)', [sibling, owner, 'Sibling']);
    await assert.rejects(runtime.admit(owner, sibling, { content: 'Hello' }, key), { statusCode: 409 });
    const mismatch = await app.request(`/api/v1/conversations/${sibling}/generations/${stored.id}`, { headers: { Cookie: cookie } });
    assert.equal(mismatch.status, 404);
    assert.equal(provider.callCount, 1);
  });

  it('bounds context by bytes and count while retaining the complete current prompt', async () => {
    for (let i = 0; i < 30; i++) {
      await db.pool.query("INSERT INTO messages (conversation_id,role,content,created_at) VALUES ($1,'user',$2,$3)", [conversationId, 'x'.repeat(4000), new Date(Date.now() - 60000 + i * 1000)]);
    }
    await collect(await post());
    const messages = provider.lastRequest!.messages;
    assert.ok(messages.length <= 41);
    assert.ok(messages.reduce((bytes, m) => bytes + Buffer.byteLength(m.content), 0) <= 65536);
    assert.deepEqual(messages.at(-1), { role: 'user', content: 'Hello' });
  });

  it('does not resurrect a conversation deleted during generation', async () => {
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    const events: ChatEvent[] = [];
    await runtime.run(owner, admitted.generation, async (event) => {
      events.push(event);
      if (event.event === 'message.delta') await db.pool.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, owner]);
    }, new AbortController().signal);
    assert.ok(!events.some((e) => e.event === 'message.completed'));
    assert.equal(await messageCount('assistant'), 0);
    await assert.rejects(repository.get(owner, conversationId, admitted.generation.id), { statusCode: 404 });
  });

  it('context excludes failed prompts/partial output and includes only persisted current content', async () => {
    setup({ errorAfterTokens: { count: 1, error: new Error('failure') } });
    await collect(await post(randomUUID(), { content: 'Failed prompt' }));
    setup({ chunks: ['Complete answer'] });
    await collect(await post(randomUUID(), { content: 'Complete prompt' }));
    assert.deepEqual(provider.lastRequest!.messages, [{ role: 'user', content: 'Complete prompt' }]);
    await collect(await post(randomUUID(), { content: 'Followup' }));
    assert.deepEqual(provider.lastRequest!.messages, [
      { role: 'user', content: 'Complete prompt' }, { role: 'assistant', content: 'Complete answer' }, { role: 'user', content: 'Followup' },
    ]);
  });

  it('bounds output and batches partial checkpoints instead of one write per token', async () => {
    class CountingRepository extends PostgresGenerationRepository {
      checkpoints = 0;
      override async checkpoint(userId: string, id: string, text: string): Promise<void> {
        this.checkpoints++;
        await super.checkpoint(userId, id, text);
      }
    }
    const counting = new CountingRepository(db.pool);
    setup({ chunks: [...Array<string>(100).fill('a'.repeat(100)), 'z'.repeat(65536)] }, counting);
    const events = await collect(await post());
    assert.equal(events.at(-1)!.event, 'message.failed');
    assert.equal((await generation()).partialContent.length, 10000);
    assert.ok(counting.checkpoints >= 2 && counting.checkpoints < 10);
    assert.equal(await messageCount('assistant'), 0);
  });

  it('interrupts downstream cancellation and suppresses late provider output', { timeout: 5000 }, async () => {
    setup({ chunkDelayMs: 20, emitTokensAfterAbort: true });
    const admission = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    const abort = new AbortController();
    const events: ChatEvent[] = [];
    await runtime.run(owner, admission.generation, async (event) => {
      events.push(event);
      if (event.event === 'message.delta') abort.abort();
    }, abort.signal);
    assert.equal((await generation()).status, 'interrupted');
    assert.equal((await generation()).partialContent, 'Hello');
    assert.equal(events.filter((e) => e.event === 'message.delta').length, 1);
    assert.equal(await messageCount('assistant'), 0);
  });

  it('bounds an uncooperative provider with a deadline and releases the active slot', { timeout: 5000 }, async () => {
    const delayed = { streamText: (_request: LLMRequest): AsyncIterable<LLMStreamEvent> => ({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise((resolve) => setTimeout(() => resolve({ done: false, value: { type: 'text.delta', text: 'too late' } }), 100)) }),
    }) };
    runtime = new ChatRuntime(repository, delayed, { totalTimeoutMs: 30, idleTimeoutMs: 20 });
    const admission = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    const events: ChatEvent[] = [];
    await runtime.run(owner, admission.generation, async (event) => { events.push(event); }, new AbortController().signal);
    assert.equal((await generation()).status, 'failed');
    assert.equal(events.at(-1)!.event, 'message.failed');
    assert.ok(!events.some((e) => e.event === 'message.delta'));
    assert.equal((await runtime.admit(owner, conversationId, { content: 'Next' }, randomUUID())).duplicate, false);
  });

  it('reclaims expired active state after a worker restart and fences stale completion', async () => {
    const old = await runtime.admit(owner, conversationId, { content: 'Old' }, randomUUID());
    await db.pool.query('UPDATE chat_generations SET created_at = $2 WHERE id = $1', [old.generation.id, new Date(Date.now() - 130000)]);
    await runtime.admit(owner, conversationId, { content: 'Next' }, randomUUID());
    assert.equal((await repository.get(owner, conversationId, old.generation.id)).status, 'interrupted');
    await assert.rejects(repository.start(owner, old.generation.id));
    await assert.rejects(repository.complete(owner, old.generation, 'late', 'stop'));
    assert.equal(await messageCount('assistant'), 0);
  });

  it('005 SQL matches the migration runner and applies idempotently beside 001–004', async () => {
    const sql = await readFile(new URL('../../src/db/migrations/005_chat_generations.sql', import.meta.url), 'utf8');
    assert.equal(MIGRATIONS.find((m) => m.version === 5)!.sql.trim(), sql.replace(/\r\n/g, '\n').trim());
    await db.pool.query(sql);
    assert.deepEqual(await runMigrations(db.pool), []);
  });

  it('database prevents a second active generation independently of service admission', async (t) => {
    if (db.isMemory) return t.skip('pg-mem partial index planner is incorrect; Real PostgreSQL proves this guard');
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    await assert.rejects(db.pool.query(`INSERT INTO chat_generations
      (owner_id, conversation_id, user_message_id, model_alias, status, idempotency_key, request_fingerprint)
      VALUES ($1, $2, $3, $4, 'streaming', $5, $6)`,
    [owner, conversationId, admitted.generation.userMessageId, CHAT_MODEL_ALIAS, randomUUID(), 'f'.repeat(64)]));
    assert.equal(await messageCount('user'), 1);
  });

  it('Real PostgreSQL rejects oversized partial content and rolls back admission on generation insert failure', async (t) => {
    if (db.isMemory) return t.skip('Real PostgreSQL transaction/constraint proof');
    await assert.rejects(repository.admit({ ownerId: owner, conversationId, content: 'Hello', key: 'k'.repeat(129), fingerprint: 'f'.repeat(64), modelId: CHAT_MODEL_ALIAS }));
    assert.equal(await messageCount('user'), 0);
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    await assert.rejects(db.pool.query('UPDATE chat_generations SET partial_content = $2 WHERE id = $1', [admitted.generation.id, '🙂'.repeat(16385)]));
  });
});
