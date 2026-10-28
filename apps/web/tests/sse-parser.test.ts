import { describe, it, expect } from 'vitest';
import {
  MAX_SSE_EVENT_DATA_CHARACTERS,
  MAX_SSE_LINE_CHARACTERS,
  SseBufferLimitError,
  SseStreamParser,
  SseValidationError,
  validateChatStreamEvent,
  type SseEvent,
} from '../src/lib/api/sse-parser.js';

describe('SseStreamParser', () => {
  it('parses standard complete SSE events', () => {
    const events: SseEvent[] = [];
    const parser = new SseStreamParser((evt) => events.push(evt));

    const raw =
      'event: message.started\ndata: {"messageId":"msg_1"}\n\n' +
      'event: message.delta\ndata: {"text":"hello world"}\n\n' +
      'event: message.completed\ndata: {"messageId":"msg_1"}\n\n';

    parser.feed(raw);

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      id: undefined,
      event: 'message.started',
      data: { messageId: 'msg_1' },
    });
    expect(events[1]).toEqual({
      id: undefined,
      event: 'message.delta',
      data: { text: 'hello world' },
    });
    expect(events[2]).toEqual({
      id: undefined,
      event: 'message.completed',
      data: { messageId: 'msg_1' },
    });
  });

  it('correctly handles fragmented network chunks split mid-token and mid-line', () => {
    const events: SseEvent[] = [];
    const parser = new SseStreamParser((evt) => events.push(evt));

    // Chunk 1: Cut right in the middle of "message.delta"
    parser.feed('event: message.');
    expect(events).toHaveLength(0);

    // Chunk 2: Finish event name and cut mid-data
    parser.feed('delta\ndata: {"te');
    expect(events).toHaveLength(0);

    // Chunk 3: Finish data line and cut before trailing newline
    parser.feed('xt": "fragmented stream"}\n');
    expect(events).toHaveLength(0);

    // Chunk 4: Finalize double newline delimiter
    parser.feed('\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      id: undefined,
      event: 'message.delta',
      data: { text: 'fragmented stream' },
    });
  });

  it('handles multi-line data payloads and id tags', () => {
    const events: SseEvent[] = [];
    const parser = new SseStreamParser((evt) => events.push(evt));

    const raw =
      'id: evt_42\n' +
      'event: tool.completed\n' +
      'data: {"tool": "github_read_file",\n' +
      'data:  "status": "success"}\n\n';

    parser.feed(raw);

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('evt_42');
    expect(events[0].event).toBe('tool.completed');
    expect(events[0].data).toEqual({
      tool: 'github_read_file',
      status: 'success',
    });
  });

  it('ignores comment lines starting with colon', () => {
    const events: SseEvent[] = [];
    const parser = new SseStreamParser((evt) => events.push(evt));

    parser.feed(': heartbeat\n: keep-alive\nevent: ping\ndata: {}\n\n');

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('ping');
  });

  it('rejects an oversized incomplete line without retaining or echoing its payload', () => {
    const secretLikePayload = `synthetic-sensitive-${'x'.repeat(MAX_SSE_LINE_CHARACTERS)}`;
    const errors: Error[] = [];
    const events: SseEvent[] = [];
    const parser = new SseStreamParser((event) => events.push(event), { onError: error => errors.push(error) });

    parser.feed(secretLikePayload);
    parser.feed('data: a later event cannot revive the failed parser\n\n');

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SseBufferLimitError);
    expect(errors[0].message).not.toContain('synthetic-sensitive');
    expect(events).toEqual([]);
  });

  it('bounds accumulated multiline event data before joining it', () => {
    const errors: Error[] = [];
    const events: SseEvent[] = [];
    const parser = new SseStreamParser((event) => events.push(event), { onError: error => errors.push(error) });
    const line = 'data: ' + 'x'.repeat(60_000) + '\n';

    parser.feed(line.repeat(Math.ceil(MAX_SSE_EVENT_DATA_CHARACTERS / 60_000)));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SseBufferLimitError);
    expect(errors[0].message).not.toContain('x'.repeat(100));
    expect(events).toEqual([]);
  });

  it('processes a large chunk incrementally while rejecting a large unterminated line', () => {
    const events: SseEvent[] = [];
    const parser = new SseStreamParser((event) => events.push(event));
    const validChunk = 'data: ok\n\n'.repeat(8_000);
    expect(validChunk.length).toBeGreaterThan(MAX_SSE_LINE_CHARACTERS);
    parser.feed(validChunk);
    expect(events).toHaveLength(8_000);

    const errors: Error[] = [];
    const overflowParser = new SseStreamParser(() => {}, { onError: error => errors.push(error) });
    overflowParser.feed('z'.repeat(MAX_SSE_LINE_CHARACTERS + 1));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SseBufferLimitError);
  });

  it('projects known event fields, redacts provider credentials, and never retains raw payloads in errors', () => {
    const secret = 'AIzaSyntheticStreamSentinelKey0123456789';
    const event = validateChatStreamEvent('message.failed', {
      messageId: 'message-1', generationId: 'generation-1',
      error: { code: 'PROVIDER_ERROR', message: `Provider rejected ${secret}` },
      workerLeaseToken: 'internal-only', providerResponse: { reasoning: 'private' },
    });
    expect(event).toEqual({
      event: 'message.failed',
      data: { messageId: 'message-1', generationId: 'generation-1', error: { code: 'PROVIDER_ERROR', message: 'Provider rejected [redacted credential]' } },
    });
    expect(JSON.stringify(event)).not.toContain(secret);
    expect(JSON.stringify(event)).not.toContain('workerLeaseToken');

    let error: unknown;
    try {
      validateChatStreamEvent('message.delta', { messageId: 'message-1', generationId: 'generation-1', text: 42, secret });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SseValidationError);
    expect(error).not.toHaveProperty('rawData');
    expect((error as Error).message).not.toContain(secret);
  });

  it('ignores unknown events and rejects malformed JSON payloads without echoing them', () => {
    expect(validateChatStreamEvent('provider.debug', { apiKey: 'sentinel' })).toBeNull();
    expect(() => validateChatStreamEvent('message.started', 'malformed-secret-payload'))
      .toThrowError(/payload must be a JSON object/);
  });
});
