import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { ModelRegistry } from '../../src/modules/llm/registry.js';
import { LLMEngine } from '../../src/modules/llm/engine.js';
import { FakeProvider } from '../../src/modules/llm/testing/fake-provider.js';
import type { LLMRequest, ModelReasoningConfig, ReasoningEffort } from '../../src/modules/llm/types.js';
import { ChatRuntime, CHAT_MODEL_ALIAS } from '../../src/modules/chat/chat-runtime.js';
import { PostgresGenerationRepository } from '../../src/modules/chat/generation-repository.js';
import { createTestDatabase, type TestDbInstance } from '../test-db-helper.js';

const all = { supported: true, efforts: ['low', 'medium', 'high'] } as const;
const request = (effort?: ReasoningEffort): LLMRequest => ({ modelAlias: CHAT_MODEL_ALIAS,
  messages: [{ role: 'user', content: 'Question' }], maxOutputTokens: 32,
  requestId: randomUUID(), caller: 'chat', signal: new AbortController().signal,
  ...(effort === undefined ? {} : { reasoningEffort: effort }) });

describe('Reasoning registry trust boundary', () => {
  it('requires adapter evidence even when startup validation was omitted', () => {
    const fake = new FakeProvider();
    const registry = new ModelRegistry();
    registry.registerAdapter({ providerId: fake.providerId, capabilities: fake.capabilities,
      streamText: fake.streamText.bind(fake), generateText: fake.generateText.bind(fake) });
    registry.registerAlias({ alias: CHAT_MODEL_ALIAS, providerId: fake.providerId, modelId: 'm',
      requiredCapabilities: ['streaming'], reasoning: all });
    assert.throws(() => registry.validate(), /does not support/);
    assert.throws(() => registry.listModels(), /does not support/);
    assert.throws(() => new LLMEngine(registry).prepareStream(request('high')), /does not support/);
    assert.equal(fake.callCount, 0);
  });

  it('rejects contradictory, duplicate, and native adapter/alias capabilities', () => {
    const invalid = [
      { supported: false, efforts: ['low'] }, { supported: true, efforts: [] },
      { supported: true, efforts: ['low', 'low'] }, { supported: true, efforts: ['max'] },
    ] as unknown as ModelReasoningConfig[];
    for (const reasoning of invalid) {
      const registry = new ModelRegistry();
      const fake = new FakeProvider({ reasoning });
      registry.registerAdapter(fake);
      assert.throws(() => registry.registerAlias({ alias: 'bad', providerId: fake.providerId,
        modelId: 'm', requiredCapabilities: ['streaming'], reasoning }));
      registry.registerAlias({ alias: 'adapter-declared', providerId: fake.providerId,
        modelId: 'm', requiredCapabilities: ['streaming'] });
      assert.throws(() => registry.validate());
      assert.throws(() => registry.listModels());
    }
  });

  it('isolates trusted alias policy from caller mutation and metadata mutation', () => {
    const fake = new FakeProvider({ reasoning: all });
    const registry = new ModelRegistry(); registry.registerAdapter(fake);
    const reasoning = { supported: true, efforts: ['low'] as ReasoningEffort[] };
    const config = { alias: CHAT_MODEL_ALIAS, providerId: fake.providerId, modelId: 'm',
      requiredCapabilities: ['streaming'] as const, reasoning };
    registry.registerAlias(config);
    reasoning.efforts.push('high');
    for (const exposed of [registry.getAliasConfig(CHAT_MODEL_ALIAS)!, registry.resolve(CHAT_MODEL_ALIAS).config]) {
      (exposed.reasoning!.efforts as ReasoningEffort[]).push('high');
    }
    (registry.listModels()[0]!.reasoning.efforts as ReasoningEffort[]).push('high');
    assert.deepEqual(registry.getReasoningCapabilities(CHAT_MODEL_ALIAS), { supported: true, efforts: ['low'] });
    assert.throws(() => new LLMEngine(registry).prepareStream(request('high')), /not supported/);
    assert.equal(fake.callCount, 0);
  });

  it('validates and forwards normalized effort for non-streaming generation too', async () => {
    const fake = new FakeProvider({ reasoning: { supported: true, efforts: ['low', 'medium'] } });
    const registry = new ModelRegistry(); registry.registerAdapter(fake);
    registry.registerAlias({ alias: CHAT_MODEL_ALIAS, providerId: fake.providerId, modelId: 'm', requiredCapabilities: ['text', 'streaming'] });
    const engine = new LLMEngine(registry);
    for (const effort of ['high', 'max', null, 1]) {
      await assert.rejects(engine.generateText(request(effort as ReasoningEffort)));
      assert.throws(() => engine.prepareStream(request(effort as ReasoningEffort)));
    }
    assert.equal(fake.callCount, 0);
    for (const effort of [undefined, 'low', 'medium'] as const) {
      await engine.generateText(request(effort));
      assert.equal(fake.lastRequest?.reasoningEffort, effort);
    }
  });
});

