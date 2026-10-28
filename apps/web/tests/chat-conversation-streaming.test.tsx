import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiModeProvider } from '../src/app/context/ApiModeContext.js';
import { AuthProvider } from '../src/app/context/AuthContext.js';
import { RouterProvider } from '../src/app/router.js';
import { ChatView } from '../src/features/chat/ChatView.js';
import { realApiClient, ApiException } from '../src/lib/api/client.js';
import { mockDataAdapter } from '../src/lib/api/mock-adapter.js';
import {
  SseStreamParser,
  validateChatStreamEvent,
  SseValidationError,
} from '../src/lib/api/sse-parser.js';
import type { Conversation, Message, ChatGeneration } from '../src/lib/api/types.js';

describe('17T-33 — GigaChat Conversation & Streaming UI Tests', () => {
  beforeEach(() => {
    // Legacy fixtures predate turn inspection; explicit empty response retains legacy answers.
    vi.spyOn(realApiClient, 'getTurnVariants').mockImplementation(async (_id, userMessageId) => ({ userMessageId, selectedGenerationId: null, items: [] }));
    if (typeof window !== 'undefined') {
      if (window.sessionStorage) {
        window.sessionStorage.clear();
      }
      window.history.replaceState({}, '', '/');
    }
    mockDataAdapter.setMockSession({
      id: 'usr_test',
      email: 'trangthu@demo.giga.dev',
      displayName: 'Tráng A Thư',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Section 1: SSE Parser & Validation Unit Tests
  // =========================================================================
  describe('SSE Stream Parser & Event Validation', () => {
    it('handles arbitrary chunk boundaries and multi-byte UTF-8 split across chunks', () => {
      const dispatched: unknown[] = [];
      const parser = new SseStreamParser((event) => {
        dispatched.push(event);
      });

      // "Tráng A Thư ⚡" contains multi-byte UTF-8 code points:
      // 'á' (2 bytes), 'ư' (2 bytes), '⚡' (3 bytes: E2 9A A1)
      const text = 'Tráng A Thư ⚡';
      const eventPayload = `event: message.delta\ndata: ${JSON.stringify({
        messageId: 'msg_1',
        generationId: 'gen_1',
        text,
      })}\n\n`;

      const encoder = new TextEncoder();
      const allBytes = encoder.encode(eventPayload);

      // Split bytes across arbitrary tiny chunks (e.g. 3 bytes per chunk)
      const chunkSize = 3;
      for (let i = 0; i < allBytes.length; i += chunkSize) {
        parser.feedBytes(allBytes.slice(i, i + chunkSize));
      }
      parser.flush();

      expect(dispatched.length).toBe(1);
      const parsed = dispatched[0] as { event: string; data: { text: string } };
      expect(parsed.event).toBe('message.delta');
      expect(parsed.data.text).toBe('Tráng A Thư ⚡');
    });

    it('handles multiple events packed into a single network chunk', () => {
      const events: string[] = [];
      const parser = new SseStreamParser((e) => {
        events.push(e.event);
      });

      const chunk =
        'event: message.started\ndata: {"messageId":"m1","generationId":"g1","conversationId":"c1"}\n\n' +
        'event: message.delta\ndata: {"messageId":"m1","generationId":"g1","text":"Hi"}\n\n' +
        'event: message.completed\ndata: {"messageId":"m1","generationId":"g1"}\n\n';

      parser.feed(chunk);
      expect(events).toEqual(['message.started', 'message.delta', 'message.completed']);
    });

    it('handles a single event split across multiple string chunks', () => {
      const events: string[] = [];
      const parser = new SseStreamParser((e) => {
        events.push(e.event);
      });

      parser.feed('event: message.');
      parser.feed('delta\ndata: {"messageId":"m1"');
      parser.feed(',"generationId":"g1","text":"Hello"}\n');
      expect(events.length).toBe(0);

      parser.feed('\n'); // Complete event dispatch on trailing newline
      expect(events).toEqual(['message.delta']);
    });

    it('safely ignores comment and keep-alive heartbeat lines', () => {
      const events: string[] = [];
      const parser = new SseStreamParser((e) => {
        events.push(e.event);
      });

      parser.feed(': ping\n: keepalive heartbeat\n\n');
      expect(events.length).toBe(0);

      parser.feed('event: message.delta\ndata: {"messageId":"m1","generationId":"g1","text":"A"}\n\n');
      expect(events.length).toBe(1);
    });

    it('safely ignores unknown event types without throwing', () => {
      const validated = validateChatStreamEvent('custom.metrics.event', { foo: 'bar' });
      expect(validated).toBeNull();
    });

    it('throws SseValidationError for malformed known-event payload', () => {
      // 1. Non-object payload
      expect(() => {
        validateChatStreamEvent('message.delta', 'not-an-object');
      }).toThrow(SseValidationError);

      // 2. Missing messageId/generationId
      expect(() => {
        validateChatStreamEvent('message.delta', { text: 'Hello' });
      }).toThrow(SseValidationError);

      // 3. message.started missing conversationId
      expect(() => {
        validateChatStreamEvent('message.started', { messageId: 'm1', generationId: 'g1' });
      }).toThrow(SseValidationError);

      // 4. message.delta missing text
      expect(() => {
        validateChatStreamEvent('message.delta', { messageId: 'm1', generationId: 'g1' });
      }).toThrow(SseValidationError);

      // 5. stream.error missing error object
      expect(() => {
        validateChatStreamEvent('stream.error', { messageId: 'm1', generationId: 'g1' });
      }).toThrow(SseValidationError);
    });

    it('enforces terminal event idempotency', () => {
      const dispatched: string[] = [];
      const parser = new SseStreamParser(
        (e) => {
          dispatched.push(e.event);
        },
        { enforceTerminalIdempotency: true }
      );

      parser.feed('event: message.completed\ndata: {"messageId":"m1","generationId":"g1"}\n\n');
      // Subsequent late events must be blocked
      parser.feed('event: message.delta\ndata: {"messageId":"m1","generationId":"g1","text":"Late"}\n\n');
      parser.feed('event: message.completed\ndata: {"messageId":"m1","generationId":"g1"}\n\n');

      expect(dispatched).toEqual(['message.completed']);
      expect(parser.hasTerminated()).toBe(true);
    });
  });

  // =========================================================================
  // Section 2: Real Mode Conversation CRUD Integration
  // =========================================================================
  describe('Real Mode Conversation CRUD', () => {
    it('renders conversation list and handles empty discussion state in Real mode', async () => {
      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [],
        nextCursor: null,
      });

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      expect(Object.prototype.hasOwnProperty.call(window, '__mockDataAdapter')).toBe(false);

      await waitFor(() => {
        expect(screen.getByText(/No discussions yet/i)).toBeDefined();
      });
      expect(screen.getByText(/Where shall we begin?/i)).toBeDefined();
    });

    it('creates a new conversation in Real mode on New Chat button click', async () => {
      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [],
        nextCursor: null,
      });
      const createSpy = vi.spyOn(realApiClient, 'createConversation').mockResolvedValue({
        conversation: {
          id: 'conv_real_new',
          title: 'Brand New Discussion',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      vi.spyOn(realApiClient, 'getConversation').mockResolvedValue({
        conversation: {
          id: 'conv_real_new',
          title: 'Brand New Discussion',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        messages: [],
      });

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /New Chat/i })).toBeDefined();
      });

      fireEvent.click(screen.getByRole('button', { name: /New Chat/i }));

      await waitFor(() => {
        expect(createSpy).toHaveBeenCalled();
        expect(screen.getByText('Brand New Discussion')).toBeDefined();
      });
    });

    it('deletes an existing conversation in Real mode', async () => {
      const mockConv: Conversation = {
        id: 'conv_to_delete',
        title: 'Discussion to Delete',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [mockConv],
        nextCursor: null,
      });
      vi.spyOn(realApiClient, 'getConversation').mockResolvedValue({
        conversation: mockConv,
        messages: [],
      });
      const deleteSpy = vi.spyOn(realApiClient, 'deleteConversation').mockResolvedValue(undefined);

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat/conv_to_delete">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByText('Discussion to Delete')).toBeDefined();
      });

      // Click delete trash icon
      const deleteBtn = screen.getByTitle('Delete conversation');
      fireEvent.click(deleteBtn);

      // Confirm in modal
      await waitFor(() => {
        expect(screen.getByText(/Are you sure you want to delete/i)).toBeDefined();
      });

      const confirmBtn = screen.getByRole('button', { name: /Delete Permanently/i });
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(deleteSpy).toHaveBeenCalledWith('conv_to_delete');
      });
    });

    it('surfaces Real mode API errors in Alert without falling back to Mock mode', async () => {
      vi.spyOn(realApiClient, 'listConversations').mockRejectedValue(
        new ApiException(500, 'INTERNAL_SERVER_ERROR', 'Neon Database pool connection failed')
      );
      const mockListSpy = vi.spyOn(mockDataAdapter, 'listConversations');

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByText(/Neon Database pool connection failed/i)).toBeDefined();
      });

      // Invariant: MUST NOT fallback silently to mockDataAdapter
      expect(mockListSpy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Section 3: GigaChat Streaming Lifecycle & Invariants
  // =========================================================================
  describe('Real Mode Streaming Lifecycle', () => {
    it('keeps a credential split across stream deltas out of rendered state and clipboard', async () => {
      const activeConv: Conversation = {
        id: 'conv_stream_redaction', title: 'Stream redaction',
        createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
      };
      const userMessage: Message = {
        id: 'user-stream-redaction', conversationId: activeConv.id, role: 'user', content: 'Ask a question',
        createdAt: activeConv.createdAt,
      };
      vi.spyOn(realApiClient, 'getMe').mockResolvedValue({ user: { id: 'u1', email: 'user@example.test', displayName: 'User' } });
      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({ items: [activeConv], nextCursor: null });
      vi.spyOn(realApiClient, 'getConversation').mockResolvedValue({ conversation: activeConv, messages: [userMessage] });
      vi.spyOn(realApiClient, 'getTurnVariants').mockResolvedValue({ userMessageId: userMessage.id, selectedGenerationId: null, items: [] });

      const ordinary = 'This ordinary streamed sentence remains visible before the credential: ';
      const credential = 'AIzaSyntheticSplitStreamCredential0123456789';
      let announceDeltas!: () => void;
      let finishStream!: () => void;
      const deltasReady = new Promise<void>(resolve => { announceDeltas = resolve; });
      const completionGate = new Promise<void>(resolve => { finishStream = resolve; });
      vi.spyOn(realApiClient, 'streamMessage').mockImplementation(async (_id, _content, onEvent) => {
        onEvent({ event: 'message.started', data: { messageId: 'answer-redaction', generationId: 'generation-redaction', conversationId: activeConv.id } });
        onEvent({ event: 'message.delta', data: { messageId: 'answer-redaction', generationId: 'generation-redaction', text: ordinary + 'AIzaSyntheticSplit' } });
        onEvent({ event: 'message.delta', data: { messageId: 'answer-redaction', generationId: 'generation-redaction', text: 'StreamCredential0123456789 and ordinary text after it.' } });
        announceDeltas();
        await completionGate;
        onEvent({ event: 'message.completed', data: { messageId: 'answer-redaction', generationId: 'generation-redaction', finishReason: 'stop' } });
      });

      const writeText = vi.fn().mockResolvedValue(undefined);
      const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      try {
        render(
          <ApiModeProvider initialMode="real">
            <AuthProvider>
              <RouterProvider initialPath={`/chat/${activeConv.id}`}><ChatView /></RouterProvider>
            </AuthProvider>
          </ApiModeProvider>
        );

        await waitFor(() => expect(screen.getByPlaceholderText(/Message Giga/i)).toBeDefined());
        const input = screen.getByPlaceholderText(/Message Giga/i) as HTMLTextAreaElement;
        fireEvent.change(input, { target: { value: 'Ask a question' } });
        fireEvent.submit(input.closest('form')!);
        await deltasReady;

        await waitFor(() => expect(document.body.textContent).toContain(ordinary));
        expect(document.body.textContent).not.toContain(credential);
        expect(document.body.textContent).not.toContain('AIzaSyntheticSplit');
        expect(document.body.textContent).not.toContain('StreamCredential0123456789');

        finishStream();
        const expected = `${ordinary}[redacted credential] and ordinary text after it.`;
        const copy = await screen.findByTestId('copy-btn-answer-redaction');
        fireEvent.click(copy);
        await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected));
        expect(document.body.textContent).not.toContain(credential);
      } finally {
        if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
        else Reflect.deleteProperty(navigator, 'clipboard');
      }
    });

    it('streams assistant response with ordered delta accumulation and reconciles without duplicate user message', async () => {
      const activeConv: Conversation = {
        id: 'conv_streaming_1',
        title: 'Active Stream Discussion',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [activeConv],
        nextCursor: null,
      });

      const userMsg: Message = {
        id: 'msg_u_persisted',
        conversationId: 'conv_streaming_1',
        role: 'user',
        content: 'Review PostgreSQL connection timeout',
        createdAt: new Date().toISOString(),
      };
      const assistantMsg: Message = {
        id: 'msg_a_persisted',
        conversationId: 'conv_streaming_1',
        role: 'assistant',
        content: 'Use pooled connections over WebSockets with 30s timeout.',
        createdAt: new Date().toISOString(),
      };

      let initialLoaded = false;
      vi.spyOn(realApiClient, 'getConversation').mockImplementation(async () => {
        if (!initialLoaded) {
          initialLoaded = true;
          return { conversation: activeConv, messages: [] };
        }
        // Authoritative reconciliation after stream completes
        return { conversation: activeConv, messages: [userMsg, assistantMsg] };
      });

      const streamSpy = vi.spyOn(realApiClient, 'streamMessage').mockImplementation(
        async (_convId, _content, onEvent) => {
          onEvent({
            event: 'message.started',
            data: { messageId: 'msg_a_persisted', generationId: 'gen_101', conversationId: 'conv_streaming_1' },
          });
          onEvent({
            event: 'message.delta',
            data: { messageId: 'msg_a_persisted', generationId: 'gen_101', text: 'Use pooled connections ' },
          });
          onEvent({
            event: 'message.delta',
            data: { messageId: 'msg_a_persisted', generationId: 'gen_101', text: 'over WebSockets with 30s timeout.' },
          });
          onEvent({
            event: 'message.completed',
            data: { messageId: 'msg_a_persisted', generationId: 'gen_101', finishReason: 'stop' },
          });
        }
      );

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat/conv_streaming_1">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Message Giga/i)).toBeDefined();
      });

      const input = screen.getByPlaceholderText(/Message Giga/i) as HTMLTextAreaElement;
      const form = input.closest('form')!;

      fireEvent.change(input, { target: { value: 'Review PostgreSQL connection timeout' } });
      fireEvent.submit(form);

      // Verify stream called
      await waitFor(() => {
        expect(streamSpy).toHaveBeenCalled();
      });

      // Verify finalized message is displayed
      await waitFor(() => {
        expect(
          screen.getByText('Use pooled connections over WebSockets with 30s timeout.')
        ).toBeDefined();
      });

      // Verify user message is not duplicated
      const userTextElements = screen.getAllByText('Review PostgreSQL connection timeout');
      expect(userTextElements.length).toBe(1);
    });

    it('prevents double-submit while an active stream is ongoing', async () => {
      const activeConv: Conversation = {
        id: 'conv_double_submit',
        title: 'Double Submit Guard Test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [activeConv],
        nextCursor: null,
      });
      vi.spyOn(realApiClient, 'getConversation').mockResolvedValue({
        conversation: activeConv,
        messages: [],
      });

      const finishRef = { current: null as (() => void) | null };
      const streamSpy = vi.spyOn(realApiClient, 'streamMessage').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishRef.current = resolve;
          })
      );

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat/conv_double_submit">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Message Giga/i)).toBeDefined();
      });

      const input = screen.getByPlaceholderText(/Message Giga/i) as HTMLTextAreaElement;
      const form = input.closest('form')!;

      // First submit
      fireEvent.change(input, { target: { value: 'First prompt' } });
      fireEvent.submit(form);

      await waitFor(() => {
        expect(streamSpy).toHaveBeenCalledTimes(1);
      });

      // Attempt second submit while stream is active
      fireEvent.change(input, { target: { value: 'Second rapid prompt' } });
      fireEvent.submit(form);

      // Invariant: MUST NOT invoke streamMessage a second time
      expect(streamSpy).toHaveBeenCalledTimes(1);

      // Clean up hanging promise
      finishRef.current?.();
    });

    it('preserves partial text and surfaces error when stream fails', async () => {
      const activeConv: Conversation = {
        id: 'conv_failure',
        title: 'Failure Recovery Test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [activeConv],
        nextCursor: null,
      });
      vi.spyOn(realApiClient, 'getConversation').mockResolvedValue({
        conversation: activeConv,
        messages: [],
      });

      vi.spyOn(realApiClient, 'getGeneration').mockResolvedValue({ generation: {
        id: 'gen_err', conversationId: 'conv_failure', userMessageId: 'u1',
        modelId: 'giga-chat-default', status: 'failed', partialContent: 'Partial text before failure...',
        createdAt: new Date().toISOString(), error: { code: 'PROVIDER_TIMEOUT', message: 'Upstream LLM timed out' },
      } });
      vi.spyOn(realApiClient, 'streamMessage').mockImplementation(async (_convId, _content, onEvent) => {
        onEvent({
          event: 'message.started',
          data: { messageId: 'msg_err', generationId: 'gen_err', conversationId: 'conv_failure' },
        });
        onEvent({
          event: 'message.delta',
          data: { messageId: 'msg_err', generationId: 'gen_err', text: 'Partial text before failure...' },
        });
        onEvent({
          event: 'message.failed',
          data: {
            messageId: 'msg_err',
            generationId: 'gen_err',
            error: { code: 'PROVIDER_TIMEOUT', message: 'Upstream LLM timed out' },
          },
        });
      });

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat/conv_failure">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Message Giga/i)).toBeDefined();
      });

      const input = screen.getByPlaceholderText(/Message Giga/i) as HTMLTextAreaElement;
      const form = input.closest('form')!;

      fireEvent.change(input, { target: { value: 'Trigger timeout' } });
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByText('Partial text before failure...')).toBeDefined();
        expect(screen.getByText(/Upstream LLM timed out/i)).toBeDefined();
      });
    });

    it('durable stop: cancel POST is unresolved -> SSE connection MUST NOT be aborted yet', async () => {
      const activeConv: Conversation = {
        id: 'conv_durable_test',
        title: 'Durable Stop Test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [activeConv],
        nextCursor: null,
      });
      vi.spyOn(realApiClient, 'getConversation').mockResolvedValue({
        conversation: activeConv,
        messages: [],
      });

      const cancelResolveRef = {
        current: null as ((val: { generation: ChatGeneration }) => void) | null,
      };
      const cancelSpy = vi.spyOn(realApiClient, 'cancelGeneration').mockImplementation(
        () =>
          new Promise<{ generation: ChatGeneration }>((resolve) => {
            cancelResolveRef.current = resolve;
          })
      );

      let capturedSignal: AbortSignal | undefined;
      vi.spyOn(realApiClient, 'streamMessage').mockImplementation(
        async (_convId, _content, onEvent, options) => {
          capturedSignal = options?.signal;
          onEvent({
            event: 'message.started',
            data: {
              messageId: 'msg_s',
              generationId: 'gen_durable',
              conversationId: 'conv_durable_test',
            },
          });
          onEvent({
            event: 'message.delta',
            data: { messageId: 'msg_s', generationId: 'gen_durable', text: 'Streaming content...' },
          });
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener('abort', () => resolve());
          });
        }
      );

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat/conv_durable_test">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Message Giga/i)).toBeDefined();
      });

      const input = screen.getByPlaceholderText(/Message Giga/i) as HTMLTextAreaElement;
      const form = input.closest('form')!;

      fireEvent.change(input, { target: { value: 'Test durable cancel' } });
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Stop Generating' })).toBeDefined();
      });

      // User clicks Stop
      fireEvent.click(screen.getByRole('button', { name: 'Stop Generating' }));

      // cancelGeneration was invoked
      await waitFor(() => {
        expect(cancelSpy).toHaveBeenCalledWith('conv_durable_test', 'gen_durable');
      });

      // INVARIANT P0: While cancel POST is pending/unresolved, SSE MUST NOT be aborted!
      expect(capturedSignal?.aborted).toBe(false);

      // Now resolve cancel with stopped state
      cancelResolveRef.current?.({
        generation: {
          id: 'gen_durable',
          conversationId: 'conv_durable_test',
          userMessageId: 'u1',
          modelId: 'giga-chat-default',
          status: 'stopped',
          partialContent: 'Streaming content...',
          finishReason: 'cancelled',
          createdAt: new Date().toISOString(),
        },
      });

      // After resolution, stop completes cleanly without error banner
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Stop Generating' })).toBeNull();
      });
      expect(screen.queryByText(/AbortError/i)).toBeNull();
    });

    it('authoritative reconciliation: disconnect after message.started calls getGeneration as source of truth', async () => {
      const activeConv: Conversation = {
        id: 'conv_reconcile_test',
        title: 'Reconciliation Test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [activeConv],
        nextCursor: null,
      });
      vi.spyOn(realApiClient, 'getConversation').mockResolvedValue({
        conversation: activeConv,
        messages: [],
      });

      const getGenSpy = vi.spyOn(realApiClient, 'getGeneration').mockResolvedValue({
        generation: {
          id: 'gen_reconcile',
          conversationId: 'conv_reconcile_test',
          userMessageId: 'u1',
          modelId: 'giga-chat-default',
          status: 'interrupted',
          partialContent: 'Saved partial text from DB checkpoint',
          finishReason: 'cancelled',
          createdAt: new Date().toISOString(),
        },
      });

      vi.spyOn(realApiClient, 'streamMessage').mockImplementation(
        async (_convId, _content, onEvent) => {
          onEvent({
            event: 'message.started',
            data: {
              messageId: 'm1',
              generationId: 'gen_reconcile',
              conversationId: 'conv_reconcile_test',
            },
          });
          // Abrupt network error/disconnect
          throw new TypeError('Failed to fetch: network dropped');
        }
      );

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat/conv_reconcile_test">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Message Giga/i)).toBeDefined();
      });

      const input = screen.getByPlaceholderText(/Message Giga/i) as HTMLTextAreaElement;
      const form = input.closest('form')!;
      fireEvent.change(input, { target: { value: 'Trigger disconnect' } });
      fireEvent.submit(form);

      // INVARIANT P1: Disconnect after message.started MUST call getGeneration for authoritative reconciliation
      await waitFor(() => {
        expect(getGenSpy).toHaveBeenCalledWith('conv_reconcile_test', 'gen_reconcile');
      });

      // Partial content from authoritative generation is displayed in UI
      await waitFor(() => {
        expect(screen.getByText('Saved partial text from DB checkpoint')).toBeDefined();
      });
    });

    it('race condition: generation completed during Stop race -> UI accepts completed winner without error', async () => {
      const activeConv: Conversation = {
        id: 'conv_race_test',
        title: 'Race Condition Test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [activeConv],
        nextCursor: null,
      });

      const completedAssistantMsg: Message = {
        id: 'msg_a_winner',
        conversationId: 'conv_race_test',
        role: 'assistant',
        content: 'Authoritative completed response from backend',
        createdAt: new Date().toISOString(),
      };

      vi.spyOn(realApiClient, 'getConversation').mockResolvedValue({
        conversation: activeConv,
        messages: [completedAssistantMsg],
      });

      // Cancel returns completed generation (provider completed before cancel intent was evaluated)
      vi.spyOn(realApiClient, 'cancelGeneration').mockResolvedValue({
        generation: {
          id: 'gen_race',
          conversationId: 'conv_race_test',
          userMessageId: 'u1',
          assistantMessageId: 'msg_a_winner',
          modelId: 'giga-chat-default',
          status: 'completed',
          partialContent: 'Authoritative completed response from backend',
          finishReason: 'stop',
          createdAt: new Date().toISOString(),
        },
      });

      vi.spyOn(realApiClient, 'getGeneration').mockResolvedValue({
        generation: {
          id: 'gen_race',
          conversationId: 'conv_race_test',
          userMessageId: 'u1',
          assistantMessageId: 'msg_a_winner',
          modelId: 'giga-chat-default',
          status: 'completed',
          partialContent: 'Authoritative completed response from backend',
          finishReason: 'stop',
          createdAt: new Date().toISOString(),
        },
      });

      vi.spyOn(realApiClient, 'streamMessage').mockImplementation(
        async (_convId, _content, onEvent, options) => {
          onEvent({
            event: 'message.started',
            data: { messageId: 'm1', generationId: 'gen_race', conversationId: 'conv_race_test' },
          });
          onEvent({
            event: 'message.delta',
            data: { messageId: 'm1', generationId: 'gen_race', text: 'Authoritative ' },
          });
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener('abort', () => resolve());
          });
        }
      );

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat/conv_race_test">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Message Giga/i)).toBeDefined();
      });

      const input = screen.getByPlaceholderText(/Message Giga/i) as HTMLTextAreaElement;
      const form = input.closest('form')!;
      fireEvent.change(input, { target: { value: 'Prompt race' } });
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Stop Generating' })).toBeDefined();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Stop Generating' }));

      // Verify UI accepts completed winner
      await waitFor(() => {
        expect(
          screen.getByText('Authoritative completed response from backend')
        ).toBeDefined();
      });
      expect(screen.queryByText(/AbortError/i)).toBeNull();
    });

    it('cancel failure: handles cancel failure visibly and does not fake stopped state', async () => {
      const activeConv: Conversation = {
        id: 'conv_fail_cancel',
        title: 'Cancel Fail Test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [activeConv],
        nextCursor: null,
      });
      vi.spyOn(realApiClient, 'getConversation').mockResolvedValue({
        conversation: activeConv,
        messages: [],
      });

      vi.spyOn(realApiClient, 'cancelGeneration').mockRejectedValue(
        new ApiException(
          503,
          'SERVICE_UNAVAILABLE',
          'Backend cancel service is temporarily unavailable'
        )
      );

      vi.spyOn(realApiClient, 'streamMessage').mockImplementation(
        async (_convId, _content, onEvent, options) => {
          onEvent({
            event: 'message.started',
            data: {
              messageId: 'm1',
              generationId: 'gen_fail',
              conversationId: 'conv_fail_cancel',
            },
          });
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener('abort', () => resolve());
          });
        }
      );

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat/conv_fail_cancel">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Message Giga/i)).toBeDefined();
      });

      const input = screen.getByPlaceholderText(/Message Giga/i) as HTMLTextAreaElement;
      const form = input.closest('form')!;
      fireEvent.change(input, { target: { value: 'Try cancel fail' } });
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Stop Generating' })).toBeDefined();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Stop Generating' }));

      // Cancel error must be visibly displayed in error banner
      await waitFor(() => {
        expect(
          screen.getByText(/Backend cancel service is temporarily unavailable/i)
        ).toBeDefined();
      });

      // No fake stopped assistant message
      expect(screen.queryByText(/Response stopped by user/i)).toBeNull();
    });

    it('bounded polling: first GET returns running, subsequent GET returns stopped', async () => {
      const activeConv: Conversation = {
        id: 'conv_poll_success',
        title: 'Polling Success Test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [activeConv],
        nextCursor: null,
      });
      vi.spyOn(realApiClient, 'getConversation').mockResolvedValue({
        conversation: activeConv,
        messages: [],
      });

      // Cancel returns 202 with running generation
      vi.spyOn(realApiClient, 'cancelGeneration').mockResolvedValue({
        generation: {
          id: 'gen_poll_success',
          conversationId: 'conv_poll_success',
          userMessageId: 'u1',
          modelId: 'giga-chat-default',
          status: 'running',
          partialContent: 'Partial content while running...',
          createdAt: new Date().toISOString(),
        },
      });

      let getGenCallCount = 0;
      const getGenSpy = vi.spyOn(realApiClient, 'getGeneration').mockImplementation(async () => {
        getGenCallCount++;
        if (getGenCallCount === 1) {
          // First GET: still running
          return {
            generation: {
              id: 'gen_poll_success',
              conversationId: 'conv_poll_success',
              userMessageId: 'u1',
              modelId: 'giga-chat-default',
              status: 'running',
              partialContent: 'Partial content while running...',
              createdAt: new Date().toISOString(),
            },
          };
        }
        // Subsequent GET: successfully transitioned to stopped
        return {
          generation: {
            id: 'gen_poll_success',
            conversationId: 'conv_poll_success',
            userMessageId: 'u1',
            modelId: 'giga-chat-default',
            status: 'stopped',
            partialContent: 'Final partial content stopped gracefully.',
            finishReason: 'cancelled',
            createdAt: new Date().toISOString(),
          },
        };
      });

      vi.spyOn(realApiClient, 'streamMessage').mockImplementation(
        async (_convId, _content, onEvent, options) => {
          onEvent({
            event: 'message.started',
            data: {
              messageId: 'm1',
              generationId: 'gen_poll_success',
              conversationId: 'conv_poll_success',
            },
          });
          onEvent({
            event: 'message.delta',
            data: {
              messageId: 'm1',
              generationId: 'gen_poll_success',
              text: 'Streaming...',
            },
          });
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener('abort', () => resolve());
          });
        }
      );

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat/conv_poll_success">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Message Giga/i)).toBeDefined();
      });

      const input = screen.getByPlaceholderText(/Message Giga/i) as HTMLTextAreaElement;
      const form = input.closest('form')!;
      fireEvent.change(input, { target: { value: 'Trigger poll stop' } });
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Stop Generating' })).toBeDefined();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Stop Generating' }));

      // Fallback triggers: first GET returns running, then subsequent GET returns stopped
      await waitFor(
        () => {
          expect(getGenSpy).toHaveBeenCalledTimes(2);
          expect(
            screen.getByText('Final partial content stopped gracefully.')
          ).toBeDefined();
        },
        { timeout: 3000 }
      );

      // Reconciles to stopped cleanly
      expect(screen.queryByRole('button', { name: 'Stop Generating' })).toBeNull();
      expect(screen.queryByText(/AbortError/i)).toBeNull();
    });

    it('bounded polling: generation remains nonterminal beyond the first fallback', async () => {
      const activeConv: Conversation = {
        id: 'conv_stuck_test',
        title: 'Stuck Nonterminal Test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [activeConv],
        nextCursor: null,
      });
      vi.spyOn(realApiClient, 'getConversation').mockResolvedValue({
        conversation: activeConv,
        messages: [],
      });

      vi.spyOn(realApiClient, 'cancelGeneration').mockResolvedValue({
        generation: {
          id: 'gen_stuck',
          conversationId: 'conv_stuck_test',
          userMessageId: 'u1',
          modelId: 'giga-chat-default',
          status: 'running',
          partialContent: 'Server is stuck running...',
          createdAt: new Date().toISOString(),
        },
      });

      // getGeneration always returns running
      const getGenSpy = vi.spyOn(realApiClient, 'getGeneration').mockResolvedValue({
        generation: {
          id: 'gen_stuck',
          conversationId: 'conv_stuck_test',
          userMessageId: 'u1',
          modelId: 'giga-chat-default',
          status: 'running',
          partialContent: 'Server is stuck running...',
          createdAt: new Date().toISOString(),
        },
      });

      vi.spyOn(realApiClient, 'streamMessage').mockImplementation(
        async (_convId, _content, onEvent, options) => {
          onEvent({
            event: 'message.started',
            data: {
              messageId: 'm1',
              generationId: 'gen_stuck',
              conversationId: 'conv_stuck_test',
            },
          });
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener('abort', () => resolve());
          });
        }
      );

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat/conv_stuck_test">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Message Giga/i)).toBeDefined();
      });

      const input = screen.getByPlaceholderText(/Message Giga/i) as HTMLTextAreaElement;
      const form = input.closest('form')!;
      fireEvent.change(input, { target: { value: 'Trigger stuck generation' } });
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Stop Generating' })).toBeDefined();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Stop Generating' }));

      // When retries are exhausted while still running:
      // 1. Visible error banner surfaces with timeout explanation
      await waitFor(
        () => {
          expect(
            screen.getByText(/Generation cancellation is taking longer than expected/i)
          ).toBeDefined();
        },
        { timeout: 3500 }
      );

      // 2. INVARIANT: Never fabricate a stopped state when generation remains nonterminal
      expect(screen.queryByText(/Response stopped by user/i)).toBeNull();
      expect(getGenSpy).toHaveBeenCalled();
    });

    it('cross-conversation fencing: async reconciliation for old conversation does not overwrite new conversation', async () => {
      const conv1: Conversation = {
        id: 'conv_1',
        title: 'Conversation 1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const conv2: Conversation = {
        id: 'conv_2',
        title: 'Conversation 2',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [conv1, conv2],
        nextCursor: null,
      });

      const conv2Msg: Message = {
        id: 'msg_conv2',
        conversationId: 'conv_2',
        role: 'assistant',
        content: 'Hello from Conversation 2',
        createdAt: new Date().toISOString(),
      };

      vi.spyOn(realApiClient, 'getConversation').mockImplementation(async (id) => {
        if (id === 'conv_1') {
          return { conversation: conv1, messages: [] };
        }
        return { conversation: conv2, messages: [conv2Msg] };
      });

      const resolveRef = {
        current: null as ((val: { generation: ChatGeneration }) => void) | null,
      };
      vi.spyOn(realApiClient, 'getGeneration').mockImplementation(
        () =>
          new Promise<{ generation: ChatGeneration }>((resolve) => {
            resolveRef.current = resolve;
          })
      );

      vi.spyOn(realApiClient, 'streamMessage').mockImplementation(
        async (_convId, _content, onEvent) => {
          onEvent({
            event: 'message.started',
            data: { messageId: 'm1', generationId: 'gen_old', conversationId: 'conv_1' },
          });
          // Abrupt disconnect triggers reconciliation
          throw new TypeError('Network error');
        }
      );

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat/conv_1">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Message Giga/i)).toBeDefined();
      });

      const input = screen.getByPlaceholderText(/Message Giga/i) as HTMLTextAreaElement;
      const form = input.closest('form')!;
      fireEvent.change(input, { target: { value: 'Query on conv 1' } });
      fireEvent.submit(form);

      // Now user clicks on Conversation 2 in the sidebar
      await waitFor(() => {
        expect(screen.getByText('Conversation 2')).toBeDefined();
      });
      fireEvent.click(screen.getByText('Conversation 2'));

      // In Conversation 2, message from conv 2 is displayed
      await waitFor(() => {
        expect(screen.getByText('Hello from Conversation 2')).toBeDefined();
      });

      // Now resolve the old getGeneration for conv 1 with completed status
      resolveRef.current?.({
        generation: {
          id: 'gen_old',
          conversationId: 'conv_1',
          userMessageId: 'u1',
          modelId: 'giga-chat-default',
          status: 'completed',
          partialContent: 'Stale conv 1 answer that should NOT appear in conv 2',
          createdAt: new Date().toISOString(),
        },
      });

      // Give event loop time to settle
      await new Promise((r) => setTimeout(r, 100));

      // Assert conv 2's message is preserved and stale conv 1 message never leaked into conv 2!
      expect(screen.getByText('Hello from Conversation 2')).toBeDefined();
      expect(
        screen.queryByText('Stale conv 1 answer that should NOT appear in conv 2')
      ).toBeNull();
    });

    it('fencing stale history: response for conversation A resolving after conversation B does not overwrite B', async () => {
      const convA: Conversation = {
        id: 'conv_a',
        title: 'Conversation A',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const convB: Conversation = {
        id: 'conv_b',
        title: 'Conversation B',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [convA, convB],
        nextCursor: null,
      });

      const messageA: Message = {
        id: 'msg_a',
        conversationId: 'conv_a',
        role: 'assistant',
        content: 'Historical message from Conversation A',
        createdAt: new Date().toISOString(),
      };
      const messageB: Message = {
        id: 'msg_b',
        conversationId: 'conv_b',
        role: 'assistant',
        content: 'Historical message from Conversation B',
        createdAt: new Date().toISOString(),
      };

      const resolveRef = {
        current: null as ((val: { conversation: Conversation; messages: Message[] }) => void) | null,
      };
      vi.spyOn(realApiClient, 'getConversation').mockImplementation(async (id: string) => {
        if (id === 'conv_a') {
          return new Promise<{ conversation: Conversation; messages: Message[] }>((resolve) => {
            resolveRef.current = resolve;
          });
        }
        if (id === 'conv_b') {
          return { conversation: convB, messages: [messageB] };
        }
        return { conversation: convA, messages: [] };
      });

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat/conv_a">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      // Verify Conversation B appears in sidebar
      await waitFor(() => {
        expect(screen.getByText('Conversation B')).toBeDefined();
      });

      // User navigates from Conversation A to Conversation B while A's history fetch is still in-flight
      fireEvent.click(screen.getByText('Conversation B'));

      // In Conversation B, B's messages resolve immediately and render
      await waitFor(() => {
        expect(screen.getByText('Historical message from Conversation B')).toBeDefined();
      });

      // Now, Conversation A's deferred history request resolves late
      resolveRef.current?.({ conversation: convA, messages: [messageA] });

      // Give event loop time to settle
      await new Promise((r) => setTimeout(r, 60));

      // Assert B's messages remain in view and A's stale response did not overwrite B
      expect(screen.getByText('Historical message from Conversation B')).toBeDefined();
      expect(screen.queryByText('Historical message from Conversation A')).toBeNull();
    });

    it('fencing stale history failures: failure loading conversation A after user navigated to conversation B does not clear B or display error', async () => {
      const convA: Conversation = {
        id: 'conv_a',
        title: 'Conversation A',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const convB: Conversation = {
        id: 'conv_b',
        title: 'Conversation B',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [convA, convB],
        nextCursor: null,
      });

      const messageB: Message = {
        id: 'msg_b',
        conversationId: 'conv_b',
        role: 'assistant',
        content: 'Active messages for Conversation B',
        createdAt: new Date().toISOString(),
      };

      const rejectRef = {
        current: null as ((err: unknown) => void) | null,
      };
      vi.spyOn(realApiClient, 'getConversation').mockImplementation(async (id: string) => {
        if (id === 'conv_a') {
          return new Promise<{ conversation: Conversation; messages: Message[] }>((_resolve, reject) => {
            rejectRef.current = reject;
          });
        }
        if (id === 'conv_b') {
          return { conversation: convB, messages: [messageB] };
        }
        return { conversation: convA, messages: [] };
      });

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat/conv_a">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByText('Conversation B')).toBeDefined();
      });

      // Navigate to Conversation B
      fireEvent.click(screen.getByText('Conversation B'));

      await waitFor(() => {
        expect(screen.getByText('Active messages for Conversation B')).toBeDefined();
      });

      // Now Conversation A fails with network error
      rejectRef.current?.(new ApiException(500, 'INTERNAL_SERVER_ERROR', 'Conversation A history unavailable'));

      // Wait for microtasks
      await new Promise((r) => setTimeout(r, 60));

      // Assert Conversation B's messages are still displayed and no error banner for Conversation A appears
      expect(screen.getByText('Active messages for Conversation B')).toBeDefined();
      expect(screen.queryByText(/Conversation A history unavailable/i)).toBeNull();
    });

    it('fencing stale history: works identically in mock mode when navigating between conversations', async () => {
      const convA: Conversation = {
        id: 'conv_a',
        title: 'Conversation A',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const convB: Conversation = {
        id: 'conv_b',
        title: 'Conversation B',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(mockDataAdapter, 'listConversations').mockResolvedValue({
        items: [convA, convB],
        nextCursor: null,
      });

      const messageA: Message = {
        id: 'msg_mock_a',
        conversationId: 'conv_a',
        role: 'assistant',
        content: 'Mock message from Conversation A',
        createdAt: new Date().toISOString(),
      };
      const messageB: Message = {
        id: 'msg_mock_b',
        conversationId: 'conv_b',
        role: 'assistant',
        content: 'Mock message from Conversation B',
        createdAt: new Date().toISOString(),
      };

      const resolveMockRef = {
        current: null as ((val: { conversation: Conversation; messages: Message[] }) => void) | null,
      };
      vi.spyOn(mockDataAdapter, 'getConversation').mockImplementation(async (id: string) => {
        if (id === 'conv_a') {
          return new Promise<{ conversation: Conversation; messages: Message[] }>((resolve) => {
            resolveMockRef.current = resolve;
          });
        }
        if (id === 'conv_b') {
          return { conversation: convB, messages: [messageB] };
        }
        return { conversation: convA, messages: [] };
      });

      render(
        <ApiModeProvider initialMode="mock">
          <AuthProvider>
            <RouterProvider initialPath="/chat/conv_a">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByText('Conversation B')).toBeDefined();
      });

      // Navigate to Conversation B
      fireEvent.click(screen.getByText('Conversation B'));

      await waitFor(() => {
        expect(screen.getByText('Mock message from Conversation B')).toBeDefined();
      });

      // Conversation A resolves late
      resolveMockRef.current?.({ conversation: convA, messages: [messageA] });

      await new Promise((r) => setTimeout(r, 60));

      // Assert B's messages remain visible and A's message is not rendered
      expect(screen.getByText('Mock message from Conversation B')).toBeDefined();
      expect(screen.queryByText('Mock message from Conversation A')).toBeNull();
    });

    it('repeated getGeneration failures: frontend does not conclude terminal or clear tracking ID', async () => {
      const activeConv: Conversation = {
        id: 'conv_err_test',
        title: 'Error Recovery Test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [activeConv],
        nextCursor: null,
      });
      vi.spyOn(realApiClient, 'getConversation').mockResolvedValue({
        conversation: activeConv,
        messages: [],
      });

      const cancelSpy = vi.spyOn(realApiClient, 'cancelGeneration').mockResolvedValue({
        generation: {
          id: 'gen_flaky',
          conversationId: 'conv_err_test',
          userMessageId: 'u1',
          modelId: 'giga-chat-default',
          status: 'stopped',
          partialContent: '',
          createdAt: new Date().toISOString(),
        },
      });

      // getGeneration always fails with 500 error
      const getGenSpy = vi.spyOn(realApiClient, 'getGeneration').mockRejectedValue(
        new ApiException(500, 'INTERNAL_SERVER_ERROR', 'Service temporarily unavailable')
      );

      vi.spyOn(realApiClient, 'streamMessage').mockImplementation(
        async (_convId, _content, onEvent) => {
          onEvent({
            event: 'message.started',
            data: { messageId: 'm1', generationId: 'gen_flaky', conversationId: 'conv_err_test' },
          });
          onEvent({
            event: 'message.delta',
            data: { messageId: 'm1', generationId: 'gen_flaky', text: 'Partial text before glitch...' },
          });
          // Abrupt stream error triggers authoritative reconciliation
          throw new TypeError('Network connection reset');
        }
      );

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat/conv_err_test">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Message Giga/i)).toBeDefined();
      });

      const input = screen.getByPlaceholderText(/Message Giga/i) as HTMLTextAreaElement;
      const form = input.closest('form')!;
      fireEvent.change(input, { target: { value: 'Trigger flaky reconciliation' } });
      fireEvent.submit(form);

      // When retries are exhausted for getGeneration failures:
      // 1. Error alert is shown
      await waitFor(
        () => {
          expect(
            screen.getByText(/Unable to verify generation gen_flaky status/i)
          ).toBeDefined();
        },
        { timeout: 3500 }
      );

      // 2. INVARIANT: Does NOT conclude terminal or add a fake terminal message
      expect(screen.queryByText(/Generation failed/i)).toBeNull();
      expect(getGenSpy).toHaveBeenCalled();

      // 3. INVARIANT: Tracking ID is preserved and allows Retry Stop / Retry Status Check
      const retryStopBtn = screen.getByRole('button', { name: /Retry Stop/i });
      expect(retryStopBtn).toBeDefined();
      expect(screen.getByRole('button', { name: /Retry Status Check/i })).toBeDefined();

      // Clicking Retry Stop uses preserved activeGenerationIdRef to cancel generation
      fireEvent.click(retryStopBtn);
      await waitFor(() => {
        expect(cancelSpy).toHaveBeenCalledWith('conv_err_test', 'gen_flaky');
      });
    });

    it('lifecycle fencing: late completion of generation A does not clear tracking ID or corrupt lifecycle of generation B', async () => {
      const activeConv: Conversation = {
        id: 'conv_seq_test',
        title: 'Sequential Generation Lifecycle Test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [activeConv],
        nextCursor: null,
      });

      const resolveConvARef = {
        current: null as ((val: { conversation: Conversation; messages: Message[] }) => void) | null,
      };

      let getConvCall = 0;
      vi.spyOn(realApiClient, 'getConversation').mockImplementation(async () => {
        getConvCall++;
        if (getConvCall === 1) {
          // Initial conversation load
          return { conversation: activeConv, messages: [] };
        }
        if (getConvCall === 2) {
          // Delay Generation A authoritative reconciliation
          return new Promise<{ conversation: Conversation; messages: Message[] }>((resolve) => {
            resolveConvARef.current = resolve;
          });
        }
        return { conversation: activeConv, messages: [] };
      });

      const cancelSpy = vi.spyOn(realApiClient, 'cancelGeneration').mockResolvedValue({
        generation: {
          id: 'gen_B',
          conversationId: 'conv_seq_test',
          userMessageId: 'u2',
          modelId: 'giga-chat-default',
          status: 'stopped',
          partialContent: '',
          createdAt: new Date().toISOString(),
        },
      });

      let streamCall = 0;
      vi.spyOn(realApiClient, 'streamMessage').mockImplementation(
        async (_convId, _content, onEvent, options) => {
          streamCall++;
          if (streamCall === 1) {
            // Generation A
            onEvent({
              event: 'message.started',
              data: { messageId: 'mA', generationId: 'gen_A', conversationId: 'conv_seq_test' },
            });
            onEvent({
              event: 'message.delta',
              data: { messageId: 'mA', generationId: 'gen_A', text: 'Answer for Question A' },
            });
            onEvent({
              event: 'message.completed',
              data: { messageId: 'mA', generationId: 'gen_A' },
            });
            return;
          }

          // Generation B
          onEvent({
            event: 'message.started',
            data: { messageId: 'mB', generationId: 'gen_B', conversationId: 'conv_seq_test' },
          });
          onEvent({
            event: 'message.delta',
            data: { messageId: 'mB', generationId: 'gen_B', text: 'Streaming answer for Question B...' },
          });
          // Generation B stays active and waits for abort
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener('abort', () => resolve());
          });
        }
      );

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat/conv_seq_test">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Message Giga/i)).toBeDefined();
      });

      const input = screen.getByPlaceholderText(/Message Giga/i) as HTMLTextAreaElement;
      const form = input.closest('form')!;

      // 1. Submit Generation A
      fireEvent.change(input, { target: { value: 'Question A' } });
      fireEvent.submit(form);

      // Verify Generation A completed locally
      await waitFor(() => {
        expect(screen.getByText('Answer for Question A')).toBeDefined();
      });

      // At this point, Generation A's getConversation reconciliation is still pending in resolveConvARef

      // 2. Submit Generation B while Generation A's getConversation is still in-flight
      fireEvent.change(input, { target: { value: 'Question B' } });
      fireEvent.submit(form);

      // Verify Generation B is actively streaming and Stop Generating button is rendered
      await waitFor(() => {
        expect(screen.getByText('Streaming answer for Question B...')).toBeDefined();
        expect(screen.getByRole('button', { name: 'Stop Generating' })).toBeDefined();
      });

      // 3. Now Generation A's delayed getConversation resolves late
      resolveConvARef.current?.({
        conversation: activeConv,
        messages: [
          {
            id: 'persisted_user_A',
            conversationId: 'conv_seq_test',
            role: 'user',
            content: 'Question A',
            createdAt: new Date().toISOString(),
          },
          {
            id: 'persisted_mA',
            conversationId: 'conv_seq_test',
            role: 'assistant',
            content: 'Answer for Question A',
            createdAt: new Date().toISOString(),
            status: 'completed',
          },
        ],
      });

      // Give event loop time to process Generation A's promise settlement
      await new Promise((r) => setTimeout(r, 60));

      // 4. INVARIANT: Generation B's active ID was NOT wiped by Generation A's .finally()!
      // Generation B streaming text is still displayed and Stop Generating is still active
      expect(screen.getByText('Streaming answer for Question B...')).toBeDefined();
      const stopBtn = screen.getByRole('button', { name: 'Stop Generating' });
      expect(stopBtn).toBeDefined();

      // 5. User clicks Stop for Generation B -> cancelGeneration MUST be called with gen_B!
      fireEvent.click(stopBtn);
      await waitFor(() => {
        expect(cancelSpy).toHaveBeenCalledWith('conv_seq_test', 'gen_B');
      });
    });

    it('fencing conversation creation: starting from /chat creates conversation and preserves optimistic user turn', async () => {
      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [],
        nextCursor: null,
      });

      const newConv: Conversation = {
        id: 'conv_from_scratch',
        title: 'First Question on Giga',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(realApiClient, 'createConversation').mockResolvedValue({
        conversation: newConv,
      });

      // Initial getConversation before message is persisted returns []
      vi.spyOn(realApiClient, 'getConversation').mockResolvedValue({
        conversation: newConv,
        messages: [],
      });

      vi.spyOn(realApiClient, 'streamMessage').mockImplementation(
        async (_convId, _content, onEvent) => {
          onEvent({
            event: 'message.started',
            data: {
              messageId: 'm_ans',
              generationId: 'gen_first',
              conversationId: 'conv_from_scratch',
            },
          });
          onEvent({
            event: 'message.delta',
            data: { messageId: 'm_ans', generationId: 'gen_first', text: 'Answer streaming...' },
          });
          onEvent({
            event: 'message.completed',
            data: { messageId: 'm_ans', generationId: 'gen_first' },
          });
        }
      );

      render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Message Giga/i)).toBeDefined();
      });

      const input = screen.getByPlaceholderText(/Message Giga/i) as HTMLTextAreaElement;
      const form = input.closest('form')!;
      fireEvent.change(input, { target: { value: 'First Question on Giga' } });
      fireEvent.submit(form);

      // Optimistic user turn MUST be visible and NOT wiped out by route change to /chat/conv_from_scratch
      await waitFor(() => {
        expect(screen.getByText('First Question on Giga')).toBeDefined();
      });

      await waitFor(() => {
        expect(screen.getByText('Answer streaming...')).toBeDefined();
      });
    });

    it('resets stream and aborts signal when switching mode while stream is running', async () => {
      let aborted = false;
      vi.spyOn(realApiClient, 'listConversations').mockResolvedValue({
        items: [
          {
            id: 'conv_mode_switch',
            title: 'Mode Switch Test',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        nextCursor: null,
      });
      vi.spyOn(realApiClient, 'getConversation').mockResolvedValue({
        conversation: {
          id: 'conv_mode_switch',
          title: 'Mode Switch Test',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        messages: [],
      });

      vi.spyOn(realApiClient, 'streamMessage').mockImplementation(
        async (_convId, _content, onEvent, options) => {
          onEvent({
            event: 'message.started',
            data: { messageId: 'm1', generationId: 'g1', conversationId: 'conv_mode_switch' },
          });
          options?.signal?.addEventListener('abort', () => {
            aborted = true;
          });
          await new Promise(() => {}); // never resolves
        }
      );

      const { unmount } = render(
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/chat/conv_mode_switch">
              <ChatView />
            </RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Message Giga/i)).toBeDefined();
      });

      const input = screen.getByPlaceholderText(/Message Giga/i) as HTMLTextAreaElement;
      const form = input.closest('form')!;
      fireEvent.change(input, { target: { value: 'Long running stream' } });
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Stop/i })).toBeDefined();
      });

      // Unmount component
      unmount();

      expect(aborted).toBe(true);
    });
  });
});
