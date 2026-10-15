import { ProviderCredential } from '../../src/modules/llm/provider-credential.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider, CHAT_MODEL_ID, GEMINI_CHAT_ENDPOINT, type ProviderTransport } from '../../src/modules/llm/providers/gemini/gemini-provider.js';
import type { LLMStreamEvent, ResolvedLLMRequest } from '../../src/modules/llm/types.js';
import { createChatEngine, loadChatConfig } from '../../src/modules/llm/chat-bootstrap.js';
import { loadConfig } from '../../src/app/config.js';
import { startServer } from '../../src/app/server.js';
import { ModelRegistry } from '../../src/modules/llm/registry.js';
import { LLMEngine } from '../../src/modules/llm/engine.js';
import { geminiFrame, providerResponse } from './gemini-fixture.js';

const key = 'test-only-placeholder-secret';
const credential = new ProviderCredential(key, 'platform');
function request(signal = new AbortController().signal): ResolvedLLMRequest {
  return { modelAlias: 'giga-chat-default', providerId: 'gemini', modelId: CHAT_MODEL_ID, messages: [{ role: 'user', content: 'Hello' }], maxOutputTokens: 32, caller: 'chat', requestId: 'test', signal };
}
async function collect(provider: GeminiProvider, req = request()): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = [];
  for await (const event of provider.streamText(req, credential)) events.push(event);
  return events;
}

