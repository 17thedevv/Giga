import type pg from 'pg';
import { ConflictError, NotFoundError } from '../auth/auth-validation.js';
import { encodeAgentCursor, encodeMessageCursor } from './validation.js';
import {
  RUNTIME_UNAVAILABLE,
  type AgentEvent,
  type AgentEventType,
  type AgentMessage,
  type AgentMessageRole,
  type AgentRun,
  type AgentStep,
  type AgentStatus,
  type AgentWorkspace,
  type BoundedConversationMessage,
  type ClaimedRun,
  type ConversationContextBoundary,
  type ListMessagesOptions,
  type ListOptions,
  type Page,
  type RunInput,
  type StepStatus,
  type ToolRisk,
  type VerifiedCheck,
  type WorkerLease,
} from './types.js';
import type { AgentPlan } from './decision-provider.js';

interface MessageRow {
  id: string;
  owner_id: string;
  workspace_id: string;
  run_id: string;
  sequence: number;
  role: AgentMessageRole;
  content: string;
  idempotency_key: string | null;
  request_fingerprint: string | null;
  created_at: Date;
}

interface WorkspaceRow {
  id: string;
  name: string;
  source_kind: 'blank';
  revision: number;
  created_at: Date;
  updated_at: Date;
  cursor_created_at?: string;
}

interface RunRow extends Omit<RunInput, 'workspaceId' | 'modelId'> {
  id: string;
  workspace_id: string;
  model_alias: string;
  status: AgentStatus;
  last_event_id: number;
  request_fingerprint: string;
  error_code: string | null;
  worker_id: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  attempt_count: number;
  verified_checks: VerifiedCheck[] | null;
  result_summary: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
  cursor_created_at?: string;
}

interface EventRow {
  sequence: number;
  event_type: AgentEventType;
  status: AgentStatus;
  error_code: string | null;
  payload: unknown | null;
}

interface StepRow {
  id: string;
  owner_id: string;
  run_id: string;
  step_number: number;
  status: StepStatus;
  tool_name: string;
  tool_call_id: string;
  tool_risk: ToolRisk;
  arguments_json: unknown;
  result_json: unknown | null;
  error_code: string | null;
  error_message: string | null;
  duration_ms: number | null;
  created_at: Date;
  completed_at: Date | null;
}

const iso = (value: Date): string => new Date(value).toISOString();

