import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LLMCancelledError,
  LLMValidationError,
  ProviderFailureError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  UnknownModelAliasError,
  UnsupportedCapabilityError,
  sanitizeErrorMessage,
  toLLMError,
} from '../../src/modules/llm/errors.js';
import { LLMEngine } from '../../src/modules/llm/engine.js';
import { ModelRegistry } from '../../src/modules/llm/registry.js';
import { FakeProvider } from '../../src/modules/llm/testing/fake-provider.js';
import type { LLMRequest, LLMStreamEvent } from '../../src/modules/llm/types.js';

describe('Shared LLM Engine v0.1', () => {
  function createTestSetup(providerOptions?: ConstructorParameters<typeof FakeProvider>[0]) {
    const fakeProvider = new FakeProvider(providerOptions);
    const registry = new ModelRegistry();
    registry.registerAdapter(fakeProvider);
    registry.registerAlias({
      alias: 'giga-chat-default',
      providerId: fakeProvider.providerId,
      modelId: 'gpt-4o-mini',
      requiredCapabilities: ['text', 'streaming'],
      maxOutputTokensLimit: 4096,
    });
    const engine = new LLMEngine(registry);
    return { engine, registry, fakeProvider };
  }

  function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
    return {
      modelAlias: 'giga-chat-default',
      messages: [{ role: 'user', content: 'Hello Giga' }],
      maxOutputTokens: 1024,
      requestId: 'req-123',
      caller: 'chat',
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  describe('Streaming Text Generation', () => {
    it('streams ordered deltas, usage, and exactly one terminal completed event', async () => {
      const { engine, fakeProvider } = createTestSetup({
        chunks: ['Xin', ' chào', ' Giga!'],
        finishReason: 'stop',
        usage: { inputTokens: 12, outputTokens: 6, source: 'provider' },
      });

      const events: LLMStreamEvent[] = [];
      for await (const event of engine.streamText(makeRequest())) {
        events.push(event);
      }

      assert.strictEqual(fakeProvider.streamCallCount, 1);
      assert.strictEqual(events.length, 5); // 3 deltas + 1 usage + 1 completed

      assert.deepStrictEqual(events[0], { type: 'text.delta', text: 'Xin' });
      assert.deepStrictEqual(events[1], { type: 'text.delta', text: ' chào' });
      assert.deepStrictEqual(events[2], { type: 'text.delta', text: ' Giga!' });
      assert.deepStrictEqual(events[3], {
        type: 'usage',
        inputTokens: 12,
        outputTokens: 6,
        source: 'provider',
      });
      assert.deepStrictEqual(events[4], { type: 'completed', finishReason: 'stop' });
    });

    it('fails with ProviderFailureError and zero completed events if stream terminates without completed', async () => {
      const { engine, fakeProvider } = createTestSetup({
        chunks: ['Partial', ' stream', ' truncated'],
        omitCompleted: true,
      });

      const events: LLMStreamEvent[] = [];
      await assert.rejects(
        async () => {
          for await (const event of engine.streamText(makeRequest())) {
            events.push(event);
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof ProviderFailureError);
          assert.match(err.message, /terminated prematurely/);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.streamCallCount, 1);
      // All partial deltas and usage were delivered before premature close
      assert.strictEqual(events.length, 4);
      assert.strictEqual(events[0]?.type, 'text.delta');
      assert.strictEqual(events[1]?.type, 'text.delta');
      assert.strictEqual(events[2]?.type, 'text.delta');
      assert.strictEqual(events[3]?.type, 'usage');
      assert.strictEqual(events.some((e) => e.type === 'completed'), false);
    });

    it('deduplicates completed events if provider emits multiples', async () => {
      const { engine } = createTestSetup({
        chunks: ['Multi', ' completed'],
        emitDuplicateCompleted: true,
      });

      const events: LLMStreamEvent[] = [];
      for await (const event of engine.streamText(makeRequest())) {
        events.push(event);
      }

      const completedEvents = events.filter((e) => e.type === 'completed');
      assert.strictEqual(completedEvents.length, 1);
    });
  });

  describe('Model Alias & Capability Resolution', () => {
    it('rejects unknown model alias before calling provider', async () => {
      const { engine, fakeProvider } = createTestSetup();

      await assert.rejects(
        async () => {
          for await (const _ of engine.streamText(makeRequest({ modelAlias: 'unknown-model' }))) {
            // Should not reach
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof UnknownModelAliasError);
          assert.strictEqual(err.code, 'UNKNOWN_MODEL_ALIAS');
          assert.strictEqual(err.statusCode, 404);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.callCount, 0);
    });

    it('rejects alias when required capability is missing from alias config', async () => {
      const registry = new ModelRegistry();
      const fakeProvider = new FakeProvider();
      registry.registerAdapter(fakeProvider);
      registry.registerAlias({
        alias: 'giga-text-only',
        providerId: fakeProvider.providerId,
        modelId: 'text-model',
        requiredCapabilities: ['text'], // Missing 'streaming'
      });
      const engine = new LLMEngine(registry);

      await assert.rejects(
        async () => {
          for await (const _ of engine.streamText(makeRequest({ modelAlias: 'giga-text-only' }))) {
            // Should not reach
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof UnsupportedCapabilityError);
          assert.strictEqual(err.code, 'UNSUPPORTED_CAPABILITY');
          assert.strictEqual(err.statusCode, 400);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.callCount, 0);
    });

    it('rejects alias when underlying adapter lacks the required capability', async () => {
      const registry = new ModelRegistry();
      // FakeProvider configured without 'streaming'
      const fakeProvider = new FakeProvider({ capabilities: ['text'] });
      registry.registerAdapter(fakeProvider);
      registry.registerAlias({
        alias: 'giga-claimed-streaming',
        providerId: fakeProvider.providerId,
        modelId: 'fake-model',
        requiredCapabilities: ['text', 'streaming'],
      });
      const engine = new LLMEngine(registry);

      await assert.rejects(
        async () => {
          for await (const _ of engine.streamText(makeRequest({ modelAlias: 'giga-claimed-streaming' }))) {
            // Should not reach
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof UnsupportedCapabilityError);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.callCount, 0);
    });

    it('enforces maxOutputTokens limit defined on alias', async () => {
      const { engine, fakeProvider } = createTestSetup();

      await assert.rejects(
        async () => {
          for await (const _ of engine.streamText(makeRequest({ maxOutputTokens: 5000 }))) {
            // Should not reach
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof LLMValidationError);
          assert.match(err.message, /exceeds alias limit/);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.callCount, 0);
    });
  });

  describe('Error Classification and Failure Semantics', () => {
    it('classifies provider error before first token with zero completed events', async () => {
      const { engine, fakeProvider } = createTestSetup({
        errorBeforeFirstToken: new Error('upstream connection failed: key=secret123'),
      });

      const events: LLMStreamEvent[] = [];
      await assert.rejects(
        async () => {
          for await (const event of engine.streamText(makeRequest())) {
            events.push(event);
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof ProviderFailureError);
          assert.strictEqual(err.code, 'PROVIDER_FAILURE');
          assert.strictEqual(err.statusCode, 502);
          // Verify error redaction
          assert.ok(!err.message.includes('secret123'));
          return true;
        }
      );

      assert.strictEqual(fakeProvider.streamCallCount, 1);
      assert.strictEqual(events.length, 0);
    });

    it('preserves partial tokens before failure, throws classified error, and emits zero completed events', async () => {
      const { engine, fakeProvider } = createTestSetup({
        chunks: ['Token 1', 'Token 2', 'Token 3'],
        errorAfterTokens: {
          count: 2,
          error: new Error('stream dropped mid-flight'),
        },
      });

      const events: LLMStreamEvent[] = [];
      await assert.rejects(
        async () => {
          for await (const event of engine.streamText(makeRequest())) {
            events.push(event);
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof ProviderFailureError);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.streamCallCount, 1);
      // Caller should have observed exactly the first 2 deltas before failure
      assert.strictEqual(events.length, 2);
      assert.deepStrictEqual(events[0], { type: 'text.delta', text: 'Token 1' });
      assert.deepStrictEqual(events[1], { type: 'text.delta', text: 'Token 2' });

      // Invariant: NEVER emit completed event on error
      const hasCompleted = events.some((e) => e.type === 'completed');
      assert.strictEqual(hasCompleted, false);
    });

    it('classifies rate limit errors with retry details', () => {
      const err = toLLMError(new Error('Rate limit exceeded (429): please slow down'));
      assert.ok(err instanceof ProviderRateLimitError);
      assert.strictEqual(err.code, 'PROVIDER_RATE_LIMIT');
      assert.strictEqual(err.statusCode, 429);
    });

    it('classifies timeout errors', () => {
      const err = toLLMError(new Error('Request timed out after 30000ms'));
      assert.ok(err instanceof ProviderTimeoutError);
      assert.strictEqual(err.code, 'PROVIDER_TIMEOUT');
      assert.strictEqual(err.statusCode, 504);
    });
  });

  describe('Cancellation and Abort Handling', () => {
    it('aborts immediately before provider call if signal is already aborted', async () => {
      const { engine, fakeProvider } = createTestSetup();
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        async () => {
          for await (const _ of engine.streamText(makeRequest({ signal: controller.signal }))) {
            // Should not reach
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof LLMCancelledError);
          assert.strictEqual(err.code, 'LLM_CANCELLED');
          assert.strictEqual(err.statusCode, 499);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.callCount, 0);
    });

    it('propagates abort during streaming and suppresses late tokens', async () => {
      const controller = new AbortController();
      const { engine, fakeProvider } = createTestSetup({
        chunks: ['First', 'Second', 'Third'],
        chunkDelayMs: 20,
        emitTokensAfterAbort: true, // Simulates an adapter that continues yielding late tokens
      });

      const events: LLMStreamEvent[] = [];

      await assert.rejects(
        async () => {
          for await (const event of engine.streamText(makeRequest({ signal: controller.signal }))) {
            events.push(event);
            if (event.type === 'text.delta' && event.text === 'First') {
              controller.abort();
            }
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof LLMCancelledError);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.signalObservedAborted, true);
      // Only the first event before abort was yielded; late tokens were dropped by engine
      assert.strictEqual(events.length, 1);
      assert.deepStrictEqual(events[0], { type: 'text.delta', text: 'First' });
      const hasLateToken = events.some((e) => e.type === 'text.delta' && e.text.includes('LATE'));
      assert.strictEqual(hasLateToken, false);
      const hasCompleted = events.some((e) => e.type === 'completed');
      assert.strictEqual(hasCompleted, false);
    });
  });

  describe('Request Validation', () => {
    it('rejects empty or whitespace requestId', async () => {
      const { engine, fakeProvider } = createTestSetup();

      await assert.rejects(
        async () => {
          for await (const _ of engine.streamText(makeRequest({ requestId: '   ' }))) {
            // Should not reach
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof LLMValidationError);
          assert.match(err.message, /requestId/);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.callCount, 0);
    });

    it('rejects invalid caller', async () => {
      const { engine, fakeProvider } = createTestSetup();

      await assert.rejects(
        async () => {
          for await (const _ of engine.streamText(
            makeRequest({ caller: 'invalid-caller' as unknown as 'chat' })
          )) {
            // Should not reach
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof LLMValidationError);
          assert.match(err.message, /Invalid caller/);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.callCount, 0);
    });

    it('rejects empty messages array', async () => {
      const { engine, fakeProvider } = createTestSetup();

      await assert.rejects(
        async () => {
          for await (const _ of engine.streamText(makeRequest({ messages: [] }))) {
            // Should not reach
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof LLMValidationError);
          assert.match(err.message, /messages/);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.callCount, 0);
    });

    it('rejects messages with invalid roles', async () => {
      const { engine, fakeProvider } = createTestSetup();

      await assert.rejects(
        async () => {
          for await (const _ of engine.streamText(
            makeRequest({
              messages: [{ role: 'tool_developer' as unknown as 'user', content: 'hello' }],
            })
          )) {
            // Should not reach
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof LLMValidationError);
          assert.match(err.message, /invalid role/);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.callCount, 0);
    });

    it('rejects non-positive maxOutputTokens', async () => {
      const { engine, fakeProvider } = createTestSetup();

      await assert.rejects(
        async () => {
          for await (const _ of engine.streamText(makeRequest({ maxOutputTokens: 0 }))) {
            // Should not reach
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof LLMValidationError);
          assert.match(err.message, /maxOutputTokens/);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.callCount, 0);
    });

    it('rejects requestId exceeding maximum length (128 chars)', async () => {
      const { engine, fakeProvider } = createTestSetup();
      const longRequestId = 'r'.repeat(129);

      await assert.rejects(
        async () => {
          for await (const _ of engine.streamText(makeRequest({ requestId: longRequestId }))) {
            // Should not reach
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof LLMValidationError);
          assert.match(err.message, /requestId exceeds maximum length/);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.callCount, 0);
    });

    it('rejects message name exceeding maximum length (64 chars)', async () => {
      const { engine, fakeProvider } = createTestSetup();
      const longName = 'n'.repeat(65);

      await assert.rejects(
        async () => {
          for await (const _ of engine.streamText(
            makeRequest({
              messages: [{ role: 'user', content: 'hi', name: longName }],
            })
          )) {
            // Should not reach
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof LLMValidationError);
          assert.match(err.message, /name exceeds maximum length/);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.callCount, 0);
    });

    it('rejects messages array exceeding maximum limit of 500 messages', async () => {
      const { engine, fakeProvider } = createTestSetup();
      const tooManyMessages = Array.from({ length: 501 }, () => ({
        role: 'user' as const,
        content: 'message',
      }));

      await assert.rejects(
        async () => {
          for await (const _ of engine.streamText(makeRequest({ messages: tooManyMessages }))) {
            // Should not reach
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof LLMValidationError);
          assert.match(err.message, /exceeds maximum limit of 500 messages/);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.callCount, 0);
    });

    it('rejects single message exceeding 256KB', async () => {
      const { engine, fakeProvider } = createTestSetup();
      const oversizedContent = 'a'.repeat(256 * 1024 + 1);

      await assert.rejects(
        async () => {
          for await (const _ of engine.streamText(
            makeRequest({
              messages: [{ role: 'user', content: oversizedContent }],
            })
          )) {
            // Should not reach
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof LLMValidationError);
          assert.match(err.message, /exceeds maximum single message limit/);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.callCount, 0);
    });

    it('rejects total messages size exceeding 1MB', async () => {
      const { engine, fakeProvider } = createTestSetup();
      // 5 messages of 220KB each = 1.1MB total (> 1MB)
      const chunk = 'x'.repeat(220 * 1024);
      const messages = Array.from({ length: 5 }, () => ({
        role: 'user' as const,
        content: chunk,
      }));

      await assert.rejects(
        async () => {
          for await (const _ of engine.streamText(makeRequest({ messages }))) {
            // Should not reach
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof LLMValidationError);
          assert.match(err.message, /Total messages size .* exceeds maximum limit/);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.callCount, 0);
    });
  });

  describe('generateText', () => {
    it('returns complete model result on success', async () => {
      const { engine, fakeProvider } = createTestSetup({
        chunks: ['Full response text'],
        finishReason: 'stop',
        usage: { inputTokens: 20, outputTokens: 8, source: 'provider' },
      });

      const result = await engine.generateText(makeRequest());

      assert.strictEqual(fakeProvider.generateCallCount, 1);
      assert.strictEqual(result.text, 'Full response text');
      assert.strictEqual(result.finishReason, 'stop');
      assert.deepStrictEqual(result.usage, {
        inputTokens: 20,
        outputTokens: 8,
        source: 'provider',
      });
    });

    it('classifies error on generateText failure', async () => {
      const { engine, fakeProvider } = createTestSetup({
        generateError: new Error('Provider 500 error'),
      });

      await assert.rejects(
        async () => {
          await engine.generateText(makeRequest());
        },
        (err: unknown) => {
          assert.ok(err instanceof ProviderFailureError);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.generateCallCount, 1);
    });

    it('rejects generateText if aborted', async () => {
      const { engine, fakeProvider } = createTestSetup();
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        async () => {
          await engine.generateText(makeRequest({ signal: controller.signal }));
        },
        (err: unknown) => {
          assert.ok(err instanceof LLMCancelledError);
          return true;
        }
      );

      assert.strictEqual(fakeProvider.callCount, 0);
    });
  });

  describe('Production Safety & Fail-Closed Registry', () => {
    it('fails closed with ProviderUnavailableError if provider is not registered', () => {
      const registry = new ModelRegistry();
      registry.registerAlias({
        alias: 'prod-chat',
        providerId: 'unconfigured-openai',
        modelId: 'gpt-4o',
        requiredCapabilities: ['streaming', 'text'],
      });

      // Does NOT fallback to fake provider
      assert.throws(
        () => registry.resolve('prod-chat', 'streaming'),
        (err: unknown) => {
          assert.ok(err instanceof ProviderUnavailableError);
          assert.match(err.message, /is not available/);
          return true;
        }
      );
    });

    it('validate() throws if any alias points to missing adapter or capability', () => {
      const registry = new ModelRegistry();
      registry.registerAlias({
        alias: 'orphan-alias',
        providerId: 'missing-provider',
        modelId: 'model-x',
        requiredCapabilities: ['text'],
      });

      assert.throws(
        () => registry.validate(),
        (err: unknown) => {
          assert.ok(err instanceof ProviderUnavailableError);
          return true;
        }
      );
    });

    it('rejects duplicate registerAdapter with LLMValidationError and preserves original', () => {
      const registry = new ModelRegistry();
      const adapter1 = new FakeProvider({ providerId: 'dup-provider' });
      const adapter2 = new FakeProvider({ providerId: 'dup-provider' });
      registry.registerAdapter(adapter1);

      assert.throws(
        () => registry.registerAdapter(adapter2),
        (err: unknown) => {
          assert.ok(err instanceof LLMValidationError);
          assert.match(err.message, /already registered/);
          return true;
        }
      );

      // Verify original is preserved
      assert.strictEqual(registry.getAdapter('dup-provider'), adapter1);
    });

    it('rejects duplicate registerAlias with LLMValidationError and preserves original', () => {
      const registry = new ModelRegistry();
      const fake = new FakeProvider({ providerId: 'p1' });
      registry.registerAdapter(fake);
      registry.registerAlias({
        alias: 'dup-alias',
        providerId: 'p1',
        modelId: 'm1',
        requiredCapabilities: ['text'],
      });

      assert.throws(
        () =>
          registry.registerAlias({
            alias: 'dup-alias',
            providerId: 'p1',
            modelId: 'm2',
            requiredCapabilities: ['text'],
          }),
        (err: unknown) => {
          assert.ok(err instanceof LLMValidationError);
          assert.match(err.message, /already registered/);
          return true;
        }
      );

      // Verify original is preserved
      assert.strictEqual(registry.getAliasConfig('dup-alias')?.modelId, 'm1');
    });
  });

  describe('Error Redaction and Sanitization', () => {
    it('redacts Bearer tokens and sensitive API keys', () => {
      const messageWithSecrets =
        'Failed auth: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID and sk-proj-9876543210abcdef';
      const sanitized = sanitizeErrorMessage(messageWithSecrets);

      assert.strictEqual(
        sanitized,
        'Failed auth: Bearer [REDACTED] and [REDACTED_KEY]'
      );
    });

    it('redacts keys in query strings and assignments', () => {
      const message =
        'Error at https://api.openai.com/v1/chat?api_key=sk-1234567890abcdef with apiKey="secret_pass_123"';
      const sanitized = sanitizeErrorMessage(message);

      assert.ok(!sanitized.includes('sk-1234567890abcdef'));
      assert.ok(!sanitized.includes('secret_pass_123'));
      assert.ok(sanitized.includes('api_key=[REDACTED]'));
    });

    it('recursively sanitizes LLMError.details and redacts secret keys and values', () => {
      const err = new ProviderFailureError('Upstream connection error', {
        endpoint: 'https://api.openai.com/v1/chat?api_key=sk-1234567890abcdef',
        auth: {
          token: 'secret-tok-999999999',
          bearer: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        },
        headers: {
          'Authorization': 'Bearer my-secret-token',
          'X-Api-Key': 'sk-abc1234567890',
        },
        metadata: {
          apiKey: 'raw-secret-key',
          password: 'super-password',
          safeField: 'harmless string with key=secret123',
          numeric: 42,
          flag: true,
          nestedList: [
            'Bearer top-secret-token',
            { secretData: 'classified' },
          ],
        },
      });

      const details = err.details;
      assert.ok(details);

      // Sensitive keys are redacted
      assert.strictEqual(details.auth, '[REDACTED]');
      assert.strictEqual(details.headers, '[REDACTED]');

      // Nested object
      const meta = details.metadata as Record<string, unknown>;
      assert.ok(meta);
      assert.strictEqual(meta.apiKey, '[REDACTED]');
      assert.strictEqual(meta.password, '[REDACTED]');
      assert.strictEqual(meta.safeField, 'harmless string with key=[REDACTED]');
      assert.strictEqual(meta.numeric, 42);
      assert.strictEqual(meta.flag, true);

      // Array sanitization
      const list = meta.nestedList as unknown[];
      assert.strictEqual(list[0], 'Bearer [REDACTED]');
      assert.deepStrictEqual(list[1], { secretData: '[REDACTED]' });

      // Entire serialized details must not contain raw secrets
      const serialized = JSON.stringify(details);
      assert.ok(!serialized.includes('sk-1234567890abcdef'));
      assert.ok(!serialized.includes('secret-tok-999999999'));
      assert.ok(!serialized.includes('my-secret-token'));
      assert.ok(!serialized.includes('raw-secret-key'));
      assert.ok(!serialized.includes('super-password'));
      assert.ok(!serialized.includes('classified'));
    });
  });
});
