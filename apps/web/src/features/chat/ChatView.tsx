import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from '../../app/router.js';
import { useApiMode } from '../../app/context/ApiModeContext.js';
import type { Conversation, Message } from '../../lib/api/types.js';
import { mockDataAdapter } from '../../lib/api/mock-adapter.js';
import { ConversationSidebar } from './ConversationSidebar.js';
import { MessageBubble } from './MessageBubble.js';
import { Composer } from './Composer.js';
import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';

export const ChatView: React.FC = () => {
  const { params, navigate } = useRouter();
  const { mode, setMode } = useApiMode();
  const conversationId = params.conversationId;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const accumulatedTextRef = useRef('');
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
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Load conversations list
  const loadConversations = useCallback(async () => {
    setIsLoading(true);
    setErrorBanner(null);
    try {
      if (mode === 'real') {
        setErrorBanner('Backend Chat CRUD endpoints (/api/v1/conversations) are currently in development under Linear 17T-21. Toggle to MOCK mode to interact with the full demo.');
        setConversations([]);
      } else {
        const res = await mockDataAdapter.listConversations();
        setConversations(res.items);
        if (!conversationId && res.items.length > 0) {
          navigate(`/chat/${res.items[0].id}`);
        }
      }
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to load conversations');
    } finally {
      setIsLoading(false);
    }
  }, [mode, conversationId, navigate]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Load specific conversation messages
  const loadMessages = useCallback(async (id: string) => {
    if (mode === 'real') return;
    try {
      const res = await mockDataAdapter.getConversation(id);
      setMessages(res.messages);
    } catch {
      setMessages([]);
    }
  }, [mode]);

  useEffect(() => {
    if (conversationId) {
      loadMessages(conversationId);
    } else {
      setMessages([]);
    }
  }, [conversationId, loadMessages]);

  const handleCreateConversation = async () => {
    if (mode === 'real') {
      setErrorBanner('Create conversation API is under development on backend.');
      return;
    }
    const res = await mockDataAdapter.createConversation('New Architecture Discussion');
    setConversations((prev) => [res.conversation, ...prev]);
    navigate(`/chat/${res.conversation.id}`);
  };

  const handleDeleteConversation = async (id: string) => {
    if (mode === 'real') return;
    await mockDataAdapter.deleteConversation(id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (conversationId === id) {
      navigate('/chat');
    }
  };

  const handleSendMessage = async (content: string) => {
    if (isStreaming) return;

    let targetConvId = conversationId;
    if (!targetConvId) {
      const newConv = await mockDataAdapter.createConversation(content.slice(0, 30));
      setConversations((prev) => [newConv.conversation, ...prev]);
      targetConvId = newConv.conversation.id;
      navigate(`/chat/${targetConvId}`);
    }

    // Add user message
    const userMsg = await mockDataAdapter.addMessage(targetConvId, 'user', content);
    setMessages((prev) => [...prev, userMsg]);

    // Start streaming simulation
    setIsStreaming(true);
    setStreamingText('');
    accumulatedTextRef.current = '';
    let accumulated = '';
    abortControllerRef.current = new AbortController();

    try {
      await mockDataAdapter.simulateChatStream(
        content,
        (chunk) => {
          accumulated += chunk;
          accumulatedTextRef.current = accumulated;
          setStreamingText(accumulated);
        },
        async () => {
          // Finalize assistant message with accumulated content (immune to stale closure)
          const fullText = accumulated.trim();
          setIsStreaming(false);
          setStreamingText('');
          accumulatedTextRef.current = '';
          if (fullText) {
            const assistantMsg = await mockDataAdapter.addMessage(targetConvId!, 'assistant', fullText);
            setMessages((prev) => [...prev, assistantMsg]);
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
  };

  const handleStopStreaming = () => {
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
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: '#090d16', minWidth: 0 }}>
        {/* Banner notification for Mock Mode */}
        {mode === 'mock' && (
          <div
            style={{
              padding: '8px 16px',
              backgroundColor: '#431407',
              borderBottom: '1px solid #7c2d12',
              fontSize: '12px',
              color: '#fdba74',
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
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #1e293b' }}>
            <Alert
              type="warning"
              title={mode === 'real' ? 'Real Backend Status' : 'Notice'}
              message={errorBanner}
              action={
                mode === 'real' ? (
                  <Button size="sm" variant="secondary" onClick={() => setMode('mock')}>
                    Switch to MOCK Mode Demo
                  </Button>
                ) : undefined
              }
              onDismiss={() => setErrorBanner(null)}
            />
          </div>
        )}

        {/* Message Feed */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 20px', display: 'flex', flexDirection: 'column' }}>
          {messages.length === 0 && !isStreaming && (
            <div
              style={{
                margin: 'auto',
                textAlign: 'center',
                maxWidth: '480px',
                padding: '32px 16px',
                color: '#94a3b8',
              }}
            >
              <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#f1f5f9', marginBottom: '8px' }}>
                Welcome to Giga Developer Chat
              </h2>
              <p style={{ fontSize: '13px', lineHeight: 1.6, marginBottom: '20px' }}>
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
          disabled={mode === 'real' && Boolean(errorBanner)}
        />
      </div>
    </div>
  );
};
