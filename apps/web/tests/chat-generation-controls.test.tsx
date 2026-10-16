import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from '../src/features/chat/ChatView.js';
import { ApiModeProvider } from '../src/app/context/ApiModeContext.js';
import { RouterProvider } from '../src/app/router.js';
import { RealApiClient, realApiClient } from '../src/lib/api/client.js';
import { MockDataAdapter } from '../src/lib/api/mock-adapter.js';
import type { ChatGeneration, ChatStreamEvent, ChatTurnVariants, Message } from '../src/lib/api/types.js';

const timestamp = '2026-10-16T00:00:00Z';
const conversation = { id: 'c1', title: 'Controls test', createdAt: timestamp, updatedAt: timestamp };
const user: Message = { id: 'u1', conversationId: 'c1', role: 'user', content: 'Question', createdAt: timestamp };
const answer: Message = { id: 'a1', conversationId: 'c1', role: 'assistant', content: 'Original completed answer', createdAt: timestamp };
const original = { id: 'g1', action: 'new_prompt' as const, modelId: 'giga-chat-default', status: 'completed' as const, assistantMessageId: 'a1', content: answer.content, createdAt: timestamp };
let history: Message[];
let variants: ChatTurnVariants;
let generation: ChatGeneration;
let emit: (event: ChatStreamEvent) => void;

function view() {
  return render(<ApiModeProvider initialMode="real"><RouterProvider initialPath="/chat/c1"><ChatView /></RouterProvider></ApiModeProvider>);
}
async function ready() {
  await waitFor(() => expect((screen.getByRole('button', { name: 'Send Message' }) as HTMLButtonElement).disabled).toBe(true));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDefined());
}
function attempt(status: ChatGeneration['status'], selected = 'g1') {
  generation = { id: 'g2', conversationId: 'c1', userMessageId: 'u1', modelId: 'giga-chat-default', status, partialContent: '', createdAt: timestamp };
  variants = { userMessageId: 'u1', selectedGenerationId: selected || null, items: [...(selected ? [original] : []), {
    id: 'g2', action: selected ? 'regenerate' : 'retry', modelId: 'giga-chat-default', status, createdAt: timestamp,
  }] };
}
async function startRegenerate() {
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
  await waitFor(() => expect(emit).toBeDefined());
  await act(async () => emit({ event: 'message.started', data: { conversationId: 'c1', generationId: 'g2', messageId: 'g2' } }));
}

beforeEach(() => {
  window.sessionStorage.clear();
  history = [user, answer];
  variants = { userMessageId: 'u1', selectedGenerationId: 'g1', items: [original] };
  emit = undefined as unknown as typeof emit;
  vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({ items: [conversation], nextCursor: null });
  vi.spyOn(realApiClient, 'listModels').mockResolvedValue({ models: [] });
  vi.spyOn(realApiClient, 'getConversation').mockImplementation(async () => ({ conversation, messages: [...history] }));
  vi.spyOn(realApiClient, 'getTurnVariants').mockImplementation(async () => variants);
  vi.spyOn(realApiClient, 'getGeneration').mockImplementation(async () => ({ generation }));
  vi.spyOn(realApiClient, 'streamVariant').mockImplementation(async (_c, _u, _a, callback) => {
    emit = callback;
    return new Promise<void>(() => {});
  });
});
afterEach(() => vi.restoreAllMocks());

