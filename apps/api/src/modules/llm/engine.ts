/**
 * Shared LLM Engine v0.1 — Core Engine
 *
 * Implements model alias resolution, input validation, capability preflight,
 * normalized streaming, cancellation, and sanitized error classification.
 */

import {
  LLMCancelledError,
  LLMValidationError,
  toLLMError,
} from './errors.js';
import type { ModelRegistry } from './registry.js';
import type {
  FinishReason,
  LLMCaller,
  LLMRequest,
  LLMStreamEvent,
  ModelMessage,
  ModelResult,
  ResolvedLLMRequest,
} from './types.js';

const VALID_CALLERS: ReadonlySet<LLMCaller> = new Set(['chat', 'agent', 'memory']);
const VALID_ROLES = new Set(['system', 'user', 'assistant']);

export class LLMEngine {
  constructor(private readonly registry: ModelRegistry) {}

  /**
   * Validates common LLMRequest invariants.
   */
  private validateRequest(req: LLMRequest): void {
    if (!req || typeof req !== 'object') {
      throw new LLMValidationError('LLMRequest must be an object');
    }

    if (!req.requestId || typeof req.requestId !== 'string' || req.requestId.trim() === '') {
      throw new LLMValidationError('requestId must be a non-empty string');
    }

    if (!VALID_CALLERS.has(req.caller)) {
      throw new LLMValidationError(`Invalid caller: '${req.caller}'. Must be one of: chat, agent, memory`);
    }

    if (!req.signal || typeof req.signal.aborted !== 'boolean') {
      throw new LLMValidationError('signal must be a valid AbortSignal');
    }

    if (req.signal.aborted) {
      throw new LLMCancelledError('LLM request was aborted before start');
    }

    if (!Array.isArray(req.messages) || req.messages.length === 0) {
      throw new LLMValidationError('messages must be a non-empty array of ModelMessage');
    }

    for (let i = 0; i < req.messages.length; i++) {
      const msg: unknown = req.messages[i];
      if (!msg || typeof msg !== 'object') {
        throw new LLMValidationError(`Message at index ${i} must be an object`);
      }
      const typedMsg = msg as Partial<ModelMessage>;
      if (!typedMsg.role || !VALID_ROLES.has(typedMsg.role)) {
        throw new LLMValidationError(
          `Message at index ${i} has invalid role: '${typedMsg.role}'. Must be system, user, or assistant`
        );
      }
      if (typeof typedMsg.content !== 'string') {
        throw new LLMValidationError(`Message at index ${i} content must be a string`);
      }
    }

    if (
      typeof req.maxOutputTokens !== 'number' ||
      !Number.isInteger(req.maxOutputTokens) ||
      req.maxOutputTokens <= 0
    ) {
      throw new LLMValidationError('maxOutputTokens must be a positive integer');
    }
  }

  /**
   * Streams text tokens and metadata events.
   *
   * Guarantees:
   * - Exactly one terminal 'completed' event on success.
   * - Zero 'completed' events on error or abort.
   * - Suppresses any late events emitted after abort or after completed.
   * - Never retries or falls back across providers once streaming has started.
   */
  public streamText(req: LLMRequest): AsyncIterable<LLMStreamEvent> {
    this.validateRequest(req);

    const { adapter, config } = this.registry.resolve(req.modelAlias, 'streaming');

    if (config.maxOutputTokensLimit !== undefined && req.maxOutputTokens > config.maxOutputTokensLimit) {
      throw new LLMValidationError(
        `Requested maxOutputTokens (${req.maxOutputTokens}) exceeds alias limit of ${config.maxOutputTokensLimit}`
      );
    }

    const resolvedReq: ResolvedLLMRequest = {
      ...req,
      providerId: config.providerId,
      modelId: config.modelId,
    };

    return this.createStream(adapter, resolvedReq, req.signal);
  }

  private async *createStream(
    adapter: { streamText(req: ResolvedLLMRequest): AsyncIterable<LLMStreamEvent> },
    resolvedReq: ResolvedLLMRequest,
    signal: AbortSignal
  ): AsyncIterable<LLMStreamEvent> {
    if (signal.aborted) {
      throw new LLMCancelledError('LLM operation was cancelled before streaming');
    }

    let hasCompleted = false;
    let terminalFinishReason: FinishReason = 'stop';

    try {
      const stream = adapter.streamText(resolvedReq);

      for await (const event of stream) {
        if (signal.aborted) {
          throw new LLMCancelledError('LLM operation was cancelled');
        }

        // Suppress any late events after completion has already occurred
        if (hasCompleted) {
          continue;
        }

        if (event.type === 'completed') {
          hasCompleted = true;
          terminalFinishReason = event.finishReason;
          yield event;
        } else {
          yield event;
        }
      }

      if (signal.aborted) {
        throw new LLMCancelledError('LLM operation was cancelled');
      }

      // If adapter completed cleanly without emitting a terminal event, emit one
      if (!hasCompleted) {
        hasCompleted = true;
        yield {
          type: 'completed',
          finishReason: terminalFinishReason,
        };
      }
    } catch (err) {
      if (signal.aborted) {
        throw new LLMCancelledError('LLM operation was cancelled');
      }
      throw toLLMError(err);
    }
  }

  /**
   * Generates a single complete text response.
   */
  public async generateText(req: LLMRequest): Promise<ModelResult> {
    this.validateRequest(req);

    const { adapter, config } = this.registry.resolve(req.modelAlias, 'text');

    if (config.maxOutputTokensLimit !== undefined && req.maxOutputTokens > config.maxOutputTokensLimit) {
      throw new LLMValidationError(
        `Requested maxOutputTokens (${req.maxOutputTokens}) exceeds alias limit of ${config.maxOutputTokensLimit}`
      );
    }

    const resolvedReq: ResolvedLLMRequest = {
      ...req,
      providerId: config.providerId,
      modelId: config.modelId,
    };

    if (req.signal.aborted) {
      throw new LLMCancelledError('LLM operation was cancelled before execution');
    }

    try {
      const result = await adapter.generateText(resolvedReq);

      if (req.signal.aborted) {
        throw new LLMCancelledError('LLM operation was cancelled');
      }

      return result;
    } catch (err) {
      if (req.signal.aborted) {
        throw new LLMCancelledError('LLM operation was cancelled');
      }
      throw toLLMError(err);
    }
  }
}
