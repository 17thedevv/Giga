import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ModelRegistry } from '../../src/modules/llm/registry.js';
import { LLMEngine } from '../../src/modules/llm/engine.js';
import { FakeProvider } from '../../src/modules/llm/testing/fake-provider.js';
import { GeminiProvider, CHAT_MODEL_ID, type ProviderTransport } from '../../src/modules/llm/providers/gemini/gemini-provider.js';
import { ProviderCredential } from '../../src/modules/llm/provider-credential.js';
import type { LLMStreamEvent, ReasoningEffort, ResolvedLLMRequest } from '../../src/modules/llm/types.js';
import { createTestDatabase, type TestDbInstance } from '../test-db-helper.js';
import { UserRepository } from '../../src/db/repositories/user-repository.js';
import { SessionRepository } from '../../src/db/repositories/session-repository.js';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../../src/modules/auth/session.js';
import { PostgresGenerationRepository } from '../../src/modules/chat/generation-repository.js';
import { ChatRuntime, CHAT_MODEL_ALIAS } from '../../src/modules/chat/chat-runtime.js';
import { startServer } from '../../src/app/server.js';
import { loadConfig } from '../../src/app/config.js';
import { geminiFrame, providerResponse } from './gemini-fixture.js';

const platformKey = 'test-platform-gemini-key';
const platformCredential = new ProviderCredential(platformKey, 'platform');
const userKey = 'test-user-byok-gemini-key';
const byokCredential = new ProviderCredential(userKey, 'user');
const origin = 'http://localhost:3000';

function makeResolvedRequest(effort?: ReasoningEffort, modelId = CHAT_MODEL_ID): ResolvedLLMRequest {
  return {
    modelAlias: 'giga-chat-default',
    providerId: 'gemini',
    modelId,
    messages: [{ role: 'user', content: 'Explain quantum computing' }],
    maxOutputTokens: 100,
    caller: 'chat',
    requestId: 'req-' + randomUUID(),
    signal: new AbortController().signal,
    reasoningEffort: effort,
  };
}

