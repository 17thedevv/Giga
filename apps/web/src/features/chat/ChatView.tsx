import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from '../../app/router.js';
import { useApiMode } from '../../app/context/ApiModeContext.js';
import type { Conversation, Message } from '../../lib/api/types.js';
import { realApiClient, ApiException } from '../../lib/api/client.js';
import { mockDataAdapter } from '../../lib/api/mock-adapter.js';
import { ConversationSidebar } from './ConversationSidebar.js';
import { MessageBubble } from './MessageBubble.js';
import { Composer } from './Composer.js';
import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { GigaLogo } from '../../components/GigaLogo.js';

export const ChatView: React.FC = () => {
  const { params, navigate } = useRouter();
  const { mode } = useApiMode();
  const conversationId = params.conversationId;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isMessagesLoading, setIsMessagesLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const accumulatedTextRef = useRef('');
  const activeGenerationIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll helper
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingText]);

  // Cleanup abort controller on component unmount or mode switch
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // When API mode switches, abort ongoing stream and reset state
  useEffect(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsStreaming(false);
    setStreamingText('');
    accumulatedTextRef.current = '';
    activeGenerationIdRef.current = null;
    setErrorBanner(null);
  }, [mode]);

  // Load conversations list
  const loadConversations = useCallback(async () => {
    setIsLoading(true);
    setErrorBanner(null);
    try {
      if (mode === 'real') {
        const res = await realApiClient.listConversations();
        setConversations(res.items);
        if (!conversationId && res.items.length > 0) {
          navigate(`/chat/${res.items[0].id}`);
        }
      } else {
        const res = await mockDataAdapter.listConversations();
        setConversations(res.items);
        if (!conversationId && res.items.length > 0) {
          navigate(`/chat/${res.items[0].id}`);
        }
      }
    } catch (err: unknown) {
      // Never fallback to mock mode silently; surface error clearly
      const message =
        err instanceof ApiException
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to load conversations';
      setErrorBanner(message);
      setConversations([]);
    } finally {
      setIsLoading(false);
    }
  }, [mode, conversationId, navigate]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Load specific conversation messages
  const loadMessages = useCallback(
    async (id: string) => {
      setIsMessagesLoading(true);
      try {
        if (mode === 'real') {
          const res = await realApiClient.getConversation(id);
          setMessages(res.messages);
        } else {
          const res = await mockDataAdapter.getConversation(id);
          setMessages(res.messages);
        }
      } catch (err: unknown) {
        const message =
          err instanceof ApiException
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to load conversation messages';
        setErrorBanner(message);
        setMessages([]);
      } finally {
        setIsMessagesLoading(false);
      }
    },
    [mode]
  );

  useEffect(() => {
    if (conversationId) {
      loadMessages(conversationId);
    } else {
      setMessages([]);
    }
  }, [conversationId, loadMessages]);

  const handleCreateConversation = async () => {
    try {
      if (mode === 'real') {
        const res = await realApiClient.createConversation();
        setConversations((prev) => [res.conversation, ...prev]);
        navigate(`/chat/${res.conversation.id}`);
      } else {
        const res = await mockDataAdapter.createConversation('New Architecture Discussion');
        setConversations((prev) => [res.conversation, ...prev]);
        navigate(`/chat/${res.conversation.id}`);
      }
    } catch (err: unknown) {
      const message =
        err instanceof ApiException
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to create conversation';
      setErrorBanner(message);
    }
  };

  const handleDeleteConversation = async (id: string) => {
    try {
      if (mode === 'real') {
        await realApiClient.deleteConversation(id);
      } else {
        await mockDataAdapter.deleteConversation(id);
      }
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (conversationId === id) {
        navigate('/chat');
      }
    } catch (err: unknown) {
      const message =
        err instanceof ApiException
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to delete conversation';
      setErrorBanner(message);
    }
  };

  const handleSendMessage = async (content: string) => {
    // Prevent double-submit while an active stream is ongoing
    if (isStreaming) return;

    let targetConvId = conversationId;
    if (!targetConvId) {
      try {
        const titleSnippet = content.trim().slice(0, 32);
        if (mode === 'real') {
          const newConv = await realApiClient.createConversation(titleSnippet);
          setConversations((prev) => [newConv.conversation, ...prev]);
          targetConvId = newConv.conversation.id;
          navigate(`/chat/${targetConvId}`);
        } else {
          const newConv = await mockDataAdapter.createConversation(titleSnippet);
          setConversations((prev) => [newConv.conversation, ...prev]);
          targetConvId = newConv.conversation.id;
          navigate(`/chat/${targetConvId}`);
        }
      } catch (err: unknown) {
        const message =
          err instanceof ApiException
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to initialize conversation';
        setErrorBanner(message);
        return;
      }
    }

    // Provision optimistic user message turn
    const tempUserMsgId = `opt_${Date.now()}`;
    const optimisticMsg: Message = {
      id: tempUserMsgId,
      conversationId: targetConvId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      isOptimistic: true,
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    setIsStreaming(true);
    setStreamingText('');
    accumulatedTextRef.current = '';
    activeGenerationIdRef.current = null;
    abortControllerRef.current = new AbortController();

    if (mode === 'real') {
      try {
        await realApiClient.streamMessage(
          targetConvId,
          content,
          (event) => {
            if (event.event === 'message.started') {
              activeGenerationIdRef.current = event.data.generationId;
            } else if (event.event === 'message.delta') {
              accumulatedTextRef.current += event.data.text;
              setStreamingText(accumulatedTextRef.current);
            } else if (event.event === 'message.completed') {
              const fullText = accumulatedTextRef.current;
              setIsStreaming(false);
              setStreamingText('');
              accumulatedTextRef.current = '';

              // Reconcile messages from backend to prevent duplicate optimistic messages
              realApiClient
                .getConversation(targetConvId!)
                .then((convRes) => {
                  setMessages(convRes.messages);
                })
                .catch(() => {
                  setMessages((prev) => {
                    const withoutOpt = prev.filter((m) => m.id !== tempUserMsgId);
                    return [
                      ...withoutOpt,
                      { ...optimisticMsg, isOptimistic: false },
                      {
                        id: event.data.messageId,
                        conversationId: targetConvId!,
                        role: 'assistant',
                        content: fullText,
                        createdAt: event.data.createdAt || new Date().toISOString(),
                        status: 'completed',
                      },
                    ];
                  });
                });
            } else if (event.event === 'stream.error' || event.event === 'message.failed') {
              setIsStreaming(false);
              const partial = accumulatedTextRef.current;
              setStreamingText('');
              accumulatedTextRef.current = '';
              setErrorBanner(event.data.error?.message || 'Chat generation failed');
              if (partial) {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: event.data.messageId || `fail_${Date.now()}`,
                    conversationId: targetConvId!,
                    role: 'assistant',
                    content: partial,
                    createdAt: new Date().toISOString(),
                    status: 'failed',
                  },
                ]);
              }
            } else if (event.event === 'message.stopped') {
              setIsStreaming(false);
              setStreamingText('');
              accumulatedTextRef.current = '';
            }
          },
          { signal: abortControllerRef.current.signal }
        );
      } catch (err: unknown) {
        setIsStreaming(false);
        setStreamingText('');
        accumulatedTextRef.current = '';
        const errMsg =
          err instanceof ApiException
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Stream error';
        setErrorBanner(errMsg);
      }
    } else {
      // Mock mode: maintain backward-compatible simulation for existing regression tests
      let accumulated = '';
      try {
        await mockDataAdapter.simulateChatStream(
          content,
          (chunk) => {
            accumulated += chunk;
            accumulatedTextRef.current = accumulated;
            setStreamingText(accumulated);
          },
          async () => {
            const fullText = accumulated.trim();
            setIsStreaming(false);
            setStreamingText('');
            accumulatedTextRef.current = '';
            if (fullText) {
              const assistantMsg = await mockDataAdapter.addMessage(
                targetConvId!,
                'assistant',
                fullText
              );
              setMessages((prev) => {
                const withoutOpt = prev.filter((m) => m.id !== tempUserMsgId);
                return [...withoutOpt, { ...optimisticMsg, isOptimistic: false }, assistantMsg];
              });
            }
          },
          abortControllerRef.current.signal
        );
      } catch (err) {
        setIsStreaming(false);
        setStreamingText('');
        accumulatedTextRef.current = '';
        setErrorBanner(err instanceof Error ? err.message : 'Stream error');
      }
    }
  };

  const handleStopStreaming = () => {
    if (mode === 'real') {
      if (activeGenerationIdRef.current && conversationId) {
        realApiClient
          .cancelGeneration(conversationId, activeGenerationIdRef.current)
          .catch(() => {});
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      setIsStreaming(false);
      setStreamingText('');
      accumulatedTextRef.current = '';
      activeGenerationIdRef.current = null;
    } else {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const stoppedPartial = accumulatedTextRef.current.trim();
      const targetId = conversationId;
      if (stoppedPartial && targetId) {
        const stoppedText = stoppedPartial + '\n\n*[Response stopped by user]*';
        mockDataAdapter.addMessage(targetId, 'assistant', stoppedText).then((msg) => {
          setMessages((prev) => [...prev, msg]);
        });
      }
      accumulatedTextRef.current = '';
      setIsStreaming(false);
      setStreamingText('');
    }
  };

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%' }}>
      {/* Sidebar with discussions list */}
      <ConversationSidebar
        conversations={conversations}
        activeId={conversationId}
        onSelect={(id) => navigate(`/chat/${id}`)}
        onCreate={handleCreateConversation}
        onDelete={handleDeleteConversation}
        isLoading={isLoading}
      />

      {/* Main Chat Workspace */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          height: '100%',
          backgroundColor: 'var(--giga-bg, #0B1220)',
          minWidth: 0,
        }}
      >
        {/* Banner notification for Mock Mode */}
        {mode === 'mock' && (
          <div
            style={{
              padding: '8px 16px',
              backgroundColor: 'rgba(217, 119, 6, 0.12)',
              borderBottom: '1px solid rgba(217, 119, 6, 0.25)',
              fontSize: '12px',
              color: 'var(--giga-warning, #D97706)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span>
              <strong>[DEMO / MOCK MODE]:</strong> Chat interactions are powered by local fixtures for UI validation. No real LLM tokens are consumed.
            </span>
          </div>
        )}

        {/* Error Alert Banner */}
        {errorBanner && (
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--giga-border, #1E293B)' }}>
            <Alert
              type="error"
              title={mode === 'real' ? 'Chat API Error' : 'Notice'}
              message={errorBanner}
              onDismiss={() => setErrorBanner(null)}
            />
          </div>
        )}

        {/* Message Feed */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 20px', display: 'flex', flexDirection: 'column' }}>
          {isMessagesLoading && messages.length === 0 && (
            <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--giga-text-muted, #94A3B8)', fontSize: '13px' }}>
              Loading message history...
            </div>
          )}

          {!isMessagesLoading && messages.length === 0 && !isStreaming && (
            <div
              className="g-empty"
              style={{
                margin: 'auto',
                textAlign: 'center',
                maxWidth: '480px',
                padding: '32px 16px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                <GigaLogo variant="mark" tone="color" width={48} />
              </div>
              <h2 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)', marginBottom: '8px' }}>
                Welcome to GIGA Developer Chat
              </h2>
              <p style={{ fontSize: '13px', lineHeight: 1.6, marginBottom: '20px', color: 'var(--giga-text-secondary, #94A3B8)' }}>
                Explore codebase architecture, troubleshoot cloud deployments, or delegate autonomous coding tasks.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleSendMessage('Explain how Giga handles human approvals for GitHub writes')}
                >
                  "Explain how Giga handles human approvals for GitHub writes"
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleSendMessage('Review Neon PostgreSQL connection pool settings in Hono')}
                >
                  "Review Neon PostgreSQL connection pool settings in Hono"
                </Button>
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          {/* Active streaming bubble */}
          {isStreaming && streamingText && (
            <MessageBubble
              message={{
                id: 'streaming_msg',
                conversationId: conversationId || 'active',
                role: 'assistant',
                content: streamingText,
                createdAt: new Date().toISOString(),
              }}
              isStreaming={true}
            />
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Composer */}
        <Composer
          onSend={handleSendMessage}
          onStop={handleStopStreaming}
          isStreaming={isStreaming}
          disabled={false}
        />
      </div>
    </div>
  );
};