describe('Gemini HTTP adapter', { timeout: 5000 }, () => {
  for (const split of [0, 1, 3, 7, 31]) {
    it(`normalizes arbitrary chunking, UTF-8 and ordered deltas (chunk bytes ${split})`, async () => {
      const frames = geminiFrame('Xin chào 🙂') + geminiFrame(' thế giới', 'STOP', { promptTokenCount: 9, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 15 });
      const events = await collect(new GeminiProvider(async () => providerResponse(frames, split)));
      assert.deepEqual(events, [{ type: 'text.delta', text: 'Xin chào 🙂' }, { type: 'text.delta', text: ' thế giới' },
        { type: 'usage', source: 'provider', inputTokens: 9, outputTokens: 6 }, { type: 'completed', finishReason: 'stop' }]);
    });
  }
  for (const newline of ['\n', '\r\n', '\r']) {
    it(`parses comments and multiline SSE data with ${JSON.stringify(newline)} separators`, async () => {
      const json = JSON.stringify({ candidates: [{ index: 0, content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }, null, 2);
      const stream = ': heartbeat\n\n' + json.split('\n').map((line) => `data: ${line}`).join('\n') + '\n\n';
      const events = await collect(new GeminiProvider(async () => providerResponse(stream.replaceAll('\n', newline), 1)));
      assert.deepEqual(events, [{ type: 'text.delta', text: 'ok' }, { type: 'completed', finishReason: 'stop' }]);
    });
  }
  it('uses server header, fixed HTTPS endpoint, trusted model and text-only request configuration', async () => {
    let calls = 0;
    const transport: ProviderTransport = async (url, init) => {
      calls++; assert.equal(url, GEMINI_CHAT_ENDPOINT); assert.ok(!url.includes(key));
      assert.equal(new Headers(init.headers).get('x-goog-api-key'), key);
      assert.equal(init.redirect, 'error'); assert.equal(init.method, 'POST');
      assert.ok(init.signal instanceof AbortSignal);
      const body = JSON.parse(init.body as string);
      assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'Hello' }] }, { role: 'model', parts: [{ text: 'Answer' }] }]);
      assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Test system' }] });
      assert.equal(body.generationConfig.maxOutputTokens, 32);
      assert.equal(body.generationConfig.candidateCount, 1);
      assert.equal(body.tools, undefined);
      return providerResponse();
    };
    await collect(new GeminiProvider(transport), { ...request(), messages: [{ role: 'system', content: 'Test system' }, { role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Answer' }] });
    assert.equal(calls, 1);
    await assert.rejects(collect(new GeminiProvider(transport), { ...request(), modelId: 'browser/raw-model' }), { code: 'PROVIDER_FAILURE' });
    assert.equal(calls, 1);
  });
  for (const [reason, expected] of [['STOP', 'stop'], ['MAX_TOKENS', 'length'], ['OTHER', 'other']]) {
    it(`maps finish ${reason} and never invents missing usage`, async () => {
      const result = await new GeminiProvider(async () => providerResponse(geminiFrame('ok', reason))).generateText(request(), credential);
      assert.deepEqual(result, { text: 'ok', finishReason: expected });
    });
  }
  it('generateText collects one bounded stream with final cumulative usage', async () => {
    const result = await new GeminiProvider(async () => providerResponse()).generateText(request(), credential);
    assert.deepEqual(result, { text: 'Hello world', finishReason: 'stop', usage: { source: 'provider', inputTokens: 5, outputTokens: 3 } });
  });
  it('keeps unknown output usage absent when thinking/total counters are unavailable', async () => {
    const result = await new GeminiProvider(async () => providerResponse(geminiFrame('ok', 'STOP', { promptTokenCount: 5, candidatesTokenCount: 2 }))).generateText(request(), credential);
    assert.deepEqual(result.usage, { source: 'provider', inputTokens: 5 });
  });
  it('suppresses thoughts and emits only final reported usage, without summing cumulative chunks', async () => {
    const stream = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'private thought', thought: true }, { text: 'Visible' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } })}\n\n` +
      geminiFrame(undefined, 'STOP', { promptTokenCount: 5, candidatesTokenCount: 4, thoughtsTokenCount: 2 });
    const events = await collect(new GeminiProvider(async () => providerResponse(stream)));
    assert.deepEqual(events, [{ type: 'text.delta', text: 'Visible' }, { type: 'usage', source: 'provider', inputTokens: 5, outputTokens: 6 }, { type: 'completed', finishReason: 'stop' }]);
  });
  for (const [status, code] of [[400, 'PROVIDER_FAILURE'], [401, 'PROVIDER_FAILURE'], [403, 'PROVIDER_FAILURE'], [429, 'PROVIDER_RATE_LIMIT'], [500, 'PROVIDER_UNAVAILABLE'], [503, 'PROVIDER_UNAVAILABLE']] as const) {
    it(`classifies HTTP ${status}, discards its body and makes no automatic retry`, async () => {
      let calls = 0;
      const provider = new GeminiProvider(async () => { calls++; return new Response('PRIVATE_PROMPT key=private-provider-response', { status, headers: { 'Retry-After': '2' } }); });
      await assert.rejects(provider.generateText(request(), credential), (err: unknown) => {
        const error = err as { code: string; retryAfterMs?: number; message: string };
        assert.equal(error.code, code);
        if (status === 429) assert.equal(error.retryAfterMs, 2000);
        assert.ok(!JSON.stringify(error).includes('PRIVATE_PROMPT'));
        assert.ok(!error.message.includes('private-provider-response'));
        return true;
      });
      assert.equal(calls, 1);
    });
  }
  for (const stream of ['data: {invalid}\n\n', 'data: ' + 'x'.repeat(131073), geminiFrame('partial'),
    geminiFrame('done', 'STOP') + 'data: {', geminiFrame('done', 'STOP') + geminiFrame('late', 'STOP'),
    geminiFrame('blocked', 'SAFETY'), 'data: {"error":{"message":"PRIVATE_PROMPT"}}\n\n',
    geminiFrame(undefined, 'STOP', { promptTokenCount: -1 }),
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'forbidden' } }] }, finishReason: 'STOP' }] })}\n\n`]) {
    it('rejects malformed, incomplete, unsafe or oversized provider data without completion', async () => {
      const events: LLMStreamEvent[] = [];
      await assert.rejects(async () => { for await (const e of new GeminiProvider(async () => providerResponse(stream)).streamText(request(), credential)) events.push(e); }, { code: 'PROVIDER_FAILURE' });
      assert.ok(!events.some((e) => e.type === 'completed' || e.type === 'usage'));
      assert.ok(!JSON.stringify(events).includes('blocked'));
    });
  }
  it('rejects invalid UTF-8 and wrong content type', async () => {
    const bad = new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'text/event-stream' } });
    await assert.rejects(collect(new GeminiProvider(async () => bad)), { code: 'PROVIDER_FAILURE' });
    await assert.rejects(collect(new GeminiProvider(async () => new Response('{}'))), { code: 'PROVIDER_FAILURE' });
  });
  it('pre-abort never calls transport and abort between buffered deltas suppresses late output', async () => {
    const control = new AbortController(); control.abort(); let calls = 0;
    await assert.rejects(collect(new GeminiProvider(async () => { calls++; return providerResponse(); }), request(control.signal)), { code: 'LLM_CANCELLED' });
    assert.equal(calls, 0);
    const abort = new AbortController(); let providerSignal: AbortSignal | undefined;
    const events: LLMStreamEvent[] = [];
    const provider = new GeminiProvider(async (_url, init) => { providerSignal = init.signal as AbortSignal; return providerResponse(); });
    await assert.rejects(async () => { for await (const event of provider.streamText(request(abort.signal), credential)) { events.push(event); abort.abort(); } }, { code: 'LLM_CANCELLED' });
    assert.equal(providerSignal!.aborted, true);
    assert.deepEqual(events, [{ type: 'text.delta', text: 'Hello' }]);
  });
  it('abort interrupts a pending body read and cancels its reader immediately', { timeout: 1000 }, async () => {
    const abort = new AbortController(); let cancelled = false;
    const provider = new GeminiProvider(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const pending = collect(provider, request(abort.signal));
    setTimeout(() => abort.abort(), 10);
    await assert.rejects(pending, { code: 'LLM_CANCELLED' });
    assert.equal(cancelled, true);
  });
  it('bounds uncooperative transport by a deadline and redacts arbitrary transport exceptions', { timeout: 1000 }, async () => {
    await assert.rejects(collect(new GeminiProvider(() => new Promise<Response>(() => {}), 15)), { code: 'PROVIDER_TIMEOUT' });
    await assert.rejects(collect(new GeminiProvider(async () => { throw new Error(`PRIVATE_PROMPT ${key}`); })), (err: unknown) => {
      assert.ok(!(err as Error).message.includes('PRIVATE_PROMPT')); assert.ok(!JSON.stringify(err).includes(key)); return true;
    });
  });
});