describe('Provider-agnostic Model Reasoning Capability', () => {
  describe('1. Model Registry capability declaration & discovery', () => {
    it('advertises per-model reasoning capabilities and distinguishes models with and without reasoning', () => {
      const registry = new ModelRegistry();
      const fake = new FakeProvider({
        providerId: 'fake-multi',
        reasoning: (modelId) => {
          if (modelId === 'model-reasoning-all') return { supported: true, efforts: ['low', 'medium', 'high'] };
          if (modelId === 'model-reasoning-partial') return { supported: true, efforts: ['low', 'medium'] };
          return { supported: false, efforts: [] };
        },
      });
      registry.registerAdapter(fake);

      registry.registerAlias({
        alias: 'all-efforts',
        providerId: 'fake-multi',
        modelId: 'model-reasoning-all',
        requiredCapabilities: ['text', 'streaming'],
        reasoning: { supported: true, efforts: ['low', 'medium', 'high'] },
      });

      registry.registerAlias({
        alias: 'partial-efforts',
        providerId: 'fake-multi',
        modelId: 'model-reasoning-partial',
        requiredCapabilities: ['text', 'streaming'],
        reasoning: { supported: true, efforts: ['low', 'medium'] },
      });

      registry.registerAlias({
        alias: 'no-reasoning',
        providerId: 'fake-multi',
        modelId: 'model-no-reasoning',
        requiredCapabilities: ['text', 'streaming'],
        reasoning: { supported: false, efforts: [] },
      });

      registry.validate();

      // Model metadata inspection
      assert.deepEqual(registry.getReasoningCapabilities('all-efforts'), { supported: true, efforts: ['low', 'medium', 'high'] });
      assert.deepEqual(registry.getReasoningCapabilities('partial-efforts'), { supported: true, efforts: ['low', 'medium'] });
      assert.deepEqual(registry.getReasoningCapabilities('no-reasoning'), { supported: false, efforts: [] });

      // listModels exposes normalized public metadata
      const models = registry.listModels();
      assert.equal(models.length, 3);
      assert.deepEqual(models.find((m) => m.id === 'all-efforts'), {
        id: 'all-efforts',
        capabilities: ['text', 'streaming'],
        reasoning: { supported: true, efforts: ['low', 'medium', 'high'] },
      });
      assert.deepEqual(models.find((m) => m.id === 'no-reasoning'), {
        id: 'no-reasoning',
        capabilities: ['text', 'streaming'],
        reasoning: { supported: false, efforts: [] },
      });
    });

    it('rejects invalid reasoning configuration at alias registration', () => {
      const registry = new ModelRegistry();
      const fake = new FakeProvider({ providerId: 'test-p' });
      registry.registerAdapter(fake);

      // Invalid effort name
      assert.throws(
        () => registry.registerAlias({
          alias: 'bad-effort',
          providerId: 'test-p',
          modelId: 'm1',
          requiredCapabilities: ['streaming'],
          reasoning: { supported: true, efforts: ['extreme' as unknown as ReasoningEffort] },
        }),
        /invalid reasoning effort/
      );

      // Non-boolean supported
      assert.throws(
        () => registry.registerAlias({
          alias: 'bad-supported',
          providerId: 'test-p',
          modelId: 'm1',
          requiredCapabilities: ['streaming'],
          reasoning: { supported: 'yes' as unknown as boolean, efforts: ['low'] },
        }),
        /reasoning.supported must be a boolean/
      );
    });

    it('fail-fast validation detects mismatch between alias reasoning claims and adapter support', () => {
      const registry = new ModelRegistry();
      const fake = new FakeProvider({
        providerId: 'limited-p',
        reasoning: () => ({ supported: true, efforts: ['low'] }),
      });
      registry.registerAdapter(fake);

      registry.registerAlias({
        alias: 'overclaiming',
        providerId: 'limited-p',
        modelId: 'm1',
        requiredCapabilities: ['streaming'],
        reasoning: { supported: true, efforts: ['low', 'high'] },
      });

      assert.throws(() => registry.validate(), /requires reasoning effort 'high'/);
    });
  });

  describe('2. Core LLM Engine normalized effort & provider agnosticism', () => {
    it('passes normalized effort to fake adapter without provider branching', async () => {
      const fake = new FakeProvider({
        providerId: 'test-fake',
        chunks: ['Reasoned response'],
        reasoning: () => ({ supported: true, efforts: ['low', 'medium', 'high'] }),
      });
      const registry = new ModelRegistry();
      registry.registerAdapter(fake);
      registry.registerAlias({
        alias: 'fake-chat',
        providerId: 'test-fake',
        modelId: 'fake-model-1',
        requiredCapabilities: ['streaming', 'text'],
        reasoning: { supported: true, efforts: ['low', 'medium', 'high'] },
      });
      const engine = new LLMEngine(registry);

      for (const effort of ['low', 'medium', 'high'] as const) {
        const prepared = engine.prepareStream({
          modelAlias: 'fake-chat',
          messages: [{ role: 'user', content: 'test' }],
          maxOutputTokens: 50,
          requestId: 'test-' + effort,
          caller: 'chat',
          signal: new AbortController().signal,
          reasoningEffort: effort,
        });

        const events: LLMStreamEvent[] = [];
        for await (const ev of prepared.stream) events.push(ev);

        assert.equal(events.at(-1)?.type, 'completed');
        assert.equal(fake.lastRequest?.reasoningEffort, effort, 'Adapter must receive exact normalized effort');
      }

      // Absent effort passes undefined preserving provider default
      const legacy = engine.prepareStream({
        modelAlias: 'fake-chat',
        messages: [{ role: 'user', content: 'test' }],
        maxOutputTokens: 50,
        requestId: 'test-legacy',
        caller: 'chat',
        signal: new AbortController().signal,
      });
      for await (const _ of legacy.stream) { /* drain */ }
      assert.equal(fake.lastRequest?.reasoningEffort, undefined, 'Absent effort must remain undefined');
    });

    it('rejects unsupported effort before transport / provider invocation', async () => {
      const fake = new FakeProvider({
        providerId: 'test-fake',
        reasoning: () => ({ supported: true, efforts: ['low', 'medium'] }),
      });
      const registry = new ModelRegistry();
      registry.registerAdapter(fake);
      registry.registerAlias({
        alias: 'low-medium-only',
        providerId: 'test-fake',
        modelId: 'model-lm',
        requiredCapabilities: ['streaming'],
        reasoning: { supported: true, efforts: ['low', 'medium'] },
      });
      registry.registerAlias({
        alias: 'no-reasoning-model',
        providerId: 'test-fake',
        modelId: 'model-plain',
        requiredCapabilities: ['streaming'],
        reasoning: { supported: false, efforts: [] },
      });
      const engine = new LLMEngine(registry);

      // Model does not support 'high'
      assert.throws(
        () => engine.prepareStream({
          modelAlias: 'low-medium-only',
          messages: [{ role: 'user', content: 'test' }],
          maxOutputTokens: 50,
          requestId: 'req-unsupported-effort',
          caller: 'chat',
          signal: new AbortController().signal,
          reasoningEffort: 'high',
        }),
        (err: unknown) => {
          const e = err as { code: string; statusCode: number };
          assert.equal(e.code, 'UNSUPPORTED_REASONING_EFFORT');
          assert.equal(e.statusCode, 400);
          return true;
        }
      );
      assert.equal(fake.callCount, 0, 'Provider must not be invoked');

      // Model does not support reasoning at all
      assert.throws(
        () => engine.prepareStream({
          modelAlias: 'no-reasoning-model',
          messages: [{ role: 'user', content: 'test' }],
          maxOutputTokens: 50,
          requestId: 'req-no-reasoning',
          caller: 'chat',
          signal: new AbortController().signal,
          reasoningEffort: 'low',
        }),
        (err: unknown) => {
          const e = err as { code: string; statusCode: number };
          assert.equal(e.code, 'UNSUPPORTED_REASONING_EFFORT');
          return true;
        }
      );
      assert.equal(fake.callCount, 0);

      // Invalid effort format (not low/medium/high) rejected in validateRequest
      assert.throws(
        () => engine.prepareStream({
          modelAlias: 'low-medium-only',
          messages: [{ role: 'user', content: 'test' }],
          maxOutputTokens: 50,
          requestId: 'req-invalid-effort',
          caller: 'chat',
          signal: new AbortController().signal,
          reasoningEffort: 'ultra' as unknown as ReasoningEffort,
        }),
        /Invalid reasoningEffort/
      );
      assert.equal(fake.callCount, 0);
    });
  });

  describe('3. Gemini adapter reasoning mapping & CoT suppression', () => {
    it('maps normalized low/medium/high to Gemini thinkingLevel LOW/MEDIUM/HIGH', async () => {
      const bodies: Record<string, unknown>[] = [];
      const transport: ProviderTransport = async (_url, init) => {
        bodies.push(JSON.parse(init.body as string));
        return providerResponse(geminiFrame('ok', 'STOP'));
      };
      const provider = new GeminiProvider(transport);

      for (const [effort, expectedLevel] of [['low', 'LOW'], ['medium', 'MEDIUM'], ['high', 'HIGH']] as const) {
        const events: LLMStreamEvent[] = [];
        for await (const ev of provider.streamText(makeResolvedRequest(effort), platformCredential)) events.push(ev);
        assert.equal(events.at(-1)?.type, 'completed');
        const lastBody = bodies.at(-1) as { generationConfig: { thinkingConfig: { thinkingLevel: string; includeThoughts: boolean } } };
        assert.deepEqual(lastBody.generationConfig.thinkingConfig, { thinkingLevel: expectedLevel, includeThoughts: false });
      }
    });

    it('absent effort preserves registered model/adapter default policy (MINIMAL thinkingLevel on Gemini)', async () => {
      let body: unknown;
      const transport: ProviderTransport = async (_url, init) => {
        body = JSON.parse(init.body as string);
        return providerResponse(geminiFrame('ok', 'STOP'));
      };
      const provider = new GeminiProvider(transport);
      const events: LLMStreamEvent[] = [];
      for await (const ev of provider.streamText(makeResolvedRequest(undefined), platformCredential)) events.push(ev);
      assert.equal(events.at(-1)?.type, 'completed');
      const genConfig = (body as { generationConfig: { thinkingConfig: { thinkingLevel: string; includeThoughts: boolean } } }).generationConfig;
      assert.deepEqual(genConfig.thinkingConfig, { thinkingLevel: 'MINIMAL', includeThoughts: false });
    });

    it('always suppresses thoughts and never exposes chain-of-thought in text deltas', async () => {
      const streamWithThoughts =
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'internal raw thought step 1', thought: true }, { text: 'Visible answer' }] } }] })}\n\n` +
        geminiFrame(undefined, 'STOP', { promptTokenCount: 5, candidatesTokenCount: 4, thoughtsTokenCount: 10, totalTokenCount: 19 });

      const transport: ProviderTransport = async () => providerResponse(streamWithThoughts);
      const provider = new GeminiProvider(transport);
      const events: LLMStreamEvent[] = [];
      for await (const ev of provider.streamText(makeResolvedRequest('high'), platformCredential)) events.push(ev);

      const deltas = events.filter((e) => e.type === 'text.delta').map((e) => (e as { text: string }).text);
      assert.deepEqual(deltas, ['Visible answer']);
      assert.ok(!JSON.stringify(events).includes('internal raw thought'));
      assert.equal(events.at(-1)?.type, 'completed');
    });

    it('produces identical reasoning request shape under BYOK and platform credentials', async () => {
      const requestBodies: Record<string, unknown>[] = [];
      const transport: ProviderTransport = async (_url, init) => {
        requestBodies.push(JSON.parse(init.body as string));
        return providerResponse(geminiFrame('ok', 'STOP'));
      };
      const provider = new GeminiProvider(transport);

      for (const effort of [undefined, 'low', 'medium', 'high'] as const) {
        for await (const _ of provider.streamText(makeResolvedRequest(effort), platformCredential)) { /* drain */ }
        for await (const _ of provider.streamText(makeResolvedRequest(effort), byokCredential)) { /* drain */ }
        assert.deepEqual(requestBodies.at(-2), requestBodies.at(-1));
      }
      assert.equal(requestBodies.length, 8);
    });
  });

  describe('4. Full HTTP runtime, persistence, variants and discovery integration', { timeout: 20000 }, () => {
    let db: TestDbInstance; let owner: string; let conversation: string; let cookie: string;
    before(async () => { db = await createTestDatabase(); });
    after(async () => { await db.cleanup(); await db.pool.end(); });
    beforeEach(async () => {
      await db.cleanup();
      owner = (await new UserRepository(db.pool).createUser({ email: `${randomUUID()}@example.com`, displayName: 'Reasoning user', passwordHash: 'test-unused' })).id;
      const token = generateSessionToken();
      await new SessionRepository(db.pool).createSession({ userId: owner, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60000) });
      cookie = `${SESSION_COOKIE_NAME}=${token}`;
      conversation = randomUUID();
      await db.pool.query("INSERT INTO conversations (id,user_id,title) VALUES ($1,$2,'Reasoning test')", [conversation, owner]);
    });

    it('rejects provider-native fields such as thinkingLevel or raw token budgets in request body', async () => {
      const repo = new PostgresGenerationRepository(db.pool);
      const runtime = new ChatRuntime(repo, undefined);

      // Unknown fields must be rejected with 400
      for (const badField of ['thinkingLevel', 'thinkingBudget', 'reasoning.effort', 'output_config.effort', 'rawBudget',
        'reasoning', 'output_config', 'providerUrl', 'providerId', 'maxOutputTokens']) {
        await assert.rejects(
          runtime.admit(owner, conversation, { content: 'test', [badField]: 'something' }, randomUUID()),
          /Unknown request field/
        );
        await assert.rejects(runtime.admitVariant(owner, conversation,
          { userMessageId: randomUUID(), action: 'retry', [badField]: { effort: 'high' } }, randomUUID()), /Unknown request field/);
      }

      // Invalid reasoningEffort values
      for (const badEffort of ['minimal', 'max', 'extreme', 123, null]) {
        await assert.rejects(
          runtime.admit(owner, conversation, { content: 'test', reasoningEffort: badEffort }, randomUUID()),
          /Invalid reasoningEffort/
        );
      }
    });

    it('GET /api/v1/models exposes discoverable trusted capabilities without provider leaks', async () => {
      const config = { ...loadConfig({ NODE_ENV: 'test' }), chatEnabled: true, chat: { apiKey: platformKey, modelId: CHAT_MODEL_ID, maxOutputTokens: 32 }, allowedOrigins: [origin] };
      const { server } = await startServer({ pool: db.pool, config, port: 0, skipMigrations: true, providerTransport: async () => providerResponse() });
      try {
        if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
        const port = (server.address() as AddressInfo).port;
        const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/v1/models`);
        assert.equal(unauthenticated.status, 401);
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/models`, {
          headers: { Cookie: cookie, Origin: origin },
        });
        assert.equal(res.status, 200);
        const data = await res.json() as { models: Array<{ id: string; capabilities: string[]; reasoning: { supported: boolean; efforts: string[] } }> };
        assert.ok(Array.isArray(data.models));
        const chatModel = data.models.find((m) => m.id === CHAT_MODEL_ALIAS);
        assert.ok(chatModel, 'Must list default chat model alias');
        assert.deepEqual(chatModel.capabilities, ['text', 'streaming']);
        assert.deepEqual(chatModel.reasoning, { supported: true, efforts: ['low', 'medium', 'high'] });

        // Invariant: No provider-native config or secrets leaked
        const rawJson = JSON.stringify(data);
        assert.ok(!rawJson.includes('gemini-3.1-flash-lite'), 'Raw provider model ID must not leak');
        assert.ok(!rawJson.includes(platformKey), 'API key must not leak');
        assert.ok(!rawJson.includes('thinkingLevel'), 'Native thinkingLevel must not leak');
        assert.ok(!rawJson.includes('googleapis.com'), 'Provider URL must not leak');
      } finally {
        server.close();
      }
    });

    it('end-to-end: new prompt with reasoningEffort snapshots in DB and streams cleanly', async () => {
      let capturedLevel: string | undefined;
      const transport: ProviderTransport = async (_url, init) => {
        const body = JSON.parse(init.body as string);
        capturedLevel = body.generationConfig?.thinkingConfig?.thinkingLevel;
        return providerResponse(geminiFrame('Result from high reasoning', 'STOP'));
      };

      const config = { ...loadConfig({ NODE_ENV: 'test' }), chatEnabled: true, chat: { apiKey: platformKey, modelId: CHAT_MODEL_ID, maxOutputTokens: 32 }, allowedOrigins: [origin] };
      const { server } = await startServer({ pool: db.pool, config, port: 0, skipMigrations: true, providerTransport: transport });
      try {
        if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
        const port = (server.address() as AddressInfo).port;
        const base = `http://127.0.0.1:${port}/api/v1/conversations/${conversation}`;

        const res = await fetch(`${base}/messages:stream`, {
          method: 'POST',
          headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
          body: JSON.stringify({ content: 'Deep problem', reasoningEffort: 'high' }),
        });
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.match(text, /message.completed/);
        assert.equal(capturedLevel, 'HIGH');

        // Check database snapshot
        const rows = await db.pool.query('SELECT reasoning_effort, status FROM chat_generations WHERE conversation_id = $1', [conversation]);
        assert.equal(rows.rows.length, 1);
        assert.equal(rows.rows[0].reasoning_effort, 'high');
        assert.equal(rows.rows[0].status, 'completed');

        // Check GET generation endpoint returns normalized reasoningEffort
        const genId = JSON.parse(text.split('\n').find((line) => line.startsWith('data: '))!.slice(6)).generationId;
        const getRes = await fetch(`${base}/generations/${genId}`, {
          headers: { Cookie: cookie, Origin: origin },
        });
        assert.equal(getRes.status, 200);
        const getData = await getRes.json() as { generation: { reasoningEffort?: string } };
        assert.equal(getData.generation.reasoningEffort, 'high');
      } finally {
        server.close();
      }
    });

    it('new message, Retry, and Regenerate can each select different reasoning effort levels', async () => {
      let attempt = 0;
      const thinkingLevelsObserved: string[] = [];
      const transport: ProviderTransport = async (_url, init) => {
        attempt++;
        const body = JSON.parse(init.body as string);
        thinkingLevelsObserved.push(body.generationConfig?.thinkingConfig?.thinkingLevel);
        if (attempt === 1) {
          // First attempt: fail to allow retry
          return providerResponse(geminiFrame('initial-failure')); // incomplete
        }
        return providerResponse(geminiFrame(`attempt-${attempt}-ok`, 'STOP'));
      };

      const config = { ...loadConfig({ NODE_ENV: 'test' }), chatEnabled: true, chat: { apiKey: platformKey, modelId: CHAT_MODEL_ID, maxOutputTokens: 32 }, allowedOrigins: [origin] };
      const { server } = await startServer({ pool: db.pool, config, port: 0, skipMigrations: true, providerTransport: transport });
      try {
        if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
        const port = (server.address() as AddressInfo).port;
        const base = `http://127.0.0.1:${port}/api/v1/conversations/${conversation}`;

        // 1. Initial message with reasoningEffort: 'low' -> fails
        const res1 = await fetch(`${base}/messages:stream`, {
          method: 'POST',
          headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
          body: JSON.stringify({ content: 'Explain relativity', reasoningEffort: 'low' }),
        });
        const text1 = await res1.text();
        assert.match(text1, /message.failed/);
        const userMsg = (await db.pool.query("SELECT id FROM messages WHERE conversation_id = $1 AND role = 'user'", [conversation])).rows[0].id;

        // 2. Retry with reasoningEffort: 'medium' -> succeeds
        const res2 = await fetch(`${base}/generations:stream`, {
          method: 'POST',
          headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
          body: JSON.stringify({ userMessageId: userMsg, action: 'retry', reasoningEffort: 'medium' }),
        });
        const text2 = await res2.text();
        assert.match(text2, /message.completed/);

        // 3. Regenerate with reasoningEffort: 'high' -> succeeds
        const res3 = await fetch(`${base}/generations:stream`, {
          method: 'POST',
          headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
          body: JSON.stringify({ userMessageId: userMsg, action: 'regenerate', reasoningEffort: 'high' }),
        });
        const text3 = await res3.text();
        assert.match(text3, /message.completed/);

        // Check provider levels observed
        assert.deepEqual(thinkingLevelsObserved, ['LOW', 'MEDIUM', 'HIGH']);

        // Check persisted variants in DB
        const variantsRes = await fetch(`${base}/messages/${userMsg}/generations`, {
          headers: { Cookie: cookie, Origin: origin },
        });
        assert.equal(variantsRes.status, 200);
        const variantsData = await variantsRes.json() as { items: Array<{ action: string; reasoningEffort?: string; status: string }> };
        assert.equal(variantsData.items.length, 3);
        const item0 = variantsData.items[0]!;
        const item1 = variantsData.items[1]!;
        const item2 = variantsData.items[2]!;
        assert.equal(item0.action, 'new_prompt');
        assert.equal(item0.reasoningEffort, 'low');
        assert.equal(item1.action, 'retry');
        assert.equal(item1.reasoningEffort, 'medium');
        assert.equal(item2.action, 'regenerate');
        assert.equal(item2.reasoningEffort, 'high');
      } finally {
        server.close();
      }
    });

    it('durable Stop remains race-safe on generations with reasoningEffort', async () => {
      let stopped = false;
      const transport: ProviderTransport = async () => {
        return new Response(new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(new TextEncoder().encode(geminiFrame('Thinking deeply... '))); },
          cancel() { stopped = true; },
        }), { headers: { 'Content-Type': 'text/event-stream' } });
      };

      const config = { ...loadConfig({ NODE_ENV: 'test' }), chatEnabled: true, chat: { apiKey: platformKey, modelId: CHAT_MODEL_ID, maxOutputTokens: 32 }, allowedOrigins: [origin] };
      const { server } = await startServer({ pool: db.pool, config, port: 0, skipMigrations: true, providerTransport: transport });
      try {
        if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
        const port = (server.address() as AddressInfo).port;
        const base = `http://127.0.0.1:${port}/api/v1/conversations/${conversation}`;

        const streamPromise = fetch(`${base}/messages:stream`, {
          method: 'POST',
          headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
          body: JSON.stringify({ content: 'Calculate pi to 1000 digits', reasoningEffort: 'high' }),
        });

        // Wait for streaming row in DB
        let genId: string | undefined;
        for (let i = 0; i < 50; i++) {
          const active = await db.pool.query("SELECT id, reasoning_effort FROM chat_generations WHERE conversation_id = $1 AND status = 'streaming'", [conversation]);
          if (active.rows[0]) {
            genId = active.rows[0].id;
            assert.equal(active.rows[0].reasoning_effort, 'high');
            break;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.ok(genId, 'Generation should enter streaming state');

        // Cancel generation
        const cancelRes = await fetch(`${base}/generations/${genId}/cancel`, {
          method: 'POST',
          headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
        });
        assert.equal(cancelRes.status, 202);

        // Await stream completion
        const streamRes = await streamPromise;
        const streamText = await streamRes.text();
        assert.match(streamText, /message.stopped/);
        assert.equal(stopped, true);

        // Check persisted state
        const result = await db.pool.query('SELECT status, reasoning_effort, finish_reason FROM chat_generations WHERE id = $1', [genId]);
        const row = result.rows[0];
        assert.ok(row, 'Generation row must exist');
        assert.equal(row.status, 'stopped');
        assert.equal(row.reasoning_effort, 'high');
        assert.equal(row.finish_reason, 'cancelled');
      } finally {
        server.close();
      }
    });
  });
});
