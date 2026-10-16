import type pg from 'pg';
import { ConflictError, NotFoundError } from '../auth/auth-validation.js';
import { encodeAgentCursor } from './validation.js';
import {
  RUNTIME_UNAVAILABLE,
  type AgentEvent,
  type AgentEventType,
  type AgentRun,
  type AgentStep,
  type AgentStatus,
  type AgentWorkspace,
  type ClaimedRun,
  type ListOptions,
  type Page,
  type RunInput,
  type StepStatus,
  type ToolRisk,
  type VerifiedCheck,
  type WorkerLease,
} from './types.js';
import type { AgentPlan } from './decision-provider.js';

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
  constructor(private readonly pool: pg.Pool) {}

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

      const stepInsert = await client.query<StepRow>(
        `INSERT INTO agent_run_steps
        (owner_id, run_id, step_number, status, tool_name, tool_call_id, tool_risk, arguments_json)
        VALUES ($1, $2, $3, 'running', $4, $5, $6, $7)
        RETURNING *`,
        [ownerId, runId, stepNumber, input.toolName, input.toolCallId, input.risk, JSON.stringify(input.arguments)]
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

      const stepUpdate = await client.query<StepRow>(
        `UPDATE agent_run_steps
        SET status = 'completed', result_json = $1, duration_ms = $2, completed_at = NOW()
        WHERE owner_id = $3 AND run_id = $4 AND step_number = $5 AND status = 'running'
        RETURNING *`,
        [JSON.stringify(input.output), input.durationMs, ownerId, runId, stepNumber]
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
        ...(input.summary ? { summary: input.summary } : {}),
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

      const stepUpdate = await client.query<StepRow>(
        `UPDATE agent_run_steps
        SET status = 'failed', error_code = $1, error_message = $2, duration_ms = $3, completed_at = NOW()
        WHERE owner_id = $4 AND run_id = $5 AND step_number = $6 AND status = 'running'
        RETURNING *`,
        [failure.errorCode, failure.errorMessage, failure.durationMs ?? 0, ownerId, runId, stepNumber]
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
        summary: failure.errorMessage,
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
   */
  async finalizeRun(
    ownerId: string,
    runId: string,
    leaseToken: string,
    outcome: RunFinalizeInput
  ): Promise<{ run: AgentRun; event: AgentEvent }> {
    return this.transaction(async (client) => {
      const lock = await client.query<RunRow>(
        'SELECT lease_token, status, last_event_id, lease_expires_at FROM agent_runs WHERE owner_id = $1 AND id = $2 FOR UPDATE',
        [ownerId, runId]
      );
      this.assertActiveLease(lock.rows[0], leaseToken);
      const runCurrent = lock.rows[0]!;

      const nextEventSeq = runCurrent.last_event_id + 1;

      if (outcome.status === 'completed') {
        const update = await client.query<RunRow>(
          `UPDATE agent_runs
          SET status = 'completed', finished_at = NOW(), verified_checks = $1, result_summary = $2,
              last_event_id = $3, updated_at = NOW()
          WHERE owner_id = $4 AND id = $5 AND status = 'running'
          RETURNING *`,
          [JSON.stringify(outcome.verifiedChecks), outcome.summary, nextEventSeq, ownerId, runId]
        );
        const updated = update.rows[0]!;

        const payload = {
          runId,
          artifactIds: [],
          verifiedChecks: outcome.verifiedChecks,
          summary: outcome.summary,
        };
        await client.query(
          `INSERT INTO agent_run_events (owner_id, run_id, sequence, event_type, status, payload)
          VALUES ($1, $2, $3, 'run.completed', 'completed', $4)`,
          [ownerId, runId, nextEventSeq, JSON.stringify(payload)]
        );

        return {
          run: run(updated),
          event: { sequence: nextEventSeq, type: 'run.completed', data: payload },
        };
      }

      if (outcome.status === 'failed') {
        const update = await client.query<RunRow>(
          `UPDATE agent_runs
          SET status = 'failed', finished_at = NOW(), error_code = $1, result_summary = $2,
              last_event_id = $3, updated_at = NOW()
          WHERE owner_id = $4 AND id = $5 AND status = 'running'
          RETURNING *`,
          [outcome.errorCode, outcome.errorMessage, nextEventSeq, ownerId, runId]
        );
        const updated = update.rows[0]!;

        const payload = { runId, code: outcome.errorCode, message: outcome.errorMessage };
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
  }

  async releaseLease(ownerId: string, runId: string, leaseToken: string): Promise<void> {
    await this.pool.query(
      `UPDATE agent_runs SET lease_expires_at = NOW()
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
}
