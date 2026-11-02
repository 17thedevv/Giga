import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ApiException, getSessionGeneration, isCurrentSessionGeneration, realApiClient, SESSION_EXPIRED_EVENT } from '../../lib/api/client.js';
import { isAgentCapabilityAvailable, type AgentRun, type AgentStatus } from '../../lib/api/agent-contract.js';
import type { PublicAgentRunEvent } from '../../lib/api/agent-events.js';
import { Alert } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';

const MAX_VISIBLE_EVENTS = 200;
const MAX_RECONNECTS = 6;

type TimelinePhase = 'loading-capabilities' | 'connecting' | 'live' | 'reconnecting' | 'complete' | 'paused' | 'unavailable' | 'session-expired';

function isTerminal(status: AgentStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
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
  const [warning, setWarning] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [olderEventsTrimmed, setOlderEventsTrimmed] = useState(false);
  const [capabilityNonce, setCapabilityNonce] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);
  const cursorRef = useRef(0);
  const entriesRef = useRef(new Map<number, PublicAgentRunEvent>());
  const refreshRef = useRef(onRefreshRun);
  const statusRef = useRef(run.status);
  const sessionExpiredRef = useRef(false);
  const retryLockRef = useRef(false);
  refreshRef.current = onRefreshRun;
  useEffect(() => { statusRef.current = run.status; }, [run.id, run.status]);

  const onSessionExpired = useCallback(() => {
    sessionExpiredRef.current = true;
    cursorRef.current = 0;
    entriesRef.current.clear();
    setEvents([]);
    setWarning(null);
    setPhase('session-expired');
  }, []);

  const [capability, setCapability] = useState<'unknown' | 'available' | 'unavailable'>('unknown');
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
    const current = () => active && !controller.signal.aborted && !sessionExpiredRef.current && isCurrentSessionGeneration(session);
    const setActivePhase = (next: TimelinePhase) => { if (current()) setPhase(next); };
    const handleExpired = () => {
      onSessionExpired();
      controller.abort();
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, handleExpired);

    const observe = async () => {
      setActivePhase('connecting');
      while (current()) {
        let streamEnded = false;
        try {
          setActivePhase(reconnects === 0 ? 'connecting' : 'reconnecting');
          await realApiClient.streamAgentRunEvents(run.id, (event) => {
            if (!current()) return;
            const existing = entriesRef.current.get(event.sequence);
            if (existing) {
              if (JSON.stringify(existing) !== JSON.stringify(event)) {
                throw new Error('Conflicting Agent event replay.');
              }
              return;
            }
            if (event.sequence <= cursorRef.current) return; // An already accepted, older replay is a duplicate.
            if (event.sequence !== cursorRef.current + 1) throw new Error('Agent event replay gap.');

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
            reconnects = 0;
          }, { signal: controller.signal, lastEventId: cursorRef.current });
          streamEnded = true;
        } catch (error) {
          if (!current()) return;
          if (error instanceof ApiException && (error.status === 401 || error.status === 403 || error.status === 404)) {
            setWarning(error.status === 401 ? 'Your session has expired. Sign in again to continue.' : 'This run is not available to the current account.');
            setActivePhase(error.status === 401 ? 'session-expired' : 'unavailable');
            return;
          }
          setWarning('The event stream was interrupted. Run status will be checked before reconnecting.');
        }
        if (!current()) return;

        // A closed stream is not a run result. Confirm status through the owner-scoped GET.
        try {
          const authoritative = await refreshRef.current();
          if (!current()) return;
          if (!authoritative || authoritative.id !== run.id) {
            setWarning('Run status could not be confirmed. Retry the timeline to continue observation.');
            setActivePhase('paused');
            return;
          }
          statusRef.current = authoritative.status;
          if (isTerminal(authoritative.status) && streamEnded) {
            setActivePhase('complete');
            return;
          }
        } catch {
          if (!current()) return;
          setWarning('Run status could not be confirmed. Retry the timeline to continue observation.');
          setActivePhase('paused');
          return;
        }

        reconnects++;
        if (reconnects > MAX_RECONNECTS) {
          setWarning('The event stream remained unavailable after several attempts. Retry to resume observation.');
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
  }, [capability, onSessionExpired, retryNonce, run.id]);

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
      setWarning(null);
      setPhase('connecting');
      const authoritative = await refreshRef.current();
      if (sessionExpiredRef.current) return;
      if (!authoritative || authoritative.id !== run.id) {
        setWarning('Run status could not be confirmed. Try again when the Agent API is available.');
        setPhase('paused');
        return;
      }
      statusRef.current = authoritative.status;
      setRetryNonce((value) => value + 1);
    } finally {
      retryLockRef.current = false;
      setIsRetrying(false);
    }
  };

  const statusLabel = phase === 'loading-capabilities' ? 'Checking event replay support'
    : phase === 'connecting' ? 'Connecting to event history'
      : phase === 'live' ? 'Receiving durable events'
        : phase === 'reconnecting' ? 'Reconnecting to event history'
          : phase === 'complete' ? `Replay complete · run ${statusRef.current}`
            : phase === 'paused' ? 'Observation paused'
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
      {warning && <div role="alert" style={{ marginTop: 12 }}><Alert type="error" message={warning} /></div>}
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
