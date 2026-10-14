/**
 * Shared LLM Engine v0.1 — Deterministic Fake Provider
 *
 * Test fixture for simulating provider behaviors, stream events,
 * network delays, errors before/after first token, and cancellation.
 * STRICTLY for testing; never to be used in production.
 */

import type { ProviderAdapter } from '../adapter.js';
import type {
  Capability,
  FinishReason,
  LLMStreamEvent,
  LLMUsage,
  ModelResult,
  ResolvedLLMRequest,
} from '../types.js';

export interface FakeProviderOptions {
  readonly providerId?: string;
  readonly capabilities?: Iterable<Capability>;
  readonly chunks?: readonly string[];
  readonly chunkDelayMs?: number;
  readonly delayBeforeFirstTokenMs?: number;
  readonly errorBeforeFirstToken?: Error;
  readonly errorAfterTokens?: { readonly count: number; readonly error: Error };
  readonly finishReason?: FinishReason;
  readonly usage?: LLMUsage;
  readonly omitCompleted?: boolean;
  readonly emitDuplicateCompleted?: boolean;
  readonly emitTokensAfterAbort?: boolean;
  readonly errorAfterCompleted?: Error;
  readonly generateResult?: ModelResult;
  readonly generateError?: Error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FakeProvider implements ProviderAdapter {
  public readonly providerId: string;
  public readonly capabilities: ReadonlySet<Capability>;

  public callCount = 0;
  public streamCallCount = 0;
  public generateCallCount = 0;
  public lastRequest?: ResolvedLLMRequest;
  public signalObservedAborted = false;

  private readonly chunks: readonly string[];
  private readonly chunkDelayMs: number;
  private readonly delayBeforeFirstTokenMs: number;
  private readonly errorBeforeFirstToken?: Error;
  private readonly errorAfterTokens?: { readonly count: number; readonly error: Error };
  private readonly finishReason: FinishReason;
  private readonly usage?: LLMUsage;
  private readonly omitCompleted: boolean;
  private readonly emitDuplicateCompleted: boolean;
  private readonly emitTokensAfterAbort: boolean;
  private readonly errorAfterCompleted?: Error;
  private readonly generateResult?: ModelResult;
  private readonly generateError?: Error;

  constructor(options: FakeProviderOptions = {}) {
    this.providerId = options.providerId ?? 'fake-provider';
    this.capabilities = new Set(
      options.capabilities ?? ['text', 'streaming', 'structured', 'tool_calling']
    );
    this.chunks = options.chunks ?? ['Hello', ' world!'];
    this.chunkDelayMs = options.chunkDelayMs ?? 0;
    this.delayBeforeFirstTokenMs = options.delayBeforeFirstTokenMs ?? 0;
    this.errorBeforeFirstToken = options.errorBeforeFirstToken;
    this.errorAfterTokens = options.errorAfterTokens;
    this.finishReason = options.finishReason ?? 'stop';
    this.usage =
      options.usage ?? {
        inputTokens: 10,
        outputTokens: 5,
        source: 'provider',
      };
    this.omitCompleted = options.omitCompleted ?? false;
    this.emitDuplicateCompleted = options.emitDuplicateCompleted ?? false;
    this.emitTokensAfterAbort = options.emitTokensAfterAbort ?? false;
    this.errorAfterCompleted = options.errorAfterCompleted;
    this.generateResult = options.generateResult;
    this.generateError = options.generateError;
  }

  public async *streamText(req: ResolvedLLMRequest): AsyncIterable<LLMStreamEvent> {
    this.callCount++;
    this.streamCallCount++;
    this.lastRequest = req;

    if (this.delayBeforeFirstTokenMs > 0) {
      await delay(this.delayBeforeFirstTokenMs);
    }

    if (req.signal.aborted) {
      this.signalObservedAborted = true;
      if (!this.emitTokensAfterAbort) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
    }

    if (this.errorBeforeFirstToken) {
      throw this.errorBeforeFirstToken;
    }

    let emittedCount = 0;
    for (const chunk of this.chunks) {
      if (req.signal.aborted) {
        this.signalObservedAborted = true;
        if (!this.emitTokensAfterAbort) {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          throw err;
        }
      }

      yield { type: 'text.delta', text: chunk };
      emittedCount++;

      if (this.errorAfterTokens && emittedCount === this.errorAfterTokens.count) {
        throw this.errorAfterTokens.error;
      }

      if (this.chunkDelayMs > 0) {
        await delay(this.chunkDelayMs);
      }
    }

    // If emitTokensAfterAbort is true and aborted, simulate a late token emission
    if (this.emitTokensAfterAbort && req.signal.aborted) {
      yield { type: 'text.delta', text: ' [LATE UNWANTED TOKEN]' };
    }

    if (this.usage) {
      yield { type: 'usage', ...this.usage };
    }

    if (!this.omitCompleted) {
      yield { type: 'completed', finishReason: this.finishReason };
      if (this.errorAfterCompleted) {
        throw this.errorAfterCompleted;
      }
      if (this.emitDuplicateCompleted) {
        yield { type: 'completed', finishReason: this.finishReason };
      }
    }
  }

  public async generateText(req: ResolvedLLMRequest): Promise<ModelResult> {
    this.callCount++;
    this.generateCallCount++;
    this.lastRequest = req;

    if (this.delayBeforeFirstTokenMs > 0) {
      await delay(this.delayBeforeFirstTokenMs);
    }

    if (req.signal.aborted) {
      this.signalObservedAborted = true;
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }

    if (this.generateError) {
      throw this.generateError;
    }

    return (
      this.generateResult ?? {
        text: this.chunks.join(''),
        finishReason: this.finishReason,
        usage: this.usage,
      }
    );
  }
}
