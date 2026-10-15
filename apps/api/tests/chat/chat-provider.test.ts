import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createTestDatabase, type TestDbInstance } from '../test-db-helper.js';
import { UserRepository } from '../../src/db/repositories/user-repository.js';
import { SessionRepository } from '../../src/db/repositories/session-repository.js';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../../src/modules/auth/session.js';
import { PostgresGenerationRepository } from '../../src/modules/chat/generation-repository.js';
import { ChatRuntime } from '../../src/modules/chat/chat-runtime.js';
import { createChatEngine } from '../../src/modules/llm/chat-bootstrap.js';
import { CHAT_MODEL_ID, type ProviderTransport } from '../../src/modules/llm/providers/gemini/gemini-provider.js';
import { startServer } from '../../src/app/server.js';
import { loadConfig } from '../../src/app/config.js';
import { geminiFrame, providerResponse } from '../llm/gemini-fixture.js';

const providerConfig = { apiKey: 'test-only-placeholder-key', modelId: CHAT_MODEL_ID, maxOutputTokens: 32 };
const origin = 'http://localhost:3000';
describe('Real adapter through Chat startup and persistence', { timeout: 15000 }, () => {
  let db: TestDbInstance; let owner: string; let conversation: string; let cookie: string;
  before(async () => { db = await createTestDatabase(); });
  after(async () => { await db.cleanup(); await db.pool.end(); });
  beforeEach(async () => {
    await db.cleanup();
    owner = (await new UserRepository(db.pool).createUser({ email: `${randomUUID()}@example.com`, displayName: 'Provider test', passwordHash: 'test-unused' })).id;
    const token = generateSessionToken();
    await new SessionRepository(db.pool).createSession({ userId: owner, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60000) });
    cookie = `${SESSION_COOKIE_NAME}=${token}`;
    conversation = randomUUID();
    await db.pool.query("INSERT INTO conversations (id,user_id,title) VALUES ($1,$2,'Provider test')", [conversation, owner]);
  });

  it('normal configured startup streams new messages, Regenerate, Retry and durable Stop using one Gemini engine', async () => {
    let calls = 0; let mode: 'success' | 'failure' | 'stop' = 'success'; let stopped = false; let lastSignal: AbortSignal | undefined;
    const transport: ProviderTransport = async (_url, init) => {
      calls++; lastSignal = init.signal as AbortSignal;
      assert.equal(new Headers(init.headers).get('x-goog-api-key'), providerConfig.apiKey);
      assert.equal(JSON.parse(init.body as string).generationConfig.maxOutputTokens, 32);
      const active = await db.pool.query("SELECT resolved_provider_id,resolved_model_id FROM chat_generations WHERE conversation_id = $1 AND status = 'streaming'", [conversation]);
      assert.deepEqual(active.rows, [{ resolved_provider_id: 'gemini', resolved_model_id: CHAT_MODEL_ID }], 'identity must commit before provider invocation');
      if (mode === 'success') return providerResponse(undefined, 3);
      if (mode === 'failure') return providerResponse(geminiFrame('partial')); // missing terminal
      return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(geminiFrame('partial'))); }, cancel() { stopped = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const config = { ...loadConfig({ NODE_ENV: 'test' }), chatEnabled: true, chat: providerConfig, allowedOrigins: [origin] };
    const { server } = await startServer({ pool: db.pool, config, port: 0, skipMigrations: true, providerTransport: transport });
    try {
      if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/conversations/${conversation}`;
      async function post(path: string, body?: unknown): Promise<Response> {
        return fetch(base + path, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      }
      async function completed(response: Response): Promise<string> {
        assert.equal(response.status, 200);
        const text = await response.text(); assert.match(text, /message.completed/);
        const started = JSON.parse(text.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
        return started.generationId as string;
      }
      const first = await completed(await post('/messages:stream', { content: 'Hello' }));
      const repo = new PostgresGenerationRepository(db.pool);
      const original = await repo.get(owner, conversation, first);
      await completed(await post('/generations:stream', { userMessageId: original.userMessageId, action: 'regenerate' }));
      assert.equal((await repo.variants(owner, conversation, original.userMessageId)).items.length, 2);
      assert.equal((await db.pool.query("SELECT id FROM messages WHERE role='user'")).rows.length, 1);
      mode = 'failure';
      const failed = await post('/messages:stream', { content: 'Try again' });
      assert.match(await failed.text(), /message.failed/);
      const latest = (await db.pool.query("SELECT user_message_id FROM chat_generations WHERE status='failed'")).rows[0].user_message_id as string;
      mode = 'success';
      const retried = await completed(await post('/generations:stream', { userMessageId: latest, action: 'retry' }));
      mode = 'stop';
      const streaming = await post('/generations:stream', { userMessageId: latest, action: 'regenerate' });
      const reader = streaming.body!.getReader(); let text = '';
      while (!text.includes('message.delta')) { const chunk = await reader.read(); assert.equal(chunk.done, false); text += new TextDecoder().decode(chunk.value); }
      const id = JSON.parse(text.split('\n').find((line) => line.startsWith('data: '))!.slice(6)).generationId as string;
      assert.equal((await post(`/generations/${id}/cancel`)).status, 202);
      while (true) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
      assert.match(text, /message.stopped/); assert.ok(!text.includes('message.completed'));
      assert.equal(stopped, true); assert.equal(lastSignal!.aborted, true);
      assert.equal((await repo.get(owner, conversation, id)).status, 'stopped');
      assert.equal((await repo.variants(owner, conversation, latest)).selectedGenerationId, retried);
      assert.equal(calls, 5);
      const safe = JSON.stringify(await repo.get(owner, conversation, retried));
      for (const secret of [providerConfig.apiKey, CHAT_MODEL_ID, 'resolved_provider', 'gemini']) assert.ok(!safe.includes(secret));
    } finally {
      if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    }
  });

  it('identity persistence failure prevents any real adapter request', async () => {
    let calls = 0;
    class FailingIdentity extends PostgresGenerationRepository {
      override async recordResolvedModel(): Promise<void> { throw new Error('test identity persistence failure'); }
    }
    const runtime = new ChatRuntime(new FailingIdentity(db.pool), createChatEngine(providerConfig, async () => { calls++; return providerResponse(); }), { maxOutputTokens: 32 });
    const admitted = await runtime.admit(owner, conversation, { content: 'Hello' }, randomUUID());
    const events: string[] = [];
    await runtime.run(owner, admitted.generation, async (event) => { events.push(event.event); }, new AbortController().signal);
    assert.equal(calls, 0); assert.equal(events.at(-1), 'message.failed'); assert.equal(runtime.activeGenerationCount, 0);
  });

  it('Real PostgreSQL makes resolved identity write-once and leaves terminal legacy identity unknown', async (t) => {
    if (db.isMemory) return t.skip('PostgreSQL write-once trigger');
    const repo = new PostgresGenerationRepository(db.pool);
    const admitted = await repo.admit({ ownerId: owner, conversationId: conversation, content: 'Hello', modelId: 'giga-chat-default', key: randomUUID(), fingerprint: 'f'.repeat(64) });
    await assert.rejects(db.pool.query("UPDATE chat_generations SET resolved_provider_id='gemini', resolved_model_id=$2 WHERE id=$1", [admitted.generation.id, CHAT_MODEL_ID]), /write-once/);
    await repo.start(owner, admitted.generation.id);
    await repo.recordResolvedModel(owner, admitted.generation.id, { providerId: 'gemini', modelId: CHAT_MODEL_ID });
    await repo.recordResolvedModel(owner, admitted.generation.id, { providerId: 'gemini', modelId: CHAT_MODEL_ID });
    await assert.rejects(db.pool.query("UPDATE chat_generations SET resolved_model_id='changed' WHERE id=$1", [admitted.generation.id]), /write-once/);
    await assert.rejects(db.pool.query('UPDATE chat_generations SET resolved_model_id=NULL,resolved_provider_id=NULL WHERE id=$1', [admitted.generation.id]), /write-once/);
    await repo.finalize(owner, admitted.generation, '', 'failed', 'TEST');
    const legacy = await repo.admit({ ownerId: owner, conversationId: conversation, content: 'Legacy', modelId: 'giga-chat-default', key: randomUUID(), fingerprint: 'e'.repeat(64) });
    await repo.finalize(owner, legacy.generation, '', 'failed', 'TEST');
    await assert.rejects(db.pool.query("UPDATE chat_generations SET resolved_provider_id='gemini',resolved_model_id=$2 WHERE id=$1", [legacy.generation.id, CHAT_MODEL_ID]), /write-once/);
    assert.equal((await db.pool.query('SELECT resolved_model_id FROM chat_generations WHERE id=$1', [legacy.generation.id])).rows[0].resolved_model_id, null);
  });
});