describe('Reasoning admission compatibility', () => {
  let db: TestDbInstance; let owner: string; let conversation: string;
  let repo: PostgresGenerationRepository; let runtime: ChatRuntime;
  let first: FakeProvider; let next: FakeProvider;
  before(async () => { db = await createTestDatabase(); });
  after(async () => { await db.cleanup(); await db.pool.end(); });
  beforeEach(async () => {
    await db.cleanup(); owner = randomUUID(); conversation = randomUUID();
    await db.pool.query("INSERT INTO users (id,email,display_name,password_hash) VALUES ($1,$2,'Test','unused')", [owner, `${owner}@example.com`]);
    await db.pool.query("INSERT INTO conversations (id,user_id,title) VALUES ($1,$2,'Test')", [conversation, owner]);
    repo = new PostgresGenerationRepository(db.pool);
    first = new FakeProvider({ providerId: 'first', reasoning: all });
    next = new FakeProvider({ providerId: 'next', reasoning: { supported: true, efforts: ['high'] } });
    const registry = new ModelRegistry(); registry.registerAdapter(first); registry.registerAdapter(next);
    registry.registerAlias({ alias: CHAT_MODEL_ALIAS, providerId: first.providerId, modelId: 'first-model', requiredCapabilities: ['text', 'streaming'] });
    registry.registerAlias({ alias: 'next-chat', providerId: next.providerId, modelId: 'next-model', requiredCapabilities: ['text', 'streaming'] });
    registry.registerAlias({ alias: 'text-only', providerId: next.providerId, modelId: 'next-model', requiredCapabilities: ['text'] });
    registry.validate(); runtime = new ChatRuntime(repo, new LLMEngine(registry));
  });

  it('new provider metadata works for new message, Retry and Regenerate without runtime branches', async () => {
    assert.deepEqual(runtime.listModels().map((m) => m.id), [CHAT_MODEL_ALIAS, 'next-chat']);
    const initial = await runtime.admit(owner, conversation, { content: 'Question', reasoningEffort: 'low' }, randomUUID());
    await runtime.run(owner, initial.generation, async () => {}, new AbortController().signal);
    const variant = await runtime.admitVariant(owner, conversation, { userMessageId: initial.generation.userMessageId,
      action: 'regenerate', modelId: 'next-chat', reasoningEffort: 'high' }, randomUUID());
    await repo.finalize(owner, variant.generation, '', 'failed', 'TEST');
    const retry = await runtime.admitVariant(owner, conversation, { userMessageId: initial.generation.userMessageId,
      action: 'retry', modelId: 'next-chat', reasoningEffort: 'high' }, randomUUID());
    await runtime.run(owner, retry.generation, async () => {}, new AbortController().signal);
    assert.equal(first.lastRequest?.reasoningEffort, 'low');
    assert.equal(next.lastRequest?.reasoningEffort, 'high');
    assert.equal(next.lastRequest?.modelId, 'next-model');
    assert.equal((await runtime.get(owner, conversation, retry.generation.id)).reasoningEffort, 'high');
  });

  it('rejects unsupported model/effort for both admissions before persistence or transport', async () => {
    for (const modelId of ['next-chat', 'text-only', 'unknown']) {
      await assert.rejects(runtime.admit(owner, conversation, { content: 'Question', modelId, reasoningEffort: 'low' }, randomUUID()));
      await assert.rejects(runtime.admitVariant(owner, conversation, { userMessageId: randomUUID(), action: 'retry', modelId, reasoningEffort: 'low' }, randomUUID()));
    }
    assert.equal((await db.pool.query('SELECT id FROM chat_generations')).rows.length, 0);
    assert.equal(first.callCount + next.callCount, 0);
  });

  it('omitted effort on Regenerate and Retry returns to model default instead of inheriting', async () => {
    const initial = await runtime.admit(owner, conversation, { content: 'Question', reasoningEffort: 'high' }, randomUUID());
    await runtime.run(owner, initial.generation, async () => {}, new AbortController().signal);
    const regenerated = await runtime.admitVariant(owner, conversation, { userMessageId: initial.generation.userMessageId,
      action: 'regenerate' }, randomUUID());
    await repo.finalize(owner, regenerated.generation, '', 'failed', 'TEST');
    const retried = await runtime.admitVariant(owner, conversation, { userMessageId: initial.generation.userMessageId,
      action: 'retry' }, randomUUID());
    await runtime.run(owner, retried.generation, async () => {}, new AbortController().signal);
    assert.equal(first.lastRequest?.reasoningEffort, undefined);
    const snapshots = await db.pool.query('SELECT reasoning_effort FROM chat_generations WHERE id IN ($1, $2)',
      [regenerated.generation.id, retried.generation.id]);
    assert.deepEqual(snapshots.rows.map((row) => row.reasoning_effort), [null, null]);
  });

  it('stream-only engines preserve legacy calls but cannot invent reasoning support', async () => {
    const legacy = new ChatRuntime(repo, { streamText: first.streamText.bind(first) });
    assert.deepEqual(legacy.listModels()[0]!.reasoning, { supported: false, efforts: [] });
    await assert.rejects(legacy.admit(owner, conversation, { content: 'Question', reasoningEffort: 'low' }, randomUUID()), /does not support/);
    const admitted = await legacy.admit(owner, conversation, { content: 'Question' }, randomUUID());
    assert.equal(admitted.generation.reasoningEffort, undefined);
  });

  it('reconciles pre-upgrade prompt and variant fingerprints when effort is omitted', async () => {
    const fingerprint = (parts: string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
    const key = randomUUID(); const content = 'Legacy question';
    const seeded = await repo.admit({ ownerId: owner, conversationId: conversation, content, modelId: CHAT_MODEL_ALIAS, key,
      fingerprint: fingerprint([conversation, content, CHAT_MODEL_ALIAS]) });
    const duplicate = await runtime.admit(owner, conversation, { content }, key);
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.generation.id, seeded.generation.id);
    await assert.rejects(runtime.admit(owner, conversation, { content, reasoningEffort: 'low' }, key), /different request/);
    await repo.finalize(owner, seeded.generation, '', 'failed', 'TEST');
    const retryKey = randomUUID(); const userMessageId = seeded.generation.userMessageId;
    const retry = await repo.admit({ ownerId: owner, conversationId: conversation, userMessageId, action: 'retry', modelId: CHAT_MODEL_ALIAS,
      key: retryKey, fingerprint: fingerprint([conversation, 'retry', userMessageId, CHAT_MODEL_ALIAS]) });
    const retryDuplicate = await runtime.admitVariant(owner, conversation, { userMessageId, action: 'retry' }, retryKey);
    assert.equal(retryDuplicate.duplicate, true); assert.equal(retryDuplicate.generation.id, retry.generation.id);
    assert.equal(first.callCount + next.callCount, 0);
  });
});