describe('latest-turn generation controls', () => {
  it.each(['failed', 'stopped', 'interrupted'] as const)('refresh discovers zero-output %s attempt and Retry reuses the exact user ID', async status => {
    history = [user];
    attempt(status, '');
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(realApiClient.streamVariant).toHaveBeenCalledWith('c1', 'u1', 'retry', expect.any(Function), expect.objectContaining({ idempotencyKey: expect.any(String) })));
    expect(history).toEqual([user]);
  });

  it.each(['failed', 'stopped'] as const)('%s regenerate preserves selected completed answer and remains retryable', async status => {
    view(); await ready(); await startRegenerate();
    attempt(status);
    await act(async () => {
      emit(status === 'stopped'
        ? { event: 'message.stopped', data: { messageId: 'g2', generationId: 'g2', finishReason: 'cancelled' } }
        : { event: 'message.failed', data: { messageId: 'g2', generationId: 'g2', error: { code: 'GENERATION_FAILED', message: 'Generation failed' } } });
    });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeDefined();
    expect(screen.getByText(answer.content)).toBeDefined();
    expect(variants.selectedGenerationId).toBe('g1');
    if (status === 'stopped') expect(screen.queryByText('Generation failed')).toBeNull();
  });

  it('completed regenerate displays the selected answer and retains the old variant', async () => {
    view(); await ready(); await startRegenerate();
    const replacement = { ...answer, id: 'g2', content: 'New completed answer' };
    history = [user, replacement];
    variants = { userMessageId: 'u1', selectedGenerationId: 'g2', items: [original, { ...original, id: 'g2', assistantMessageId: 'g2', action: 'regenerate', content: replacement.content }] };
    await act(async () => {
      emit({ event: 'message.delta', data: { messageId: 'g2', generationId: 'g2', text: replacement.content } });
      emit({ event: 'message.completed', data: { messageId: 'g2', generationId: 'g2' } });
    });
    expect(await screen.findByText('Previous completed answers')).toBeDefined();
    expect(screen.getByText(answer.content)).toBeDefined();
    expect(screen.getByText(replacement.content)).toBeDefined();
  });

  it('Stop waits for durable cancel acceptance and prevents duplicate cancel/actions', async () => {
    let resolveCancel!: (value: { generation: ChatGeneration }) => void;
    const cancel = vi.spyOn(realApiClient, 'cancelGeneration').mockImplementation(() => new Promise(resolve => { resolveCancel = resolve; }));
    view(); await ready(); await startRegenerate();
    const stop = screen.getByRole('button', { name: 'Stop Generating' });
    fireEvent.click(stop); fireEvent.click(stop);
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(realApiClient.streamVariant).toHaveBeenCalledTimes(1);
    expect((stop as HTMLButtonElement).disabled).toBe(true);
    attempt('stopped');
    await act(async () => resolveCancel({ generation }));
    expect(await screen.findByText('Response stopped by user')).toBeDefined();
    expect(screen.getByText(answer.content)).toBeDefined();
  });

  it('completion wins a Stop race and the completed answer remains authoritative', async () => {
    view(); await ready(); await startRegenerate();
    attempt('completed');
    generation = { ...generation, assistantMessageId: 'g2', partialContent: 'Completion won' };
    history = [user, { ...answer, id: 'g2', content: 'Completion won' }];
    variants = { userMessageId: 'u1', selectedGenerationId: 'g2', items: [original, { ...original, id: 'g2', action: 'regenerate', assistantMessageId: 'g2', content: 'Completion won' }] };
    vi.spyOn(realApiClient, 'cancelGeneration').mockResolvedValue({ generation });
    fireEvent.click(screen.getByRole('button', { name: 'Stop Generating' }));
    expect(await screen.findByText('Completion won')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByText('Response stopped by user')).toBeNull();
  });

  it('refresh discovers an active attempt and keeps actions blocked when status remains unknown', async () => {
    attempt('streaming');
    vi.spyOn(realApiClient, 'getGeneration').mockRejectedValue(new Error('Offline'));
    view();
    expect(await screen.findByText(/Unable to verify generation g2 status/)).toBeDefined();
    expect((screen.getByRole('button', { name: 'Regenerate' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole('button', { name: 'Stop Generating' }).closest('form')!);
    expect(realApiClient.streamVariant).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Retry Status Check' })).toBeDefined();
  });

  it('lost cancel response reconciles stopped state', async () => {
    view(); await ready(); await startRegenerate();
    attempt('stopped');
    vi.spyOn(realApiClient, 'cancelGeneration').mockRejectedValue(new Error('Connection lost'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop Generating' }));
    expect(await screen.findByText('Response stopped by user')).toBeDefined();
    expect(screen.getByText(answer.content)).toBeDefined();
  });

  it('network failure before message.started discovers the admitted attempt without repeating a request', async () => {
    view(); await ready();
    const spy = vi.spyOn(realApiClient, 'streamVariant').mockImplementation(async () => {
      attempt('stopped');
      throw new TypeError('Network disconnected before headers');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(screen.getByText(answer.content)).toBeDefined();
  });

  it('duplicate admission envelope reconciles the existing generation without a second POST', async () => {
    view(); await ready(); attempt('stopped');
    const { ApiException } = await import('../src/lib/api/client.js');
    const spy = vi.spyOn(realApiClient, 'streamVariant').mockRejectedValue(new ApiException(409, 'CONFLICT', 'Already admitted', { generation }));
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(realApiClient.getGeneration).toHaveBeenCalledWith('c1', 'g2');
  });

  it('synchronous double Regenerate starts one request', async () => {
    view(); await ready();
    const button = screen.getByRole('button', { name: 'Regenerate' });
    await act(async () => { button.click(); button.click(); });
    expect(realApiClient.streamVariant).toHaveBeenCalledTimes(1);
  });

  it('locks admission before asynchronous conversation creation and supports Enter to send', async () => {
    vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({ items: [], nextCursor: null });
    const create = vi.spyOn(realApiClient, 'createConversation').mockImplementation(() => new Promise(() => {}));
    render(<ApiModeProvider initialMode="real"><RouterProvider initialPath="/chat"><ChatView /></RouterProvider></ApiModeProvider>);
    const input = await screen.findByPlaceholderText(/Ask Giga anything/);
    fireEvent.change(input, { target: { value: 'New keyboard turn' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.submit(input.closest('form')!);
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith('New keyboard turn');
  });
});

describe('implemented HTTP contract', () => {
  it('cancel has zero body bytes; variants are owner-cookie GET; retry consumes stopped SSE', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ generation: {} }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(variants), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('event: message.started\ndata: {"messageId":"g2","generationId":"g2","conversationId":"c1"}\n\nevent: message.stopped\ndata: {"messageId":"g2","generationId":"g2","finishReason":"cancelled"}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const client = new RealApiClient();
    await client.cancelGeneration('c/1', 'g/2', 'cancel-key');
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/conversations/c%2F1/generations/g%2F2/cancel');
    expect(fetch.mock.calls[0][1]?.body).toBeUndefined();
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('Idempotency-Key')).toBe('cancel-key');
    await client.getTurnVariants('c1', 'u1');
    expect(fetch.mock.calls[1][1]?.credentials).toBe('include');
    const events: ChatStreamEvent[] = [];
    await client.streamVariant('c1', 'u1', 'retry', event => events.push(event), { idempotencyKey: 'retry-key' });
    expect(JSON.parse(fetch.mock.calls[2][1]?.body as string)).toEqual({ userMessageId: 'u1', action: 'retry' });
    expect(events.map(event => event.event)).toEqual(['message.started', 'message.stopped']);
  });

  it('Mock mode preserves completed variants across failed regeneration', async () => {
    const mock = new MockDataAdapter();
    const { conversation } = await mock.createConversation('Mock controls');
    vi.spyOn(mock, 'simulateChatStream').mockImplementationOnce(async (_p, chunk, done) => { chunk('Mock completed answer'); done(); })
      .mockImplementationOnce(async () => { throw new Error('Mock failure'); });
    await mock.streamMessage(conversation.id, 'Question', () => {});
    const { messages } = await mock.getConversation(conversation.id);
    const userId = messages.find(m => m.role === 'user')!.id;
    const before = await mock.getTurnVariants(conversation.id, userId);
    await mock.streamVariant(conversation.id, userId, 'regenerate', () => {});
    const after = await mock.getTurnVariants(conversation.id, userId);
    expect(after.selectedGenerationId).toBe(before.selectedGenerationId);
    expect(after.items.map(item => item.status)).toEqual(['completed', 'failed']);
    expect((await mock.getConversation(conversation.id)).messages.filter(m => m.role === 'assistant').map(m => m.content)).toEqual(['Mock completed answer']);
  });
});
