import type pg from 'pg';
import { ConflictError, NotFoundError } from '../auth/auth-validation.js';
import { encodeAgentCursor } from './validation.js';
import { RUNTIME_UNAVAILABLE, type AgentEvent, type AgentRun, type AgentStatus, type AgentWorkspace, type ListOptions, type Page, type RunInput } from './types.js';

interface WorkspaceRow {
  id: string; name: string; source_kind: 'blank'; revision: number;
  created_at: Date; updated_at: Date; cursor_created_at?: string;
}
interface RunRow extends Omit<RunInput, 'workspaceId' | 'modelId'> {
  id: string; workspace_id: string; model_alias: string; status: AgentStatus;
  last_event_id: number; request_fingerprint: string; error_code: string | null;
  created_at: Date; updated_at: Date; finished_at: Date | null; cursor_created_at?: string;
}
interface EventRow { sequence: number; event_type: AgentEvent['type']; status: AgentStatus; error_code: string | null }
const iso = (value: Date): string => new Date(value).toISOString();
const workspace = (row: WorkspaceRow): AgentWorkspace => ({ id: row.id, name: row.name, sourceKind: row.source_kind,
  revision: row.revision, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
const run = (row: RunRow): AgentRun => ({ id: row.id, workspaceId: row.workspace_id, task: row.task, mode: row.mode,
  runtime: row.runtime, modelId: row.model_alias, status: row.status,
  ...(row.status === 'queued' ? { phase: 'waiting_runtime' as const } : {}),
  createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {}),
  ...(row.error_code ? { error: RUNTIME_UNAVAILABLE } : {}) });

/** All entry points require authenticated owner scope, including internal event reads/writes. */
export class AgentRepository {
  constructor(private readonly pool: pg.Pool) {}
  private async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try { const result = await fn(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
    } finally { client.release(); }
  }

  async createWorkspace(ownerId: string, name: string): Promise<AgentWorkspace> {
    const result = await this.pool.query<WorkspaceRow>(`INSERT INTO agent_workspaces (owner_id, name)
      VALUES ($1, $2) RETURNING *`, [ownerId, name]);
    return workspace(result.rows[0]!);
  }
  async getWorkspace(ownerId: string, id: string): Promise<AgentWorkspace> {
    const result = await this.pool.query<WorkspaceRow>('SELECT * FROM agent_workspaces WHERE owner_id = $1 AND id = $2', [ownerId, id]);
    if (!result.rows[0]) throw new NotFoundError();
    return workspace(result.rows[0]);
  }
  private async runRow(ownerId: string, id: string): Promise<RunRow> {
    const result = await this.pool.query<RunRow>('SELECT * FROM agent_runs WHERE owner_id = $1 AND id = $2', [ownerId, id]);
    if (!result.rows[0]) throw new NotFoundError();
    return result.rows[0];
  }
  async getRun(ownerId: string, id: string): Promise<AgentRun> { return run(await this.runRow(ownerId, id)); }

  async listWorkspaces(ownerId: string, options: ListOptions): Promise<Page<AgentWorkspace>> {
    return this.list(ownerId, 'workspaces', options, workspace);
  }
  async listRuns(ownerId: string, options: ListOptions): Promise<Page<AgentRun>> {
    if (options.workspaceId) await this.getWorkspace(ownerId, options.workspaceId);
    return this.list(ownerId, 'runs', options, run);
  }
  private async list<T>(ownerId: string, kind: 'workspaces' | 'runs', options: ListOptions,
    map: (row: WorkspaceRow & RunRow) => T): Promise<Page<T>> {
    // Table choice is an internal constant, never a request-supplied identifier.
    const table = kind === 'workspaces' ? 'agent_workspaces' : 'agent_runs';
    const params: unknown[] = [ownerId];
    let where = 'owner_id = $1';
    if (options.workspaceId) { params.push(options.workspaceId); where += ` AND workspace_id = $${params.length}`; }
    if (options.cursor) {
      params.push(options.cursor.createdAt, options.cursor.id);
      where += ` AND (created_at < $${params.length - 1} OR (created_at = $${params.length - 1} AND id < $${params.length}))`;
    }
    params.push(options.limit + 1);
    const result = await this.pool.query<WorkspaceRow & RunRow>(`SELECT *,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
      FROM ${table} WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
    const rows = result.rows.slice(0, options.limit);
    const last = rows.at(-1);
    return { items: rows.map(map), nextCursor: result.rows.length > options.limit && last ? encodeAgentCursor({
      kind, workspaceId: options.workspaceId ?? null, createdAt: last.cursor_created_at ?? iso(last.created_at), id: last.id,
    }) : null };
  }

  /** Admission and both unavailable-runtime events commit atomically; no runner/network call occurs here. */
  async admitRun(ownerId: string, input: RunInput, key: string, fingerprint: string): Promise<{ run: AgentRun; duplicate: boolean }> {
    return this.transaction(async (client) => {
      const owned = await client.query('SELECT id FROM agent_workspaces WHERE owner_id = $1 AND id = $2 FOR UPDATE', [ownerId, input.workspaceId]);
      if (!owned.rows[0]) throw new NotFoundError();
      const replay = async (): Promise<{ run: AgentRun; duplicate: boolean } | undefined> => {
        const previous = await client.query<RunRow>('SELECT * FROM agent_runs WHERE owner_id = $1 AND idempotency_key = $2', [ownerId, key]);
        if (!previous.rows[0]) return undefined;
        if (previous.rows[0].request_fingerprint !== fingerprint) throw new ConflictError('Idempotency key was used for a different request');
        return { run: run(previous.rows[0]), duplicate: true };
      };
      const existing = await replay();
      if (existing) return existing;
      const inserted = await client.query<RunRow>(`INSERT INTO agent_runs
        (owner_id, workspace_id, task, mode, runtime, model_alias, status, idempotency_key, request_fingerprint)
        VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8)
        ON CONFLICT (owner_id, idempotency_key) DO NOTHING RETURNING *`,
      [ownerId, input.workspaceId, input.task, input.mode, input.runtime, input.modelId, key, fingerprint]);
      if (!inserted.rows[0]) {
        const raced = await replay();
        if (raced) return raced;
        throw new ConflictError('Run admission conflict');
      }
      const id = inserted.rows[0].id;
      await client.query('UPDATE agent_runs SET last_event_id = last_event_id + 1 WHERE owner_id = $1 AND id = $2', [ownerId, id]);
      await client.query(`INSERT INTO agent_run_events (owner_id, run_id, sequence, event_type, status)
        VALUES ($1, $2, 1, 'run.status', 'queued')`, [ownerId, id]);
      const failed = await client.query<RunRow>(`UPDATE agent_runs SET status = 'failed', error_code = 'RUNTIME_UNAVAILABLE',
        updated_at = NOW(), finished_at = NOW(), last_event_id = last_event_id + 1
        WHERE owner_id = $1 AND id = $2 AND status = 'queued' RETURNING *`, [ownerId, id]);
      await client.query(`INSERT INTO agent_run_events (owner_id, run_id, sequence, event_type, status, error_code)
        VALUES ($1, $2, 2, 'run.failed', 'failed', 'RUNTIME_UNAVAILABLE')`, [ownerId, id]);
      return { run: run(failed.rows[0]!), duplicate: false };
    });
  }

  /** Bounded replay window. A captured high-water mark prevents terminal-close races. */
  async events(ownerId: string, id: string, after: number): Promise<{ status: AgentStatus; lastEventId: number; items: AgentEvent[] }> {
    const current = await this.runRow(ownerId, id);
    const events = await this.pool.query<EventRow>(`SELECT sequence, event_type, status, error_code FROM agent_run_events
      WHERE owner_id = $1 AND run_id = $2 AND sequence > $3 AND sequence <= $4 ORDER BY sequence ASC LIMIT 100`,
    [ownerId, id, after, current.last_event_id]);
    return { status: current.status, lastEventId: current.last_event_id, items: events.rows.map((event) => ({
      sequence: event.sequence, type: event.event_type, data: event.event_type === 'run.failed'
        ? { runId: id, ...RUNTIME_UNAVAILABLE }
        : { runId: id, status: event.status, ...(event.status === 'queued' ? { phase: 'waiting_runtime' as const } : {}) },
    })) };
  }
}