describe('Server-only Chat provider bootstrap', () => {
  const env = { GEMINI_API_KEY: key, CHAT_MODEL_ID };
  it('is offline by default in development/test and has no fake production fallback', () => {
    assert.equal(loadChatConfig({}, false), undefined);
    assert.equal(createChatEngine(undefined), undefined);
    assert.throws(() => loadChatConfig({}, true), /GEMINI_API_KEY/);
    assert.equal(loadChatConfig({ CHAT_ENABLED: 'false' }, true), undefined);
  });
  it('fails closed on missing/invalid key, model, limit, endpoint and enable flag without echoing secrets', () => {
    for (const bad of [{ CHAT_ENABLED: 'true' }, { GEMINI_API_KEY: key }, { CHAT_MODEL_ID },
      { ...env, GEMINI_API_KEY: 'bad\nkey' }, { ...env, CHAT_MODEL_ID: 'fake-model' },
      { ...env, CHAT_MAX_OUTPUT_TOKENS: '2049' }, { ...env, CHAT_MAX_OUTPUT_TOKENS: '0' }, { ...env, CHAT_MAX_OUTPUT_TOKENS: '1.5' },
      { ...env, GEMINI_BASE_URL: 'https://invalid.example' }, { ...env, CHAT_ENABLED: 'yes' }]) {
      assert.throws(() => loadChatConfig(bad, false), (err: unknown) => { assert.ok(!(err as Error).message.includes(key)); return true; });
    }
  });
  it('maps the public alias to exactly the server model without HTTP I/O during resolution', async () => {
    let calls = 0;
    const engine = createChatEngine(loadChatConfig(env, true), async () => { calls++; return providerResponse(); })!;
    const prepared = engine.prepareStream(request());
    assert.deepEqual(prepared.identity, { providerId: 'gemini', modelId: CHAT_MODEL_ID });
    assert.equal(calls, 0);
    for await (const _event of prepared.stream) { /* normalized adapter */ }
    assert.equal(calls, 1);
    assert.deepEqual(loadConfig({ ...env, NODE_ENV: 'test' }).chat, { apiKey: key, modelId: CHAT_MODEL_ID, maxOutputTokens: 1024 });
  });
  it('validates programmatic startup before opening a socket or database', async () => {
    await assert.rejects(startServer({ port: 0, config: { ...loadConfig({ NODE_ENV: 'test' }), nodeEnv: 'production', chatEnabled: true } }), /requires server provider configuration/);
    await assert.rejects(startServer({ port: 0, config: { ...loadConfig({ NODE_ENV: 'test' }), chatEnabled: true, chat: { apiKey: key, modelId: 'fake-model', maxOutputTokens: 32 } } }), /reviewed Gemini/);
  });
  it('keeps a prepared request tied to its recorded identity if the alias changes later', async () => {
    const registry = new ModelRegistry();
    registry.registerAdapter(new GeminiProvider(async () => providerResponse()));
    registry.registerAlias({ alias: 'giga-chat-default', providerId: 'gemini', modelId: CHAT_MODEL_ID, requiredCapabilities: ['streaming'] });
    const engine = new LLMEngine(registry, credential);
    const prepared = engine.prepareStream(request());
    // Simulate trusted server-side alias reconfiguration after resolution.
    const config = registry.resolve('giga-chat-default').config as { modelId: string };
    config.modelId = 'future-reviewed-model';
    const events: LLMStreamEvent[] = [];
    for await (const event of prepared.stream) events.push(event);
    assert.deepEqual(prepared.identity, { providerId: 'gemini', modelId: CHAT_MODEL_ID });
    assert.equal(events.at(-1)!.type, 'completed');
  });
});
