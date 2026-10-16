/**
 * Shared LLM Engine v0.1 — Core Engine
 *
 * Implements model alias resolution, input validation, capability preflight,
 * normalized streaming, cancellation, and sanitized error classification.
 */

import {
  LLMCancelledError,
  LLMValidationError,
  ProviderFailureError,
  UnsupportedReasoningEffortError,
  toLLMError,
} from './errors.js';
import type { ModelRegistry } from './registry.js';
import type { CredentialResolver, ProviderCredential } from './provider-credential.js';
import type { ProviderAdapter } from './adapter.js';
import {
  VALID_REASONING_EFFORTS,
  type LLMCaller,
  type LLMRequest,
  type LLMStreamEvent,
  type ModelMessage,
  type ModelMetadata,
  type ModelResult,
  type ResolvedLLMRequest,
  type ResolvedModelIdentity,
} from './types.js';

export const MAX_REQUEST_ID_LENGTH = 128;
export const MAX_MESSAGE_NAME_LENGTH = 64;
export const MAX_MESSAGES_COUNT = 500;
export const MAX_SINGLE_MESSAGE_BYTES = 256 * 1024; // 256 KB
export const MAX_TOTAL_MESSAGES_BYTES = 1024 * 1024; // 1 MB

const VALID_CALLERS: ReadonlySet<LLMCaller> = new Set(['chat', 'agent', 'memory']);
const VALID_ROLES = new Set(['system', 'user', 'assistant']);

export class LLMEngine {
  constructor(private readonly registry: ModelRegistry, private readonly platformCredential?: ProviderCredential) {}

  /**
   * Validates common LLMRequest invariants and enforces conservative bounds.
   */
  private validateRequest(req: LLMRequest): void {
    if (!req || typeof req !== 'object') {
      throw new LLMValidationError('LLMRequest must be an object');
    }

    if (!req.requestId || typeof req.requestId !== 'string' || req.requestId.trim() === '') {
      throw new LLMValidationError('requestId must be a non-empty string');
    }

    if (req.requestId.length > MAX_REQUEST_ID_LENGTH) {
      throw new LLMValidationError(
        `requestId exceeds maximum length of ${MAX_REQUEST_ID_LENGTH} characters`
      );
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

    if (req.messages.length > MAX_MESSAGES_COUNT) {
      throw new LLMValidationError(
        `messages array exceeds maximum limit of ${MAX_MESSAGES_COUNT} messages`
      );
    }

    let totalBytes = 0;
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
      if (typedMsg.name !== undefined) {
        if (typeof typedMsg.name !== 'string' || typedMsg.name.length > MAX_MESSAGE_NAME_LENGTH) {
          throw new LLMValidationError(
            `Message at index ${i} name exceeds maximum length of ${MAX_MESSAGE_NAME_LENGTH} characters`
          );
        }
      }

      const msgBytes = Buffer.byteLength(typedMsg.content, 'utf8');
      if (msgBytes > MAX_SINGLE_MESSAGE_BYTES) {
        throw new LLMValidationError(
          `Message at index ${i} size (${msgBytes} bytes) exceeds maximum single message limit of ${MAX_SINGLE_MESSAGE_BYTES} bytes`
        );
      }
      totalBytes += msgBytes;
      if (totalBytes > MAX_TOTAL_MESSAGES_BYTES) {
        throw new LLMValidationError(
          `Total messages size (${totalBytes} bytes) exceeds maximum limit of ${MAX_TOTAL_MESSAGES_BYTES} bytes`
        );
      }
    }

    if (
      typeof req.maxOutputTokens !== 'number' ||
      !Number.isInteger(req.maxOutputTokens) ||
      req.maxOutputTokens <= 0
    ) {
      throw new LLMValidationError('maxOutputTokens must be a positive integer');
    }

    if (req.reasoningEffort !== undefined) {
      if (typeof req.reasoningEffort !== 'string' || !VALID_REASONING_EFFORTS.includes(req.reasoningEffort)) {
        throw new LLMValidationError(`Invalid reasoningEffort: '${req.reasoningEffort}'. Must be one of: low, medium, high`);
      }
    }
  }

  /**
   * Lists all registered models with their trusted capabilities.
   */
  public listModels(): readonly ModelMetadata[] {
    return this.registry.listModels();
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
    return this.prepareStream(req).stream;
  }

  /** Resolve once without network I/O so callers can durably record trusted identity. */
  public prepareStream(req: LLMRequest, resolveCredential?: CredentialResolver): { readonly identity: ResolvedModelIdentity; readonly stream: AsyncIterable<LLMStreamEvent> } {
    this.validateRequest(req);
    if (resolveCredential && req.caller !== 'chat') throw new LLMValidationError('Chat credentials require a Chat caller');

    const { adapter, config } = this.registry.resolve(req.modelAlias, 'streaming');

    if (config.maxOutputTokensLimit !== undefined && req.maxOutputTokens > config.maxOutputTokensLimit) {
      throw new LLMValidationError(
        `Requested maxOutputTokens (${req.maxOutputTokens}) exceeds alias limit of ${config.maxOutputTokensLimit}`
      );
    }

    if (req.reasoningEffort !== undefined) {
      const reasoning = this.registry.getReasoningCapabilities(req.modelAlias);
      if (!reasoning.supported || !reasoning.efforts.includes(req.reasoningEffort)) {
        throw new UnsupportedReasoningEffortError(req.reasoningEffort, req.modelAlias);
      }
    }

    const resolvedReq: ResolvedLLMRequest = {
      ...req,
      providerId: config.providerId,
      modelId: config.modelId,
    };

    return { identity: { providerId: config.providerId, modelId: config.modelId }, stream: this.createStream(adapter, resolvedReq, req.signal, resolveCredential) };
  }

  private async *createStream(
    adapter: ProviderAdapter,
    resolvedReq: ResolvedLLMRequest,
    signal: AbortSignal,
    resolveCredential?: CredentialResolver
  ): AsyncIterable<LLMStreamEvent> {
    if (signal.aborted) {
      throw new LLMCancelledError('LLM operation was cancelled before streaming');
    }

    let hasCompleted = false;

    try {
      // Resolve once after alias validation, immediately before transport. No fallback
      // when an explicit resolver rejects or returns an unavailable credential.
      const credential = resolveCredential ? await resolveCredential() : this.platformCredential;
      if (signal.aborted) throw new LLMCancelledError();
      const stream = adapter.streamText(resolvedReq, credential);

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
          yield event;
          return;
        }

        yield event;
      }

      if (signal.aborted) {
        throw new LLMCancelledError('LLM operation was cancelled');
      }

      // A normalized adapter stream MUST emit an explicit terminal completed event.
      // If the iterator closes without emitting completed, treat it as premature truncation / provider failure.
      if (!hasCompleted) {
        throw new ProviderFailureError(
          'Stream terminated prematurely without a terminal completed event'
        );
      }
    } catch (err) {
      // Completed is the absolute terminal event. Suppress any subsequent errors
      // thrown during provider iterator cleanup/teardown.
      if (hasCompleted) {
        return;
      }
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

    if (req.reasoningEffort !== undefined) {
      const reasoning = this.registry.getReasoningCapabilities(req.modelAlias);
      if (!reasoning.supported || !reasoning.efforts.includes(req.reasoningEffort)) {
        throw new UnsupportedReasoningEffortError(req.reasoningEffort, req.modelAlias);
      }
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
      const result = await adapter.generateText(resolvedReq, this.platformCredential);

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
