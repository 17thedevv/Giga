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

    it('synthesizes exactly one completed event if provider omits it', async () => {
      const { engine } = createTestSetup({
        chunks: ['No', ' completed', ' emitted'],
        omitCompleted: true,
      });

      const events: LLMStreamEvent[] = [];
      for await (const event of engine.streamText(makeRequest())) {
        events.push(event);
      }

      const completedEvents = events.filter((e) => e.type === 'completed');
      assert.strictEqual(completedEvents.length, 1);
      assert.strictEqual(completedEvents[0]?.type, 'completed');
      if (completedEvents[0]?.type === 'completed') {
        assert.strictEqual(completedEvents[0].finishReason, 'stop');
      }
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
  });
});
