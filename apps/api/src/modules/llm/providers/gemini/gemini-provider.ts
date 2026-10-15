import type { ProviderAdapter } from '../../adapter.js';
import type { ProviderCredential } from '../../provider-credential.js';
import { BYOKCredentialInvalidError, BYOKProviderError } from '../../errors.js';
import { LLMCancelledError, ProviderFailureError, ProviderRateLimitError, ProviderTimeoutError, ProviderUnavailableError } from '../../errors.js';
import type { Capability, FinishReason, LLMStreamEvent, LLMUsage, ModelReasoningConfig, ModelResult, ReasoningEffort, ResolvedLLMRequest } from '../../types.js';

export const CHAT_MODEL_ID = 'gemini-3.1-flash-lite';
export const GEMINI_CHAT_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${CHAT_MODEL_ID}:streamGenerateContent?alt=sse`;
export type ProviderTransport = (url: string, init: RequestInit) => Promise<Response>;
const MAX_FRAME_BYTES = 131072;
const MAX_RESPONSE_BYTES = 1048576;
const MAX_TEXT_BYTES = 65536;
const failure = (): ProviderFailureError => new ProviderFailureError('Provider returned an invalid or incomplete response');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
  return value as Record<string, unknown>;
}
function usage(value: unknown): LLMUsage | undefined {
  if (value === undefined || value === null) return undefined;
  const row = object(value);
  for (const key of ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount']) {
    if (row[key] !== undefined && (!Number.isSafeInteger(row[key]) || (row[key] as number) < 0)) throw failure();
  }
  const input = row.promptTokenCount as number | undefined;
  const candidate = row.candidatesTokenCount as number | undefined;
  const thoughts = row.thoughtsTokenCount as number | undefined;
  const total = row.totalTokenCount as number | undefined;
  // Prefer total minus prompt: includes thinking. Without those, require both output
  // counters; never assume that an unreported thinking count is zero.
  const output = total !== undefined && input !== undefined ? total - input
    : candidate !== undefined && thoughts !== undefined ? candidate + thoughts : undefined;
  if (output !== undefined && (!Number.isSafeInteger(output) || output < 0)) throw failure();
  if (input === undefined && output === undefined) return undefined;
  return { source: 'provider', ...(input === undefined ? {} : { inputTokens: input }), ...(output === undefined ? {} : { outputTokens: output }) };
}
function finish(value: unknown): FinishReason {
  if (value === 'STOP') return 'stop';
  if (value === 'MAX_TOKENS') return 'length';
  if (value === 'OTHER') return 'other';
  throw failure(); // Blocked/unsafe/tool outcomes must not become successful answers.
}
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const ms = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.min(60000, ms)) : undefined;
}
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      abort = () => reject(new LLMCancelledError());
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}

/** Incremental SSE: UTF-8, LF/CRLF/CR, comments and multi-line data; bounded frames. */
async function* frames(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): AsyncIterable<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = ''; let data: string[] = []; let frameBytes = 0; let totalBytes = 0; let skipLf = false;
  while (true) {
    if (signal.aborted) throw new LLMCancelledError();
    const next = await abortable(reader.read(), signal);
    if (signal.aborted) throw new LLMCancelledError();
    if (next.done) {
      buffer += decoder.decode();
      if (buffer.length || data.length) throw failure();
      return;
    }
    totalBytes += next.value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) throw failure();
    buffer += decoder.decode(next.value, { stream: true });
    if (skipLf && buffer.length) { if (buffer[0] === '\n') buffer = buffer.slice(1); skipLf = false; }
    while (true) {
      const boundary = buffer.search(/[\r\n]/);
      if (boundary < 0) break;
      const line = buffer.slice(0, boundary);
      const cr = buffer[boundary] === '\r';
      const separator = cr && buffer[boundary + 1] === '\n' ? 2 : 1;
      skipLf = cr && boundary === buffer.length - 1;
      buffer = buffer.slice(boundary + separator);
      frameBytes += Buffer.byteLength(line) + separator;
      if (frameBytes > MAX_FRAME_BYTES) throw failure();
      if (!line) {
        const event = data.join('\n'); data = []; frameBytes = 0;
        if (event) { if (signal.aborted) throw new LLMCancelledError(); yield event; }
      } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (frameBytes + Buffer.byteLength(buffer) > MAX_FRAME_BYTES) throw failure();
  }
}

export class GeminiProvider implements ProviderAdapter {
  readonly providerId = 'gemini';
  readonly capabilities: ReadonlySet<Capability> = new Set(['text', 'streaming']);
  constructor(private readonly transport: ProviderTransport = fetch, private readonly timeoutMs = 85000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 85000) throw new Error('Invalid provider timeout configuration');
  }

  getReasoningCapabilities(modelId: string): ModelReasoningConfig {
    if (modelId === CHAT_MODEL_ID) {
      return {
        supported: true,
        efforts: ['low', 'medium', 'high'] as const,
      };
    }
    return { supported: false, efforts: [] };
  }

  /**
   * Adapter-owned mapping policy:
   * Translates normalized Giga reasoning effort to native Gemini thinkingConfig.
   * When effort is absent (no explicit user reasoning override), the registered
   * model/adapter default policy applies (MINIMAL thinkingLevel on Gemini to preserve legacy behavior).
   * Never exposes raw internal thoughts (includeThoughts is always false).
   */
  mapReasoningEffort(effort?: ReasoningEffort, modelId = CHAT_MODEL_ID): { readonly thinkingLevel: string; readonly includeThoughts: boolean } {
    if (effort === undefined) {
      return { thinkingLevel: 'MINIMAL', includeThoughts: false };
    }
    const capabilities = this.getReasoningCapabilities(modelId);
    if (!capabilities.supported || !capabilities.efforts.includes(effort)) {
      throw failure();
    }
    switch (effort) {
      case 'low':
        return { thinkingLevel: 'LOW', includeThoughts: false };
      case 'medium':
        return { thinkingLevel: 'MEDIUM', includeThoughts: false };
      case 'high':
        return { thinkingLevel: 'HIGH', includeThoughts: false };
      default:
        throw failure();
    }
  }

  async *streamText(req: ResolvedLLMRequest, credential?: ProviderCredential): AsyncIterable<LLMStreamEvent> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    req.signal.addEventListener('abort', abort, { once: true });
    if (req.signal.aborted) abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const closeReader = (): void => { try { void reader?.cancel().catch(() => {}); } catch { /* released */ } };
    controller.signal.addEventListener('abort', closeReader, { once: true });
    try {
      if (controller.signal.aborted) throw new LLMCancelledError();
      if (!credential || credential.providerId !== this.providerId || (credential.source === 'user' && req.caller !== 'chat')) throw failure();
      if (req.providerId !== this.providerId || req.modelId !== CHAT_MODEL_ID || !Number.isInteger(req.maxOutputTokens) || req.maxOutputTokens < 1 || req.maxOutputTokens > 2048) throw failure();
      const system = req.messages.filter((m) => m.role === 'system');
      const thinkingConfig = this.mapReasoningEffort(req.reasoningEffort, req.modelId);
      const pending = this.transport(GEMINI_CHAT_ENDPOINT, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { ...credential.transportHeaders(), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          contents: req.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          ...(system.length ? { systemInstruction: { parts: system.map((m) => ({ text: m.content })) } } : {}),
          generationConfig: { maxOutputTokens: req.maxOutputTokens, candidateCount: 1, responseModalities: ['TEXT'], thinkingConfig },
        }),
      }).then((response) => {
        if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
        return response;
      });
      const response = await abortable(pending, controller.signal);
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new LLMCancelledError(); }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {}); // Provider error bodies never reach logs/errors.
        if ((response.status === 401 || response.status === 403) && credential.source === 'user') throw new BYOKCredentialInvalidError();
        if (response.status === 429) throw new ProviderRateLimitError('Provider rate limit reached', retryAfter(response.headers.get('retry-after')));
        if (response.status >= 500) throw new ProviderUnavailableError('Provider is temporarily unavailable');
        throw new ProviderFailureError('Provider rejected the request');
      }
      if (!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
        void response.body?.cancel().catch(() => {}); throw failure();
      }
      reader = response.body.getReader();
      let reason: FinishReason | undefined; let textBytes = 0; let reported: LLMUsage | undefined;
      for await (const frame of frames(reader, controller.signal)) {
        if (controller.signal.aborted) throw new LLMCancelledError();
        const row = object(JSON.parse(frame));
        if (row.error || (row.promptFeedback && object(row.promptFeedback).blockReason)) throw failure();
        const currentUsage = usage(row.usageMetadata);
        if (currentUsage) reported = currentUsage; // Metadata is cumulative, never summed per chunk.
        if (currentUsage && (row.candidates === undefined || (Array.isArray(row.candidates) && row.candidates.length === 0))) continue;
        if (!Array.isArray(row.candidates) || row.candidates.length !== 1 || reason) throw failure();
        const candidate = object(row.candidates[0]);
        if (candidate.index !== undefined && candidate.index !== 0) throw failure();
        // Inspect terminal reason before accepting text from a blocked terminal frame.
        if (candidate.finishReason !== undefined) reason = finish(candidate.finishReason);
        if (candidate.content !== undefined) {
          const content = object(candidate.content);
          if (content.role !== undefined && content.role !== 'model') throw failure();
          if (!Array.isArray(content.parts)) throw failure();
          for (const raw of content.parts) {
            const part = object(raw);
            if (part.thought === true) continue;
            if (typeof part.text !== 'string' || part.functionCall || part.executableCode || part.inlineData) throw failure();
            textBytes += Buffer.byteLength(part.text);
            if (textBytes > MAX_TEXT_BYTES) throw failure();
            if (controller.signal.aborted) throw new LLMCancelledError();
            if (part.text) yield { type: 'text.delta', text: part.text };
          }
        }
      }
      if (!reason || controller.signal.aborted) throw failure();
      if (reported) yield { type: 'usage', ...reported };
      if (controller.signal.aborted) throw new LLMCancelledError();
      yield { type: 'completed', finishReason: reason };
    } catch (error) {
      if (req.signal.aborted) throw new LLMCancelledError();
      if (credential?.source === 'user') {
        if (timedOut) throw new BYOKProviderError('PROVIDER_TIMEOUT');
        if (error instanceof ProviderRateLimitError || error instanceof ProviderUnavailableError) throw new BYOKProviderError(error.code);
      }
      if (timedOut) throw new ProviderTimeoutError('Provider request deadline exceeded');
      if (error instanceof BYOKCredentialInvalidError) throw new BYOKCredentialInvalidError();
      if (error instanceof ProviderRateLimitError) throw new ProviderRateLimitError('Provider rate limit reached',
        error.retryAfterMs === undefined ? undefined : Math.max(0, Math.min(60000, error.retryAfterMs)));
      if (error instanceof ProviderUnavailableError) throw new ProviderUnavailableError('Provider is temporarily unavailable');
      throw failure(); // Discard transport/parser exception text, cause, prompts and credentials.
    } finally {
      clearTimeout(timer); req.signal.removeEventListener('abort', abort);
      controller.abort(); closeReader(); controller.signal.removeEventListener('abort', closeReader);
      try { reader?.releaseLock(); } catch { /* pending cancellation */ }
    }
  }

  async generateText(req: ResolvedLLMRequest, credential?: ProviderCredential): Promise<ModelResult> {
    let text = ''; let reported: LLMUsage | undefined;
    for await (const event of this.streamText(req, credential)) {
      if (event.type === 'text.delta') text += event.text;
      else if (event.type === 'usage') reported = { source: event.source, ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }), ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }) };
      else if (event.type === 'completed') return { text, finishReason: event.finishReason, ...(reported ? { usage: reported } : {}) };
    }
    throw failure();
  }
}
