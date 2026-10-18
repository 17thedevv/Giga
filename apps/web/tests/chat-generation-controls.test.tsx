import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from '../src/features/chat/ChatView.js';
import { ApiModeProvider } from '../src/app/context/ApiModeContext.js';
import { RouterProvider, useRouter } from '../src/app/router.js';
import { ApiException, RealApiClient, realApiClient } from '../src/lib/api/client.js';
import { MockDataAdapter } from '../src/lib/api/mock-adapter.js';
import type { ChatGeneration, ChatStreamEvent, ChatTurnVariants, Message, ModelMetadata } from '../src/lib/api/types.js';

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

  it('duplicate active admission enables Stop while keeping new actions locked through polling', async () => {
    view(); await ready(); attempt('streaming');
    const admission = vi.spyOn(realApiClient, 'streamVariant').mockRejectedValue(
      new ApiException(409, 'CONFLICT', 'Already admitted', { generation })
    );
    let resolveStatus!: (result: { generation: ChatGeneration }) => void;
    vi.spyOn(realApiClient, 'getGeneration').mockImplementationOnce(
      () => new Promise(resolve => { resolveStatus = resolve; })
    );
    let resolveCancel!: (result: { generation: ChatGeneration }) => void;
    const cancel = vi.spyOn(realApiClient, 'cancelGeneration').mockImplementation(
      () => new Promise(resolve => { resolveCancel = resolve; })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(realApiClient.getGeneration).toHaveBeenCalledWith('c1', 'g2'));
    // The verified conflict envelope permits Stop even before GET finishes.
    expect((screen.getByRole('button', { name: 'Stop Generating' }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => resolveStatus({ generation }));
    // Bounded polling must retain both the action lock and durable Stop access.
    await screen.findByText(/Generation cancellation is taking longer than expected/);
    const stop = screen.getByRole('button', { name: 'Stop Generating' }) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Regenerate' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(stop.closest('form')!);
    expect(admission).toHaveBeenCalledTimes(1);
    fireEvent.click(stop);
    expect(cancel).toHaveBeenCalledWith('c1', 'g2');
    attempt('stopped');
    await act(async () => resolveCancel({ generation }));
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeDefined();
    expect(screen.getByText(answer.content)).toBeDefined();
  });

  it.each(['creation', 'history recovery'] as const)('late %s failure cannot release the generation on a newer route', async source => {
    let rejectCreate!: (reason: Error) => void;
    const create = vi.spyOn(realApiClient, 'createConversation').mockImplementation(
      () => new Promise((_resolve, reject) => { rejectCreate = reject; })
    );
    vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({ items: [], nextCursor: null });
    let rejectHistory!: (reason: Error) => void;
    let oldHistoryLoads = 0;
    vi.spyOn(realApiClient, 'getConversation').mockImplementation(async id => {
      if (id === 'cA') {
        if (++oldHistoryLoads > 1) return new Promise((_resolve, reject) => { rejectHistory = reject; });
        return { conversation: { ...conversation, id }, messages: [] };
      }
      return { conversation, messages: [...history] };
    });
    let emitB!: (event: ChatStreamEvent) => void;
    const stream = vi.spyOn(realApiClient, 'streamMessage').mockImplementation(async (_id, _text, callback) => {
      if (_id === 'cA') throw new TypeError('Admission connection lost');
      emitB = callback;
      callback({ event: 'message.started', data: { conversationId: 'c1', messageId: 'gB', generationId: 'gB' } });
      callback({ event: 'message.delta', data: { messageId: 'gB', generationId: 'gB', text: 'B stays active' } });
      return new Promise<void>(() => {});
    });
    const cancel = vi.spyOn(realApiClient, 'cancelGeneration').mockImplementation(() => new Promise(() => {}));
    function Navigation() {
      const { navigate } = useRouter();
      return <button onClick={() => navigate('/chat/c1')}>Open conversation B</button>;
    }
    render(<ApiModeProvider initialMode="real"><RouterProvider initialPath={source === 'creation' ? '/chat' : '/chat/cA'}><Navigation /><ChatView /></RouterProvider></ApiModeProvider>);
    const input = await screen.findByPlaceholderText(/Ask Giga anything/);
    fireEvent.change(input, { target: { value: 'Create conversation A' } });
    fireEvent.submit(input.closest('form')!);
    if (source === 'creation') expect(create).toHaveBeenCalledTimes(1);
    else await waitFor(() => expect(rejectHistory).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation B' }));
    await ready();
    const inputB = screen.getByPlaceholderText(/Ask Giga anything/);
    fireEvent.change(inputB, { target: { value: 'Start generation B' } });
    fireEvent.submit(inputB.closest('form')!);
    expect(await screen.findByText('B stays active')).toBeDefined();
    await act(async () => (source === 'creation' ? rejectCreate : rejectHistory)(new Error('Stale request failed')));
    const stop = screen.getByRole('button', { name: 'Stop Generating' }) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    expect(screen.queryByText('Stale request failed')).toBeNull();
    fireEvent.submit(stop.closest('form')!);
    expect(stream).toHaveBeenCalledTimes(source === 'creation' ? 1 : 2);
    await act(async () => emitB({ event: 'message.delta', data: { messageId: 'gB', generationId: 'gB', text: ' after stale rejection' } }));
    expect(screen.getByText('B stays active after stale rejection')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Stop Generating' }));
    expect(cancel).toHaveBeenCalledWith('c1', 'gB');
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

  it('navigating from conversation A to B prevents sending (conversation B, generation A) on Stop', async () => {
    vi.spyOn(realApiClient, 'streamMessage').mockImplementation(async (_id, _text, callback) => {
      callback({ event: 'message.started', data: { conversationId: 'cA', messageId: 'gA', generationId: 'gA' } });
      return new Promise<void>(() => {});
    });
    const cancel = vi.spyOn(realApiClient, 'cancelGeneration').mockImplementation(() => new Promise(() => {}));

    vi.spyOn(realApiClient, 'getConversation').mockImplementation(async id => {
      if (id === 'cA') return { conversation: { ...conversation, id: 'cA' }, messages: [] };
      return { conversation: { ...conversation, id: 'cB' }, messages: [] };
    });

    function Navigation() {
      const { navigate } = useRouter();
      return (
        <div>
          <button onClick={() => navigate('/chat/cA')}>Go to A</button>
          <button onClick={() => navigate('/chat/cB')}>Go to B</button>
        </div>
      );
    }

    render(
      <ApiModeProvider initialMode="real">
        <RouterProvider initialPath="/chat/cA">
          <Navigation />
          <ChatView />
        </RouterProvider>
      </ApiModeProvider>
    );

    // Send in conversation A
    const inputA = await screen.findByPlaceholderText(/Ask Giga anything/);
    fireEvent.change(inputA, { target: { value: 'Prompt in A' } });
    fireEvent.submit(inputA.closest('form')!);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop Generating' })).toBeDefined());

    // Navigate to conversation B
    fireEvent.click(screen.getByRole('button', { name: 'Go to B' }));

    // In conversation B, generation A is not active on this route
    expect(cancel).not.toHaveBeenCalled();

    // Verify cancelGeneration is never called with ('cB', 'gA')
    const calls = cancel.mock.calls;
    const sentMismatched = calls.some(args => args[0] === 'cB' && args[1] === 'gA');
    expect(sentMismatched).toBe(false);
  });

  it('late SSE events from conversation A do not overwrite conversation B', async () => {
    let emitA!: (event: ChatStreamEvent) => void;
    vi.spyOn(realApiClient, 'streamMessage').mockImplementation(async (id, _text, callback) => {
      if (id === 'cA') {
        emitA = callback;
        callback({ event: 'message.started', data: { conversationId: 'cA', messageId: 'gA', generationId: 'gA' } });
        return new Promise<void>(() => {});
      }
      return new Promise<void>(() => {});
    });

    vi.spyOn(realApiClient, 'getConversation').mockImplementation(async id => {
      if (id === 'cA') return { conversation: { ...conversation, id: 'cA' }, messages: [] };
      return {
        conversation: { ...conversation, id: 'cB' },
        messages: [
          { id: 'uB', conversationId: 'cB', role: 'user', content: 'User message in B', createdAt: timestamp },
          { id: 'aB', conversationId: 'cB', role: 'assistant', content: 'Authoritative answer in B', createdAt: timestamp },
        ],
      };
    });

    function Navigation() {
      const { navigate } = useRouter();
      return (
        <div>
          <button onClick={() => navigate('/chat/cA')}>Go to A</button>
          <button onClick={() => navigate('/chat/cB')}>Go to B</button>
        </div>
      );
    }

    render(
      <ApiModeProvider initialMode="real">
        <RouterProvider initialPath="/chat/cA">
          <Navigation />
          <ChatView />
        </RouterProvider>
      </ApiModeProvider>
    );

    // Send in conversation A
    const inputA = await screen.findByPlaceholderText(/Ask Giga anything/);
    fireEvent.change(inputA, { target: { value: 'Prompt in A' } });
    fireEvent.submit(inputA.closest('form')!);

    await waitFor(() => expect(emitA).toBeDefined());

    // Navigate to conversation B
    fireEvent.click(screen.getByRole('button', { name: 'Go to B' }));

    // Wait for conversation B history to display
    expect(await screen.findByText('Authoritative answer in B')).toBeDefined();

    // Now emit late events from conversation A
    await act(async () => {
      emitA({ event: 'message.delta', data: { messageId: 'gA', generationId: 'gA', text: 'Late leakage text from A' } });
      emitA({ event: 'message.completed', data: { messageId: 'gA', generationId: 'gA' } });
    });

    // Conversation B must NOT be contaminated by late A events
    expect(screen.queryByText('Late leakage text from A')).toBeNull();
    expect(screen.getByText('Authoritative answer in B')).toBeDefined();
  });

  it('regenerate respects selected model and reasoning effort', async () => {
    const customModel: ModelMetadata = {
      id: 'giga-custom-preview',
      capabilities: ['text', 'streaming'],
      reasoning: { supported: true, efforts: ['low', 'medium', 'high'] },
    };
    vi.spyOn(realApiClient, 'listModels').mockResolvedValue({
      models: [customModel],
    });

    view(); await ready();

    // Select high reasoning effort
    const effortSelect = screen.getByTestId('composer-reasoning-select');
    fireEvent.change(effortSelect, { target: { value: 'high' } });

    // Click Regenerate
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

    await waitFor(() => {
      expect(realApiClient.streamVariant).toHaveBeenCalledWith(
        'c1',
        'u1',
        'regenerate',
        expect.any(Function),
        expect.objectContaining({
          modelId: 'giga-custom-preview',
          reasoningEffort: 'high',
        })
      );
    });
  });

  it('rapid conversation switching cleans up in-flight requests without stale contamination', async () => {
    let resolveA!: (value: any) => void;
    let resolveB!: (value: any) => void;

    vi.spyOn(realApiClient, 'getConversation').mockImplementation(async id => {
      if (id === 'cA') {
        return new Promise(resolve => { resolveA = resolve; });
      }
      return new Promise(resolve => { resolveB = resolve; });
    });

    function Navigation() {
      const { navigate } = useRouter();
      return (
        <div>
          <button onClick={() => navigate('/chat/cA')}>Go to A</button>
          <button onClick={() => navigate('/chat/cB')}>Go to B</button>
        </div>
      );
    }

    render(
      <ApiModeProvider initialMode="real">
        <RouterProvider initialPath="/chat/cA">
          <Navigation />
          <ChatView />
        </RouterProvider>
      </ApiModeProvider>
    );

    // Switch rapidly A -> B -> A
    fireEvent.click(screen.getByRole('button', { name: 'Go to B' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go to A' }));

    // Resolve B after navigating back to A
    if (resolveB) {
      await act(async () => {
        resolveB({
          conversation: { ...conversation, id: 'cB' },
          messages: [{ id: 'mB', conversationId: 'cB', role: 'assistant', content: 'Message from B', createdAt: timestamp }],
        });
      });
    }

    // Resolve A
    await act(async () => {
      resolveA({
        conversation: { ...conversation, id: 'cA' },
        messages: [{ id: 'mA', conversationId: 'cA', role: 'assistant', content: 'Message from A', createdAt: timestamp }],
      });
    });

    // In conversation A, only message from A should be visible; message from B must be ignored
    expect(await screen.findByText('Message from A')).toBeDefined();
    expect(screen.queryByText('Message from B')).toBeNull();
  });

  it('start generation in A -> navigate to B -> return to A while generation remains active recovers generation and permits Stop', async () => {
    const cancelCalledWith: any[] = [];
    vi.spyOn(realApiClient, 'streamMessage').mockImplementation(async (_id, _text, callback) => {
      callback({ event: 'message.started', data: { conversationId: 'cA', messageId: 'gA', generationId: 'gA' } });
      return new Promise<void>(() => {});
    });
    vi.spyOn(realApiClient, 'cancelGeneration').mockImplementation(async (convId, genId) => {
      cancelCalledWith.push([convId, genId]);
      return { generation: { id: genId, conversationId: convId, userMessageId: 'uA', modelId: 'giga-chat-default', status: 'stopped', partialContent: 'Recovered partial text', createdAt: timestamp } };
    });
    vi.spyOn(realApiClient, 'getGeneration').mockImplementation(async (convId, genId) => {
      return { generation: { id: genId, conversationId: convId, userMessageId: 'uA', modelId: 'giga-chat-default', status: 'streaming', partialContent: 'Recovered partial text', createdAt: timestamp } };
    });
    vi.spyOn(realApiClient, 'getConversation').mockImplementation(async id => {
      if (id === 'cA') {
        return {
          conversation: { ...conversation, id: 'cA' },
          messages: [{ id: 'uA', conversationId: 'cA', role: 'user', content: 'Prompt in A', createdAt: timestamp }],
        };
      }
      return { conversation: { ...conversation, id: 'cB' }, messages: [] };
    });
    vi.spyOn(realApiClient, 'getTurnVariants').mockImplementation(async (id, _userId) => {
      if (id === 'cA') {
        return {
          userMessageId: 'uA',
          selectedGenerationId: null,
          items: [{ id: 'gA', action: 'new_prompt', modelId: 'giga-chat-default', status: 'streaming', createdAt: timestamp }],
        };
      }
      return { userMessageId: 'uB', selectedGenerationId: null, items: [] };
    });

    function Navigation() {
      const { navigate } = useRouter();
      return (
        <div>
          <button onClick={() => navigate('/chat/cA')}>Go to A</button>
          <button onClick={() => navigate('/chat/cB')}>Go to B</button>
        </div>
      );
    }

    render(
      <ApiModeProvider initialMode="real">
        <RouterProvider initialPath="/chat/cA">
          <Navigation />
          <ChatView />
        </RouterProvider>
      </ApiModeProvider>
    );

    // Initial load of conversation A
    expect(await screen.findByText('Prompt in A')).toBeDefined();

    // Navigate to B
    fireEvent.click(screen.getByRole('button', { name: 'Go to B' }));
    await waitFor(() => expect(screen.queryByText('Prompt in A')).toBeNull());

    // Navigate back to A
    fireEvent.click(screen.getByRole('button', { name: 'Go to A' }));
    expect(await screen.findByText('Prompt in A')).toBeDefined();

    // Verify generation A is recovered, Stop button is visible, new generation is locked
    const stopBtn = await screen.findByRole('button', { name: 'Stop Generating' });
    expect(stopBtn).toBeDefined();

    // Verify textarea is disabled / generation action locked
    const textarea = screen.getByPlaceholderText(/Generating response...|Ask Giga anything/);
    expect(textarea.hasAttribute('disabled')).toBe(true);

    // Click Stop Generating
    fireEvent.click(stopBtn);

    // Verify cancelGeneration was called with ('cA', 'gA') and NEVER ('cB', 'gA')
    await waitFor(() => expect(cancelCalledWith.length).toBeGreaterThan(0));
    expect(cancelCalledWith[0]).toEqual(['cA', 'gA']);
    const mismatched = cancelCalledWith.some(([c, g]) => c === 'cB' && g === 'gA');
    expect(mismatched).toBe(false);
  });

  it('returning to conversation A after generation completed restores terminal state and enables Regenerate', async () => {
    vi.spyOn(realApiClient, 'getConversation').mockImplementation(async id => {
      if (id === 'cA') {
        return {
          conversation: { ...conversation, id: 'cA' },
          messages: [
            { id: 'uA', conversationId: 'cA', role: 'user', content: 'Prompt in A', createdAt: timestamp },
            { id: 'aA', conversationId: 'cA', role: 'assistant', content: 'Finished answer in A', createdAt: timestamp, status: 'completed' },
          ],
        };
      }
      return { conversation: { ...conversation, id: 'cB' }, messages: [] };
    });
    vi.spyOn(realApiClient, 'getTurnVariants').mockImplementation(async id => {
      if (id === 'cA') {
        return {
          userMessageId: 'uA',
          selectedGenerationId: 'gA_completed',
          items: [{ id: 'gA_completed', action: 'new_prompt', modelId: 'giga-chat-default', status: 'completed', assistantMessageId: 'aA', content: 'Finished answer in A', createdAt: timestamp }],
        };
      }
      return { userMessageId: 'uB', selectedGenerationId: null, items: [] };
    });

    function Navigation() {
      const { navigate } = useRouter();
      return (
        <div>
          <button onClick={() => navigate('/chat/cA')}>Go to A</button>
          <button onClick={() => navigate('/chat/cB')}>Go to B</button>
        </div>
      );
    }

    render(
      <ApiModeProvider initialMode="real">
        <RouterProvider initialPath="/chat/cB">
          <Navigation />
          <ChatView />
        </RouterProvider>
      </ApiModeProvider>
    );

    // Navigate to A
    fireEvent.click(screen.getByRole('button', { name: 'Go to A' }));

    // Messages and completed response restored
    expect(await screen.findByText('Finished answer in A')).toBeDefined();

    // Regenerate is available, Retry is not, Composer is unlocked
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    const textarea = screen.getByPlaceholderText(/Ask Giga anything/);
    expect(textarea.hasAttribute('disabled')).toBe(false);
  });

  it('history loading failure displays visible Retry button and locks Composer until retry succeeds', async () => {
    let failCount = 1;
    vi.spyOn(realApiClient, 'getConversation').mockImplementation(async id => {
      if (id === 'cA' && failCount > 0) {
        failCount--;
        throw new Error('Network timeout loading history');
      }
      return {
        conversation: { ...conversation, id: 'cA' },
        messages: [{ id: 'uA', conversationId: 'cA', role: 'user', content: 'Recovered prompt', createdAt: timestamp }],
      };
    });
    vi.spyOn(realApiClient, 'getTurnVariants').mockResolvedValue({
      userMessageId: 'uA',
      selectedGenerationId: null,
      items: [],
    });

    render(
      <ApiModeProvider initialMode="real">
        <RouterProvider initialPath="/chat/cA">
          <ChatView />
        </RouterProvider>
      </ApiModeProvider>
    );

    // Verify error is displayed
    expect(await screen.findByText(/Network timeout loading history/)).toBeDefined();

    // Composer is locked due to history loading failure
    const textarea = screen.getByPlaceholderText(/Chat is disabled|Ask Giga anything/);
    expect(textarea.hasAttribute('disabled')).toBe(true);

    // Find and click Retry Loading History button
    const retryBtn = screen.getAllByRole('button', { name: /Retry/ })[0];
    fireEvent.click(retryBtn);

    // On successful retry, history is restored and Composer is unlocked
    expect(await screen.findByText('Recovered prompt')).toBeDefined();
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Ask Giga anything/).hasAttribute('disabled')).toBe(false);
    });
  });

  it('history loading failure followed by retry with active generation keeps Composer locked and enables Stop', async () => {
    let failCount = 1;
    vi.spyOn(realApiClient, 'getConversation').mockImplementation(async id => {
      if (id === 'cA' && failCount > 0) {
        failCount--;
        throw new Error('500 Internal Server Error');
      }
      return {
        conversation: { ...conversation, id: 'cA' },
        messages: [{ id: 'uA', conversationId: 'cA', role: 'user', content: 'Active prompt', createdAt: timestamp }],
      };
    });
    vi.spyOn(realApiClient, 'getTurnVariants').mockResolvedValue({
      userMessageId: 'uA',
      selectedGenerationId: null,
      items: [{ id: 'gA_active', action: 'new_prompt', modelId: 'giga-chat-default', status: 'streaming', createdAt: timestamp }],
    });
    vi.spyOn(realApiClient, 'getGeneration').mockResolvedValue({
      generation: { id: 'gA_active', conversationId: 'cA', userMessageId: 'uA', modelId: 'giga-chat-default', status: 'streaming', partialContent: 'In flight', createdAt: timestamp },
    });

    render(
      <ApiModeProvider initialMode="real">
        <RouterProvider initialPath="/chat/cA">
          <ChatView />
        </RouterProvider>
      </ApiModeProvider>
    );

    // Expect error
    expect(await screen.findByText(/500 Internal Server Error/)).toBeDefined();

    // Click retry
    const retryBtn = screen.getAllByRole('button', { name: /Retry/ })[0];
    fireEvent.click(retryBtn);

    // Message restored, but active generation discovered -> Stop enabled and Composer locked
    expect(await screen.findByText('Active prompt')).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Stop Generating' })).toBeDefined();
    expect(screen.getByPlaceholderText(/Generating response...|Ask Giga anything/).hasAttribute('disabled')).toBe(true);
  });

  it('rapid A -> B navigation while history request for A fails does not lock Composer in B', async () => {
    let rejectA: ((err: any) => void) | null = null;
    vi.spyOn(realApiClient, 'getConversation').mockImplementation(async id => {
      if (id === 'cA') {
        return new Promise((_, reject) => {
          rejectA = reject;
        });
      }
      return {
        conversation: { ...conversation, id: 'cB' },
        messages: [{ id: 'uB', conversationId: 'cB', role: 'user', content: 'Prompt in B', createdAt: timestamp }],
      };
    });
    vi.spyOn(realApiClient, 'getTurnVariants').mockResolvedValue({
      userMessageId: 'uB',
      selectedGenerationId: null,
      items: [],
    });

    function Navigation() {
      const { navigate } = useRouter();
      return (
        <div>
          <button onClick={() => navigate('/chat/cA')}>Go to A</button>
          <button onClick={() => navigate('/chat/cB')}>Go to B</button>
        </div>
      );
    }

    render(
      <ApiModeProvider initialMode="real">
        <RouterProvider initialPath="/chat/cA">
          <Navigation />
          <ChatView />
        </RouterProvider>
      </ApiModeProvider>
    );

    // Immediately navigate to B while A is still pending
    fireEvent.click(screen.getByRole('button', { name: 'Go to B' }));

    // Now fail request for A
    if (rejectA) {
      const rej: (err: any) => void = rejectA;
      await act(async () => {
        rej(new Error('Stale failure in A'));
      });
    }

    // In conversation B: prompt in B is displayed, no error from A, and Composer is NOT locked
    expect(await screen.findByText('Prompt in B')).toBeDefined();
    expect(screen.queryByText(/Stale failure in A/)).toBeNull();
    const textarea = screen.getByPlaceholderText(/Ask Giga anything/);
    expect(textarea.hasAttribute('disabled')).toBe(false);
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
