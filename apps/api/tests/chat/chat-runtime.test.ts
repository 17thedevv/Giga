import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
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
import type { ChatEvent, ChatGeneration, ChatTurnVariants } from '../../src/modules/chat/types.js';
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

  async function variant(userMessageId: string, action = 'regenerate', key: string = randomUUID(), extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Response> {
    return app.request(`/api/v1/conversations/${conversationId}/generations:stream`, { method: 'POST', headers: {
      Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers,
    }, body: JSON.stringify({ userMessageId, action, ...extra }) });
  }
  async function variants(userMessageId: string): Promise<ChatTurnVariants> {
    const response = await app.request(`/api/v1/conversations/${conversationId}/messages/${userMessageId}/generations`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, response.status !== 200 ? await response.text() : '');
    return await response.json() as ChatTurnVariants;
  }
  async function seedCompleted(): Promise<ChatGeneration> {
    setup({ chunks: ['Original answer'] });
    await collect(await post(randomUUID(), { content: 'Original prompt' }));
    return generation();
  }

  it('CHAT-10 streams regenerate, retains old output and selects only after durable completion', async () => {
    const old = await seedCompleted();
    setup({ chunks: ['New', ' answer'] });
    const response = await variant(old.userMessageId);
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /message.started/);
    const before = await variants(old.userMessageId);
    assert.equal(before.selectedGenerationId, old.id);
    assert.equal(before.items.length, 2);
    const candidate = before.items.find((i) => i.id !== old.id)!;
    assert.equal(candidate.action, 'regenerate');
    assert.equal(candidate.content, undefined);
    let remaining = '';
    while (true) { const next = await reader.read(); if (next.done) break; remaining += new TextDecoder().decode(next.value); }
    const events = eventsFrom(remaining);
    assert.deepEqual(events.map((e) => e.event), ['message.delta', 'message.delta', 'message.completed']);
    const after = await variants(old.userMessageId);
    assert.equal(after.selectedGenerationId, candidate.id);
    assert.deepEqual(after.items.map((i) => i.content), ['Original answer', 'New answer']);
    assert.deepEqual(await repository.get(owner, conversationId, old.id), old);
    assert.equal(await messageCount('user'), 1);
    assert.equal(await messageCount('assistant'), 2);
    assert.deepEqual(provider.lastRequest!.messages, [{ role: 'user', content: 'Original prompt' }]);
    const history = await app.request(`/api/v1/conversations/${conversationId}`, { headers: { Cookie: cookie } });
    const body = await history.json() as { messages: { role: string; content: string }[] };
    assert.deepEqual(body.messages.map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'Original prompt' }, { role: 'assistant', content: 'New answer' },
    ]);
    assert.equal(provider.callCount, 1);
  });

  for (const status of ['failed', 'stopped', 'interrupted'] as const) {
    it(`CHAT-11 retries latest ${status} attempt with one user and a newly selected generation`, async () => {
      const original = await runtime.admit(owner, conversationId, { content: 'Retry prompt' }, randomUUID());
      if (status === 'stopped') await runtime.cancel(owner, conversationId, original.generation.id, randomUUID());
      else await repository.finalize(owner, original.generation, 'partial', status, 'TEST_FAILURE');
      setup({ chunks: ['Recovered'] });
      const events = await collect(await variant(original.generation.userMessageId, 'retry'));
      assert.equal(events.at(-1)!.event, 'message.completed');
      const current = await variants(original.generation.userMessageId);
      assert.notEqual(current.selectedGenerationId, original.generation.id);
      assert.equal(current.items.length, 2);
      assert.equal(current.items[0]!.status, status);
      assert.equal(current.items[0]!.content, undefined);
      assert.equal(current.items[1]!.action, 'retry');
      assert.equal(current.items[1]!.content, 'Recovered');
      assert.equal(await messageCount('user'), 1);
      assert.deepEqual(provider.lastRequest!.messages, [{ role: 'user', content: 'Retry prompt' }]);
    });
  }

  for (const outcome of ['failed', 'stopped', 'interrupted'] as const) {
    it(`${outcome} regenerate preserves the selected completed variant`, async () => {
      const old = await seedCompleted();
      setup(outcome === 'failed' ? { chunks: ['partial'], errorAfterTokens: { count: 1, error: new Error('private upstream') } } : { chunks: ['partial', 'late'] });
      const admitted = await runtime.admitVariant(owner, conversationId, { userMessageId: old.userMessageId, action: 'regenerate' }, randomUUID());
      const abort = new AbortController();
      const events: ChatEvent[] = [];
      await runtime.run(owner, admitted.generation, async (e) => {
        events.push(e);
        if (e.event === 'message.delta' && outcome === 'stopped') await runtime.cancel(owner, conversationId, admitted.generation.id, randomUUID());
        if (e.event === 'message.delta' && outcome === 'interrupted') abort.abort();
      }, abort.signal);
      const current = await variants(old.userMessageId);
      assert.equal(current.selectedGenerationId, old.id);
      assert.equal(current.items.find((i) => i.id === admitted.generation.id)!.status, outcome);
      assert.equal((await repository.get(owner, conversationId, admitted.generation.id)).partialContent, 'partial');
      assert.equal(await messageCount('user'), 1);
      assert.equal(await messageCount('assistant'), 1);
      assert.ok(!events.some((e) => e.event === 'message.completed'));
      if (outcome === 'stopped') assert.equal(events.at(-1)!.event, 'message.stopped');
    });
  }

  it('context contains each prior user and its selected answer once across multiple variant-bearing turns', async () => {
    const old = await seedCompleted();
    for (const answer of ['Alternative A', 'Selected A']) {
      setup({ chunks: [answer] });
      await collect(await variant(old.userMessageId));
      assert.deepEqual(provider.lastRequest!.messages, [{ role: 'user', content: 'Original prompt' }]);
    }
    setup({ chunks: ['Original B'] });
    const next = await collect(await post(randomUUID(), { content: 'Second prompt' }));
    const nextId = next[0]!.data.generationId as string;
    const second = await repository.get(owner, conversationId, nextId);
    setup({ chunks: ['Selected B'] });
    await collect(await variant(second.userMessageId));
    assert.deepEqual(provider.lastRequest!.messages, [
      { role: 'user', content: 'Original prompt' }, { role: 'assistant', content: 'Selected A' }, { role: 'user', content: 'Second prompt' },
    ]);
    await collect(await post(randomUUID(), { content: 'Third prompt' }));
    assert.deepEqual(provider.lastRequest!.messages, [
      { role: 'user', content: 'Original prompt' }, { role: 'assistant', content: 'Selected A' },
      { role: 'user', content: 'Second prompt' }, { role: 'assistant', content: 'Selected B' }, { role: 'user', content: 'Third prompt' },
    ]);
  });

  it('fails closed for earlier turns and ineligible latest retry/regenerate states', async () => {
    const old = await seedCompleted();
    assert.equal((await variant(old.userMessageId, 'retry')).status, 409);
    setup({ errorBeforeFirstToken: new Error('failed') });
    const events = await collect(await post(randomUUID(), { content: 'Latest failed prompt' }));
    const latest = await repository.get(owner, conversationId, events[0]!.data.generationId as string);
    assert.equal((await variant(latest.userMessageId, 'regenerate')).status, 409);
    for (const action of ['retry', 'regenerate']) assert.equal((await variant(old.userMessageId, action)).status, 409);
    const response = await app.request(`/api/v1/conversations/${conversationId}/messages/${old.userMessageId}/generations`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 409);
    assert.equal(provider.callCount, 1);
  });

  it('reconciles identical variant keys and rejects changed operations, source or payload', async () => {
    const old = await seedCompleted();
    const key = randomUUID();
    await collect(await variant(old.userMessageId, 'regenerate', key));
    const duplicate = await variant(old.userMessageId.toUpperCase(), 'regenerate', key, { modelId: CHAT_MODEL_ALIAS });
    assert.equal(duplicate.status, 409);
    const existing = (await duplicate.json() as { generation: ChatGeneration }).generation;
    assert.equal(existing.id, (await variants(old.userMessageId)).selectedGenerationId);
    const changed = await variant(old.userMessageId, 'retry', key);
    assert.equal(changed.status, 409);
    assert.equal((await changed.json() as { generation?: unknown }).generation, undefined);
    assert.equal((await post(key, { content: 'New prompt' })).status, 409);
    await assert.rejects(runtime.cancel(owner, conversationId, existing.id, key), { statusCode: 409 });
    const cancelKey = randomUUID();
    await runtime.cancel(owner, conversationId, existing.id, cancelKey);
    assert.equal((await variant(old.userMessageId, 'regenerate', cancelKey)).status, 409);
    const promptKey = (await db.pool.query('SELECT idempotency_key FROM chat_generations WHERE id = $1', [old.id])).rows[0].idempotency_key as string;
    assert.equal((await variant(old.userMessageId, 'regenerate', promptKey)).status, 409);
    const next = await collect(await post(randomUUID(), { content: 'Next turn' }));
    const target = await repository.get(owner, conversationId, next[0]!.data.generationId as string);
    assert.equal((await variant(target.userMessageId, 'regenerate', key)).status, 409);
    // Duplicate original operation reconciles even though its turn is no longer latest.
    assert.equal((await (await variant(old.userMessageId, 'regenerate', key)).json() as { generation: ChatGeneration }).generation.id, existing.id);
    assert.equal(provider.callCount, 3);
    assert.equal(await messageCount('user'), 2);
  });

  it('variant routes enforce session, CSRF, source ownership and strict validation before provider', async () => {
    const old = await seedCompleted();
    setup();
    assert.equal((await variant(old.userMessageId, 'regenerate', randomUUID(), {}, { Cookie: '' })).status, 401);
    assert.equal((await variant(old.userMessageId, 'regenerate', randomUUID(), {}, { Origin: 'https://invalid.example' })).status, 403);
    assert.equal((await variant(old.userMessageId, 'regenerate', randomUUID(), {}, { Cookie: otherCookie })).status, 404);
    const foreignConversation = randomUUID(); const foreignMessage = randomUUID();
    await db.pool.query("INSERT INTO conversations (id,user_id,title) VALUES ($1,$2,'Foreign')", [foreignConversation, other]);
    await db.pool.query("INSERT INTO messages (id,conversation_id,role,content) VALUES ($1,$2,'user','Foreign')", [foreignMessage, foreignConversation]);
    assert.equal((await variant(foreignMessage)).status, 404);
    assert.equal((await variant(randomUUID())).status, 404);
    assert.equal((await variant(old.id)).status, 404); // assistant IDs are not source users
    const listPath = `/api/v1/conversations/${conversationId}/messages/${old.userMessageId}/generations`;
    assert.equal((await app.request(listPath)).status, 401);
    assert.equal((await app.request(listPath, { headers: { Cookie: otherCookie } })).status, 404);
    for (const [action, extra] of [['other', {}], ['retry', { modelId: null }], ['regenerate', { modelId: 'private/provider' }], ['regenerate', { sourceGenerationId: old.id }]] as const) {
      assert.equal((await variant(old.userMessageId, action, randomUUID(), extra)).status, 400);
    }
    for (const key of ['', 'bad key', 'k'.repeat(129)]) assert.equal((await variant(old.userMessageId, 'regenerate', key)).status, 400);
    assert.equal((await variant('invalid-uuid')).status, 400);
    assert.equal(provider.callCount, 0);
    const safe = JSON.stringify(await variants(old.userMessageId));
    for (const secret of ['owner', 'fingerprint', 'idempotency', 'provider', 'password']) assert.ok(!safe.includes(secret));
    const offline = new ChatRuntime(repository, undefined);
    assert.equal((await offline.variants(owner, conversationId, old.userMessageId)).items.length, 1);
    await assert.rejects(offline.admitVariant(owner, conversationId, { userMessageId: old.userMessageId, action: 'regenerate' }, randomUUID()), { statusCode: 503 });
  });

  for (const action of ['retry', 'regenerate'] as const) {
    it(`${action} cannot overlap another active generation and can be cancelled through the existing endpoint`, async () => {
      let old: ChatGeneration;
      if (action === 'regenerate') old = await seedCompleted();
      else {
        const admitted = await runtime.admit(owner, conversationId, { content: 'Retry me' }, randomUUID());
        old = await repository.finalize(owner, admitted.generation, '', 'failed', 'TEST');
      }
      setup({ chunks: ['partial', 'late'] });
      const response = await variant(old.userMessageId, action);
      const reader = response.body!.getReader();
      const started = eventsFrom(new TextDecoder().decode((await reader.read()).value))[0]!;
      const id = started.data.generationId as string;
      assert.equal((await variant(old.userMessageId, action)).status, 409);
      const cancel = await app.request(`/api/v1/conversations/${conversationId}/generations/${id}/cancel`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Idempotency-Key': randomUUID() } });
      assert.equal(cancel.status, 202);
      let rest = '';
      while (true) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
      assert.equal(eventsFrom(rest).at(-1)!.event, 'message.stopped');
      assert.equal((await repository.get(owner, conversationId, id)).status, 'stopped');
      assert.equal((await variants(old.userMessageId)).selectedGenerationId, action === 'regenerate' ? old.id : null);
      assert.equal(await messageCount('user'), 1);
    });
  }

  it('deletion fences variant completion, cascades selection and retains operation tombstones', async () => {
    const old = await seedCompleted(); const key = randomUUID();
    const candidate = await runtime.admitVariant(owner, conversationId, { userMessageId: old.userMessageId, action: 'regenerate' }, key);
    const events: ChatEvent[] = [];
    await runtime.run(owner, candidate.generation, async (event) => {
      events.push(event);
      if (event.event === 'message.delta') await db.pool.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
    }, new AbortController().signal);
    assert.ok(!events.some((e) => e.event === 'message.completed'));
    assert.equal((await db.pool.query('SELECT * FROM chat_turn_selections')).rows.length, 0);
    assert.equal((await db.pool.query('SELECT * FROM chat_generations')).rows.length, 0);
    assert.equal((await variant(old.userMessageId, 'regenerate', key)).status, 404);
    conversationId = randomUUID();
    await db.pool.query("INSERT INTO conversations (id,user_id,title) VALUES ($1,$2,'New')", [conversationId, owner]);
    await collect(await post());
    const fresh = await generation();
    assert.equal((await variant(fresh.userMessageId, 'regenerate', key)).status, 409);
    assert.equal((await db.pool.query('SELECT * FROM chat_generations')).rows.length, 1);
  });

  for (const action of ['retry', 'regenerate'] as const) {
    it(`Real PostgreSQL concurrent identical ${action} POSTs create one generation and provider call`, { timeout: 6000 }, async (t) => {
      if (db.isMemory) return t.skip('Real PostgreSQL locks/unique arbitration');
      let old: ChatGeneration;
      if (action === 'regenerate') old = await seedCompleted();
      else {
        const admitted = await runtime.admit(owner, conversationId, { content: 'Retry me' }, randomUUID());
        old = await repository.finalize(owner, admitted.generation, '', 'failed', 'TEST');
      }
      setup({ chunks: ['New answer'] });
      const key = randomUUID();
      const responses = await Promise.all([variant(old.userMessageId, action, key), variant(old.userMessageId, action, key)]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
      const duplicate = await responses.find((r) => r.status === 409)!.json() as { generation: ChatGeneration };
      const stream = await collect(responses.find((r) => r.status === 200)!);
      assert.equal(duplicate.generation.id, stream[0]!.data.generationId);
      assert.equal(provider.callCount, 1);
      assert.equal(await messageCount('user'), 1);
      assert.equal((await variants(old.userMessageId)).items.length, 2);
    });
  }

  it('Real PostgreSQL rejects invalid selection scope/status independently of service code', async (t) => {
    if (db.isMemory) return t.skip('Real PostgreSQL composite foreign keys/checks');
    const old = await seedCompleted();
    const admitted = await runtime.admitVariant(owner, conversationId, { userMessageId: old.userMessageId, action: 'regenerate' }, randomUUID());
    await assert.rejects(db.pool.query('UPDATE chat_turn_selections SET selected_generation_id = $1 WHERE user_message_id = $2', [admitted.generation.id, old.userMessageId]), { code: '23503' });
    await repository.start(owner, admitted.generation.id);
    await assert.rejects(db.pool.query('UPDATE chat_turn_selections SET selected_generation_id = $1 WHERE user_message_id = $2', [admitted.generation.id, old.userMessageId]), { code: '23503' });
    await repository.finalize(owner, admitted.generation, '', 'failed', 'TEST');
    for (const status of ['failed', 'interrupted', 'stopped'] as const) {
      const invalid = randomUUID();
      await db.pool.query(`INSERT INTO chat_generations (id, owner_id, conversation_id, user_message_id, model_alias, status, idempotency_key, request_fingerprint, finished_at, cancel_requested_at, finish_reason)
          VALUES ($1,$2,$3,$4,'giga-chat-default',$5,$6,$7,NOW(),$8,$9)`,
        [invalid, owner, conversationId, old.userMessageId, status, randomUUID(), 'f'.repeat(64), status === 'stopped' ? new Date() : null, status === 'stopped' ? 'cancelled' : null]);
      await assert.rejects(db.pool.query('UPDATE chat_turn_selections SET selected_generation_id = $1 WHERE user_message_id = $2', [invalid, old.userMessageId]), { code: '23503' });
    }
    await assert.rejects(db.pool.query('UPDATE chat_turn_selections SET owner_id = $1 WHERE user_message_id = $2', [other, old.userMessageId]), { code: '23503' });
    await assert.rejects(db.pool.query("UPDATE chat_turn_selections SET selected_status = 'pending' WHERE user_message_id = $1", [old.userMessageId]), { code: '23514' });
    await assert.rejects(db.pool.query("UPDATE chat_turn_selections SET user_role = 'assistant' WHERE user_message_id = $1", [old.userMessageId]), { code: '23514' });
    assert.equal((await variants(old.userMessageId)).selectedGenerationId, old.id);
    const sibling = randomUUID();
    await db.pool.query("INSERT INTO conversations (id,user_id,title) VALUES ($1,$2,'Sibling')", [sibling, owner]);
    const siblingAttempt = await runtime.admit(owner, sibling, { content: 'Sibling prompt' }, randomUUID());
    await runtime.run(owner, siblingAttempt.generation, async () => {}, new AbortController().signal);
    await assert.rejects(db.pool.query('UPDATE chat_turn_selections SET selected_generation_id = $1 WHERE user_message_id = $2', [siblingAttempt.generation.id, old.userMessageId]), { code: '23503' });
    const anotherTurn = await runtime.admit(owner, conversationId, { content: 'Another turn' }, randomUUID());
    await runtime.run(owner, anotherTurn.generation, async () => {}, new AbortController().signal);
    await assert.rejects(db.pool.query('UPDATE chat_turn_selections SET selected_generation_id = $1 WHERE user_message_id = $2', [anotherTurn.generation.id, old.userMessageId]), { code: '23503' });
  });

  it('retry after a failed regenerate selects the successful retry and excludes failed candidate context', async () => {
    const old = await seedCompleted();
    setup({ errorBeforeFirstToken: new Error('failure') });
    await collect(await variant(old.userMessageId));
    setup({ chunks: ['Retry winner'] });
    await collect(await variant(old.userMessageId, 'retry'));
    const current = await variants(old.userMessageId);
    assert.equal(current.items.length, 3);
    assert.equal(current.selectedGenerationId, current.items[2]!.id);
    await collect(await post(randomUUID(), { content: 'Followup' }));
    assert.deepEqual(provider.lastRequest!.messages, [
      { role: 'user', content: 'Original prompt' }, { role: 'assistant', content: 'Retry winner' }, { role: 'user', content: 'Followup' },
    ]);
  });

  it('failed completion transaction during regenerate retains previous output and selection', async () => {
    const old = await seedCompleted();
    class FailingVariantCompletion extends PostgresGenerationRepository {
      protected override async insertAssistant(client: pg.PoolClient, item: ChatGeneration, text: string): Promise<void> {
        await super.insertAssistant(client, item, text);
        throw new Error('injected variant commit failure');
      }
    }
    setup({}, new FailingVariantCompletion(db.pool));
    const events = await collect(await variant(old.userMessageId));
    assert.equal(events.at(-1)!.event, 'message.failed');
    assert.equal((await variants(old.userMessageId)).selectedGenerationId, old.id);
    assert.equal(await messageCount('assistant'), 1);
    assert.deepEqual(await repository.get(owner, conversationId, old.id), old);
  });

  it('Real PostgreSQL completion exposes output and new selection atomically while cancel waits', { timeout: 6000 }, async (t) => {
    if (db.isMemory) return t.skip('Real PostgreSQL MVCC and row locks');
    const old = await seedCompleted();
    const inserted = gate(); const release = gate(); const cancelEntered = gate();
    class PausedVariantCommit extends PostgresGenerationRepository {
      protected override async insertAssistant(client: pg.PoolClient, item: ChatGeneration, text: string): Promise<void> {
        await super.insertAssistant(client, item, text);
        inserted.release();
        await release.promise;
      }
      override async requestCancel(userId: string, conv: string, id: string, key: string) {
        cancelEntered.release();
        return super.requestCancel(userId, conv, id, key);
      }
    }
    setup({ chunks: ['New winner'] }, new PausedVariantCommit(db.pool));
    const candidate = await runtime.admitVariant(owner, conversationId, { userMessageId: old.userMessageId, action: 'regenerate' }, randomUUID());
    const events: ChatEvent[] = [];
    const running = runtime.run(owner, candidate.generation, async (e) => { events.push(e); }, new AbortController().signal);
    let cancelling: ReturnType<ChatRuntime['cancel']> | undefined;
    try {
      await inserted.promise;
      assert.equal((await db.pool.query('SELECT selected_generation_id FROM chat_turn_selections WHERE user_message_id = $1', [old.userMessageId])).rows[0].selected_generation_id, old.id);
      assert.equal(await messageCount('assistant'), 1, 'uncommitted candidate assistant must be invisible');
      assert.equal((await repository.get(owner, conversationId, candidate.generation.id)).status, 'streaming');
      cancelling = runtime.cancel(owner, conversationId, candidate.generation.id, randomUUID());
      await cancelEntered.promise;
      const deadline = Date.now() + 1000;
      let blocked = false;
      while (Date.now() < deadline) {
        const locks = await db.pool.query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM conversations%FOR UPDATE%'");
        if (locks.rows.length) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true);
    } finally { release.release(); await running; }
    assert.equal((await cancelling!).accepted, false);
    assert.equal((await variants(old.userMessageId)).selectedGenerationId, candidate.generation.id);
    assert.equal(events.at(-1)!.event, 'message.completed');
    assert.equal(await messageCount('assistant'), 2);
  });

  it('Real PostgreSQL Stop wins a regenerate completion race without replacing selection', { timeout: 6000 }, async (t) => {
    if (db.isMemory) return t.skip('Real PostgreSQL variant completion race');
    const old = await seedCompleted();
    const ready = gate(); const release = gate();
    class PausedVariantCompletion extends PostgresGenerationRepository {
      override async complete(userId: string, item: ChatGeneration, text: string, reason: 'stop' | 'length' | 'other' | 'cancelled'): Promise<ChatGeneration> {
        ready.release(); await release.promise;
        return super.complete(userId, item, text, reason);
      }
    }
    setup({ chunks: ['Candidate'] }, new PausedVariantCompletion(db.pool));
    const candidate = await runtime.admitVariant(owner, conversationId, { userMessageId: old.userMessageId, action: 'regenerate' }, randomUUID());
    const events: ChatEvent[] = [];
    const running = runtime.run(owner, candidate.generation, async (e) => { events.push(e); }, new AbortController().signal);
    try {
      await ready.promise;
      await runtime.cancel(owner, conversationId, candidate.generation.id, randomUUID());
    } finally { release.release(); await running; }
    assert.equal((await variants(old.userMessageId)).selectedGenerationId, old.id);
    assert.equal((await repository.get(owner, conversationId, candidate.generation.id)).status, 'stopped');
    assert.equal(events.at(-1)!.event, 'message.stopped');
    assert.equal(await messageCount('assistant'), 1);
  });

  before(async () => { db = await createTestDatabase(); });
  afterEach(() => { assert.equal(runtime.activeGenerationCount, 0, 'controller registry must be empty after every terminal path'); });
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

  async function cancelPost(id: string, key: string = randomUUID(), options: { body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
    return app.request(`/api/v1/conversations/${conversationId}/generations/${id}/cancel`, {
      method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Idempotency-Key': key, ...options.headers },
      ...(options.body === undefined ? {} : { body: options.body }),
    });
  }

  it('cancel pending commits stopped before provider invocation and GET reconciles it', async () => {
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    const response = await cancelPost(admitted.generation.id);
    assert.equal(response.status, 202);
    const stored = (await response.json() as { generation: ChatGeneration }).generation;
    assert.equal(stored.status, 'stopped');
    assert.equal(stored.finishReason, 'cancelled');
    assert.ok(stored.finishedAt && stored.cancelRequestedAt);
    assert.equal(stored.assistantMessageId, undefined);
    const events: ChatEvent[] = [];
    await runtime.run(owner, admitted.generation, async (e) => { events.push(e); }, new AbortController().signal);
    assert.deepEqual(events.map((e) => e.event), ['message.started', 'message.stopped']);
    const get = await app.request(`/api/v1/conversations/${conversationId}/generations/${stored.id}`, { headers: { Cookie: cookie } });
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), { generation: stored });
    assert.equal(provider.callCount, 0);
    assert.equal(await messageCount('assistant'), 0);
  });

  it('durable Stop preserves the full local partial and emits one stopped without an error', async () => {
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    const events: ChatEvent[] = [];
    let abortObserved = false;
    await runtime.run(owner, admitted.generation, async (event) => {
      events.push(event);
      if (event.event === 'message.delta') {
        assert.equal((await generation()).partialContent, ''); // below the checkpoint threshold
        provider.lastRequest!.signal.addEventListener('abort', () => { abortObserved = true; }, { once: true });
        const result = await runtime.cancel(owner, conversationId, admitted.generation.id, randomUUID());
        assert.equal(result.accepted, true);
        assert.ok(result.generation.cancelRequestedAt); // durable before provider abort
        assert.equal(abortObserved, true);
      }
    }, new AbortController().signal);
    assert.deepEqual(events.map((e) => e.event), ['message.started', 'message.delta', 'message.stopped']);
    const stored = await generation();
    assert.equal(stored.status, 'stopped');
    assert.equal(stored.partialContent, 'Hello');
    assert.equal(stored.error, undefined);
    assert.equal(await messageCount('assistant'), 0);
  });

  it('original HTTP SSE receives exactly one stopped event after the cancel endpoint', { timeout: 5000 }, async () => {
    setup({ chunkDelayMs: 150 });
    const response = await post();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let stream = '';
    while (!stream.includes('event: message.delta')) stream += decoder.decode((await reader.read()).value, { stream: true });
    const stored = await generation();
    assert.equal((await cancelPost(stored.id)).status, 202);
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      stream += decoder.decode(next.value, { stream: true });
    }
    const events = eventsFrom(stream);
    assert.deepEqual(events.map((e) => e.event), ['message.started', 'message.delta', 'message.stopped']);
    assert.deepEqual(events.at(-1)!.data, { messageId: stored.id, generationId: stored.id, finishReason: 'cancelled' });
    assert.equal((await generation()).status, 'stopped');
    assert.equal(provider.lastRequest!.signal.aborted, true);
  });

  it('same cancel key reconciles without changing timestamps or terminal state', async () => {
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    const key = randomUUID();
    const first = await cancelPost(admitted.generation.id, key);
    assert.equal(first.status, 202);
    const result = await first.json();
    const repeat = await cancelPost(admitted.generation.id, key);
    assert.equal(repeat.status, 200);
    assert.deepEqual(await repeat.json(), result);
    const bindings = await db.pool.query("SELECT * FROM chat_operation_keys WHERE operation = 'cancel'");
    assert.equal(bindings.rows.length, 1);
  });

  it('cancel keys cannot be reused for another generation or a prompt operation', async () => {
    const promptKey = randomUUID();
    const first = await runtime.admit(owner, conversationId, { content: 'Hello' }, promptKey);
    assert.equal((await cancelPost(first.generation.id, promptKey)).status, 409);
    assert.equal((await generation()).status, 'pending');
    const key = randomUUID();
    assert.equal((await cancelPost(first.generation.id, key)).status, 202);
    const next = await runtime.admit(owner, conversationId, { content: 'Next' }, randomUUID());
    assert.equal((await cancelPost(next.generation.id, key)).status, 409);
    assert.equal((await repository.get(owner, conversationId, next.generation.id)).status, 'pending');
    await runtime.cancel(owner, conversationId, next.generation.id, randomUUID());
    await assert.rejects(runtime.admit(owner, conversationId, { content: 'Next' }, key), { statusCode: 409 });
    assert.equal(await messageCount('user'), 2);
  });

  it('cross-owner cancel returns 404 and does not abort the active provider', async () => {
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    await runtime.run(owner, admitted.generation, async (event) => {
      if (event.event === 'message.delta') {
        assert.equal((await cancelPost(admitted.generation.id, randomUUID(), { headers: { Cookie: otherCookie } })).status, 404);
        assert.equal(provider.lastRequest!.signal.aborted, false);
        assert.equal((await generation()).cancelRequestedAt, undefined);
      }
    }, new AbortController().signal);
    assert.equal((await generation()).status, 'completed');
  });

  it('cancel enforces empty body, bounded keys, authentication and strict CSRF', async () => {
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    const id = admitted.generation.id;
    for (const body of ['{}', ' ', '\n', 'null', '{"modelId":"raw"}']) assert.equal((await cancelPost(id, randomUUID(), { body })).status, 400);
    for (const key of ['', 'with spaces', 'a'.repeat(129)]) assert.equal((await cancelPost(id, key)).status, 400);
    const missing = await app.request(`/api/v1/conversations/${conversationId}/generations/${id}/cancel`, { method: 'POST', headers: { Origin: origin, Cookie: cookie } });
    assert.equal(missing.status, 400);
    assert.equal((await cancelPost(id, randomUUID(), { headers: { Cookie: '' } })).status, 401);
    assert.equal((await cancelPost(id, randomUUID(), { headers: { Origin: '' } })).status, 403);
    assert.equal((await cancelPost(id, randomUUID(), { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await generation()).cancelRequestedAt, undefined);
    assert.equal(provider.callCount, 0);
  });

  for (const terminal of ['failed', 'interrupted', 'completed'] as const) {
    it(`cancel cannot downgrade an already ${terminal} generation`, async () => {
      if (terminal === 'failed') setup({ errorBeforeFirstToken: new Error('failure') });
      const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
      const abort = new AbortController();
      if (terminal === 'interrupted') abort.abort();
      await runtime.run(owner, admitted.generation, async () => {}, abort.signal);
      const before = await generation();
      assert.equal(before.status, terminal);
      const response = await cancelPost(before.id);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { generation: before });
      assert.deepEqual(await generation(), before);
    });
  }

  it('a Stop handled by another coordinator fences completion and late tokens', async () => {
    const remote = new ChatRuntime(new PostgresGenerationRepository(db.pool), engineFor(provider));
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    const events: ChatEvent[] = [];
    await runtime.run(owner, admitted.generation, async (event) => {
      events.push(event);
      if (event.event === 'message.delta') {
        await remote.cancel(owner, conversationId, admitted.generation.id, randomUUID());
        assert.equal(provider.lastRequest!.signal.aborted, false, 'another coordinator cannot instantly signal this provider');
      }
    }, new AbortController().signal);
    assert.deepEqual(events.map((e) => e.event), ['message.started', 'message.delta', 'message.stopped']);
    assert.equal((await generation()).status, 'stopped');
    assert.equal(await messageCount('assistant'), 0);
    assert.equal(remote.activeGenerationCount, 0);
  });

  it('durably recorded intent alone fences completion before any abort/finalization', async () => {
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    await repository.start(owner, admitted.generation.id);
    await repository.checkpoint(owner, admitted.generation.id, 'partial');
    await repository.requestCancel(owner, conversationId, admitted.generation.id, randomUUID());
    await assert.rejects(repository.complete(owner, admitted.generation, 'must not commit', 'stop'), { statusCode: 409 });
    const stopped = await repository.finalize(owner, admitted.generation, 'partial', 'failed', 'GENERATION_FAILED');
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.partialContent, 'partial');
    assert.equal(await messageCount('assistant'), 0);
  });

  it('late provider output after local Stop cannot emit or change stopped state', { timeout: 5000 }, async () => {
    setup({ emitTokensAfterAbort: true, chunkDelayMs: 20 });
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    const events: ChatEvent[] = [];
    await runtime.run(owner, admitted.generation, async (event) => {
      events.push(event);
      if (event.event === 'message.delta') await runtime.cancel(owner, conversationId, admitted.generation.id, randomUUID());
    }, new AbortController().signal);
    const stopped = await generation();
    await assert.rejects(repository.checkpoint(owner, stopped.id, 'late'));
    await assert.rejects(repository.complete(owner, stopped, 'late', 'stop'));
    assert.deepEqual(await generation(), stopped);
    assert.equal(events.filter((e) => e.event === 'message.delta').length, 1);
    assert.equal(events.filter((e) => e.event === 'message.stopped').length, 1);
  });

  it('cancel after conversation deletion is 404 and cannot resurrect state or bind keys', async () => {
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    await db.pool.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
    assert.equal((await cancelPost(admitted.generation.id)).status, 404);
    assert.equal((await db.pool.query("SELECT * FROM chat_operation_keys WHERE operation = 'cancel'")).rows.length, 0);
    assert.equal(provider.callCount, 0);
  });

  it('terminal transition guard and stopped/completed constraints hold on Real PostgreSQL', async (t) => {
    if (db.isMemory) return t.skip('PostgreSQL trigger/constraint enforcement is not emulated');
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    await assert.rejects(db.pool.query("UPDATE chat_generations SET status = 'stopped' WHERE id = $1", [admitted.generation.id]));
    await assert.rejects(db.pool.query("UPDATE chat_generations SET status = 'completed', finished_at = NOW() WHERE id = $1", [admitted.generation.id]));
    await runtime.cancel(owner, conversationId, admitted.generation.id, randomUUID());
    for (const status of ['pending', 'streaming', 'completed', 'failed', 'interrupted']) {
      await assert.rejects(db.pool.query('UPDATE chat_generations SET status = $2 WHERE id = $1', [admitted.generation.id, status]));
    }
    assert.equal((await generation()).status, 'stopped');
  });

  // Each gate rejects after two seconds and is released in finally: race tests cannot
  // leave a PoolClient or an unresolved test promise behind after an assertion failure.
  function gate(): { promise: Promise<void>; release: () => void } {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Race gate timed out')), 2000);
      release = () => { clearTimeout(timer); resolve(); };
    });
    void promise.catch(() => {});
    return { promise, release };
  }

  it('Real PostgreSQL Stop wins while completion is ready but has not locked the row', { timeout: 6000 }, async (t) => {
    if (db.isMemory) return t.skip('Real PostgreSQL transaction race');
    const atCompletion = gate(); const releaseCompletion = gate();
    class PausedCompletion extends PostgresGenerationRepository {
      override async complete(userId: string, item: ChatGeneration, text: string, reason: 'stop' | 'length' | 'other' | 'cancelled'): Promise<ChatGeneration> {
        atCompletion.release();
        await releaseCompletion.promise;
        return super.complete(userId, item, text, reason);
      }
    }
    setup({}, new PausedCompletion(db.pool));
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    const events: ChatEvent[] = [];
    const running = runtime.run(owner, admitted.generation, async (e) => { events.push(e); }, new AbortController().signal);
    try {
      await atCompletion.promise;
      await runtime.cancel(owner, conversationId, admitted.generation.id, randomUUID());
    } finally { releaseCompletion.release(); await running; }
    assert.equal((await generation()).status, 'stopped');
    assert.equal((await generation()).partialContent, 'Hello world!');
    assert.equal(await messageCount('assistant'), 0);
    assert.equal(events.at(-1)!.event, 'message.stopped');
    assert.equal(events.filter((e) => e.event === 'message.stopped').length, 1);
    assert.ok(!events.some((e) => e.event === 'message.completed' || e.event === 'message.failed' || e.event === 'stream.error'));
  });

  it('Real PostgreSQL Completion wins when cancel waits on its transaction lock', { timeout: 6000 }, async (t) => {
    if (db.isMemory) return t.skip('Real PostgreSQL row locks');
    const insideTransaction = gate(); const releaseCommit = gate(); const cancelEntered = gate();
    class PausedCommit extends PostgresGenerationRepository {
      protected override async insertAssistant(client: pg.PoolClient, item: ChatGeneration, text: string): Promise<void> {
        await super.insertAssistant(client, item, text);
        insideTransaction.release();
        await releaseCommit.promise;
      }
      override async requestCancel(userId: string, conv: string, id: string, key: string) {
        cancelEntered.release();
        return super.requestCancel(userId, conv, id, key);
      }
    }
    setup({}, new PausedCommit(db.pool));
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    const events: ChatEvent[] = [];
    const running = runtime.run(owner, admitted.generation, async (e) => { events.push(e); }, new AbortController().signal);
    let cancelling: ReturnType<ChatRuntime['cancel']> | undefined;
    try {
      await insideTransaction.promise;
      cancelling = runtime.cancel(owner, conversationId, admitted.generation.id, randomUUID());
      await cancelEntered.promise;
      const lockDeadline = Date.now() + 1000;
      let blocked = false;
      while (Date.now() < lockDeadline) {
        const waiting = await db.pool.query(`SELECT pid FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query LIKE '%FROM conversations%FOR UPDATE%'`);
        if (waiting.rows.length > 0) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, 'cancel must actually wait for the completion transaction lock');
    } finally { releaseCommit.release(); await running; }
    const result = await cancelling!;
    assert.equal(result.accepted, false);
    assert.equal(result.generation.status, 'completed');
    assert.equal(result.generation.cancelRequestedAt, undefined);
    assert.equal(await messageCount('assistant'), 1);
    assert.equal(events.at(-1)!.event, 'message.completed');
  });

  it('Real PostgreSQL concurrent cancellation with the same key is idempotent', { timeout: 5000 }, async (t) => {
    if (db.isMemory) return t.skip('Real PostgreSQL row locks/unique conflict arbitration');
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    const key = randomUUID();
    const results = await Promise.all([
      runtime.cancel(owner, conversationId, admitted.generation.id, key),
      runtime.cancel(owner, conversationId, admitted.generation.id, key),
    ]);
    assert.ok(results.every((r) => r.generation.id === admitted.generation.id));
    assert.equal((await generation()).status, 'stopped');
    const stored = await generation();
    assert.deepEqual((await runtime.cancel(owner, conversationId, admitted.generation.id, key)).generation, stored);
    assert.equal((await db.pool.query("SELECT * FROM chat_operation_keys WHERE operation = 'cancel'")).rows.length, 1);
  });

  it('records cancel keys on already-terminal rows and retains key identity after deletion', async () => {
    await collect(await post());
    const stored = await generation();
    const key = randomUUID();
    assert.equal((await cancelPost(stored.id, key)).status, 200);
    await db.pool.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
    conversationId = randomUUID();
    await db.pool.query('INSERT INTO conversations (id,user_id,title) VALUES ($1,$2,$3)', [conversationId, owner, 'New']);
    await assert.rejects(runtime.admit(owner, conversationId, { content: 'Hello' }, key), { statusCode: 409 });
    const next = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    assert.equal((await cancelPost(next.generation.id, key)).status, 409);
    assert.equal(await messageCount('user'), 1);
  });

  it('a failure to record durable cancel intent never aborts the provider', async () => {
    class FailingIntent extends PostgresGenerationRepository {
      override async requestCancel(): Promise<never> { throw new Error('injected durable cancel failure'); }
    }
    setup({}, new FailingIntent(db.pool));
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    await runtime.run(owner, admitted.generation, async (event) => {
      if (event.event === 'message.delta') {
        await assert.rejects(runtime.cancel(owner, conversationId, admitted.generation.id, randomUUID()));
        assert.equal(provider.lastRequest!.signal.aborted, false);
      }
    }, new AbortController().signal);
    assert.equal((await generation()).status, 'completed');
  });

  it('durable Stop survives downstream disconnect without fabricating terminal delivery', async () => {
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    const abort = new AbortController();
    const events: ChatEvent[] = [];
    await runtime.run(owner, admitted.generation, async (event) => {
      events.push(event);
      if (event.event === 'message.delta') {
        await runtime.cancel(owner, conversationId, admitted.generation.id, randomUUID());
        abort.abort();
      }
    }, abort.signal);
    assert.equal((await generation()).status, 'stopped');
    assert.equal((await generation()).partialContent, 'Hello');
    assert.deepEqual(events.map((e) => e.event), ['message.started', 'message.delta']);
  });

  it('conversation deletion after durable intent cannot resurrect a stopped conversation', async () => {
    class DeleteAfterIntent extends PostgresGenerationRepository {
      override async requestCancel(userId: string, conv: string, id: string, key: string) {
        const result = await super.requestCancel(userId, conv, id, key);
        await db.pool.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [conv, userId]);
        return result;
      }
    }
    setup({}, new DeleteAfterIntent(db.pool));
    const admitted = await runtime.admit(owner, conversationId, { content: 'Hello' }, randomUUID());
    await runtime.run(owner, admitted.generation, async (event) => {
      if (event.event === 'message.delta') await runtime.cancel(owner, conversationId, admitted.generation.id, randomUUID());
    }, new AbortController().signal);
    await assert.rejects(repository.get(owner, conversationId, admitted.generation.id), { statusCode: 404 });
    assert.equal(await messageCount('assistant'), 0);
    assert.equal(provider.lastRequest!.signal.aborted, true);
  });
});
