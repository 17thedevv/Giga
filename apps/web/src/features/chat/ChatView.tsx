import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from '../../app/router.js';
import { useApiMode } from '../../app/context/ApiModeContext.js';
import type { Conversation, Message, ModelMetadata, ReasoningEffort, ChatTurnVariants, ChatGeneration, ChatStreamEvent } from '../../lib/api/types.js';
import { realApiClient, ApiException } from '../../lib/api/client.js';
import { mockDataAdapter } from '../../lib/api/mock-adapter.js';
import { ConversationSidebar } from './ConversationSidebar.js';
import { MessageBubble } from './MessageBubble.js';
import { Composer } from './Composer.js';
import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { GigaLogo } from '../../components/GigaLogo.js';
import {
  normalizeModelMetadata,
  getEffectiveReasoningEffort,
} from './model-capabilities.js';

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

if (typeof window !== 'undefined') {
  (window as any).__mockDataAdapter = mockDataAdapter;
}

export const ChatView: React.FC = () => {
  const { params, navigate } = useRouter();
  const { mode } = useApiMode();
  const conversationId = params.conversationId;

  const conversationIdRef = useRef<string | undefined>(conversationId);
  conversationIdRef.current = conversationId;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [models, setModels] = useState<ModelMetadata[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<ReasoningEffort | undefined>(
    undefined
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isMessagesLoading, setIsMessagesLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [turn, setTurn] = useState<ChatTurnVariants | null>(null);
  const [canStop, setCanStop] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isActionLocked, setIsActionLocked] = useState(false);
  const [historyLoadError, setHistoryLoadError] = useState(false);
  const actionLockRef = useRef(false);
  const operationRef = useRef(0);
  const modeRef = useRef(mode);
  const routeModeRef = useRef(mode);
  modeRef.current = mode;

  const setActionLock = useCallback((locked: boolean) => {
    actionLockRef.current = locked;
    setIsActionLocked(locked);
  }, []);
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const accumulatedTextRef = useRef('');
  const activeGenerationIdRef = useRef<string | null>(null);
  const activeGenerationConversationIdRef = useRef<string | null>(null);
  const isStoppingRef = useRef(false);
  const createdConversationIdRef = useRef<string | null>(null);
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageLoadRequestIdRef = useRef(0);
  const conversationsLoadRequestIdRef = useRef(0);
  const modelsLoadRequestIdRef = useRef(0);

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
      operationRef.current++;
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
    activeGenerationConversationIdRef.current = null;
    isStoppingRef.current = false;
    setActionLock(false);
    setHistoryLoadError(false);
    setErrorBanner(null);
    setModels([]);
    setSelectedModelId('');
    setSelectedReasoningEffort(undefined);
  }, [mode, setActionLock]);

  // Load conversations list
  const loadConversations = useCallback(async () => {
    const reqId = ++conversationsLoadRequestIdRef.current;
    setIsLoading(true);
    setErrorBanner(null);
    try {
      if (mode === 'real') {
        const res = await realApiClient.listConversations();
        if (conversationsLoadRequestIdRef.current !== reqId) return;
        setConversations(res.items);
        if (
          !conversationIdRef.current &&
          !createdConversationIdRef.current &&
          !actionLockRef.current &&
          res.items.length > 0
        ) {
          navigate(`/chat/${res.items[0].id}`);
        }
      } else {
        const res = await mockDataAdapter.listConversations();
        if (conversationsLoadRequestIdRef.current !== reqId) return;
        setConversations(res.items);
        if (
          !conversationIdRef.current &&
          !createdConversationIdRef.current &&
          !actionLockRef.current &&
          res.items.length > 0
        ) {
          navigate(`/chat/${res.items[0].id}`);
        }
      }
    } catch (err: unknown) {
      if (conversationsLoadRequestIdRef.current !== reqId) return;
      const message =
        err instanceof ApiException
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to load conversations';
      setErrorBanner(message);
      setConversations([]);
    } finally {
      if (conversationsLoadRequestIdRef.current === reqId) {
        setIsLoading(false);
      }
    }
  }, [mode, conversationId, navigate]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Load available models and their capabilities
  const loadModels = useCallback(async () => {
    const reqId = ++modelsLoadRequestIdRef.current;
    try {
      const res =
        mode === 'real'
          ? await realApiClient.listModels()
          : await mockDataAdapter.listModels();
      if (modelsLoadRequestIdRef.current !== reqId) return;
      const normalized = (res.models || []).map(normalizeModelMetadata);
      setModels(normalized);
      if (normalized.length > 0) {
        setSelectedModelId((prev) => {
          if (prev && normalized.some((m) => m.id === prev)) return prev;
          if (typeof window !== 'undefined' && window.location) {
            const urlModel = new URLSearchParams(window.location.search).get('model');
            if (urlModel && normalized.some((m) => m.id === urlModel)) return urlModel;
          }
          return normalized[0].id;
        });

        if (typeof window !== 'undefined' && window.location) {
          const urlEffort = new URLSearchParams(window.location.search).get('effort');
          if (urlEffort === 'low' || urlEffort === 'medium' || urlEffort === 'high') {
            setSelectedReasoningEffort(urlEffort);
          }
        }
      } else {
        setModels([]);
        setSelectedModelId('');
        setSelectedReasoningEffort(undefined);
      }
    } catch {
      if (modelsLoadRequestIdRef.current !== reqId) return;
      setModels([]);
      setSelectedModelId('');
      setSelectedReasoningEffort(undefined);
    }
  }, [mode]);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  // Model selection handler that enforces capability fencing:
  // When switching models, existing reasoning selection MUST be cleared if not supported by the new model.
  const handleSelectModel = useCallback(
    (modelId: string) => {
      setSelectedModelId(modelId);
      const targetModel = models.find((m) => m.id === modelId);
      if (
        !targetModel ||
        !targetModel.reasoning?.supported ||
        !selectedReasoningEffort ||
        !targetModel.reasoning.efforts.includes(selectedReasoningEffort)
      ) {
        setSelectedReasoningEffort(undefined);
      }
    },
    [models, selectedReasoningEffort]
  );

  // Synchronize reasoning selection if models list changes
  useEffect(() => {
    if (selectedReasoningEffort) {
      const activeModel = models.find((m) => m.id === selectedModelId);
      if (
        !activeModel ||
        !activeModel.reasoning?.supported ||
        !activeModel.reasoning.efforts.includes(selectedReasoningEffort)
      ) {
        setSelectedReasoningEffort(undefined);
      }
    }
  }, [models, selectedModelId, selectedReasoningEffort]);

  const api = mode === 'real' ? realApiClient : mockDataAdapter;
  const current = (id: string, op: number, sourceMode = mode) =>
    operationRef.current === op && modeRef.current === sourceMode &&
    (conversationIdRef.current === id || createdConversationIdRef.current === id);

  const release = () => {
    setActionLock(false);
    setCanStop(false);
    activeGenerationIdRef.current = null;
    activeGenerationConversationIdRef.current = null;
    isStoppingRef.current = false;
    setIsStopping(false);
    setIsStreaming(false);
    setStreamingText('');
    accumulatedTextRef.current = '';
    if (stopTimeoutRef.current) clearTimeout(stopTimeoutRef.current);
  };

  const inspectTurn = async (id: string, history: Message[], op: number) => {
    const user = [...history].reverse().find(m => m.role === 'user');
    if (!user) { if (current(id, op)) setTurn(null); return; }
    const variants = await api.getTurnVariants(id, user.id);
    if (!current(id, op)) return;
    setTurn(variants.items.length ? variants : null);
    const latest = variants.items.at(-1);
    if (latest && !isTerminalStatus(latest.status)) {
      activeGenerationIdRef.current = latest.id;
      activeGenerationConversationIdRef.current = id;
      setCanStop(true);
      setActionLock(true);
      setIsStreaming(true);
      void reconcileAuthoritativeGeneration(id, latest.id);
    }
  };

  // Only terminal server state releases the action lock after an uncertain stream.
  const reconcileAuthoritativeGeneration = async (
    id: string, generationId: string, fallback?: string, localPartial?: string,
    attempt = 0, op = operationRef.current, snapshot?: ChatGeneration
  ): Promise<boolean> => {
    if (
      !current(id, op) ||
      activeGenerationIdRef.current !== generationId ||
      (activeGenerationConversationIdRef.current && activeGenerationConversationIdRef.current !== id)
    ) {
      return false;
    }
    try {
      const generation = snapshot || (await api.getGeneration(id, generationId)).generation;
      if (!current(id, op) || activeGenerationIdRef.current !== generationId) return false;
      if (!isTerminalStatus(generation.status)) {
        setCanStop(true);
        if (generation.partialContent) setStreamingText(generation.partialContent);
        if (attempt < MAX_POLL_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
          return reconcileAuthoritativeGeneration(id, generationId, fallback, localPartial, attempt + 1, op);
        }
        setErrorBanner('Generation cancellation is taking longer than expected. Generation remains ' + generation.status + ' on server.');
        isStoppingRef.current = false;
        setIsStopping(false);
        return false;
      }
      const history = await api.getConversation(id);
      const user = [...history.messages].reverse().find(m => m.role === 'user');
      const variants = user ? await api.getTurnVariants(id, user.id) : null;
      if (!current(id, op) || activeGenerationIdRef.current !== generationId) return false;
      // Flat history contains the server-selected completed answer only.
      let next = history.messages;
      if (generation.status === 'completed' && !next.some(m => m.id === generation.assistantMessageId)) {
        next = [...next, { id: generation.assistantMessageId || generation.id, conversationId: id,
          role: 'assistant', content: generation.partialContent, createdAt: generation.finishedAt || generation.createdAt, status: 'completed' }];
      }
      if (generation.status !== 'completed' && !(variants?.selectedGenerationId)) {
        const partial = generation.partialContent || localPartial;
        if (partial) next = [...next, {
          id: 'partial_' + generation.id, conversationId: id, role: 'assistant',
          content: partial, createdAt: generation.finishedAt || generation.createdAt,
          status: generation.status === 'stopped' ? 'stopped' : 'failed',
        }];
      }
      setMessages(next);
      setTurn(variants?.items.length ? variants : null);
      setErrorBanner(generation.status === 'failed' || generation.status === 'interrupted'
        ? generation.error?.message || fallback || 'Generation failed' : null);
      release();
      return true;
    } catch (err) {
      if (!current(id, op) || activeGenerationIdRef.current !== generationId) return false;
      if (attempt < MAX_POLL_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        return reconcileAuthoritativeGeneration(id, generationId, fallback, localPartial, attempt + 1, op);
      }
      isStoppingRef.current = false;
      setIsStopping(false);
      setErrorBanner('Unable to verify generation ' + generationId + ' status: ' +
        (err instanceof Error ? err.message : 'Status check failed') + '. Generation remains active on server; you can retry status check or stop.');
      return false;
    }
  };

  useEffect(() => {
    const modeChanged = routeModeRef.current !== mode;
    routeModeRef.current = mode;
    if (!modeChanged && createdConversationIdRef.current === conversationId) return;
    operationRef.current++;
    abortControllerRef.current?.abort();
    createdConversationIdRef.current = null;
    release();
    setMessages([]);
    setTurn(null);
    setErrorBanner(null);
    setHistoryLoadError(false);
  }, [conversationId, mode]);

  // Load specific conversation messages
  const loadMessages = useCallback(
    async (id: string) => {
      const requestId = ++messageLoadRequestIdRef.current;
      setIsMessagesLoading(true);
      setHistoryLoadError(false);
      try {
        const res =
          mode === 'real'
            ? await realApiClient.getConversation(id)
            : await mockDataAdapter.getConversation(id);

        if (
          conversationIdRef.current !== id ||
          messageLoadRequestIdRef.current !== requestId
        ) {
          return;
        }
        setMessages(res.messages);
        setHistoryLoadError(false);
        setErrorBanner(null);
        await inspectTurn(id, res.messages, operationRef.current);
        if (conversationIdRef.current === id && !activeGenerationIdRef.current) {
          setActionLock(false);
        }
      } catch (err: unknown) {
        if (
          conversationIdRef.current !== id ||
          messageLoadRequestIdRef.current !== requestId
        ) {
          return;
        }
        const message =
          err instanceof ApiException
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to load conversation messages';
        setErrorBanner(message);
        setHistoryLoadError(true);
        setActionLock(true);
      } finally {
        if (messageLoadRequestIdRef.current === requestId) {
          setIsMessagesLoading(false);
        }
      }
    },
    [mode, setActionLock]
  );

  useEffect(() => {
    if (conversationId) {
      if (createdConversationIdRef.current !== conversationId) {
        loadMessages(conversationId);
      }
    } else {
      messageLoadRequestIdRef.current++;
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
      if (conversationIdRef.current === id) {
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

  const runGeneration = async (content?: string, action?: 'retry' | 'regenerate') => {
    if (actionLockRef.current || isMessagesLoading || historyLoadError) return;
    setActionLock(true); // Synchronous: protects clicks before React renders.
    const op = ++operationRef.current;
    let id = conversationIdRef.current;
    setIsStreaming(true);
    setErrorBanner(null);
    setStreamingText('');
    accumulatedTextRef.current = '';
    const controller = new AbortController();
    abortControllerRef.current = controller;
    let terminal = false;
    let terminalWork: Promise<unknown> | undefined;
    try {
      if (!id) {
        const res = await api.createConversation(content?.trim().slice(0, 32));
        if (op !== operationRef.current || modeRef.current !== mode) return;
        id = res.conversation.id;
        createdConversationIdRef.current = id;
        setConversations(prev => [res.conversation, ...prev]);
        navigate('/chat/' + id);
      }
      const target = id;
      const originalUser = [...messages].reverse().find(m => m.role === 'user');
      if (content !== undefined) {
        setTurn(null);
        setMessages(prev => [...prev, {
          id: 'opt_' + crypto.randomUUID(), conversationId: target, role: 'user', content,
          createdAt: new Date().toISOString(), isOptimistic: true,
        }]);
      }
      const model = models.find(m => m.id === selectedModelId);
      const options = {
        signal: controller.signal, idempotencyKey: crypto.randomUUID(),
        modelId: model?.id, reasoningEffort: getEffectiveReasoningEffort(model, selectedReasoningEffort),
      };
      const onEvent = (event: ChatStreamEvent) => {
        if (!current(target, op) || terminal) return;
        if (event.event === 'message.started') {
          if (event.data.conversationId !== target) return;
          activeGenerationIdRef.current = event.data.generationId;
          activeGenerationConversationIdRef.current = target;
          setCanStop(true);
        } else if (event.data.generationId !== activeGenerationIdRef.current) return;
        if (event.event === 'message.delta') {
          accumulatedTextRef.current += event.data.text;
          setStreamingText(accumulatedTextRef.current);
        } else if (event.event === 'stream.error') {
          // Diagnostic; message.failed is the terminal event.
          setErrorBanner(event.data.error.message);
        } else if (event.event === 'message.completed') {
          terminal = true;
          const text = accumulatedTextRef.current;
          if (action && originalUser) {
            setTurn(prev => prev ? {
              ...prev, selectedGenerationId: event.data.generationId,
              items: [...prev.items.filter(item => item.id !== event.data.generationId), {
                id: event.data.generationId, assistantMessageId: event.data.messageId,
                action, modelId: model?.id || 'giga-chat-default', status: 'completed', content: text,
                createdAt: event.data.createdAt || new Date().toISOString(),
              }],
            } : prev);
          }
          // A completed SSE follows the durable commit. Keep old variants in turn metadata.
          setMessages(prev => {
            const userIndex = prev.map(m => m.role).lastIndexOf('user');
            return [...prev.slice(0, userIndex + 1).map(m => ({ ...m, isOptimistic: false })), {
              id: event.data.messageId, conversationId: target, role: 'assistant', content: text,
              createdAt: event.data.createdAt || new Date().toISOString(), status: 'completed',
            }];
          });
          release();
          terminalWork = (async () => {
            const history = await api.getConversation(target);
            if (!current(target, op)) return;
            const user = [...history.messages].reverse().find(m => m.role === 'user');
            const variants = user ? await api.getTurnVariants(target, user.id) : null;
            if (!current(target, op)) return;
            if (history.messages.some(m => m.id === event.data.messageId)) setMessages(history.messages);
            setTurn(variants?.items.length ? variants : null);
          })().catch(err => {
            if (current(target, op)) setErrorBanner('Answer completed; history refresh failed: ' + (err instanceof Error ? err.message : 'Try refreshing.'));
          });
        } else if (event.event === 'message.failed' || event.event === 'message.stopped') {
          terminal = true;
          terminalWork = reconcileAuthoritativeGeneration(target, event.data.generationId,
            event.event === 'message.failed' ? event.data.error.message : undefined, accumulatedTextRef.current);
        }
      };
      if (action && originalUser) {
        await api.streamVariant(target, originalUser.id, action, onEvent, options);
      } else if (content !== undefined) {
        await api.streamMessage(target, content, onEvent, options);
      }
      if (terminalWork) await terminalWork;
      if (!terminal && current(target, op) && actionLockRef.current) {
        if (activeGenerationIdRef.current) {
          await reconcileAuthoritativeGeneration(target, activeGenerationIdRef.current, 'Stream ended before a terminal event', accumulatedTextRef.current);
        } else {
          throw new Error('Stream ended before generation admission was confirmed');
        }
      }
    } catch (err) {
      // Creation can reject after navigation, mode changes, or a newer admission.
      // A stale operation must never release the current generation's lock/IDs.
      if (op !== operationRef.current || modeRef.current !== mode) return;
      if (!id) {
        if (conversationIdRef.current) return;
        release();
        setErrorBanner(err instanceof Error ? err.message : 'Failed to create conversation');
        return;
      }
      if (!current(id, op) || controller.signal.aborted && !actionLockRef.current) return;
      const duplicate = err instanceof ApiException ? err.details?.generation as ChatGeneration | undefined : undefined;
      if (duplicate?.conversationId === id) {
        activeGenerationIdRef.current = duplicate.id;
        activeGenerationConversationIdRef.current = id;
        setCanStop(!isTerminalStatus(duplicate.status));
      }
      if (activeGenerationIdRef.current) {
        await reconcileAuthoritativeGeneration(id, activeGenerationIdRef.current,
          err instanceof Error ? err.message : 'Stream error', accumulatedTextRef.current);
      } else {
        setErrorBanner(err instanceof Error ? err.message : 'Stream error');
        // Refresh latest-turn variants to discover admission if message.started was lost.
        try {
          const history = await api.getConversation(id);
          if (!current(id, op)) return;
          setMessages(history.messages);
          await inspectTurn(id, history.messages, op);
          if (current(id, op) && !activeGenerationIdRef.current) release();
        } catch {
          if (!current(id, op)) return;
          // Unknown admission: keep actions locked until a successful status refresh.
          setIsStreaming(false);
        }
      }
    }
  };

  const handleSendMessage = (content: string) => runGeneration(content);
  const handleRegenerateMessage = (message: Message) => runGeneration(undefined,
    message.status === 'failed' || message.status === 'stopped' ? 'retry' : 'regenerate');

  const handleStopStreaming = async () => {
    const owningConvId = activeGenerationConversationIdRef.current;
    const currentConvId = conversationIdRef.current || createdConversationIdRef.current;
    const genId = activeGenerationIdRef.current;
    if (!owningConvId || !genId || isStoppingRef.current) return;
    if (currentConvId !== owningConvId) return;
    const op = operationRef.current;
    isStoppingRef.current = true;
    setIsStopping(true);
    try {
      const result = await api.cancelGeneration(owningConvId, genId);
      if (!current(owningConvId, op) || activeGenerationIdRef.current !== genId) return;
      if (mode === 'mock') abortControllerRef.current?.abort();
      if (isTerminalStatus(result.generation.status)) {
        await reconcileAuthoritativeGeneration(owningConvId, genId, undefined, accumulatedTextRef.current, 0, op, result.generation);
        if (current(owningConvId, op) && !activeGenerationIdRef.current) abortControllerRef.current?.abort();
      } else {
        stopTimeoutRef.current = setTimeout(() => {
          void reconcileAuthoritativeGeneration(owningConvId, genId, undefined, accumulatedTextRef.current);
        }, STOP_FALLBACK_TIMEOUT_MS);
      }
    } catch (err) {
      if (!current(owningConvId, op) || activeGenerationIdRef.current !== genId) return;
      setErrorBanner(err instanceof Error ? err.message : 'Failed to cancel generation');
      isStoppingRef.current = false;
      setIsStopping(false);
      // A lost cancel response may still mean the intent committed.
      void reconcileAuthoritativeGeneration(owningConvId, genId);
    }
  };

  const latestUserIndex = messages.map(m => m.role).lastIndexOf('user');
  const latestAssistant = messages.slice(latestUserIndex + 1).find(m => m.role === 'assistant');
  const latestAttempt = turn?.items.at(-1);
  const canRetry = latestAttempt && ['failed', 'stopped', 'interrupted'].includes(latestAttempt.status);


  return (
    <div style={{ display: 'flex', height: '100%', width: '100%' }}>
      {/* Sidebar with discussions list */}
      <ConversationSidebar
        conversations={conversations}
        activeId={conversationId}
        onSelect={(id) => {
          navigate(`/chat/${id}`);
          setShowMobileSidebar(false);
        }}
        onCreate={() => {
          handleCreateConversation();
          setShowMobileSidebar(false);
        }}
        onDelete={handleDeleteConversation}
        isLoading={isLoading}
        isOpenOnMobile={showMobileSidebar}
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
        {/* Mobile Header Bar for discussions toggle (< 768px) */}
        <div
          className="mobile-chat-bar"
          style={{
            padding: '8px 16px',
            borderBottom: '1px solid var(--giga-border, #1E293B)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: 'var(--giga-surface, #111C2D)',
          }}
        >
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowMobileSidebar(!showMobileSidebar)}
          >
            {showMobileSidebar ? '✕ Close Discussions' : '☰ Discussions'}
          </Button>
          <span style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)' }}>
            {models.find((m) => m.id === selectedModelId)?.id || 'GigaChat'}
          </span>
        </div>
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
              action={
                conversationId ? (
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {historyLoadError ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setErrorBanner(null);
                          setHistoryLoadError(false);
                          loadMessages(conversationId);
                        }}
                      >
                        Retry Loading History
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            if (
                              conversationId &&
                              activeGenerationIdRef.current &&
                              (!activeGenerationConversationIdRef.current || activeGenerationConversationIdRef.current === conversationId)
                            ) {
                              reconcileAuthoritativeGeneration(conversationId, activeGenerationIdRef.current);
                            } else if (conversationId) {
                              loadMessages(conversationId);
                            }
                          }}
                        >
                          Retry Status Check
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={
                            isStopping ||
                            !canStop ||
                            (activeGenerationConversationIdRef.current !== null &&
                              activeGenerationConversationIdRef.current !== conversationId)
                          }
                          onClick={handleStopStreaming}
                        >
                          Retry Stop
                        </Button>
                      </>
                    )}
                  </div>
                ) : undefined
              }
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

          {!isMessagesLoading && messages.length === 0 && historyLoadError && (
            <div
              className="g-empty"
              style={{
                margin: 'auto',
                textAlign: 'center',
                maxWidth: '480px',
                padding: '32px 16px',
              }}
            >
              <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)', marginBottom: '8px' }}>
                Failed to load conversation history
              </h2>
              <p style={{ fontSize: '13px', lineHeight: 1.6, marginBottom: '20px', color: 'var(--giga-text-secondary, #94A3B8)' }}>
                An error occurred while loading messages for this discussion.
              </p>
              {conversationId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setErrorBanner(null);
                    setHistoryLoadError(false);
                    loadMessages(conversationId);
                  }}
                >
                  Retry Loading History
                </Button>
              )}
            </div>
          )}

          {!isMessagesLoading && messages.length === 0 && !isStreaming && !historyLoadError && (
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

          {messages.map((msg) => {
            const isLatestAssistant = msg.role === 'assistant' && msg.id === latestAssistant?.id;
            return (
              <MessageBubble
                key={msg.id}
                message={msg}
                onRegenerate={isLatestAssistant && !turn && !messages[latestUserIndex]?.id.startsWith('opt_') ? handleRegenerateMessage : undefined}
                canRegenerate={!isStreaming && isLatestAssistant}
              />
            );
          })}

          {turn && (
            <div className="g-generation-controls" aria-label="Latest turn controls">
              <span role="status" aria-live="polite">{latestAttempt?.status === 'stopped' ? 'Response stopped by user' : latestAttempt?.status}</span>
              {canRetry && <Button size="sm" variant="outline" title="Retry generation" style={{ minHeight: 44 }} disabled={isStreaming || isMessagesLoading} onClick={() => runGeneration(undefined, 'retry')}>Retry</Button>}
              {turn.selectedGenerationId && <Button size="sm" variant="outline" title="Regenerate response" style={{ minHeight: 44 }} disabled={isStreaming || isMessagesLoading} onClick={() => runGeneration(undefined, 'regenerate')}>Regenerate</Button>}
              {turn.items.filter(item => item.status === 'completed').length > 1 && (
                <details><summary>Previous completed answers</summary>
                  {turn.items.filter(item => item.status === 'completed' && item.id !== turn.selectedGenerationId).map(item => (
                    <p key={item.id} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.content}</p>
                  ))}
                </details>
              )}
            </div>
          )}
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
          disabled={isMessagesLoading || (isActionLocked && !isStreaming) || historyLoadError}
          isStopping={isStopping}
          canStop={canStop}
          models={models}
          selectedModelId={selectedModelId}
          onSelectModel={handleSelectModel}
          reasoningEffort={selectedReasoningEffort}
          onSelectReasoningEffort={setSelectedReasoningEffort}
        />
      </div>
    </div>
  );
};