const workspace = (row: WorkspaceRow): AgentWorkspace => ({
  id: row.id,
  name: row.name,
  sourceKind: row.source_kind,
  revision: row.revision,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const run = (row: RunRow): AgentRun => {
  const result: AgentRun = {
    id: row.id,
    workspaceId: row.workspace_id,
    task: row.task,
    mode: row.mode,
    runtime: row.runtime,
    modelId: row.model_alias,
    status: row.status,
    ...(row.status === 'queued' ? { phase: 'waiting_runtime' as const } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {}),
    ...(row.error_code
      ? {
          error: {
            code: row.error_code,
            message:
              row.result_summary ??
              (row.error_code === 'RUNTIME_UNAVAILABLE'
                ? RUNTIME_UNAVAILABLE.message
                : `Agent run failed: ${row.error_code}`),
          },
        }
      : {}),
    ...(row.result_summary && row.status === 'completed'
      ? {
          result: {
            summary: row.result_summary,
            artifactIds: [],
            verifiedChecks: row.verified_checks ?? [],
          },
        }
      : {}),
  };
  return result;
};

const step = (row: StepRow): AgentStep => ({
  id: row.id,
  runId: row.run_id,
  stepNumber: row.step_number,
  status: row.status,
  toolName: row.tool_name,
  toolCallId: row.tool_call_id,
  toolRisk: row.tool_risk,
  arguments: (row.arguments_json as Record<string, unknown>) ?? {},
  ...(row.result_json ? { result: row.result_json as Record<string, unknown> } : {}),
  ...(row.error_code ? { errorCode: row.error_code } : {}),
  ...(row.error_message ? { errorMessage: row.error_message } : {}),
  ...(row.duration_ms !== null && row.duration_ms !== undefined ? { durationMs: row.duration_ms } : {}),
  createdAt: iso(row.created_at),
  ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
});

const message = (row: MessageRow): AgentMessage => ({
  id: row.id,
  workspaceId: row.workspace_id,
  runId: row.run_id,
  sequence: row.sequence,
  role: row.role,
  content: row.content,
  createdAt: iso(row.created_at),
});

export type { ClaimedRun, WorkerLease };

export interface StepStartInput {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly risk: ToolRisk;
  readonly arguments: Record<string, unknown>;
}

export interface StepCompleteInput {
  readonly output: Record<string, unknown>;
  readonly durationMs: number;
  readonly summary?: string;
}

export interface StepFailInput {
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly durationMs?: number;
}

export type RunFinalizeInput =
  | { readonly status: 'completed'; readonly summary: string; readonly verifiedChecks: readonly VerifiedCheck[] }
  | { readonly status: 'failed'; readonly errorCode: string; readonly errorMessage: string }
  | { readonly status: 'cancelled' };

/** All entry points require authenticated owner scope, including internal event reads/writes. */
export class AgentRepository {
  private static readonly runLocks = new Map<string, Promise<void>>();

  constructor(private readonly pool: pg.Pool) {}

  static getActiveLockCount(): number {
    return AgentRepository.runLocks.size;
  }

  private async withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = AgentRepository.runLocks.get(runId) ?? Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = prev.then(() => next, () => next);
    AgentRepository.runLocks.set(runId, current);
    try {
      await prev;
      return await fn();
    } finally {
      release!();
      if (AgentRepository.runLocks.get(runId) === current) {
        AgentRepository.runLocks.delete(runId);
      }
    }
  }

  private async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const res = await fn(client);
        await client.query('COMMIT');
        return res;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      client.release();
    }
  }

  async createWorkspace(ownerId: string, name: string): Promise<AgentWorkspace> {
    const result = await this.pool.query<WorkspaceRow>(
      `INSERT INTO agent_workspaces (owner_id, name) VALUES ($1, $2) RETURNING *`,
      [ownerId, name]
    );
    return workspace(result.rows[0]!);
  }

  async getWorkspace(ownerId: string, id: string): Promise<AgentWorkspace> {
    const result = await this.pool.query<WorkspaceRow>(
      'SELECT * FROM agent_workspaces WHERE owner_id = $1 AND id = $2',
      [ownerId, id]
    );
    if (!result.rows[0]) throw new NotFoundError();
    return workspace(result.rows[0]);
  }

  private async runRow(ownerId: string, id: string): Promise<RunRow> {
    const result = await this.pool.query<RunRow>(
      'SELECT * FROM agent_runs WHERE owner_id = $1 AND id = $2',
      [ownerId, id]
    );
    if (!result.rows[0]) throw new NotFoundError();
    return result.rows[0];
  }

  async getRun(ownerId: string, id: string): Promise<AgentRun> {
    return run(await this.runRow(ownerId, id));
  }

  async listWorkspaces(ownerId: string, options: ListOptions): Promise<Page<AgentWorkspace>> {
    return this.list(ownerId, 'workspaces', options, workspace);
  }

  async listRuns(ownerId: string, options: ListOptions): Promise<Page<AgentRun>> {
    if (options.workspaceId) await this.getWorkspace(ownerId, options.workspaceId);
    return this.list(ownerId, 'runs', options, run);
  }

  private async list<T>(
    ownerId: string,
    kind: 'workspaces' | 'runs',
    options: ListOptions,
    map: (row: WorkspaceRow & RunRow) => T
  ): Promise<Page<T>> {
    const table = kind === 'workspaces' ? 'agent_workspaces' : 'agent_runs';
    const params: unknown[] = [ownerId];
    let where = 'owner_id = $1';
    if (options.workspaceId) {
      params.push(options.workspaceId);
      where += ` AND workspace_id = $${params.length}`;
    }
    if (options.cursor) {
      params.push(options.cursor.createdAt, options.cursor.id);
      where += ` AND (created_at < $${params.length - 1} OR (created_at = $${params.length - 1} AND id < $${params.length}))`;
    }
    params.push(options.limit + 1);
    const result = await this.pool.query<WorkspaceRow & RunRow>(
      `SELECT *,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
      FROM ${table} WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params
    );
    const rows = result.rows.slice(0, options.limit);
    const last = rows.at(-1);
    return {
      items: rows.map(map),
      nextCursor:
        result.rows.length > options.limit && last
          ? encodeAgentCursor({
              kind,
              workspaceId: options.workspaceId ?? null,
              createdAt: last.cursor_created_at ?? iso(last.created_at),
              id: last.id,
            })
          : null,
    };
  }

  private hasMessagesTable: boolean | undefined;

  private async canPersistMessages(client: pg.PoolClient | pg.Pool): Promise<boolean> {
    if (this.hasMessagesTable) return true;
    try {
      const res = await client.query('SELECT 1 FROM schema_migrations WHERE version = 13 LIMIT 1');
      if ((res.rowCount ?? 0) > 0) {
        this.hasMessagesTable = true;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Admission for default control plane without active runner.
   * Atomically commits queued event 1, failed event 2 (RUNTIME_UNAVAILABLE), and the final failed run.
   */
  async admitRun(
    ownerId: string,
    input: RunInput,
    key: string,
    fingerprint: string
  ): Promise<{ run: AgentRun; duplicate: boolean }> {
    return this.transaction(async (client) => {
      const owned = await client.query(
        'SELECT id FROM agent_workspaces WHERE owner_id = $1 AND id = $2 FOR UPDATE',
        [ownerId, input.workspaceId]
      );
      if (!owned.rows[0]) throw new NotFoundError();

      const replay = async (): Promise<{ run: AgentRun; duplicate: boolean } | undefined> => {
        const previous = await client.query<RunRow>(
          'SELECT * FROM agent_runs WHERE owner_id = $1 AND idempotency_key = $2',
          [ownerId, key]
        );
        if (!previous.rows[0]) return undefined;
        if (previous.rows[0].request_fingerprint !== fingerprint) {
          throw new ConflictError('Idempotency key was used for a different request');
        }
        return { run: run(previous.rows[0]), duplicate: true };
      };

      const existing = await replay();
      if (existing) return existing;

      const inserted = await client.query<RunRow>(
        `INSERT INTO agent_runs
        (owner_id, workspace_id, task, mode, runtime, model_alias, status, idempotency_key, request_fingerprint)
        VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8)
        ON CONFLICT (owner_id, idempotency_key) DO NOTHING RETURNING *`,
        [ownerId, input.workspaceId, input.task, input.mode, input.runtime, input.modelId, key, fingerprint]
      );
      if (!inserted.rows[0]) {
        const raced = await replay();
        if (raced) return raced;
        throw new ConflictError('Run admission conflict');
      }

      const id = inserted.rows[0].id;
      if (await this.canPersistMessages(client)) {
        await client.query(
          `INSERT INTO agent_messages (owner_id, workspace_id, run_id, sequence, role, content)
          VALUES ($1, $2, $3, 1, 'user', $4)`,
          [ownerId, input.workspaceId, id, input.task]
        );
      }
      await client.query('UPDATE agent_runs SET last_event_id = last_event_id + 1 WHERE owner_id = $1 AND id = $2', [
        ownerId,
        id,
      ]);
      await client.query(
        `INSERT INTO agent_run_events (owner_id, run_id, sequence, event_type, status)
        VALUES ($1, $2, 1, 'run.status', 'queued')`,
        [ownerId, id]
      );

      const failed = await client.query<RunRow>(
        `UPDATE agent_runs SET status = 'failed', error_code = 'RUNTIME_UNAVAILABLE',
        updated_at = NOW(), finished_at = NOW(), last_event_id = last_event_id + 1
        WHERE owner_id = $1 AND id = $2 AND status = 'queued' RETURNING *`,
        [ownerId, id]
      );
      await client.query(
        `INSERT INTO agent_run_events (owner_id, run_id, sequence, event_type, status, error_code)
        VALUES ($1, $2, 2, 'run.failed', 'failed', 'RUNTIME_UNAVAILABLE')`,
        [ownerId, id]
      );

      return { run: run(failed.rows[0]!), duplicate: false };
    });
  }

  /**
   * Enqueues an active run in queued status for background or orchestrator dispatch.
   */
  async enqueueRun(
    ownerId: string,
    input: RunInput,
    key: string,
    fingerprint: string
  ): Promise<{ run: AgentRun; duplicate: boolean }> {
    return this.transaction(async (client) => {
      const owned = await client.query(
        'SELECT id FROM agent_workspaces WHERE owner_id = $1 AND id = $2 FOR UPDATE',
        [ownerId, input.workspaceId]
      );
      if (!owned.rows[0]) throw new NotFoundError();

      const replay = async (): Promise<{ run: AgentRun; duplicate: boolean } | undefined> => {
        const previous = await client.query<RunRow>(
          'SELECT * FROM agent_runs WHERE owner_id = $1 AND idempotency_key = $2',
          [ownerId, key]
        );
        if (!previous.rows[0]) return undefined;
        if (previous.rows[0].request_fingerprint !== fingerprint) {
          throw new ConflictError('Idempotency key was used for a different request');
        }
        return { run: run(previous.rows[0]), duplicate: true };
      };

      const existing = await replay();
      if (existing) return existing;

      const inserted = await client.query<RunRow>(
        `INSERT INTO agent_runs
        (owner_id, workspace_id, task, mode, runtime, model_alias, status, idempotency_key, request_fingerprint, last_event_id)
        VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, 1)
        ON CONFLICT (owner_id, idempotency_key) DO NOTHING RETURNING *`,
        [ownerId, input.workspaceId, input.task, input.mode, input.runtime, input.modelId, key, fingerprint]
      );
      if (!inserted.rows[0]) {
        const raced = await replay();
        if (raced) return raced;
        throw new ConflictError('Run admission conflict');
      }

      const id = inserted.rows[0].id;
      if (await this.canPersistMessages(client)) {
        await client.query(
          `INSERT INTO agent_messages (owner_id, workspace_id, run_id, sequence, role, content)
          VALUES ($1, $2, $3, 1, 'user', $4)`,
          [ownerId, input.workspaceId, id, input.task]
        );
      }
      await client.query(
        `INSERT INTO agent_run_events (owner_id, run_id, sequence, event_type, status, payload)
        VALUES ($1, $2, 1, 'run.status', 'queued', $3)`,
        [ownerId, id, JSON.stringify({ runId: id, status: 'queued', phase: 'waiting_runtime' })]
      );

      return { run: run(inserted.rows[0]!), duplicate: false };
    });
  }

  /**
   * Claims an eligible queued or stale run for execution by a worker.
   * Guarantees:
   * - One effective active worker per run
   * - Stale-worker fencing via attempt count and unique lease token
   * - Terminal runs cannot be claimed
   */
  async claimRun(
    ownerId: string,
    runId: string,
    workerId: string,
    leaseDurationMs = 30000
  ): Promise<ClaimedRun | null> {
    return this.transaction(async (client) => {
      const res = await client.query<RunRow>(
        'SELECT * FROM agent_runs WHERE owner_id = $1 AND id = $2 FOR UPDATE',
        [ownerId, runId]
      );
      const row = res.rows[0];
      if (!row) throw new NotFoundError();

      if (['completed', 'failed', 'cancelled'].includes(row.status)) {
        return null;
      }

      const leaseToken = `lease-${crypto.randomUUID()}`;
      const expiresAt = new Date(Date.now() + leaseDurationMs);

      if (row.status === 'queued') {
        const updated = await client.query<RunRow>(
          `UPDATE agent_runs
          SET status = 'running', worker_id = $1, lease_token = $2, lease_expires_at = $3,
              attempt_count = attempt_count + 1, updated_at = NOW(), last_event_id = last_event_id + 1
          WHERE owner_id = $4 AND id = $5 AND status = 'queued'
          RETURNING *`,
          [workerId, leaseToken, expiresAt, ownerId, runId]
        );
        if (!updated.rows[0]) return null;

        await client.query(
          `INSERT INTO agent_run_events (owner_id, run_id, sequence, event_type, status, payload)
          VALUES ($1, $2, $3, 'run.status', 'running', $4)`,
          [ownerId, runId, updated.rows[0].last_event_id, JSON.stringify({ runId, status: 'running' })]
        );

        return {
          run: run(updated.rows[0]),
          leaseToken,
          leaseExpiresAt: iso(expiresAt),
          workerId,
          attemptCount: updated.rows[0].attempt_count,
        };
      }

      if (row.status === 'running') {
        // If lease is still active, another worker owns it
        if (row.lease_expires_at && new Date(row.lease_expires_at).getTime() > Date.now()) {
          return null;
        }

        // Stale lease takeover: bump attempt count and allocate new lease token
        const updated = await client.query<RunRow>(
          `UPDATE agent_runs
          SET worker_id = $1, lease_token = $2, lease_expires_at = $3,
              attempt_count = attempt_count + 1, updated_at = NOW()
          WHERE owner_id = $4 AND id = $5 AND status = 'running'
          RETURNING *`,
          [workerId, leaseToken, expiresAt, ownerId, runId]
        );
        if (!updated.rows[0]) return null;

        return {
          run: run(updated.rows[0]),
          leaseToken,
          leaseExpiresAt: iso(expiresAt),
          workerId,
          attemptCount: updated.rows[0].attempt_count,
        };
      }

      return null;
    });
  }

  private assertActiveLease(row: RunRow | undefined, leaseToken: string): void {
    if (
      !row ||
      row.status !== 'running' ||
      row.lease_token !== leaseToken ||
      !row.lease_expires_at ||
      new Date(row.lease_expires_at).getTime() <= Date.now()
    ) {
      throw new ConflictError('Worker fenced: lease expired or run status changed');
    }
  }

  /**
   * Appends a plan.updated event with lease fencing verification.
   */
  async appendPlanUpdatedEvent(
    ownerId: string,
    runId: string,
    leaseToken: string,
    plan: AgentPlan
  ): Promise<AgentEvent> {
    return this.transaction(async (client) => {
      const lock = await client.query<RunRow>(
        'SELECT lease_token, status, last_event_id, lease_expires_at FROM agent_runs WHERE owner_id = $1 AND id = $2 FOR UPDATE',
        [ownerId, runId]
      );
      this.assertActiveLease(lock.rows[0], leaseToken);
      const row = lock.rows[0]!;

      const nextSequence = row.last_event_id + 1;
      await client.query(
        'UPDATE agent_runs SET last_event_id = $1, updated_at = NOW() WHERE owner_id = $2 AND id = $3',
        [nextSequence, ownerId, runId]
      );

      const payload = { runId, version: plan.version, steps: plan.steps };
      await client.query(
        `INSERT INTO agent_run_events (owner_id, run_id, sequence, event_type, status, payload)
        VALUES ($1, $2, $3, 'plan.updated', 'running', $4)`,
        [ownerId, runId, nextSequence, JSON.stringify(payload)]
      );

      return { sequence: nextSequence, type: 'plan.updated', data: payload };
    });
  }

  /**
   * Records a started step and emits tool.started event atomically.
   */
  async recordStepStarted(
    ownerId: string,
    runId: string,
    leaseToken: string,
    input: StepStartInput
  ): Promise<{ step: AgentStep; event: AgentEvent }> {
    return this.transaction(async (client) => {
      const lock = await client.query<RunRow>(
        'SELECT lease_token, status, last_event_id, lease_expires_at FROM agent_runs WHERE owner_id = $1 AND id = $2 FOR UPDATE',
        [ownerId, runId]
      );
      this.assertActiveLease(lock.rows[0], leaseToken);
      const runCurrent = lock.rows[0]!;

      const seqRes = await client.query<{ next_step: number }>(
        'SELECT COALESCE(MAX(step_number), 0) + 1 AS next_step FROM agent_run_steps WHERE run_id = $1',
        [runId]
      );
      const stepNumber = seqRes.rows[0]!.next_step;

      const sanitizedArgs = AgentRepository.redactJsonValue(input.arguments);
      const stepInsert = await client.query<StepRow>(
        `INSERT INTO agent_run_steps
        (owner_id, run_id, step_number, status, tool_name, tool_call_id, tool_risk, arguments_json)
        VALUES ($1, $2, $3, 'running', $4, $5, $6, $7)
        RETURNING *`,
        [ownerId, runId, stepNumber, input.toolName, input.toolCallId, input.risk, JSON.stringify(sanitizedArgs)]
      );

      const nextEventSeq = runCurrent.last_event_id + 1;
      await client.query(
        'UPDATE agent_runs SET last_event_id = $1, updated_at = NOW() WHERE owner_id = $2 AND id = $3',
        [nextEventSeq, ownerId, runId]
      );

      const eventPayload = { runId, toolCallId: input.toolCallId, name: input.toolName, stepNumber };
      await client.query(
        `INSERT INTO agent_run_events (owner_id, run_id, sequence, event_type, status, payload)
        VALUES ($1, $2, $3, 'tool.started', 'running', $4)`,
        [ownerId, runId, nextEventSeq, JSON.stringify(eventPayload)]
      );

      return {
        step: step(stepInsert.rows[0]!),
        event: { sequence: nextEventSeq, type: 'tool.started', data: eventPayload },
      };
    });
  }

  /**
   * Records a completed step and emits tool.completed event atomically.
   */
  async recordStepCompleted(
    ownerId: string,
    runId: string,
    leaseToken: string,
    stepNumber: number,
    input: StepCompleteInput
  ): Promise<{ step: AgentStep; event: AgentEvent }> {
    return this.transaction(async (client) => {
      const lock = await client.query<RunRow>(
        'SELECT lease_token, status, last_event_id, lease_expires_at FROM agent_runs WHERE owner_id = $1 AND id = $2 FOR UPDATE',
        [ownerId, runId]
      );
      this.assertActiveLease(lock.rows[0], leaseToken);
      const runCurrent = lock.rows[0]!;

      const sanitizedOutput = AgentRepository.redactJsonValue(input.output);
      const sanitizedSummary = input.summary ? AgentRepository.redactSensitiveContent(input.summary) : undefined;

      const stepUpdate = await client.query<StepRow>(
        `UPDATE agent_run_steps
        SET status = 'completed', result_json = $1, duration_ms = $2, completed_at = NOW()
        WHERE owner_id = $3 AND run_id = $4 AND step_number = $5 AND status = 'running'
        RETURNING *`,
        [JSON.stringify(sanitizedOutput), input.durationMs, ownerId, runId, stepNumber]
      );
      if (!stepUpdate.rows[0]) throw new ConflictError('Step is not in running status');

      const nextEventSeq = runCurrent.last_event_id + 1;
      await client.query(
        'UPDATE agent_runs SET last_event_id = $1, updated_at = NOW() WHERE owner_id = $2 AND id = $3',
        [nextEventSeq, ownerId, runId]
      );

      const eventPayload = {
        runId,
        toolCallId: stepUpdate.rows[0].tool_call_id,
        outcome: 'success' as const,
        durationMs: input.durationMs,
        ...(sanitizedSummary ? { summary: sanitizedSummary } : {}),
      };
      await client.query(
        `INSERT INTO agent_run_events (owner_id, run_id, sequence, event_type, status, payload)
        VALUES ($1, $2, $3, 'tool.completed', 'running', $4)`,
        [ownerId, runId, nextEventSeq, JSON.stringify(eventPayload)]
      );

      return {
        step: step(stepUpdate.rows[0]),
        event: { sequence: nextEventSeq, type: 'tool.completed', data: eventPayload },
      };
    });
  }

  /**
   * Records a failed step and emits tool.failed event atomically.
   */
  async recordStepFailed(
    ownerId: string,
    runId: string,
    leaseToken: string,
    stepNumber: number,
    failure: StepFailInput
  ): Promise<{ step: AgentStep; event: AgentEvent }> {
    return this.transaction(async (client) => {
      const lock = await client.query<RunRow>(
        'SELECT lease_token, status, last_event_id, lease_expires_at FROM agent_runs WHERE owner_id = $1 AND id = $2 FOR UPDATE',
        [ownerId, runId]
      );
      this.assertActiveLease(lock.rows[0], leaseToken);
      const runCurrent = lock.rows[0]!;

      const sanitizedErrorMessage = AgentRepository.redactSensitiveContent(failure.errorMessage);

      const stepUpdate = await client.query<StepRow>(
        `UPDATE agent_run_steps
        SET status = 'failed', error_code = $1, error_message = $2, duration_ms = $3, completed_at = NOW()
        WHERE owner_id = $4 AND run_id = $5 AND step_number = $6 AND status = 'running'
        RETURNING *`,
        [failure.errorCode, sanitizedErrorMessage, failure.durationMs ?? 0, ownerId, runId, stepNumber]
      );
      if (!stepUpdate.rows[0]) throw new ConflictError('Step is not in running status');

      const nextEventSeq = runCurrent.last_event_id + 1;
      await client.query(
        'UPDATE agent_runs SET last_event_id = $1, updated_at = NOW() WHERE owner_id = $2 AND id = $3',
        [nextEventSeq, ownerId, runId]
      );

      const eventPayload = {
        runId,
        toolCallId: stepUpdate.rows[0].tool_call_id,
        code: failure.errorCode,
        summary: sanitizedErrorMessage,
      };
      await client.query(
        `INSERT INTO agent_run_events (owner_id, run_id, sequence, event_type, status, payload)
        VALUES ($1, $2, $3, 'tool.failed', 'running', $4)`,
        [ownerId, runId, nextEventSeq, JSON.stringify(eventPayload)]
      );

      return {
        step: step(stepUpdate.rows[0]),
        event: { sequence: nextEventSeq, type: 'tool.failed', data: eventPayload },
      };
    });
  }

  /**
   * Finalizes the run as completed, failed, or cancelled. Fenced by active lease token.
   * Protects against completion race if a new follow-up message arrived while deciding.
   */
  async finalizeRun(
    ownerId: string,
    runId: string,
    leaseToken: string,
    outcome: RunFinalizeInput,
    options?: { expectedMaxSequence?: number }
  ): Promise<{ run: AgentRun; event: AgentEvent }> {
    return this.withRunLock(runId, async () => {
      return this.transaction(async (client) => {
        const lock = await client.query<RunRow>(
          'SELECT lease_token, status, last_event_id, lease_expires_at FROM agent_runs WHERE owner_id = $1 AND id = $2 FOR UPDATE',
          [ownerId, runId]
        );
        this.assertActiveLease(lock.rows[0], leaseToken);
        const runCurrent = lock.rows[0]!;

        // Race guard: If finalizing as completed, verify that no new user messages arrived
        // after the expected sequence snapshot was processed.
        if (outcome.status === 'completed' && options?.expectedMaxSequence !== undefined) {
          const maxSeqRes = await client.query<{ max_seq: number }>(
            'SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM agent_messages WHERE run_id = $1',
            [runId]
          );
          const currentMaxSeq = Number(maxSeqRes.rows[0]?.max_seq ?? 0);
          if (currentMaxSeq > options.expectedMaxSequence) {
            throw new ConflictError(
              `Cannot complete run: follow-up message sequence ${currentMaxSeq} arrived after processed sequence ${options.expectedMaxSequence}`
            );
          }
        }

        const nextEventSeq = runCurrent.last_event_id + 1;

        if (outcome.status === 'completed') {
          const sanitizedSummary = AgentRepository.redactSensitiveContent(outcome.summary);
          const boundedSummary = AgentRepository.boundUtf8(sanitizedSummary);
          const sanitizedChecks = outcome.verifiedChecks.map((c) => ({
            ...c,
            summary: c.summary ? AgentRepository.boundUtf8(AgentRepository.redactSensitiveContent(c.summary)) : c.summary,
          }));
          const update = await client.query<RunRow>(
            `UPDATE agent_runs
            SET status = 'completed', finished_at = NOW(), verified_checks = $1, result_summary = $2,
                last_event_id = $3, updated_at = NOW()
            WHERE owner_id = $4 AND id = $5 AND status = 'running'
            RETURNING *`,
            [JSON.stringify(sanitizedChecks), boundedSummary, nextEventSeq, ownerId, runId]
          );
          const updated = update.rows[0]!;

          const payload = {
            runId,
            artifactIds: [],
            verifiedChecks: sanitizedChecks,
            summary: boundedSummary,
          };
          await client.query(
            `INSERT INTO agent_run_events (owner_id, run_id, sequence, event_type, status, payload)
            VALUES ($1, $2, $3, 'run.completed', 'completed', $4)`,
            [ownerId, runId, nextEventSeq, JSON.stringify(payload)]
          );

          if (boundedSummary && boundedSummary.trim().length > 0 && (await this.canPersistMessages(client))) {
            const nextMsgSeq = await client.query<{ next_seq: number }>(
              'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM agent_messages WHERE run_id = $1',
              [runId]
            );
            await client.query(
              `INSERT INTO agent_messages (owner_id, workspace_id, run_id, sequence, role, content)
              VALUES ($1, $2, $3, $4, 'assistant', $5)`,
              [ownerId, updated.workspace_id, runId, nextMsgSeq.rows[0]!.next_seq, boundedSummary]
            );
          }

          return {
            run: run(updated),
            event: { sequence: nextEventSeq, type: 'run.completed', data: payload },
          };
        }

        if (outcome.status === 'failed') {
          const sanitizedErrorMessage = AgentRepository.redactSensitiveContent(outcome.errorMessage);
          const update = await client.query<RunRow>(
            `UPDATE agent_runs
            SET status = 'failed', finished_at = NOW(), error_code = $1, result_summary = $2,
                last_event_id = $3, updated_at = NOW()
            WHERE owner_id = $4 AND id = $5 AND status = 'running'
            RETURNING *`,
            [outcome.errorCode, sanitizedErrorMessage, nextEventSeq, ownerId, runId]
          );
          const updated = update.rows[0]!;

          const payload = { runId, code: outcome.errorCode, message: sanitizedErrorMessage };
          await client.query(
            `INSERT INTO agent_run_events (owner_id, run_id, sequence, event_type, status, error_code, payload)
            VALUES ($1, $2, $3, 'run.failed', 'failed', $4, $5)`,
            [ownerId, runId, nextEventSeq, outcome.errorCode, JSON.stringify(payload)]
          );

          return {
            run: run(updated),
            event: { sequence: nextEventSeq, type: 'run.failed', data: payload },
          };
        }

        // Cancelled
        const update = await client.query<RunRow>(
          `UPDATE agent_runs
          SET status = 'cancelled', finished_at = NOW(), last_event_id = $1, updated_at = NOW()
          WHERE owner_id = $2 AND id = $3 AND status = 'running'
          RETURNING *`,
          [nextEventSeq, ownerId, runId]
        );
        const updated = update.rows[0]!;

        const payload = { runId, status: 'cancelled' as const };
        await client.query(
          `INSERT INTO agent_run_events (owner_id, run_id, sequence, event_type, status, payload)
          VALUES ($1, $2, $3, 'run.status', 'cancelled', $4)`,
          [ownerId, runId, nextEventSeq, JSON.stringify(payload)]
        );

        return {
          run: run(updated),
          event: { sequence: nextEventSeq, type: 'run.status', data: payload },
        };
      });
    });
  }

  async releaseLease(ownerId: string, runId: string, leaseToken: string): Promise<void> {
    await this.pool.query(
      `UPDATE agent_runs SET lease_expires_at = NOW() - INTERVAL '1 second'
      WHERE owner_id = $1 AND id = $2 AND lease_token = $3`,
      [ownerId, runId, leaseToken]
    );
  }

  async renewLease(ownerId: string, runId: string, leaseToken: string, extensionMs = 30000): Promise<boolean> {
    const newExpiresAt = new Date(Date.now() + extensionMs);
    const res = await this.pool.query(
      `UPDATE agent_runs
      SET lease_expires_at = $1, updated_at = NOW()
      WHERE owner_id = $2 AND id = $3 AND lease_token = $4 AND status = 'running' AND lease_expires_at > NOW()`,
      [newExpiresAt, ownerId, runId, leaseToken]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async listSteps(ownerId: string, runId: string): Promise<readonly AgentStep[]> {
    // Owner check
    await this.getRun(ownerId, runId);
    const result = await this.pool.query<StepRow>(
      'SELECT * FROM agent_run_steps WHERE owner_id = $1 AND run_id = $2 ORDER BY step_number ASC',
      [ownerId, runId]
    );
    return result.rows.map(step);
  }

  /** Bounded replay window. A captured high-water mark prevents terminal-close races. */
  async events(
    ownerId: string,
    id: string,
    after: number
  ): Promise<{ status: AgentStatus; lastEventId: number; items: AgentEvent[] }> {
    const current = await this.runRow(ownerId, id);
    let events: pg.QueryResult<EventRow>;
    try {
      events = await this.pool.query<EventRow>(
        `SELECT sequence, event_type, status, error_code, payload FROM agent_run_events
        WHERE owner_id = $1 AND run_id = $2 AND sequence > $3 AND sequence <= $4 ORDER BY sequence ASC LIMIT 100`,
        [ownerId, id, after, current.last_event_id]
      );
    } catch {
      events = await this.pool.query<EventRow>(
        `SELECT sequence, event_type, status, error_code, NULL as payload FROM agent_run_events
        WHERE owner_id = $1 AND run_id = $2 AND sequence > $3 AND sequence <= $4 ORDER BY sequence ASC LIMIT 100`,
        [ownerId, id, after, current.last_event_id]
      );
    }

    return {
      status: current.status,
      lastEventId: current.last_event_id,
      items: events.rows.map((row) => {
        if (row.payload && typeof row.payload === 'object') {
          return {
            sequence: row.sequence,
            type: row.event_type,
            data: row.payload as AgentEvent['data'],
          };
        }
        // Legacy fallback from migration 011 rows without payload
        if (row.event_type === 'run.failed') {
          return {
            sequence: row.sequence,
            type: 'run.failed',
            data: {
              runId: id,
              code: row.error_code ?? 'RUNTIME_UNAVAILABLE',
              message: current.result_summary ?? 'Agent execution runtime is not available',
            },
          };
        }
        return {
          sequence: row.sequence,
          type: 'run.status',
          data: {
            runId: id,
            status: row.status,
            ...(row.status === 'queued' ? { phase: 'waiting_runtime' as const } : {}),
          },
        };
      }),
    };
  }

  /**
   * Appends a user follow-up message to a non-terminal run.
   * Guarantees:
   * - Only authenticated owner can append
   * - Replays exact match for duplicate (ownerId, runId, idempotencyKey)
   * - Rejects changed payload for same idempotencyKey with 409 Conflict
   * - Rejects new messages to terminal runs (completed, failed, cancelled) with 409 Conflict
   * - Monotonic sequence allocation serialized via run FOR UPDATE
   */
  async appendUserMessage(
    ownerId: string,
    runId: string,
    content: string,
    key: string,
    fingerprint: string
  ): Promise<{ message: AgentMessage; duplicate: boolean }> {
    return this.withRunLock(runId, async () => {
      return this.transaction(async (client) => {
        const runRes = await client.query<RunRow>(
          'SELECT * FROM agent_runs WHERE owner_id = $1 AND id = $2 FOR UPDATE',
          [ownerId, runId]
        );
        const runCurrent = runRes.rows[0];
        if (!runCurrent) throw new NotFoundError();

        // Check idempotency replay within this run
        const existingRes = await client.query<MessageRow>(
          'SELECT * FROM agent_messages WHERE owner_id = $1 AND run_id = $2 AND idempotency_key = $3',
          [ownerId, runId, key]
        );
        if (existingRes.rows[0]) {
          const existing = existingRes.rows[0];
          if (existing.request_fingerprint !== fingerprint) {
            throw new ConflictError('Idempotency key was used for a different request');
          }
          return { message: message(existing), duplicate: true };
        }

        // Terminal run check (must not admit new messages to terminal runs)
        if (['completed', 'failed', 'cancelled'].includes(runCurrent.status)) {
          throw new ConflictError(
            `Cannot send follow-up message to a ${runCurrent.status} run. Create a new run in the workspace to continue.`
          );
        }

        const seqRes = await client.query<{ next_seq: number }>(
          'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM agent_messages WHERE run_id = $1',
          [runId]
        );
        const nextSequence = seqRes.rows[0]!.next_seq;

        const inserted = await client.query<MessageRow>(
          `INSERT INTO agent_messages
          (owner_id, workspace_id, run_id, sequence, role, content, idempotency_key, request_fingerprint)
          VALUES ($1, $2, $3, $4, 'user', $5, $6, $7)
          RETURNING *`,
          [ownerId, runCurrent.workspace_id, runId, nextSequence, content, key, fingerprint]
        );

        return { message: message(inserted.rows[0]!), duplicate: false };
      });
    });
  }

  static redactJsonValue(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      return AgentRepository.redactStringPatterns(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => AgentRepository.redactJsonValue(item));
    }
    if (typeof value === 'object') {
      const sensitiveKeyPattern = /^(?:api[_-]?key|lease[_-]?token|worker[_-]?token|password|passwd|pass|client[_-]?secret|secret(?:[_-]?key)?|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key|authorization|credential|credentials|cookie|session[_-]?token)$/i;
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (sensitiveKeyPattern.test(k)) {
          result[k] = '[REDACTED]';
        } else {
          result[k] = AgentRepository.redactJsonValue(v);
        }
      }
      return result;
    }
    return value;
  }

  static redactStringPatterns(content: string): string {
    if (!content || typeof content !== 'string') return '';
    let sanitized = content;

    // 1. Private keys (PEM format)
    sanitized = sanitized.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');

    // 2. URL userinfo credentials: https://user:password@host or postgres://user:pass@host:port/db
    sanitized = sanitized.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:\s/@]+):([^@\s/]+)@/gi, '$1$2:[REDACTED]@');

    // 3. URL query parameters: ?api_key=..., &token=..., etc.
    sanitized = sanitized.replace(/([?&](?:api[_-]?key|key|token|auth(?:[_-]?token)?|access[_-]?token|secret|password)=)(?!\[REDACTED\])[^&\s#]+/gi, '$1[REDACTED]');

    // 4. Authorization headers: Authorization: Bearer ..., Authorization: Basic ..., Authorization: ...
    sanitized = sanitized.replace(/\b(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)(?!\[REDACTED\])[^\s,;\r\n]+/gi, '$1[REDACTED]');
    sanitized = sanitized.replace(/\b(Authorization\s*:\s*)(?!(?:Bearer|Basic|Token)\s+|\[REDACTED\])[^\s,;\r\n]+/gi, '$1[REDACTED]');

    // 5. Standalone Authorization scheme tokens (Bearer ..., Basic ...)
    sanitized = sanitized.replace(/\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9\-_.~+/=]+/gi, 'Bearer [REDACTED]');
    sanitized = sanitized.replace(/\bBasic\s+(?!\[REDACTED\])[A-Za-z0-9+/=]{16,}/gi, 'Basic [REDACTED]');

    // 6. Common API key prefixes: sk-..., ghp-..., gho-..., pat-..., live_..., test_...
    sanitized = sanitized.replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr|pat|xoxb|xoxp|xapp|glpat|npm|live|test)[-_][A-Za-z0-9_\-]{8,}\b/gi, '[REDACTED_KEY]');

    // 7. Quoted JSON / object key-value pairs:
    // Matches "apiKey": "...", 'apiKey': "...", "leaseToken": 12345, etc.
    sanitized = sanitized.replace(
      /(["'])(api[_-]?key|lease[_-]?token|worker[_-]?token|password|passwd|pass|client[_-]?secret|secret(?:[_-]?key)?|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key|authorization|credential|credentials|cookie|token)\1(\s*:\s*)(["'])(?:\\.|(?!\4)[^\\])*\4/gi,
      '$1$2$1$3$4[REDACTED]$4'
    );
    // Also handle quoted key with unquoted value (e.g. number, boolean, null in JSON)
    sanitized = sanitized.replace(
      /(["'])(api[_-]?key|lease[_-]?token|worker[_-]?token|password|passwd|pass|client[_-]?secret|secret(?:[_-]?key)?|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key|authorization|credential|credentials|cookie|token)\1(\s*:\s*)(?!(?:\[REDACTED\]|"[REDACTED]"))([^\s"',;}\]]+)/gi,
      '$1$2$1$3"[REDACTED]"'
    );

    // 8. Unquoted key assignments (e.g. CLI output, env lines, key=value, key: value)
    sanitized = sanitized.replace(
      /\b(api[_-]?key|lease[_-]?token|worker[_-]?token|password|passwd|pass|client[_-]?secret|secret(?:[_-]?key)?|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key|credential|credentials)(\s*[:=]\s*)(?!(?:\[REDACTED(?:_KEY)?\]|"[REDACTED]"))(?:["']([^"'\r\n]+)["']|([^\s"',;}\]]+))/gi,
      '$1$2[REDACTED]'
    );

    return sanitized;
  }

  static redactSensitiveContent(content: string): string {
    if (!content || typeof content !== 'string') return '';
    const trimmed = content.trim();

    // If the content is valid JSON, recursively redact structured keys first
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        const redactedObj = AgentRepository.redactJsonValue(parsed);
        const isFormatted = content.includes('\n');
        return JSON.stringify(redactedObj, null, isFormatted ? 2 : undefined);
      } catch {
        // Fallback to pattern-based string redaction
      }
    }

    return AgentRepository.redactStringPatterns(content);
  }

  static boundUtf8(content: string, maxBytes = 16384): string {
    const buf = Buffer.from(content, 'utf8');
    if (buf.length <= maxBytes) return content;

    let end = maxBytes;
    // Scan backwards past any UTF-8 continuation bytes (10xxxxxx)
    while (end > 0 && (buf[end - 1]! & 0xC0) === 0x80) {
      end--;
    }

    if (end > 0) {
      const lead = buf[end - 1]!;
      let seqLen = 1;
      if ((lead & 0x80) === 0x00) seqLen = 1;
      else if ((lead & 0xE0) === 0xC0) seqLen = 2;
      else if ((lead & 0xF0) === 0xE0) seqLen = 3;
      else if ((lead & 0xF8) === 0xF0) seqLen = 4;

      if (end - 1 + seqLen > maxBytes) {
        // Multi-byte character was cut in the middle; exclude its leading byte
        end = end - 1;
      } else {
        // Multi-byte character fits completely within maxBytes
        end = end - 1 + seqLen;
      }
    }

    let result = buf.subarray(0, end).toString('utf8');
    // Safety guard: ensure no decoding replacement char ever causes byte length to exceed maxBytes
    while (Buffer.byteLength(result, 'utf8') > maxBytes) {
      result = result.slice(0, -1);
    }
    return result;
  }

  async appendAssistantMessage(ownerId: string, runId: string, content: string): Promise<AgentMessage> {
    return this.withRunLock(runId, async () => {
      return this.transaction(async (client) => {
        const runRes = await client.query<RunRow>(
          'SELECT * FROM agent_runs WHERE owner_id = $1 AND id = $2 FOR UPDATE',
          [ownerId, runId]
        );
        const runCurrent = runRes.rows[0];
        if (!runCurrent) throw new NotFoundError();

        const seqRes = await client.query<{ next_seq: number }>(
          'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM agent_messages WHERE run_id = $1',
          [runId]
        );
        const nextSequence = seqRes.rows[0]!.next_seq;

        const sanitized = AgentRepository.redactSensitiveContent(content);
        const boundedContent = AgentRepository.boundUtf8(sanitized);

        const inserted = await client.query<MessageRow>(
          `INSERT INTO agent_messages
          (owner_id, workspace_id, run_id, sequence, role, content)
          VALUES ($1, $2, $3, $4, 'assistant', $5)
          RETURNING *`,
          [ownerId, runCurrent.workspace_id, runId, nextSequence, boundedContent]
        );

        return message(inserted.rows[0]!);
      });
    });
  }

  async appendToolSummaryMessage(ownerId: string, runId: string, content: string): Promise<AgentMessage> {
    return this.withRunLock(runId, async () => {
      return this.transaction(async (client) => {
        const runRes = await client.query<RunRow>(
          'SELECT * FROM agent_runs WHERE owner_id = $1 AND id = $2 FOR UPDATE',
          [ownerId, runId]
        );
        const runCurrent = runRes.rows[0];
        if (!runCurrent) throw new NotFoundError();

        const seqRes = await client.query<{ next_seq: number }>(
          'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM agent_messages WHERE run_id = $1',
          [runId]
        );
        const nextSequence = seqRes.rows[0]!.next_seq;

        const sanitized = AgentRepository.redactSensitiveContent(content);
        const boundedContent = AgentRepository.boundUtf8(sanitized);

        const inserted = await client.query<MessageRow>(
          `INSERT INTO agent_messages
          (owner_id, workspace_id, run_id, sequence, role, content)
          VALUES ($1, $2, $3, $4, 'tool_summary', $5)
          RETURNING *`,
          [ownerId, runCurrent.workspace_id, runId, nextSequence, boundedContent]
        );

        return message(inserted.rows[0]!);
      });
    });
  }

  async listMessages(ownerId: string, runId: string, options: ListMessagesOptions): Promise<Page<AgentMessage>> {
    const currentRun = await this.getRun(ownerId, runId);

    if (!(await this.canPersistMessages(this.pool))) {
      const initialMessage: AgentMessage = {
        id: currentRun.id,
        workspaceId: currentRun.workspaceId,
        runId: currentRun.id,
        sequence: 1,
        role: 'user',
        content: currentRun.task,
        createdAt: currentRun.createdAt,
      };
      return {
        items: [initialMessage],
        nextCursor: null,
      };
    }

    const params: unknown[] = [ownerId, runId];
    let where = 'owner_id = $1 AND run_id = $2';
    if (options.cursor) {
      params.push(options.cursor.sequence);
      where += ` AND sequence > $${params.length}`;
    }
    params.push(options.limit + 1);

    const result = await this.pool.query<MessageRow>(
      `SELECT * FROM agent_messages WHERE ${where} ORDER BY sequence ASC LIMIT $${params.length}`,
      params
    );

    const rows = result.rows.slice(0, options.limit);
    const last = rows.at(-1);

    return {
      items: rows.map(message),
      nextCursor:
        result.rows.length > options.limit && last
          ? encodeMessageCursor({
              kind: 'messages',
              runId,
              sequence: last.sequence,
            })
          : null,
    };
  }

  async getConversationContext(
    ownerId: string,
    runId: string,
    options: { maxMessages?: number; maxBytes?: number; scope?: 'run' | 'workspace' } = {}
  ): Promise<ConversationContextBoundary> {
    const currentRun = await this.getRun(ownerId, runId);

    if (!(await this.canPersistMessages(this.pool))) {
      return {
        messages: [{ runId: currentRun.id, sequence: 1, role: 'user', content: currentRun.task }],
        totalBytes: Buffer.byteLength(currentRun.task, 'utf8'),
        isTruncated: false,
      };
    }

    const maxMessages = options.maxMessages ?? 50;
    const maxBytes = options.maxBytes ?? 65536;
    const scope = options.scope ?? 'workspace';
    // 1. ALWAYS query the current run's messages independently.
    // This guarantees that past runs (even 200+ historical messages) can never push
    // the current run's task and follow-up instructions out of context.
    const currentRunResult = await this.pool.query<MessageRow>(
      `SELECT run_id, sequence, role, content FROM agent_messages
       WHERE owner_id = $1 AND run_id = $2
       ORDER BY sequence ASC`,
      [ownerId, runId]
    );
    const currentRunRows = currentRunResult.rows;

    let isTruncated = false;
    const selectedCurrentRows: MessageRow[] = [];
    let currentBytes = 0;

    // Prioritize current run messages: if they exceed maxMessages or maxBytes,
    // take from newest to oldest to guarantee the latest instruction/follow-up is always kept.
    for (let i = currentRunRows.length - 1; i >= 0; i--) {
      const row = currentRunRows[i]!;
      const msgBytes = Buffer.byteLength(row.content, 'utf8');
      if (selectedCurrentRows.length < maxMessages && currentBytes + msgBytes <= maxBytes) {
        selectedCurrentRows.unshift(row);
        currentBytes += msgBytes;
      } else {
        isTruncated = true;
      }
    }

    // 2. If scope is workspace, query prior completed runs history using the remaining budget.
    let remainingBytes = Math.max(0, maxBytes - currentBytes);
    const remainingMessages = Math.max(0, maxMessages - selectedCurrentRows.length);
    const selectedPriorRows: MessageRow[] = [];

    if (scope === 'workspace' && remainingMessages > 0 && remainingBytes > 0) {
      const priorSqlLimit = Math.max(200, remainingMessages * 2);
      const priorResult = await this.pool.query<MessageRow>(
        `SELECT m.run_id, m.sequence, m.role, m.content
         FROM agent_messages m
         JOIN agent_runs r ON m.run_id = r.id AND m.owner_id = r.owner_id
         WHERE m.owner_id = $1
           AND m.workspace_id = $2
           AND r.status = 'completed'
           AND r.created_at < $3
           AND r.id != $4
         ORDER BY r.created_at DESC, r.id DESC, m.sequence DESC
         LIMIT $5`,
        [ownerId, currentRun.workspaceId, currentRun.createdAt, currentRun.id, priorSqlLimit]
      );

      if (priorResult.rows.length >= priorSqlLimit) {
        isTruncated = true;
      }

      for (const row of priorResult.rows) {
        const msgBytes = Buffer.byteLength(row.content, 'utf8');
        if (selectedPriorRows.length >= remainingMessages || msgBytes > remainingBytes) {
          isTruncated = true;
          continue;
        }
        selectedPriorRows.unshift(row);
        remainingBytes -= msgBytes;
        currentBytes += msgBytes;
      }
    }

    // 3. Combine in chronological order: [prior completed runs history..., current run messages...]
    const finalRows = [...selectedPriorRows, ...selectedCurrentRows];

    const boundedMessages: BoundedConversationMessage[] = finalRows.map((row) => ({
      runId: row.run_id,
      sequence: row.sequence,
      role: row.role,
      content: row.content,
    }));

    return {
      messages: boundedMessages,
      totalBytes: currentBytes,
      isTruncated,
    };
  }
}
