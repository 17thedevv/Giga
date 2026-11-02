import type { AgentStatus, VerifiedCheck } from './agent-contract.js';
import { sanitizeUntrustedText } from '../security/untrusted-content.js';

export type PublicAgentRunEvent =
  | { readonly sequence: number; readonly type: 'run.status'; readonly status: AgentStatus; readonly phase?: string }
  | { readonly sequence: number; readonly type: 'plan.updated'; readonly version: number; readonly steps: readonly string[] }
  | { readonly sequence: number; readonly type: 'tool.started'; readonly name: string; readonly stepNumber: number }
  | { readonly sequence: number; readonly type: 'tool.completed'; readonly durationMs: number; readonly summary?: string }
  | { readonly sequence: number; readonly type: 'tool.failed'; readonly code: string; readonly summary: string }
  | { readonly sequence: number; readonly type: 'run.completed'; readonly artifactIds: readonly string[]; readonly verifiedChecks: readonly VerifiedCheck[]; readonly summary?: string }
  | { readonly sequence: number; readonly type: 'run.failed'; readonly code: string; readonly message: string }
  | { readonly sequence: number; readonly type: 'unsupported'; readonly eventName: string };

export class AgentEventProjectionError extends Error {
  constructor() {
    super('The Agent event stream contained an invalid event.');
    this.name = 'AgentEventProjectionError';
  }
}

const statuses: readonly AgentStatus[] = ['queued', 'running', 'awaiting_approval', 'applying', 'completed', 'failed', 'cancelled'];
const phases = ['waiting_runtime', 'planning', 'executing', 'observing', 'verifying'] as const;
const eventNamePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_EVENT_SEQUENCE = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length > 16_384) throw new AgentEventProjectionError();
  return sanitizeUntrustedText(value).slice(0, maxLength);
}

function safeIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !identifierPattern.test(value)) throw new AgentEventProjectionError();
  return value;
}

function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : 'AGENT_EVENT_ERROR';
}

function safeChecks(value: unknown): VerifiedCheck[] {
  if (!Array.isArray(value) || value.length > 100) throw new AgentEventProjectionError();
  return value.map((item) => {
    if (!isRecord(item) || !['passed', 'failed', 'not_run'].includes(String(item.outcome))) {
      throw new AgentEventProjectionError();
    }
    return {
      name: safeText(item.name, 160),
      outcome: item.outcome as VerifiedCheck['outcome'],
      ...(item.summary === undefined ? {} : { summary: safeText(item.summary, 500) }),
    };
  });
}

/** Validate and project one SSE frame. Raw provider/internal fields are never retained. */
export function projectAgentRunEvent(
  eventName: string,
  eventId: string | undefined,
  payload: unknown,
  expectedRunId: string,
): PublicAgentRunEvent | null {
  if (eventName === 'heartbeat') return null;
  if (!eventNamePattern.test(eventName)) throw new AgentEventProjectionError();
  const known = ['run.status', 'plan.updated', 'tool.started', 'tool.completed', 'tool.failed', 'run.completed', 'run.failed'];
  if (eventId === undefined) {
    if (known.includes(eventName)) throw new AgentEventProjectionError();
    return null; // Non-persisted or additive frames without a replay cursor are ignored.
  }
  if (!/^[1-9][0-9]{0,9}$/.test(eventId)) throw new AgentEventProjectionError();
  const sequence = Number(eventId);
  if (!Number.isSafeInteger(sequence) || sequence > MAX_EVENT_SEQUENCE) throw new AgentEventProjectionError();

  if (!known.includes(eventName)) return { sequence, type: 'unsupported', eventName };
  if (!isRecord(payload) || payload.runId !== expectedRunId) throw new AgentEventProjectionError();

  switch (eventName) {
    case 'run.status': {
      if (!statuses.includes(payload.status as AgentStatus)) throw new AgentEventProjectionError();
      if (payload.phase !== undefined && !phases.includes(payload.phase as typeof phases[number])) throw new AgentEventProjectionError();
      return { sequence, type: 'run.status', status: payload.status as AgentStatus, ...(payload.phase ? { phase: payload.phase as string } : {}) };
    }
    case 'plan.updated': {
      if (!Number.isSafeInteger(payload.version) || (payload.version as number) < 1 || !Array.isArray(payload.steps) || payload.steps.length > 100) {
        throw new AgentEventProjectionError();
      }
      return { sequence, type: 'plan.updated', version: payload.version as number, steps: payload.steps.map((step) => safeText(step, 500)) };
    }
    case 'tool.started':
      if (!Number.isSafeInteger(payload.stepNumber) || (payload.stepNumber as number) < 1) throw new AgentEventProjectionError();
      safeIdentifier(payload.toolCallId);
      return { sequence, type: 'tool.started', name: safeText(payload.name, 120), stepNumber: payload.stepNumber as number };
    case 'tool.completed':
      safeIdentifier(payload.toolCallId);
      if (!Number.isFinite(payload.durationMs) || (payload.durationMs as number) < 0) throw new AgentEventProjectionError();
      if (payload.outcome !== 'success') throw new AgentEventProjectionError();
      return { sequence, type: 'tool.completed', durationMs: payload.durationMs as number, ...(payload.summary === undefined ? {} : { summary: safeText(payload.summary, 500) }) };
    case 'tool.failed':
      safeIdentifier(payload.toolCallId);
      return { sequence, type: 'tool.failed', code: safeCode(payload.code), summary: safeText(payload.summary, 500) };
    case 'run.completed':
      if (!Array.isArray(payload.artifactIds) || payload.artifactIds.length > 100) throw new AgentEventProjectionError();
      return {
        sequence,
        type: 'run.completed',
        artifactIds: payload.artifactIds.map(safeIdentifier),
        verifiedChecks: safeChecks(payload.verifiedChecks),
        ...(payload.summary === undefined ? {} : { summary: safeText(payload.summary, 1000) }),
      };
    case 'run.failed':
      return { sequence, type: 'run.failed', code: safeCode(payload.code), message: safeText(payload.message, 1000) };
    default:
      return { sequence, type: 'unsupported', eventName };
  }
}
