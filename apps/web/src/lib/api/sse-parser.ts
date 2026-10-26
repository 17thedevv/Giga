import type {
  ChatStreamEvent,
} from './types.js';
import { sanitizeUntrustedText } from '../security/untrusted-content.js';

export interface SseEvent<T = unknown> {
  id?: string;
  event: string;
  data: T;
}

export type SseEventHandler<T = unknown> = (event: SseEvent<T>) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export class SseValidationError extends Error {
  constructor(
    message: string,
    public readonly event: string
  ) {
    super(message);
    this.name = 'SseValidationError';
  }
}

/** Limits are in UTF-16 code units: 64 Ki per incomplete line and 256 Ki per event payload. */
export const MAX_SSE_LINE_CHARACTERS = 64 * 1024;
export const MAX_SSE_EVENT_DATA_CHARACTERS = 256 * 1024;

export class SseBufferLimitError extends Error {
  constructor(public readonly limit: 'line' | 'event') {
    super(limit === 'line' ? 'SSE line exceeded the configured size limit' : 'SSE event exceeded the configured size limit');
    this.name = 'SseBufferLimitError';
  }
}

/**
 * Validates whether an incoming SSE event is a known GigaChat streaming event
 * and conforms to the expected contract.
 * - Returns the typed ChatStreamEvent if valid.
 * - Returns null if the event is unknown (which should be safely ignored per spec).
 * - Throws SseValidationError if the event is a known event but has a malformed payload.
 */
export function validateChatStreamEvent(event: string, data: unknown): ChatStreamEvent | null {
  const knownEvents = [
    'message.started',
    'message.delta',
    'message.completed',
    'stream.error',
    'message.failed',
    'message.stopped',
  ];

  if (!knownEvents.includes(event)) {
    return null; // Ignore unknown event safely
  }

  if (!isRecord(data)) {
    throw new SseValidationError(`Known event '${event}' payload must be a JSON object`, event);
  }

  const messageId = data.messageId;
  const generationId = data.generationId;
  if (typeof messageId !== 'string' || typeof generationId !== 'string') {
    throw new SseValidationError(`Known event '${event}' missing required 'messageId' or 'generationId'`, event);
  }

  switch (event) {
    case 'message.started':
      if (typeof data.conversationId !== 'string') {
        throw new SseValidationError(`'message.started' event missing 'conversationId'`, event);
      }
      return { event: 'message.started', data: { messageId, generationId, conversationId: data.conversationId } };

    case 'message.delta':
      if (typeof data.text !== 'string') {
        throw new SseValidationError(`'message.delta' event missing required string 'text'`, event);
      }
      // Do not redact deltas independently: credentials can cross event boundaries.
      // ChatView sanitizes the concatenated stream before putting text in UI state.
      return { event: 'message.delta', data: { messageId, generationId, text: data.text } };

    case 'message.completed':
      if ((data.createdAt !== undefined && typeof data.createdAt !== 'string') || (data.finishReason !== undefined && typeof data.finishReason !== 'string')) {
        throw new SseValidationError(`'message.completed' event contains invalid optional fields`, event);
      }
      return {
        event: 'message.completed',
        data: {
          messageId,
          generationId,
          ...(typeof data.createdAt === 'string' ? { createdAt: data.createdAt } : {}),
          ...(typeof data.finishReason === 'string' ? { finishReason: data.finishReason } : {}),
        },
      };

    case 'stream.error':
      if (!isRecord(data.error)) {
        throw new SseValidationError(`'stream.error' event missing 'error' object`, event);
      }
      return { event: 'stream.error', data: { messageId, generationId, error: safeStreamError(data.error, event) } };

    case 'message.failed':
      if (!isRecord(data.error)) {
        throw new SseValidationError(`'message.failed' event missing 'error' object`, event);
      }
      return { event: 'message.failed', data: { messageId, generationId, error: safeStreamError(data.error, event) } };

    case 'message.stopped':
      if (data.finishReason !== undefined && typeof data.finishReason !== 'string') {
        throw new SseValidationError(`'message.stopped' event contains invalid finishReason`, event);
      }
      return { event: 'message.stopped', data: { messageId, generationId, ...(typeof data.finishReason === 'string' ? { finishReason: data.finishReason } : {}) } };

    default:
      return null;
  }
}

function safeStreamError(value: unknown, event: string): { readonly code: string; readonly message: string } {
  if (!isRecord(value)) throw new SseValidationError('Stream error payload must be an object', event);
  const error = value;
  if (typeof error.code !== 'string' || typeof error.message !== 'string') {
    throw new SseValidationError('Stream error payload has invalid fields', event);
  }
  return {
    code: /^[A-Za-z0-9_.-]{1,80}$/.test(error.code) ? error.code : 'STREAM_ERROR',
    message: sanitizeUntrustedText(error.message).slice(0, 500),
  };
}

/**
 * Robust Server-Sent Events (SSE) stream buffer parser.
 * Handles fragmented network chunks, multi-line data payloads,
 * multi-byte UTF-8 split across chunks, and terminal event idempotency.
 */
