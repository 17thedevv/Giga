import { createHash } from 'node:crypto';
import { AppError, ValidationError } from '../auth/auth-validation.js';
import type { LLMEngine } from '../llm/engine.js';
import type { LLMStreamEvent } from '../llm/types.js';
import {
  MAX_OUTPUT_BYTES, MAX_PROMPT_BYTES, SAFE_GENERATION_ERROR,
  type Admission, type Cancellation, type ChatGeneration, type ChatTurnVariants, type EventSink, type GenerationRepository,
} from './types.js';
import { validateIdempotencyKey } from './chat-validation.js';
import { validateUuid } from '../conversations/conversations-validation.js';

export const CHAT_MODEL_ALIAS = 'giga-chat-default';
export const MAX_ACTIVE_GENERATIONS = 256;
interface ActiveGeneration {
  readonly ownerId: string;
  readonly controller: AbortController;
}
export interface RuntimeOptions {
  readonly maxOutputTokens?: number;
  readonly totalTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
}

class RuntimeFailure extends Error {
  constructor(readonly code: string) { super(SAFE_GENERATION_ERROR); }
}

/** Bounds individual provider reads and delivery even if the adapter ignores AbortSignal. */
async function bounded<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new RuntimeFailure('INTERRUPTED'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        timer = setTimeout(() => reject(new RuntimeFailure('GENERATION_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

export class ChatRuntime {
  private readonly active = new Map<string, ActiveGeneration>();
  get activeGenerationCount(): number { return this.active.size; }
  constructor(
    private readonly repository: GenerationRepository,
    private readonly engine: (Pick<LLMEngine, 'streamText'> & Partial<Pick<LLMEngine, 'prepareStream'>>) | undefined,
    private readonly options: RuntimeOptions = {},
  ) {}

  async admit(ownerId: string, conversationId: string, body: unknown, key: string | undefined): Promise<Admission> {
    await this.repository.authorize(ownerId, conversationId);
    const validatedKey = validateIdempotencyKey(key);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Expected a JSON object');
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some((name) => name !== 'content' && name !== 'modelId')) throw new ValidationError('Unknown request field');
    if (typeof input.content !== 'string' || !input.content.trim() || Buffer.byteLength(input.content) > MAX_PROMPT_BYTES) {
      throw new ValidationError('Content must be nonempty and at most 16384 UTF-8 bytes');
    }
    const modelId = input.modelId === undefined ? CHAT_MODEL_ALIAS : input.modelId;
    if (modelId !== CHAT_MODEL_ALIAS) throw new ValidationError('Unsupported model alias');
    if (!this.engine) throw new AppError('SERVICE_UNAVAILABLE', 'Chat model is not configured', 503);
    const fingerprint = createHash('sha256').update(JSON.stringify([conversationId, input.content, modelId])).digest('hex');
    return this.repository.admit({ ownerId, conversationId, content: input.content, modelId, key: validatedKey, fingerprint });
  }

  get(ownerId: string, conversationId: string, generationId: string): Promise<ChatGeneration> {
    return this.repository.get(ownerId, conversationId, generationId);
  }

  async admitVariant(ownerId: string, conversationId: string, body: unknown, key: string | undefined): Promise<Admission> {
    await this.repository.authorize(ownerId, conversationId);
    const validatedKey = validateIdempotencyKey(key);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Expected a JSON object');
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some((name) => !['userMessageId', 'action', 'modelId'].includes(name))) throw new ValidationError('Unknown request field');
    if (typeof input.userMessageId !== 'string') throw new ValidationError('Expected userMessageId');
    const userMessageId = validateUuid(input.userMessageId).toLowerCase();
    conversationId = conversationId.toLowerCase();
    if (input.action !== 'retry' && input.action !== 'regenerate') throw new ValidationError('Unsupported generation action');
    const modelId = input.modelId === undefined ? CHAT_MODEL_ALIAS : input.modelId;
    if (modelId !== CHAT_MODEL_ALIAS) throw new ValidationError('Unsupported model alias');
    if (!this.engine) throw new AppError('SERVICE_UNAVAILABLE', 'Chat model is not configured', 503);
    const fingerprint = createHash('sha256').update(JSON.stringify([conversationId, input.action, userMessageId, modelId])).digest('hex');
    return this.repository.admit({ ownerId, conversationId, userMessageId, action: input.action, modelId, key: validatedKey, fingerprint });
  }

  variants(ownerId: string, conversationId: string, userMessageId: string): Promise<ChatTurnVariants> {
    return this.repository.variants(ownerId, conversationId.toLowerCase(), userMessageId.toLowerCase());
  }

  async cancel(ownerId: string, conversationId: string, generationId: string, key: string | undefined): Promise<Cancellation> {
    // Ownership is checked before key binding or any process-local signal.
    await this.repository.get(ownerId, conversationId, generationId);
    const result = await this.repository.requestCancel(ownerId, conversationId, generationId, validateIdempotencyKey(key));
    if (!result.accepted) return result;
    const entry = this.active.get(generationId);
    if (entry?.ownerId === ownerId) {
      // requestCancel has committed. Abort is an optimization; DB intent fences completion.
      entry.controller.abort(new RuntimeFailure('STOPPED'));
      return result; // 202 reports durable intent; the owning run finalizes its full buffer.
    }
    // Pending or another worker: finalize checkpointed text. Remote provider abort is not instant.
    const generation = await this.repository.finalize(ownerId, result.generation, result.generation.partialContent, 'interrupted', 'INTERRUPTED');
    return { ...result, generation };
  }

  async run(ownerId: string, generation: ChatGeneration, sink: EventSink, signal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const entry: ActiveGeneration = { ownerId, controller };
    const registered = this.active.size < MAX_ACTIVE_GENERATIONS && !this.active.has(generation.id);
    if (registered) this.active.set(generation.id, entry);
    const onAbort = (): void => controller.abort(new RuntimeFailure('INTERRUPTED'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const totalTimer = setTimeout(() => controller.abort(new RuntimeFailure('GENERATION_TIMEOUT')), this.options.totalTimeoutMs ?? 90000);
    const identity = { messageId: generation.id, generationId: generation.id };
    let text = '';
    let committed = false;
    let deliveryFailed = false;
    let iterator: AsyncIterator<LLMStreamEvent> | undefined;
    const send: EventSink = async (event) => {
      try {
        // Diagnostics after a provider timeout may still be delivered to a connected client.
        await bounded(sink(event), signal, this.options.writeTimeoutMs ?? 5000);
      } catch (error) {
        deliveryFailed = true;
        controller.abort(new RuntimeFailure('INTERRUPTED'));
        throw error;
      }
    };
    try {
      controller.signal.throwIfAborted();
      await send({ event: 'message.started', data: { ...identity, conversationId: generation.conversationId } });
      if (!registered) throw new RuntimeFailure('RUNTIME_CAPACITY');
      await this.repository.start(ownerId, generation.id);
      const messages = await this.repository.context(ownerId, generation);
      const beforeProvider = await this.repository.get(ownerId, generation.conversationId, generation.id);
      if (beforeProvider.cancelRequestedAt) throw new RuntimeFailure('STOPPED');
      controller.signal.throwIfAborted();
      if (!this.engine) throw new RuntimeFailure('SERVICE_UNAVAILABLE');
      const request = { modelAlias: generation.modelId, messages, maxOutputTokens: this.options.maxOutputTokens ?? 2048,
        requestId: generation.id, caller: 'chat' as const, signal: controller.signal };
      if (this.engine.prepareStream) {
        const prepared = this.engine.prepareStream(request);
        await this.repository.recordResolvedModel(ownerId, generation.id, prepared.identity);
        controller.signal.throwIfAborted();
        iterator = prepared.stream[Symbol.asyncIterator]();
      } else {
        iterator = this.engine.streamText(request)[Symbol.asyncIterator](); // Explicit stream-only test doubles.
      }
      let lastCheckpointBytes = 0;
      let lastCheckpointAt = Date.now();
      while (true) {
        const next = await bounded(iterator.next(), controller.signal, this.options.idleTimeoutMs ?? 15000);
        controller.signal.throwIfAborted();
        if (next.done) throw new RuntimeFailure('UPSTREAM_ERROR');
        // Observe another worker's durable Stop before accepting further provider output.
        const current = await this.repository.get(ownerId, generation.conversationId, generation.id);
        if (current.cancelRequestedAt) throw new RuntimeFailure('STOPPED');
        if (current.status !== 'streaming') throw new RuntimeFailure('INTERRUPTED');
        controller.signal.throwIfAborted();
        const event = next.value;
        if (event.type === 'text.delta') {
          if (typeof event.text !== 'string') throw new RuntimeFailure('UPSTREAM_ERROR');
          const bytes = Buffer.byteLength(text) + Buffer.byteLength(event.text);
          if (bytes > MAX_OUTPUT_BYTES) throw new RuntimeFailure('OUTPUT_LIMIT');
          text += event.text;
          if (bytes - lastCheckpointBytes >= 4096 || Date.now() - lastCheckpointAt >= 1000) {
            await this.repository.checkpoint(ownerId, generation.id, text);
            lastCheckpointBytes = bytes;
            lastCheckpointAt = Date.now();
          }
          await send({ event: 'message.delta', data: { ...identity, text: event.text } });
        } else if (event.type === 'completed') {
          const reason = event.finishReason === 'stop' || event.finishReason === 'length' ? event.finishReason : 'other';
          // complete() returns only after COMMIT. Delivery errors must never undo this durable result.
          const completed = await this.repository.complete(ownerId, generation, text, reason);
          committed = true;
          await send({ event: 'message.completed', data: { ...identity, createdAt: completed.finishedAt, finishReason: completed.finishReason } });
          return;
        } else if (event.type !== 'usage') {
          throw new RuntimeFailure('UPSTREAM_ERROR');
        }
      }
    } catch (error) {
      controller.abort(error);
      if (committed) return;
      const interrupted = signal.aborted || deliveryFailed;
      const code = interrupted ? 'INTERRUPTED' : error instanceof RuntimeFailure ? error.code : 'GENERATION_FAILED';
      // A persistent DB outage can prevent failure persistence; GET remains authoritative.
      // Never replace a committed terminal state, including an ambiguous COMMIT response.
      let persisted: ChatGeneration | undefined;
      try { persisted = await this.repository.finalize(ownerId, generation, text, interrupted ? 'interrupted' : 'failed', code); } catch { /* no fabricated success */ }
      if (persisted?.status === 'stopped') {
        if (!interrupted) {
          try { await send({ event: 'message.stopped', data: { ...identity, finishReason: 'cancelled' } }); } catch { /* reconcile through GET */ }
        }
        return;
      }
      if (persisted?.status === 'completed') return;
      const stopRequested = (error instanceof RuntimeFailure && error.code === 'STOPPED') ||
        (controller.signal.reason instanceof RuntimeFailure && controller.signal.reason.code === 'STOPPED');
      if (!persisted && stopRequested) return;
      if (!interrupted) {
        const safeError = { code, message: SAFE_GENERATION_ERROR };
        try {
          await send({ event: 'stream.error', data: { ...identity, error: safeError } });
          await send({ event: 'message.failed', data: { ...identity, error: safeError } });
        } catch { /* disconnected: reconcile through GET */ }
      }
    } finally {
      clearTimeout(totalTimer);
      signal.removeEventListener('abort', onAbort);
      if (this.active.get(generation.id) === entry) this.active.delete(generation.id);
      controller.abort();
      // Do not await teardown of an uncooperative provider. Late iterator results have no writer.
      try { void iterator?.return?.().catch(() => {}); } catch { /* adapter teardown */ }
    }
  }
}
