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

const MAX_POLL_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 150;
const STOP_FALLBACK_TIMEOUT_MS = 600;

const isTerminalStatus = (status: string): boolean => {
  return (
    status === 'completed' ||
    status === 'stopped' ||
    status === 'failed' ||
    status === 'interrupted'
  );
};

export const ChatView: React.FC = () => {
  const { params, navigate } = useRouter();
  const { mode } = useApiMode();
  const conversationId = params.conversationId;

  const conversationIdRef = useRef<string | undefined>(conversationId);
  conversationIdRef.current = conversationId;

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
  const isStoppingRef = useRef(false);
  const createdConversationIdRef = useRef<string | null>(null);
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll helper
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingText]);

  // Cleanup abort controller on component unmount
  useEffect(() => {
    return () => {
      if (stopTimeoutRef.current) {
        clearTimeout(stopTimeoutRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // When API mode switches, abort ongoing stream and reset state
  useEffect(() => {
    if (stopTimeoutRef.current) {
      clearTimeout(stopTimeoutRef.current);
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsStreaming(false);
    setStreamingText('');
    accumulatedTextRef.current = '';
    activeGenerationIdRef.current = null;
    isStoppingRef.current = false;
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
        if (
          !conversationIdRef.current &&
          !createdConversationIdRef.current &&
          res.items.length > 0
        ) {
          navigate(`/chat/${res.items[0].id}`);
        }
      } else {
        const res = await mockDataAdapter.listConversations();
        setConversations(res.items);
        if (
          !conversationIdRef.current &&
          !createdConversationIdRef.current &&
          res.items.length > 0
        ) {
          navigate(`/chat/${res.items[0].id}`);
        }
      }
    } catch (err: unknown) {
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

  // Authoritative reconciliation via GET generation
  const reconcileAuthoritativeGeneration = useCallback(
    async (
      targetConvId: string,
      generationId: string,
      fallbackErrorMsg?: string,
      localPartial?: string,
      attempt: number = 0
    ): Promise<boolean> => {
      // Invariant 5: Fencing across conversation navigation and newer generations
      if (
        conversationIdRef.current !== targetConvId ||
        activeGenerationIdRef.current !== generationId
      ) {
        return false;
      }

      try {
        const { generation } = await realApiClient.getGeneration(targetConvId, generationId);

        // Re-check fencing after asynchronous getGeneration call
        if (
          conversationIdRef.current !== targetConvId ||
          activeGenerationIdRef.current !== generationId
        ) {
          return false;
        }

        if (isTerminalStatus(generation.status)) {
          // Fetch authoritative conversation messages from backend
          const convRes = await realApiClient.getConversation(targetConvId).catch(() => null);

          // Re-check fencing after getConversation
          if (
            conversationIdRef.current !== targetConvId ||
            activeGenerationIdRef.current !== generationId
          ) {
            return false;
          }

          if (generation.status === 'completed') {
            // Completed won the race! Accept completed as winner
            if (convRes && convRes.messages.some((m) => m.role === 'assistant')) {
              setMessages(convRes.messages);
            } else {
              setMessages((prev) => {
                const withoutOpt = prev.filter((m) => !m.isOptimistic);
                return [
                  ...withoutOpt,
                  {
                    id: generation.assistantMessageId || `msg_${generation.id}`,
                    conversationId: targetConvId,
                    role: 'assistant',
                    content: generation.partialContent || localPartial || '',
                    createdAt: generation.finishedAt || new Date().toISOString(),
                    status: 'completed',
                  },
                ];
              });
            }
            setErrorBanner(null);
          } else if (generation.status === 'stopped') {
            // Intentional durable stop confirmed
            if (convRes && convRes.messages.some((m) => m.role === 'assistant')) {
              setMessages(convRes.messages);
            } else if (generation.partialContent || localPartial) {
              setMessages((prev) => [
                ...prev.filter((m) => !m.isOptimistic),
                {
                  id: generation.assistantMessageId || `stop_${generation.id}`,
                  conversationId: targetConvId,
                  role: 'assistant',
                  content: generation.partialContent || localPartial || '',
                  createdAt: generation.finishedAt || new Date().toISOString(),
                  status: 'stopped',
                },
              ]);
            }
            setErrorBanner(null);
          } else if (generation.status === 'failed' || generation.status === 'interrupted') {
            if (convRes && convRes.messages.some((m) => m.role === 'assistant')) {
              setMessages(convRes.messages);
            } else if (generation.partialContent || localPartial) {
              setMessages((prev) => [
                ...prev.filter((m) => !m.isOptimistic),
                {
                  id: `fail_${generation.id}`,
                  conversationId: targetConvId,
                  role: 'assistant',
                  content: generation.partialContent || localPartial || '',
                  createdAt: generation.finishedAt || new Date().toISOString(),
                  status: 'failed',
                },
              ]);
            }
            // Only show error if user didn't intentionally stop
            if (!isStoppingRef.current) {
              const serverError =
                generation.error?.message || fallbackErrorMsg || 'Generation failed';
              setErrorBanner(serverError);
            }
          }

          // Terminal reached: clean up active generation ID, stopping flags, and stream UI
          activeGenerationIdRef.current = null;
          isStoppingRef.current = false;
          setIsStreaming(false);
          setStreamingText('');
          accumulatedTextRef.current = '';
          return true;
        }

        // Status is nonterminal ('running' | 'queued' | 'pending' | 'streaming')
        // Invariant 1 & 4: Preserve activeGenerationIdRef.current, NEVER fabricate stopped state!
        if (attempt < MAX_POLL_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          if (
            conversationIdRef.current !== targetConvId ||
            activeGenerationIdRef.current !== generationId
          ) {
            return false;
          }
          return reconcileAuthoritativeGeneration(
            targetConvId,
            generationId,
            fallbackErrorMsg,
            localPartial || generation.partialContent,
            attempt + 1
          );
        }

        // Bounded retries exhausted while generation remains nonterminal
        // Invariant 3: Visible recovery/error handling with clear timeout notice
        setErrorBanner(
          `Generation cancellation is taking longer than expected. Generation ${generationId} remains ${generation.status} on server.`
        );
        setIsStreaming(false);
        // Invariant 1: Preserve active generation ID
        return false;
      } catch {
        if (
          conversationIdRef.current !== targetConvId ||
          activeGenerationIdRef.current !== generationId
        ) {
          return false;
        }

        if (attempt < MAX_POLL_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          if (
            conversationIdRef.current !== targetConvId ||
            activeGenerationIdRef.current !== generationId
          ) {
            return false;
          }
          return reconcileAuthoritativeGeneration(
            targetConvId,
            generationId,
            fallbackErrorMsg,
            localPartial,
            attempt + 1
          );
        }

        if (localPartial) {
          setMessages((prev) => [
            ...prev,
            {
              id: `fail_${generationId}`,
              conversationId: targetConvId,
              role: 'assistant',
              content: localPartial,
              createdAt: new Date().toISOString(),
              status: 'failed',
            },
          ]);
        }
        if (fallbackErrorMsg && !isStoppingRef.current) {
          setErrorBanner(fallbackErrorMsg);
        }
        setIsStreaming(false);
        activeGenerationIdRef.current = null;
        isStoppingRef.current = false;
        return false;
      }
    },
    []
  );

  // Load specific conversation messages
  const loadMessages = useCallback(
    async (id: string) => {
      // If this conversation was just created in this view with active/pending optimistic message,
      // skip resetting messages so we don't wipe out the optimistic user turn
      if (createdConversationIdRef.current === id) {
        return;
      }

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
      if (createdConversationIdRef.current !== conversationId) {
        loadMessages(conversationId);
      }
    } else {
      createdConversationIdRef.current = null;
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
          createdConversationIdRef.current = newConv.conversation.id;
          setConversations((prev) => [newConv.conversation, ...prev]);
          targetConvId = newConv.conversation.id;
          navigate(`/chat/${targetConvId}`);
        } else {
          const newConv = await mockDataAdapter.createConversation(titleSnippet);
          createdConversationIdRef.current = newConv.conversation.id;
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
    isStoppingRef.current = false;
    abortControllerRef.current = new AbortController();

    if (mode === 'real') {
      try {
        await realApiClient.streamMessage(
          targetConvId,
          content,
          async (event) => {
            if (event.event === 'message.started') {
              activeGenerationIdRef.current = event.data.generationId;
            } else if (event.event === 'message.delta') {
              accumulatedTextRef.current += event.data.text;
              setStreamingText(accumulatedTextRef.current);
            } else if (event.event === 'message.completed') {
              if (stopTimeoutRef.current) {
                clearTimeout(stopTimeoutRef.current);
                stopTimeoutRef.current = null;
              }
              const fullText = accumulatedTextRef.current;
              setIsStreaming(false);
              setStreamingText('');
              accumulatedTextRef.current = '';

              // Reconcile messages from backend to prevent duplicate optimistic messages
              realApiClient
                .getConversation(targetConvId!)
                .then((convRes) => {
                  if (conversationIdRef.current !== targetConvId) return;
                  if (
                    convRes.messages.length > 0 &&
                    convRes.messages.some((m) => m.role === 'assistant')
                  ) {
                    setMessages(convRes.messages);
                  } else {
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
                  }
                })
                .catch(() => {
                  if (conversationIdRef.current !== targetConvId) return;
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
                })
                .finally(() => {
                  activeGenerationIdRef.current = null;
                  isStoppingRef.current = false;
                });
            } else if (event.event === 'stream.error' || event.event === 'message.failed') {
              if (stopTimeoutRef.current) {
                clearTimeout(stopTimeoutRef.current);
                stopTimeoutRef.current = null;
              }
              setIsStreaming(false);
              const partial = accumulatedTextRef.current;
              setStreamingText('');
              accumulatedTextRef.current = '';
              const genId = activeGenerationIdRef.current;
              const errMsg = event.data?.error?.message || 'Chat generation failed';

              if (genId && targetConvId) {
                await reconcileAuthoritativeGeneration(
                  targetConvId,
                  genId,
                  errMsg,
                  partial
                );
              } else {
                setErrorBanner(errMsg);
                if (partial) {
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: event.data?.messageId || `fail_${Date.now()}`,
                      conversationId: targetConvId!,
                      role: 'assistant',
                      content: partial,
                      createdAt: new Date().toISOString(),
                      status: 'failed',
                    },
                  ]);
                }
              }
            } else if (event.event === 'message.stopped') {
              if (stopTimeoutRef.current) {
                clearTimeout(stopTimeoutRef.current);
                stopTimeoutRef.current = null;
              }
              const partial = accumulatedTextRef.current;
              setIsStreaming(false);
              setStreamingText('');
              accumulatedTextRef.current = '';
              const genId = activeGenerationIdRef.current;
              if (genId && targetConvId) {
                await reconcileAuthoritativeGeneration(targetConvId, genId, undefined, partial);
              }
            }
          },
          { signal: abortControllerRef.current.signal }
        );
      } catch (err: unknown) {
        if (stopTimeoutRef.current) {
          clearTimeout(stopTimeoutRef.current);
          stopTimeoutRef.current = null;
        }
        const partial = accumulatedTextRef.current;
        setIsStreaming(false);
        setStreamingText('');
        accumulatedTextRef.current = '';

        const isAbort =
          (err instanceof Error &&
            (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'))) ||
          abortControllerRef.current?.signal.aborted;

        const genId = activeGenerationIdRef.current;
        const errMsg =
          err instanceof ApiException
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Stream error';

        if (genId && targetConvId) {
          // Reconcile authoritative generation state from backend
          await reconcileAuthoritativeGeneration(
            targetConvId,
            genId,
            isAbort ? undefined : errMsg,
            partial
          );
        } else {
          // Do not display generic AbortError as chat failure if user intentionally stopped
          if (!isAbort && !isStoppingRef.current) {
            setErrorBanner(errMsg);
          }
        }
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

  const handleStopStreaming = async () => {
    if (mode === 'real') {
      const targetId = conversationId;
      const genId = activeGenerationIdRef.current;

      if (!genId || !targetId) {
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
        }
        setIsStreaming(false);
        setStreamingText('');
        accumulatedTextRef.current = '';
        return;
      }

      isStoppingRef.current = true;

      try {
        // 1. Await durable cancel acceptance BEFORE aborting SSE connection!
        const cancelRes = await realApiClient.cancelGeneration(targetId, genId);

        // 2. If already terminal (completed or stopped), reconcile immediately and abort local reader
        if (isTerminalStatus(cancelRes.generation.status)) {
          if (abortControllerRef.current) {
            abortControllerRef.current.abort();
          }
          await reconcileAuthoritativeGeneration(targetId, genId);
        } else {
          // 202 Accepted: durable intent committed on backend.
          // Keep SSE open to receive message.stopped, with a fallback timer for stalled connections
          if (stopTimeoutRef.current) {
            clearTimeout(stopTimeoutRef.current);
          }
          stopTimeoutRef.current = setTimeout(async () => {
            // Keep SSE open where possible; fallback reconciliation polls authoritative status
            const terminal = await reconcileAuthoritativeGeneration(targetId, genId);
            if (terminal) {
              if (abortControllerRef.current) {
                abortControllerRef.current.abort();
              }
            }
          }, STOP_FALLBACK_TIMEOUT_MS);
        }
      } catch (cancelErr: unknown) {
        // Handle cancel failure VISIBLY! Do NOT swallow it or fabricate stopped state!
        isStoppingRef.current = false;
        const msg =
          cancelErr instanceof ApiException
            ? cancelErr.message
            : cancelErr instanceof Error
              ? cancelErr.message
              : 'Failed to cancel generation';
        setErrorBanner(msg);
      }
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
