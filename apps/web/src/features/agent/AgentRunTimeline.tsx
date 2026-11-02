import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiException, getSessionGeneration, isCurrentSessionGeneration, realApiClient, SESSION_EXPIRED_EVENT } from '../../lib/api/client.js';
import { isAgentCapabilityAvailable, type AgentRun, type AgentStatus } from '../../lib/api/agent-contract.js';
import { AgentEventProjectionError, type PublicAgentRunEvent } from '../../lib/api/agent-events.js';
import { SseBufferLimitError, SseValidationError } from '../../lib/api/sse-parser.js';
import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';

const MAX_VISIBLE_EVENTS = 200;
const MAX_RECONNECTS = 6;

type TimelinePhase = 'loading-capabilities' | 'connecting' | 'live' | 'reconnecting' | 'complete' | 'paused' | 'unavailable' | 'session-expired';
type WarningKind = 'transport' | 'status' | 'incomplete' | 'integrity';
interface TimelineWarning { readonly kind: WarningKind; readonly message: string }
interface TerminalMarker { readonly status: AgentStatus; readonly sequence: number }

class ReplayIntegrityError extends Error {}

function isTerminal(status: AgentStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function terminalEventStatus(event: PublicAgentRunEvent): AgentStatus | null {
  if (event.type === 'run.completed') return 'completed';
  if (event.type === 'run.failed') return 'failed';
  if (event.type === 'run.status' && isTerminal(event.status)) return event.status;
  return null;
}

function retryDelay(attempt: number): number {
  return Math.min(500 * (2 ** Math.max(0, attempt - 1)), 8_000);
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timeout = window.setTimeout(done, ms);
    function done() {
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function renderEvent(event: PublicAgentRunEvent): string {
  switch (event.type) {
    case 'run.status': return `Run status: ${event.status}${event.phase ? ` · ${event.phase}` : ''}`;
    case 'plan.updated': return `Plan updated (version ${event.version})`;
    case 'tool.started': return `Tool started: ${event.name} · step ${event.stepNumber}`;
    case 'tool.completed': return `Tool completed · ${event.durationMs} ms${event.summary ? ` · ${event.summary}` : ''}`;
    case 'tool.failed': return `Tool failed · ${event.code}: ${event.summary}`;
    case 'run.completed': return `Run completed${event.summary ? ` · ${event.summary}` : ''}`;
    case 'run.failed': return `Run failed · ${event.code}: ${event.message}`;
    case 'unsupported': return `Unsupported event skipped: ${event.eventName}`;
  }
}

function AgentEventRow({ event }: { event: PublicAgentRunEvent }) {
  return (
    <li data-testid="agent-timeline-event" data-sequence={event.sequence} style={{ borderLeft: '2px solid var(--giga-border, #334155)', padding: '4px 0 12px 14px', marginLeft: 5 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' }}>
        <span>{renderEvent(event)}</span>
        <span aria-label={`Event ${event.sequence}`} style={{ color: 'var(--giga-text-secondary, #94A3B8)', fontVariantNumeric: 'tabular-nums' }}>#{event.sequence}</span>
      </div>
      {event.type === 'plan.updated' && event.steps.length > 0 && <ul>{event.steps.map((step, index) => <li key={`${event.sequence}-${index}`}>{step}</li>)}</ul>}
      {event.type === 'run.completed' && event.verifiedChecks.length > 0 && (
        <ul aria-label="Verified checks">{event.verifiedChecks.map((check, index) => <li key={`${event.sequence}-check-${index}`}>{check.name}: {check.outcome}{check.summary ? ` — ${check.summary}` : ''}</li>)}</ul>
      )}
    </li>
  );
}

interface AgentRunTimelineProps {
  readonly run: AgentRun;
  /** Performs an authoritative GET and returns null when it cannot be confirmed. */
  readonly onRefreshRun: () => Promise<AgentRun | null>;
}

/** Displays durable events for an existing run. This component only observes; it never controls execution. */
export const AgentRunTimeline: React.FC<AgentRunTimelineProps> = ({ run, onRefreshRun }) => {
  const [phase, setPhase] = useState<TimelinePhase>('loading-capabilities');
  const [events, setEvents] = useState<PublicAgentRunEvent[]>([]);
  const [warning, setWarning] = useState<TimelineWarning | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [olderEventsTrimmed, setOlderEventsTrimmed] = useState(false);
  const [capabilityNonce, setCapabilityNonce] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);
  const [capability, setCapability] = useState<'unknown' | 'available' | 'unavailable'>('unknown');
  const cursorRef = useRef(0);
  const entriesRef = useRef(new Map<number, PublicAgentRunEvent>());
  const terminalMarkerRef = useRef<TerminalMarker | null>(null);
  const integrityBlockedRef = useRef(false);
  const integrityTargetRef = useRef<number | null>(null);
  const warningRef = useRef<TimelineWarning | null>(null);
  const refreshRef = useRef(onRefreshRun);
  const statusRef = useRef(run.status);
  const runIdRef = useRef(run.id);
  const sessionExpiredRef = useRef(false);
  const retryLockRef = useRef(false);
  refreshRef.current = onRefreshRun;

  const publishWarning = useCallback((next: TimelineWarning) => {
    const rank: Record<WarningKind, number> = { transport: 1, status: 2, incomplete: 3, integrity: 4 };
    const existing = warningRef.current;
    if (existing && (rank[existing.kind] > rank[next.kind] || (existing.kind === next.kind && next.kind !== 'incomplete'))) return;
    warningRef.current = next;
    setWarning(next);
  }, []);

  const clearWarning = useCallback((...kinds: WarningKind[]) => {
    const existing = warningRef.current;
    if (existing && kinds.includes(existing.kind)) {
      warningRef.current = null;
      setWarning(null);
    }
  }, []);

  const clearAllWarnings = useCallback(() => {
    warningRef.current = null;
    setWarning(null);
  }, []);

  // A route change starts a new isolated replay; previous run events and warnings cannot bleed into it.
  useLayoutEffect(() => {
    if (runIdRef.current === run.id) return;
    runIdRef.current = run.id;
    cursorRef.current = 0;
    entriesRef.current.clear();
    terminalMarkerRef.current = null;
    integrityBlockedRef.current = false;
    integrityTargetRef.current = null;
    warningRef.current = null;
    statusRef.current = run.status;
    sessionExpiredRef.current = false;
    setEvents([]);
    setWarning(null);
    setOlderEventsTrimmed(false);
    setPhase('loading-capabilities');
  }, [run.id, run.status]);

  const onSessionExpired = useCallback(() => {
    sessionExpiredRef.current = true;
    cursorRef.current = 0;
    entriesRef.current.clear();
    terminalMarkerRef.current = null;
    integrityBlockedRef.current = false;
    integrityTargetRef.current = null;
    warningRef.current = null;
    setEvents([]);
    setWarning(null);
    setPhase('session-expired');
  }, []);

  useEffect(() => { statusRef.current = run.status; }, [run.id, run.status]);

  useEffect(() => {
    const session = getSessionGeneration();
    let active = true;
    sessionExpiredRef.current = false;
    setCapability('unknown');
    setPhase('loading-capabilities');
    const handleExpired = () => onSessionExpired();
    window.addEventListener(SESSION_EXPIRED_EVENT, handleExpired);
    void realApiClient.getAgentCapabilities().then((capabilities) => {
      if (!active || !isCurrentSessionGeneration(session) || sessionExpiredRef.current) return;
      setCapability(isAgentCapabilityAvailable(capabilities, 'eventReplay') && isAgentCapabilityAvailable(capabilities, 'runHistory') ? 'available' : 'unavailable');
    }).catch(() => {
      if (!active || !isCurrentSessionGeneration(session) || sessionExpiredRef.current) return;
      setCapability('unavailable');
    });
    return () => {
      active = false;
      window.removeEventListener(SESSION_EXPIRED_EVENT, handleExpired);
    };
  }, [capabilityNonce, run.id, onSessionExpired]);

  useEffect(() => {
    if (capability === 'unknown') return;
    if (capability === 'unavailable') {
      setPhase('unavailable');
      return;
    }
    if (sessionExpiredRef.current) return;

    const controller = new AbortController();
    const session = getSessionGeneration();
    let active = true;
    let reconnects = 0;
    const current = () => active && runIdRef.current === run.id && !controller.signal.aborted && !sessionExpiredRef.current && isCurrentSessionGeneration(session);
    const setActivePhase = (next: TimelinePhase) => { if (current()) setPhase(next); };
    const handleExpired = () => {
      onSessionExpired();
      controller.abort();
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, handleExpired);

    const observe = async () => {
      setActivePhase('connecting');
      while (current()) {
        let streamError: unknown = null;
        try {
          setActivePhase(reconnects === 0 ? 'connecting' : 'reconnecting');
          await realApiClient.streamAgentRunEvents(run.id, (event) => {
            if (!current()) return;
            const existing = entriesRef.current.get(event.sequence);
            if (existing) {
              if (JSON.stringify(existing) !== JSON.stringify(event)) {
                integrityBlockedRef.current = true;
                publishWarning({ kind: 'integrity', message: 'Event history contains a conflicting replay record. Refresh the run before trusting this timeline.' });
                throw new ReplayIntegrityError('Conflicting Agent event replay.');
              }
              clearWarning('transport');
              return;
            }
            if (event.sequence <= cursorRef.current) {
              clearWarning('transport');
              return; // Exact older duplicates can occur after trimming the in-memory window.
            }
            if (event.sequence !== cursorRef.current + 1) {
              integrityTargetRef.current = Math.max(integrityTargetRef.current ?? 0, event.sequence);
              publishWarning({ kind: 'integrity', message: 'Event history has a sequence gap. Replaying from the last contiguous event.' });
              throw new ReplayIntegrityError('Agent event replay gap.');
            }
            if (terminalMarkerRef.current && event.sequence > terminalMarkerRef.current.sequence) {
              integrityBlockedRef.current = true;
              publishWarning({ kind: 'integrity', message: 'Event history contains records after a terminal marker. Refresh the run before trusting this timeline.' });
              throw new ReplayIntegrityError('Agent event followed a terminal marker.');
            }

            const terminalStatus = terminalEventStatus(event);
            if (terminalStatus) {
              if (terminalMarkerRef.current) {
                integrityBlockedRef.current = true;
                publishWarning({ kind: 'integrity', message: 'Event history contains contradictory terminal markers. Refresh the run before trusting this timeline.' });
                throw new ReplayIntegrityError('Contradictory Agent terminal markers.');
              }
              terminalMarkerRef.current = { status: terminalStatus, sequence: event.sequence };
            }

            cursorRef.current = event.sequence;
            entriesRef.current.set(event.sequence, event);
            if (entriesRef.current.size > MAX_VISIBLE_EVENTS) {
              const oldest = Math.min(...entriesRef.current.keys());
              entriesRef.current.delete(oldest);
              setOlderEventsTrimmed(true);
            }
            const ordered = [...entriesRef.current.values()].sort((left, right) => left.sequence - right.sequence);
            setEvents(ordered);
            setActivePhase('live');
            clearWarning('transport');
            reconnects = 0;

            if (integrityTargetRef.current !== null && cursorRef.current >= integrityTargetRef.current) {
              integrityTargetRef.current = null;
              clearWarning('integrity');
            }
          }, { signal: controller.signal, lastEventId: cursorRef.current });
        } catch (error) {
          if (!current()) return;
          if (error instanceof ApiException && (error.status === 401 || error.status === 403 || error.status === 404)) {
            publishWarning({
              kind: 'status',
              message: error.status === 401 ? 'Your session has expired. Sign in again to continue.' : 'This run is not available to the current account.',
            });
            setActivePhase(error.status === 401 ? 'session-expired' : 'unavailable');
            return;
          }
          streamError = error;
          if (error instanceof ReplayIntegrityError || error instanceof AgentEventProjectionError || error instanceof SseValidationError || error instanceof SseBufferLimitError) {
            publishWarning({ kind: 'integrity', message: 'Event history could not be validated. Replaying from the last contiguous event.' });
          } else {
            publishWarning({ kind: 'transport', message: 'The event stream was interrupted. Run status will be checked before reconnecting.' });
          }
        }
        if (!current()) return;

        // EOF (including an observer failure that closes cleanly) is never proof that replay is complete.
        try {
          const authoritative = await refreshRef.current();
          if (!current()) return;
          if (!authoritative || authoritative.id !== run.id) {
            publishWarning({ kind: 'status', message: 'Run status could not be confirmed. Retry the timeline to continue observation.' });
            setActivePhase('paused');
            return;
          }
          statusRef.current = authoritative.status;
          clearWarning('status');
          if (isTerminal(authoritative.status)) {
            const marker = terminalMarkerRef.current;
            if (marker && marker.status !== authoritative.status) {
              integrityBlockedRef.current = true;
              publishWarning({ kind: 'integrity', message: 'The replay terminal event conflicts with the authoritative run status. Refresh the run before trusting this timeline.' });
            }
            if (marker?.status === authoritative.status && !integrityBlockedRef.current && integrityTargetRef.current === null) {
              clearAllWarnings();
              setActivePhase('complete');
              return;
            }
            publishWarning({
              kind: 'incomplete',
              message: `Run status is ${authoritative.status}, but replay has not confirmed its matching terminal event. Retrying from event ${cursorRef.current}.`,
            });
          } else if (!streamError) {
            publishWarning({ kind: 'transport', message: 'The event stream ended before a terminal event. Reconnecting to continue observation.' });
          }
        } catch {
          if (!current()) return;
          publishWarning({ kind: 'status', message: 'Run status could not be confirmed. Retry the timeline to continue observation.' });
          setActivePhase('paused');
          return;
        }

        reconnects++;
        if (reconnects > MAX_RECONNECTS) {
          publishWarning({ kind: 'incomplete', message: 'The replay did not reach a confirmed terminal event after several attempts. Retry to resume observation.' });
          setActivePhase('paused');
          return;
        }
        setActivePhase('reconnecting');
        await waitForRetry(retryDelay(reconnects), controller.signal);
      }
    };

    void observe();
    return () => {
      active = false;
      window.removeEventListener(SESSION_EXPIRED_EVENT, handleExpired);
      controller.abort(); // Observation only; the durable run continues on the server.
    };
  }, [capability, clearAllWarnings, clearWarning, onSessionExpired, publishWarning, retryNonce, run.id]);

  const retry = async () => {
    if (sessionExpiredRef.current || retryLockRef.current) return;
    retryLockRef.current = true;
    setIsRetrying(true);
    try {
      if (capability === 'unavailable') {
        setCapability('unknown');
        setPhase('loading-capabilities');
        setCapabilityNonce((value) => value + 1);
        return;
      }
      setPhase('connecting');
      const authoritative = await refreshRef.current();
      if (sessionExpiredRef.current) return;
      if (!authoritative || authoritative.id !== run.id) {
        publishWarning({ kind: 'status', message: 'Run status could not be confirmed. Try again when the Agent API is available.' });
        setPhase('paused');
        return;
      }
      statusRef.current = authoritative.status;
      clearWarning('status');
      setRetryNonce((value) => value + 1);
    } catch {
      if (sessionExpiredRef.current) return;
      publishWarning({ kind: 'status', message: 'Run status could not be confirmed. Try again when the Agent API is available.' });
      setPhase('paused');
    } finally {
      retryLockRef.current = false;
      setIsRetrying(false);
    }
  };

  const statusLabel = phase === 'loading-capabilities' ? 'Checking event replay support'
    : phase === 'connecting' ? 'Connecting to event history'
      : phase === 'live' ? 'Receiving durable events'
        : phase === 'reconnecting' ? isTerminal(statusRef.current) ? `Run ${statusRef.current} · event history incomplete · reconnecting` : 'Reconnecting to event history'
          : phase === 'complete' ? `Replay complete · run ${statusRef.current}`
            : phase === 'paused' ? isTerminal(statusRef.current) ? `Run ${statusRef.current} · event history incomplete · observation paused` : 'Observation paused'
              : phase === 'session-expired' ? 'Session expired'
                : 'Event replay unavailable';

  return (
    <section aria-labelledby="agent-run-timeline-heading" data-testid="agent-run-timeline" style={{ marginTop: 20, background: 'var(--giga-surface, #111C2D)', border: '1px solid var(--giga-border, #1E293B)', borderRadius: 12, padding: 20 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h2 id="agent-run-timeline-heading" style={{ margin: 0, fontSize: 17 }}>Run timeline</h2>
          <p role="status" aria-live="polite" data-testid="agent-timeline-status" style={{ margin: '6px 0 0', color: 'var(--giga-text-secondary, #94A3B8)' }}>{statusLabel}</p>
        </div>
        {(phase === 'paused' || phase === 'unavailable') && <Button variant="outline" onClick={() => void retry()} disabled={isRetrying} data-testid="retry-agent-timeline-btn">Retry timeline</Button>}
      </div>
      {phase === 'unavailable' && <p data-testid="agent-timeline-unavailable">The backend has not confirmed both run history and event replay support. No fallback timeline is shown.</p>}
      {warning && <div style={{ marginTop: 12 }}><Alert type="error" message={warning.message} /></div>}
      {olderEventsTrimmed && <p data-testid="agent-timeline-window-note">Showing the newest {MAX_VISIBLE_EVENTS} events. Replay cursor is #{cursorRef.current}; older events are outside this in-memory window.</p>}
      {events.length === 0 ? (
        <p data-testid="agent-timeline-empty" style={{ color: 'var(--giga-text-secondary, #94A3B8)' }}>No replayable run events have been received yet.</p>
      ) : (
        <ol aria-label="Agent run events" data-testid="agent-timeline-events" style={{ listStyle: 'none', padding: '12px 0 0', margin: 0 }}>
          {events.map((event) => <AgentEventRow key={event.sequence} event={event} />)}
        </ol>
      )}
    </section>
  );
};
