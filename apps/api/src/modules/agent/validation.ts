import { ValidationError } from '../auth/auth-validation.js';
import { validateUuid } from '../conversations/conversations-validation.js';
import { AGENT_MODEL_ALIAS, type AgentCursor, type ListOptions, type RunInput } from './types.js';

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Expected a JSON object');
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new ValidationError('Unknown request field');
  return value as Record<string, unknown>;
}
function text(value: unknown, maxBytes: number, field: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value.trim()) > maxBytes || value.includes('\0')) {
    throw new ValidationError(`Invalid ${field}`);
  }
  return value.trim();
}
export const agentUuid = (value: unknown): string => validateUuid(value).toLowerCase();
export function workspaceInput(value: unknown): { name: string } {
  const body = object(value, ['name', 'source']);
  const source = object(body.source, ['kind']);
  if (source.kind !== 'blank') throw new ValidationError('Only blank workspaces are supported');
  return { name: body.name === undefined ? 'New Workspace' : text(body.name, 255, 'name') };
}
export function runInput(value: unknown): RunInput {
  const body = object(value, ['workspaceId', 'task', 'mode', 'runtime', 'modelId']);
  const mode = body.mode === undefined ? 'ask' : body.mode;
  if (mode !== 'ask' && mode !== 'plan' && mode !== 'execute') throw new ValidationError('Invalid Agent mode');
  if (body.runtime !== undefined && body.runtime !== 'cloud') throw new ValidationError('Invalid Agent runtime');
  if (body.modelId !== undefined && body.modelId !== AGENT_MODEL_ALIAS) throw new ValidationError('Unsupported Agent model alias');
  return { workspaceId: agentUuid(body.workspaceId), task: text(body.task, 16384, 'task'), mode, runtime: 'cloud', modelId: AGENT_MODEL_ALIAS };
}
export function idempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new ValidationError('Invalid or missing Idempotency-Key');
  return value;
}
export function eventCursor(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  if (!/^(0|[1-9][0-9]{0,9})$/.test(value) || Number(value) > 2147483647) throw new ValidationError('Invalid Last-Event-ID');
  return Number(value);
}
export function listOptions(query: Record<string, string[]>, kind: AgentCursor['kind']): ListOptions {
  const allowed = kind === 'runs' ? ['limit', 'cursor', 'workspaceId'] : ['limit', 'cursor'];
  if (Object.entries(query).some(([key, values]) => !allowed.includes(key) || values.length !== 1)) throw new ValidationError('Invalid query parameters');
  const rawLimit = query.limit?.[0];
  if (rawLimit !== undefined && !/^(?:[1-9][0-9]?|100)$/.test(rawLimit)) throw new ValidationError('Limit must be between 1 and 100');
  const workspaceId = query.workspaceId === undefined ? undefined : agentUuid(query.workspaceId[0]);
  let cursor: AgentCursor | undefined;
  const rawCursor = query.cursor?.[0];
  if (rawCursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,1024}$/.test(rawCursor)) throw new Error();
      const decoded = Buffer.from(rawCursor, 'base64url');
      if (decoded.toString('base64url') !== rawCursor) throw new Error();
      const parsed = object(JSON.parse(decoded.toString('utf8')), ['kind', 'workspaceId', 'createdAt', 'id']);
      if (parsed.kind !== kind || parsed.workspaceId !== (workspaceId ?? null) || typeof parsed.createdAt !== 'string'
        || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(parsed.createdAt) || !Number.isFinite(Date.parse(parsed.createdAt))) throw new Error();
      // Date.parse rolls impossible dates forward; PostgreSQL rejects them. Reject before SQL.
      const milliseconds = parsed.createdAt.replace(/\.(\d{3})\d*Z$/, '.$1Z');
      if (parsed.createdAt.startsWith('0000-') || new Date(parsed.createdAt).toISOString() !== milliseconds) throw new Error();
      cursor = { kind, workspaceId: workspaceId ?? null, createdAt: parsed.createdAt, id: agentUuid(parsed.id) };
    } catch { throw new ValidationError('Invalid pagination cursor'); }
  }
  return { limit: rawLimit === undefined ? 20 : Number(rawLimit), cursor, workspaceId };
}
export const encodeAgentCursor = (value: AgentCursor): string => Buffer.from(JSON.stringify(value)).toString('base64url');
export const encodeMessageCursor = (value: import('./types.js').AgentMessageCursor): string => Buffer.from(JSON.stringify(value)).toString('base64url');

export function messageInput(value: unknown): import('./types.js').MessageInput {
  const body = object(value, ['content']);
  return { content: text(body.content, 16384, 'content') };
}

export function listMessagesOptions(query: Record<string, string[]>, runId: string): import('./types.js').ListMessagesOptions {
  const allowed = ['limit', 'cursor'];
  if (Object.entries(query).some(([key, values]) => !allowed.includes(key) || values.length !== 1)) {
    throw new ValidationError('Invalid query parameters');
  }
  const rawLimit = query.limit?.[0];
  if (rawLimit !== undefined && !/^(?:[1-9][0-9]?|100)$/.test(rawLimit)) {
    throw new ValidationError('Limit must be between 1 and 100');
  }
  let cursor: import('./types.js').AgentMessageCursor | undefined;
  const rawCursor = query.cursor?.[0];
  if (rawCursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,1024}$/.test(rawCursor)) throw new Error();
      const decoded = Buffer.from(rawCursor, 'base64url');
      if (decoded.toString('base64url') !== rawCursor) throw new Error();
      const parsed = object(JSON.parse(decoded.toString('utf8')), ['kind', 'runId', 'sequence']);
      if (
        parsed.kind !== 'messages' ||
        parsed.runId !== runId ||
        typeof parsed.sequence !== 'number' ||
        !Number.isInteger(parsed.sequence) ||
        parsed.sequence < 1
      ) {
        throw new Error();
      }
      cursor = { kind: 'messages', runId, sequence: parsed.sequence };
    } catch {
      throw new ValidationError('Invalid pagination cursor');
    }
  }
  return { limit: rawLimit === undefined ? 50 : Number(rawLimit), cursor };
}
