import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ApiException, realApiClient } from '../../lib/api/client.js';
import type { AgentMessage, AgentRun } from '../../lib/api/agent-contract.js';
import { Button } from '../../components/Button.js';
import { Textarea } from '../../components/Textarea.js';

const TERMINAL_STATUSES: readonly AgentRun['status'][] = ['completed', 'failed', 'cancelled'];

interface PendingSubmission {
  readonly content: string;
  readonly idempotencyKey: string;
}

interface AgentMessageThreadProps {
  readonly run: AgentRun;
  readonly onStartNewRun: () => void;
  readonly onRefreshRun: () => Promise<void>;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function createIdempotencyKey(): string {
  const randomId = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `agent-${randomId}`;
}

function safeMessageError(error: unknown): string {
  if (!(error instanceof ApiException)) return 'The Agent service or network is unavailable.';
  if (error.status === 401) return 'Your session has expired. Sign in again to continue.';
  if (error.status === 403 || error.status === 404) return 'This conversation is unavailable for the current account.';
  if (error.status === 409) return 'This run no longer accepts follow-up messages. Refresh its status or start a new run in this workspace.';
  if (error.status >= 500) return 'The Agent service could not complete this request. Try again shortly.';
  return 'The Agent API rejected the request. Check the message and try again.';
}

function messageRoleLabel(role: AgentMessage['role']): string {
  if (role === 'user') return 'You';
  if (role === 'assistant') return 'Agent';
  return 'Tool summary';
}

function mergeMessagePages(current: readonly AgentMessage[], incoming: readonly AgentMessage[]): AgentMessage[] {
  const bySequence = new Map(current.map((message) => [message.sequence, message]));
  for (const message of incoming) {
    const existing = bySequence.get(message.sequence);
    if (existing && existing.id !== message.id) throw new Error('Conflicting message sequence');
    bySequence.set(message.sequence, message);
  }
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

export const AgentMessageThread: React.FC<AgentMessageThreadProps> = ({ run, onStartNewRun, onRefreshRun }) => {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [followUpAvailable, setFollowUpAvailable] = useState(false);
  const [capabilityReason, setCapabilityReason] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingSubmission, setPendingSubmission] = useState<PendingSubmission | null>(null);
  const requestRef = useRef(0);
  const loadMoreRef = useRef(false);
  const submitLockRef = useRef(false);
  const pendingSubmissionRef = useRef<PendingSubmission | null>(null);
  const messagesRef = useRef<AgentMessage[]>([]);
  messagesRef.current = messages;

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setIsLoading(true);
    setMessages([]);
    messagesRef.current = [];
    loadMoreRef.current = false;
    setIsLoadingMore(false);
    setCursor(null);
    setLoadError(null);
    setFollowUpAvailable(false);
    setCapabilityReason('Checking whether follow-up messages are available…');

    const [pageResult, capabilityResult] = await Promise.allSettled([
      realApiClient.listAgentMessages(run.id, { workspaceId: run.workspaceId }),
      realApiClient.getAgentCapabilities(),
    ]);
    if (requestRef.current !== requestId) return;

    if (pageResult.status === 'fulfilled') {
      setMessages([...pageResult.value.items]);
      messagesRef.current = [...pageResult.value.items];
      setCursor(pageResult.value.nextCursor);
    } else {
      setLoadError(safeMessageError(pageResult.reason));
    }

    if (capabilityResult.status === 'fulfilled') {
      const capability = capabilityResult.value.capabilities.followUp;
      setFollowUpAvailable(capability.available);
      setCapabilityReason(capability.available ? null : capability.reason === 'runtime_unavailable'
        ? 'The Agent execution runtime is unavailable, so this thread is read-only.'
        : capability.reason === 'not_implemented'
          ? 'Follow-up messages are not enabled by this Agent API, so this thread is read-only.'
          : 'The Agent API has not confirmed follow-up support. Sending is disabled.');
    } else {
      setFollowUpAvailable(false);
      setCapabilityReason('Could not confirm follow-up support. Sending is disabled until the Agent API confirms it.');
    }
    setIsLoading(false);
  }, [run.id, run.workspaceId]);

  useEffect(() => {
    setDraft('');
    setSubmitError(null);
    setPendingSubmission(null);
    pendingSubmissionRef.current = null;
    void load();
    return () => { requestRef.current++; };
  }, [load]);

  const loadMore = async () => {
    if (!cursor || loadMoreRef.current || isLoading || isLoadingMore) return;
    loadMoreRef.current = true;
    setIsLoadingMore(true);
    setLoadError(null);
    const requestId = requestRef.current;
    try {
      const page = await realApiClient.listAgentMessages(run.id, {
        workspaceId: run.workspaceId,
        cursor,
      });
      if (requestRef.current !== requestId) return;
      const merged = mergeMessagePages(messagesRef.current, page.items);
      setMessages(merged);
      messagesRef.current = merged;
      setCursor(page.nextCursor);
    } catch (error) {
      if (requestRef.current === requestId) setLoadError(safeMessageError(error));
    } finally {
      if (requestRef.current === requestId) {
        loadMoreRef.current = false;
        setIsLoadingMore(false);
      }
    }
  };

  const terminal = TERMINAL_STATUSES.includes(run.status);
  const canSubmit = followUpAvailable && !terminal;
  const displayedContent = pendingSubmission?.content ?? draft;
  const messageBytes = utf8Length(displayedContent.trim());
  const invalidDraft = !displayedContent.trim() || displayedContent.includes('\0') || messageBytes > 16384;

  const submit = async (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!canSubmit || submitLockRef.current) return;
    const pending = pendingSubmissionRef.current ?? {
      content: draft.trim(),
      idempotencyKey: createIdempotencyKey(),
    };
    if (!pendingSubmissionRef.current) {
      if (!pending.content || pending.content.includes('\0') || utf8Length(pending.content) > 16384) return;
      pendingSubmissionRef.current = pending;
      setPendingSubmission(pending);
    }

    submitLockRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);
    const operationId = requestRef.current;
    try {
      const response = await realApiClient.createAgentMessage(run.id, { content: pending.content }, {
        workspaceId: run.workspaceId,
        idempotencyKey: pending.idempotencyKey,
      });
      if (requestRef.current !== operationId) return;
      let merged: AgentMessage[];
      try {
        merged = mergeMessagePages(messagesRef.current, [response.message]);
      } catch {
        pendingSubmissionRef.current = null;
        setPendingSubmission(null);
        setDraft('');
        setSubmitError('The API accepted the message, but the visible history could not be reconciled. Reloading the conversation from the server.');
        setIsSubmitting(false);
        void load();
        return;
      }
      setMessages(merged);
      messagesRef.current = merged;
      setDraft('');
      pendingSubmissionRef.current = null;
      setPendingSubmission(null);
    } catch (error) {
      if (requestRef.current !== operationId) return;
      if (error instanceof ApiException && error.status === 409) {
        pendingSubmissionRef.current = null;
        setPendingSubmission(null);
        setSubmitError('The run changed state before this message was accepted. Its status is being refreshed; start a new run if it is terminal.');
        void onRefreshRun();
      } else if (!(error instanceof ApiException) || error.status >= 500) {
        // The same body and key stay pinned until exact idempotent replay confirms the outcome.
        setSubmitError('The message outcome could not be confirmed. Retry the same message safely; it will reuse the same request key.');
      } else {
        pendingSubmissionRef.current = null;
        setPendingSubmission(null);
        setSubmitError(safeMessageError(error));
      }
    } finally {
      submitLockRef.current = false;
      if (requestRef.current === operationId) setIsSubmitting(false);
    }
  };

  const roleReason = terminal
    ? `This run is ${run.status} and its conversation is read-only.`
    : capabilityReason;

  return (
    <section className="g-agent-message-thread" aria-labelledby="agent-message-thread-heading" aria-busy={isLoading}>
      <div className="g-agent-message-thread__header">
        <div>
          <h2 id="agent-message-thread-heading">Conversation</h2>
          <p>Messages are loaded from the Agent API and shown as plain text.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={isLoading} data-testid="refresh-agent-messages-btn">
          Refresh conversation
        </Button>
      </div>

      {roleReason && <p className="g-agent-thread__read-only" data-testid="agent-thread-read-only">{roleReason}</p>}
      {terminal && <Button variant="outline" onClick={onStartNewRun} data-testid="start-new-agent-run-btn">Start a new run in this workspace</Button>}

      {isLoading && <p role="status" aria-live="polite" data-testid="agent-messages-loading">Loading conversation…</p>}
      {loadError && (
        <div role="alert" className="g-agent-thread__error" data-testid="agent-messages-error">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>Retry loading</Button>
        </div>
      )}
      {!isLoading && !loadError && messages.length === 0 && (
        <p className="g-agent-thread__empty" data-testid="agent-messages-empty">No messages have been saved for this run.</p>
      )}

      {messages.length > 0 && (
        <ol className="g-agent-message-list" aria-label="Agent conversation messages" data-testid="agent-message-list">
          {messages.map((message) => (
            <li key={message.id} data-sequence={message.sequence} data-testid="agent-message-item">
              <article className={`g-agent-message g-agent-message--${message.role}`} aria-label={`${messageRoleLabel(message.role)} message ${message.sequence}`}>
                <div className="g-agent-message__meta">
                  <strong>{messageRoleLabel(message.role)}</strong>
                  <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time>
                </div>
                <p className="g-agent-message__content">{message.content}</p>
              </article>
            </li>
          ))}
        </ol>
      )}

      {cursor && !loadError && (
        <Button variant="outline" onClick={() => void loadMore()} disabled={isLoadingMore || isLoading} loading={isLoadingMore} data-testid="load-more-agent-messages-btn">
          Load more messages
        </Button>
      )}

      {canSubmit && (
        <form className="g-agent-follow-up" onSubmit={(event) => void submit(event)} aria-label="Send a follow-up message">
          <Textarea
            id="agent-follow-up-content"
            label="Follow-up message"
            value={displayedContent}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Add an instruction for this run…"
            disabled={isSubmitting || pendingSubmission !== null}
            aria-describedby="agent-follow-up-hint agent-follow-up-status"
            data-testid="agent-follow-up-input"
          />
          <div className="g-agent-follow-up__footer">
            <span id="agent-follow-up-hint" className="g-agent-follow-up__hint">Up to 16,384 UTF-8 bytes. Ctrl+Enter or ⌘+Enter sends.</span>
            <span aria-live="polite">{messageBytes.toLocaleString()} / 16,384 bytes</span>
            <Button type="submit" disabled={isSubmitting || (!pendingSubmission && invalidDraft)} loading={isSubmitting} data-testid="send-agent-follow-up-btn">
              {pendingSubmission ? 'Retry same message' : 'Send follow-up'}
            </Button>
          </div>
          <div id="agent-follow-up-status" aria-live="polite">
            {submitError && <p role="alert" className="g-agent-thread__error" data-testid="agent-follow-up-error">{submitError}</p>}
          </div>
        </form>
      )}
    </section>
  );
};