export class SseStreamParser {
  private buffer = '';
  private currentEvent = 'message';
  private currentId?: string;
  private currentDataLines: string[] = [];
  private currentDataCharacters = 0;
  private decoder?: TextDecoder;
  private terminalDispatched = false;
  private failed = false;

  constructor(
    private readonly onEvent: SseEventHandler,
    private readonly options?: {
      onError?: (err: Error) => void;
      enforceTerminalIdempotency?: boolean;
    }
  ) {}

  /**
   * Feed raw bytes from a ReadableStreamDefaultReader.
   * Uses TextDecoder with streaming mode to handle multi-byte UTF-8 sequences.
   */
  feedBytes(chunk: Uint8Array): void {
    if (this.failed) return;
    if (!this.decoder) {
      this.decoder = new TextDecoder('utf-8', { fatal: false });
    }
    const text = this.decoder.decode(chunk, { stream: true });
    this.feed(text);
  }

  /**
   * Feed a new raw string chunk from the readable stream reader.
   */
  feed(chunk: string): void {
    if (this.failed || chunk.length === 0) return;

    // Consume a chunk line by line. Check each fragment before copying it into
    // the incomplete-line buffer so a large network chunk cannot be appended
    // wholesale and retained before the limit is enforced.
    let segmentStart = 0;
    while (segmentStart < chunk.length) {
      const newlineIndex = chunk.indexOf('\n', segmentStart);
      const segmentEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
      if (!this.appendLineFragment(chunk, segmentStart, segmentEnd)) return;

      if (newlineIndex === -1) return;

      const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = '';
      this.processLine(line);
      if (this.failed) return;
      segmentStart = newlineIndex + 1;
    }
  }

  private appendLineFragment(chunk: string, start: number, end: number): boolean {
    const fragmentLength = end - start;
    if (this.buffer.length + fragmentLength > MAX_SSE_LINE_CHARACTERS) {
      this.fail('line');
      return false;
    }
    this.buffer += chunk.slice(start, end);
    return true;
  }

  private fail(limit: 'line' | 'event'): void {
    if (this.failed) return;
    this.failed = true;
    // Drop all retained input before reporting a generic error; never echo an
    // oversized untrusted payload into logs or error objects.
    this.buffer = '';
    this.currentDataLines = [];
    this.currentDataCharacters = 0;
    this.currentEvent = 'message';
    this.currentId = undefined;
    const error = new SseBufferLimitError(limit);
    if (this.options?.onError) {
      this.options.onError(error);
      return;
    }
    throw error;
  }

  private processLine(line: string): void {
    // Blank line indicates dispatch of current event buffer
    if (line.trim() === '') {
      this.dispatch();
      return;
    }

    // Comment lines starting with colon are ignored (heartbeats or comments)
    if (line.startsWith(':')) {
      return;
    }

    const colonIndex = line.indexOf(':');
    let field = line;
    let value = '';

    if (colonIndex !== -1) {
      field = line.slice(0, colonIndex);
      value = line.slice(colonIndex + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
    }

    switch (field) {
      case 'event':
        this.currentEvent = value;
        break;
      case 'data':
        {
          const separatorLength = this.currentDataLines.length > 0 ? 1 : 0;
          if (this.currentDataCharacters + separatorLength + value.length > MAX_SSE_EVENT_DATA_CHARACTERS) {
            this.fail('event');
            return;
          }
          this.currentDataCharacters += separatorLength + value.length;
        }
        this.currentDataLines.push(value);
        break;
      case 'id':
        this.currentId = value;
        break;
      default:
        // Ignore unknown fields per SSE specification
        break;
    }
  }

  private dispatch(): void {
    if (this.failed) return;
    if (this.currentDataLines.length === 0) {
      this.currentEvent = 'message';
      this.currentDataCharacters = 0;
      return;
    }

    const eventName = this.currentEvent;
    const rawData = this.currentDataLines.join('\n');
    let parsedData: unknown = rawData;

    try {
      parsedData = JSON.parse(rawData);
    } catch {
      // Keep as raw string if not JSON
    }

    // Reset buffer for next event
    this.currentDataLines = [];
    this.currentDataCharacters = 0;
    this.currentEvent = 'message';

    const isTerminal = ['message.completed', 'message.failed', 'message.stopped'].includes(
      eventName
    );

    // Terminal event idempotency check
    if (this.options?.enforceTerminalIdempotency && this.terminalDispatched) {
      return;
    }

    try {
      this.onEvent({
        id: this.currentId,
        event: eventName,
        data: parsedData,
      });

      if (isTerminal) {
        this.terminalDispatched = true;
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.options?.onError) {
        this.options.onError(error);
      } else {
        throw error;
      }
    }
  }

  /**
   * Flush any remaining buffered data at end of stream.
   */
  flush(): void {
    if (this.failed) return;
    if (this.decoder) {
      const remaining = this.decoder.decode();
      if (remaining) {
        this.feed(remaining);
      }
    }
    const pendingLine = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
    this.buffer = '';
    if (pendingLine.trim().length > 0) this.processLine(pendingLine);
    if (this.failed) return;
    this.dispatch();
  }

  /**
   * Returns whether a terminal event has been dispatched.
   */
  hasTerminated(): boolean {
    return this.terminalDispatched;
  }
}
