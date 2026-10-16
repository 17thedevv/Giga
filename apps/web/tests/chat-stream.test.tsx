import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiModeProvider } from '../src/app/context/ApiModeContext.js';
import { AuthProvider } from '../src/app/context/AuthContext.js';
import { RouterProvider } from '../src/app/router.js';
import { ChatView } from '../src/features/chat/ChatView.js';
import { mockDataAdapter } from '../src/lib/api/mock-adapter.js';

describe('Chat Stream Finalization Regression Tests', () => {
  beforeEach(() => {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.clear();
    }
    // Initialize mock session
    mockDataAdapter.setMockSession({
      id: 'usr_test',
      email: 'trangthu@demo.giga.dev',
      displayName: 'Tráng A Thư',
    });
  });

  it('accumulates multiple chunks and persists exactly one finalized assistant message in conversation history', async () => {
    // Mock simulateChatStream to emit 3 distinct chunks rapidly and finish
    const simulateSpy = vi.spyOn(mockDataAdapter, 'simulateChatStream').mockImplementation(
      async (_prompt, onChunk, onComplete) => {
        onChunk('Chunk 1: Hello. ');
        onChunk('Chunk 2: This is Giga. ');
        onChunk('Chunk 3: Response complete.');
        onComplete();
      }
    );

    render(
      <ApiModeProvider initialMode="mock">
        <AuthProvider>
          <RouterProvider initialPath="/chat">
            <ChatView />
          </RouterProvider>
        </AuthProvider>
      </ApiModeProvider>
    );

    // Wait for chat to load
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Ask Giga anything/i)).toBeDefined();
    });

    const input = screen.getByPlaceholderText(/Ask Giga anything/i) as HTMLTextAreaElement;
    const form = input.closest('form')!;

    // Send a message
    fireEvent.change(input, { target: { value: 'Test streaming accumulator' } });
    fireEvent.submit(form);

    // User message should appear immediately
    await waitFor(() => {
      expect(screen.getByText('Test streaming accumulator')).toBeDefined();
    });

    // Assistant response must be finalized and persisted in history
    await waitFor(() => {
      expect(
        screen.getByText('Chunk 1: Hello. Chunk 2: This is Giga. Chunk 3: Response complete.')
      ).toBeDefined();
    });

    // Verify exactly one finalized assistant message was added
    const convs = await mockDataAdapter.listConversations();
    const activeConvId = convs.items[0].id;
    const convData = await mockDataAdapter.getConversation(activeConvId);
    const assistantMsgs = convData.messages.filter((m) => m.role === 'assistant');

    expect(assistantMsgs.length).toBe(1);
    expect(assistantMsgs[0].content).toBe(
      'Chunk 1: Hello. Chunk 2: This is Giga. Chunk 3: Response complete.'
    );

    simulateSpy.mockRestore();
  });

  it('does not produce a fake finalized assistant message when stream encounters an error', async () => {
    const simulateSpy = vi.spyOn(mockDataAdapter, 'simulateChatStream').mockImplementation(
      async (_prompt, onChunk) => {
        onChunk('Partial content before failure...');
        throw new Error('Connection severed abruptly');
      }
    );

    render(
      <ApiModeProvider initialMode="mock">
        <AuthProvider>
          <RouterProvider initialPath="/chat">
            <ChatView />
          </RouterProvider>
        </AuthProvider>
      </ApiModeProvider>
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Ask Giga anything/i)).toBeDefined();
    });

    const input = screen.getByPlaceholderText(/Ask Giga anything/i) as HTMLTextAreaElement;
    const form = input.closest('form')!;

    fireEvent.change(input, { target: { value: 'Trigger stream error' } });
    fireEvent.submit(form);

    // Error banner should be displayed
    await waitFor(() => {
      expect(screen.getByText('Connection severed abruptly')).toBeDefined();
    });

    // Confirm no completed assistant message was persisted into conversation history
    const convs = await mockDataAdapter.listConversations();
    const activeConvId = convs.items[0].id;
    const convData = await mockDataAdapter.getConversation(activeConvId);
    const assistantMsgs = convData.messages.filter(
      (m) => m.role === 'assistant' && m.content.includes('Partial content')
    );

    expect(assistantMsgs.length).toBe(0);

    simulateSpy.mockRestore();
  });

  it('preserves partial accumulated content with stop indicator when user cancels stream', async () => {
    let cancelSignal: AbortSignal | undefined;
    const simulateSpy = vi.spyOn(mockDataAdapter, 'simulateChatStream').mockImplementation(
      async (_prompt, onChunk, _onComplete, signal) => {
        cancelSignal = signal;
        onChunk('Initial chunk received...');
        // Pause to simulate ongoing stream until cancelled
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (!signal?.aborted) {
          onChunk('Second chunk...');
        }
      }
    );

    render(
      <ApiModeProvider initialMode="mock">
        <AuthProvider>
          <RouterProvider initialPath="/chat">
            <ChatView />
          </RouterProvider>
        </AuthProvider>
      </ApiModeProvider>
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Ask Giga anything/i)).toBeDefined();
    });

    const input = screen.getByPlaceholderText(/Ask Giga anything/i) as HTMLTextAreaElement;
    const form = input.closest('form')!;

    fireEvent.change(input, { target: { value: 'Cancel midway' } });
    fireEvent.submit(form);

    // Streaming starts, stop button should appear
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Stop/i })).toBeDefined();
    });

    // Wait for admission before Stop can durably target a generation.
    await waitFor(() => expect(cancelSignal).toBeDefined());
    await waitFor(() => expect((screen.getByRole('button', { name: /Stop/i }) as HTMLButtonElement).disabled).toBe(false));
    // Click stop
    fireEvent.click(screen.getByRole('button', { name: /Stop/i }));

    await waitFor(() => {
      expect(cancelSignal?.aborted).toBe(true);
      expect(screen.getByText(/Response stopped by user/i)).toBeDefined();
    });

    // Incomplete output is generation state, never a fabricated completed answer.
    const convs = await mockDataAdapter.listConversations();
    const activeConvId = convs.items[0].id;
    const convData = await mockDataAdapter.getConversation(activeConvId);
    const userId = convData.messages.filter(m => m.role === 'user').at(-1)!.id;
    const variants = await mockDataAdapter.getTurnVariants(activeConvId, userId);
    const stopped = await mockDataAdapter.getGeneration(activeConvId, variants.items.at(-1)!.id);
    expect(stopped.generation.status).toBe('stopped');
    expect(stopped.generation.partialContent).toContain('Initial chunk received...');
    expect(convData.messages.filter(m => m.role === 'assistant')).toHaveLength(0);

    simulateSpy.mockRestore();
  });
});
