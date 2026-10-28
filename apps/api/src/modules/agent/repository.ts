import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from '../auth/auth-validation.js';
import { encodeAgentCursor, encodeMessageCursor } from './validation.js';
import {
  RUNTIME_UNAVAILABLE,
  type AgentEvent,
  type AgentEventType,
  type AgentMessage,
  type AgentMessageRole,
  type AgentMode,
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
  type DurableSandboxSession,
  type CreateSandboxAllocationInput,
  type SandboxLifecycleState,
  type SandboxAllocationState,
  type SandboxCleanupState,
  type SandboxAttemptLifecycleSnapshot,
  type SandboxLifecycleOperation,
} from './types.js';
import {
  SENSITIVE_KEY_NAMES,
  isSensitiveKey,
  redactJsonValue,
  redactStringPatterns,
  redactSensitiveContent,
  boundUtf8,
} from './redaction.js';
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
  owner_id: string;
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

function isMissingLifecycleFunction(error: unknown, functionName: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== '42883' || !('message' in error)) {
    return false;
  }
  const message = String(error.message).toLowerCase();
  return message.includes('function ') && message.includes(functionName.toLowerCase()) && message.includes('does not exist');
}

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

interface SandboxSessionRow {
  id: string;
  owner_id: string;
  workspace_id: string;
  run_id: string;
  attempt_number: number;
  attempt_generation: string;
  mode: AgentMode;
  provider_type: string;
  provider_session_id: string | null;
  lifecycle_state: SandboxLifecycleState;
  allocation_state: SandboxAllocationState;
  cleanup_state: SandboxCleanupState;
  worker_id: string;
  lease_token: string;
  allocation_intent_id: string;
  cleanup_attempts: number;
  next_cleanup_retry_at: Date | null;
  cleanup_lease_token?: string | null;
  cleanup_lease_expires_at?: Date | null;
  cleanup_worker_id?: string | null;
  allocation_expires_at: Date;
  created_at: Date;
  updated_at: Date;
  destroyed_at: Date | null;
  diagnostics: Record<string, unknown>;
  verified_checks: VerifiedCheck[] | null;
}

const sandboxSession = (row: SandboxSessionRow): DurableSandboxSession => ({
  id: row.id,
  ownerId: row.owner_id,
  workspaceId: row.workspace_id,
  runId: row.run_id,
  attemptNumber: row.attempt_number,
  attemptGeneration: row.attempt_generation,
  mode: row.mode,
  providerType: row.provider_type,
  providerSessionId: row.provider_session_id,
  lifecycleState: row.lifecycle_state,
  allocationState: row.allocation_state,
  cleanupState: row.cleanup_state,
  workerId: row.worker_id,
  leaseToken: row.lease_token,
  allocationIntentId: row.allocation_intent_id,
  cleanupAttempts: row.cleanup_attempts,
  nextCleanupRetryAt: row.next_cleanup_retry_at ? iso(row.next_cleanup_retry_at) : null,
  cleanupLeaseToken: row.cleanup_lease_token ?? null,
  cleanupLeaseExpiresAt: row.cleanup_lease_expires_at ? iso(row.cleanup_lease_expires_at) : null,
  cleanupWorkerId: row.cleanup_worker_id ?? null,
  allocationExpiresAt: iso(row.allocation_expires_at),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  destroyedAt: row.destroyed_at ? iso(row.destroyed_at) : null,
  diagnostics: row.diagnostics ?? {},
  verifiedChecks: row.verified_checks ?? [],
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
  private readonly lifecycleFinalizationPool: pg.Pool;

  constructor(private readonly pool: pg.Pool, lifecycleFinalizationPool?: pg.Pool) {
    this.lifecycleFinalizationPool = lifecycleFinalizationPool ?? pool;
  }

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
    const result = await this.transaction<ClaimedRun | null | { finalizeSessionId: string }>(async (client) => {
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

        // Fence the exact expired generation before issuing a replacement lease. A new
        // worker must not overlap an allocation, sandbox, or runtime operation whose
        // provider outcome is still unknown. The fence and the replacement claim share
        // this run-row transaction/lock, so admission cannot slip between them.
        const previousAttempt = await this.fenceExpiredAttemptBeforeTakeover(client, row);
        if (!previousAttempt.settled) {
          return previousAttempt.finalizeSessionId
            ? { finalizeSessionId: previousAttempt.finalizeSessionId }
            : null;
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
    if (result && 'finalizeSessionId' in result) {
      await this.confirmSandboxAllocationAbsent(result.finalizeSessionId, 'expired_run_lease_takeover');
      return this.claimRun(ownerId, runId, workerId, leaseDurationMs);
    }
    return result;
  }

  private async fenceExpiredAttemptBeforeTakeover(
    client: pg.PoolClient,
    runRow: RunRow
  ): Promise<{ settled: boolean; finalizeSessionId?: string }> {
    const attemptNumber = runRow.attempt_count;
    if (attemptNumber <= 0) return { settled: true };
    let fence = (await client.query<{ generation: string; fenced_at: Date | null }>(
      `SELECT generation, fenced_at FROM agent_sandbox_attempt_fences
       WHERE owner_id = $1 AND workspace_id = $2 AND run_id = $3 AND attempt_number = $4 FOR UPDATE`,
      [runRow.owner_id, runRow.workspace_id, runRow.id, attemptNumber]
    )).rows[0];
    if (!fence) {
      fence = (await client.query<{ generation: string; fenced_at: Date | null }>(
        `INSERT INTO agent_sandbox_attempt_fences
           (owner_id, workspace_id, run_id, attempt_number, generation, fenced_at, fence_reason)
         VALUES ($1, $2, $3, $4, $5, NOW(), 'expired_run_lease_takeover')
         RETURNING generation, fenced_at`,
        [runRow.owner_id, runRow.workspace_id, runRow.id, attemptNumber, randomUUID()]
      )).rows[0]!;
    } else if (!fence.fenced_at) {
      fence = (await client.query<{ generation: string; fenced_at: Date | null }>(
        `UPDATE agent_sandbox_attempt_fences SET fenced_at = NOW(), fence_reason = 'expired_run_lease_takeover'
         WHERE owner_id = $1 AND workspace_id = $2 AND run_id = $3 AND attempt_number = $4
         RETURNING generation, fenced_at`,
        [runRow.owner_id, runRow.workspace_id, runRow.id, attemptNumber]
      )).rows[0]!;
    }

    const session = (await client.query<SandboxSessionRow>(
      `SELECT * FROM agent_sandbox_sessions
       WHERE owner_id = $1 AND workspace_id = $2 AND run_id = $3 AND attempt_number = $4
       AND attempt_generation = $5 FOR UPDATE`,
      [runRow.owner_id, runRow.workspace_id, runRow.id, attemptNumber, fence.generation]
    )).rows[0];
    if (!session) return { settled: true };

    const operations = (await client.query<{
      id: string; operation_kind: 'allocation' | 'tool' | 'snapshot';
      state: 'not_started' | 'in_progress' | 'ambiguous' | 'settled';
      outcome: 'resource' | 'no_resource' | null; provider_resource_id: string | null;
    }>(
      `SELECT id, operation_kind, state, outcome, provider_resource_id
       FROM agent_sandbox_lifecycle_operations
       WHERE session_id = $1 AND generation = $2 ORDER BY created_at, id FOR UPDATE`,
      [session.id, fence.generation]
    )).rows;
    const allocation = operations.find((operation) => operation.operation_kind === 'allocation');
    if (!allocation) return { settled: false };

    // An operation that never crossed the provider boundary is durably resource-free.
    if (allocation.state === 'not_started') {
      return { settled: false, finalizeSessionId: session.id };
    }

    if (operations.some((operation) => operation.state !== 'settled')) return { settled: false };
    if (allocation.outcome === 'no_resource') {
      if (session.provider_session_id !== null) return { settled: false };
      if (session.lifecycle_state === 'allocating') {
        await client.query(
          `UPDATE agent_sandbox_sessions SET lifecycle_state = 'failed', allocation_state = 'failed',
             updated_at = NOW() WHERE id = $1 AND lifecycle_state = 'allocating'`, [session.id]
        );
      }
      return { settled: true };
    }
    if (allocation.outcome !== 'resource' || !allocation.provider_resource_id ||
        session.provider_session_id !== allocation.provider_resource_id || session.lifecycle_state !== 'destroyed') {
      return { settled: false };
    }
    return { settled: true };
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
          const sanitizedChecks = (outcome.verifiedChecks ?? []).map((c) => ({
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

  static readonly SENSITIVE_KEY_NAMES = SENSITIVE_KEY_NAMES;
  static isSensitiveKey = isSensitiveKey;
  static redactJsonValue = redactJsonValue;
  static redactStringPatterns = redactStringPatterns;
  static redactSensitiveContent = redactSensitiveContent;
  static boundUtf8 = boundUtf8;

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

  /**
   * Checks if migration 014 (agent_sandbox_sessions) is applied.
   */
  async canPersistSandboxSessions(client?: pg.PoolClient | pg.Pool): Promise<boolean> {
    const executor = client ?? this.pool;
    try {
      const res = await executor.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_sandbox_sessions'"
      );
      return res.rows.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Creates a durable sandbox session allocation intent in PostgreSQL.
   * Guarantees:
   * 1. Fenced with worker lease check on agent_runs
   * 2. Rejects terminal runs
   * 3. Idempotently returns existing active session for same attempt & worker
   * 4. Enforces tenant and mode matching (rejects cross-tenant with TENANT_MISMATCH)
   * 5. Atomically transitions to 'allocating' with expiration TTL
   */
  async createSandboxAllocationIntent(
    input: CreateSandboxAllocationInput
  ): Promise<{ session: DurableSandboxSession; duplicate: boolean }> {
    return this.transaction(async (client) => {
      // 1. Lock and verify the run
      const runRes = await client.query<RunRow>(
        'SELECT * FROM agent_runs WHERE owner_id = $1 AND workspace_id = $2 AND id = $3 FOR UPDATE',
        [input.ownerId, input.workspaceId, input.runId]
      );
      const runRow = runRes.rows[0];
      if (!runRow) throw new NotFoundError();

      if (['completed', 'failed', 'cancelled'].includes(runRow.status)) {
        throw new ConflictError('Cannot allocate sandbox for terminal run');
      }

      if (runRow.mode !== input.mode) {
        throw new ConflictError(`MODE_MISMATCH: run mode is '${runRow.mode}', requested allocation is '${input.mode}'`);
      }

      this.assertActiveLease(runRow, input.leaseToken);

      // 2. Check existing active, allocating, or cleaning up sessions for this run
      const existingRes = await client.query<SandboxSessionRow>(
        `SELECT * FROM agent_sandbox_sessions
         WHERE run_id = $1 AND lifecycle_state IN ('allocating', 'active', 'stopping', 'destroying', 'cleanup_pending')
         FOR UPDATE`,
        [input.runId]
      );
      const existing = existingRes.rows[0];

      if (existing) {
        // Tenant boundary enforcement
        if (existing.owner_id !== input.ownerId || existing.workspace_id !== input.workspaceId) {
          throw new ConflictError('TENANT_MISMATCH: owner or workspace mismatch on active sandbox session');
        }
        // Mode boundary enforcement
        if (existing.mode !== input.mode) {
          throw new ConflictError(`TENANT_MISMATCH: active session is '${existing.mode}' mode, requested '${input.mode}'`);
        }

        // Check if this is an idempotent retry by the same worker lease & attempt
        if (
          existing.attempt_number === input.attemptNumber &&
          existing.worker_id === input.workerId &&
          existing.lease_token === input.leaseToken
        ) {
          return { session: sandboxSession(existing), duplicate: true };
        }

        // Expiry is only a scheduling hint. The provider may still be allocating;
        // retain the row and capacity until the allocation operation is settled.
        throw new ConflictError(
          `SANDBOX_RESOURCE_EXISTS: A non-terminal sandbox session is already in state '${existing.lifecycle_state}' for this run; awaiting cleanup before new allocation`
        );
      }

      if (runRow.attempt_count !== input.attemptNumber) {
        throw new ConflictError('Sandbox allocation attempt does not match the active run generation');
      }

      // The run row is always locked before the exact-attempt fence. The fence row
      // remains as a tombstone after cleanup so stale workers cannot recreate work.
      let fence = (await client.query<{ generation: string; fenced_at: Date | null }>(
        `SELECT generation, fenced_at FROM agent_sandbox_attempt_fences
         WHERE owner_id = $1 AND workspace_id = $2 AND run_id = $3 AND attempt_number = $4
         FOR UPDATE`,
        [input.ownerId, input.workspaceId, input.runId, input.attemptNumber]
      )).rows[0];
      if (!fence) {
        const generation = randomUUID();
        fence = (await client.query<{ generation: string; fenced_at: Date | null }>(
          `INSERT INTO agent_sandbox_attempt_fences
             (owner_id, workspace_id, run_id, attempt_number, generation)
           VALUES ($1, $2, $3, $4, $5) RETURNING generation, fenced_at`,
          [input.ownerId, input.workspaceId, input.runId, input.attemptNumber, generation]
        )).rows[0]!;
      }
      if (fence.fenced_at) throw new ConflictError('Sandbox attempt has been durably fenced');

      // 3. Insert new session record in 'allocating' state
      const timeoutMs = input.allocationTimeoutMs ?? 60_000;
      const expiresAt = new Date(Date.now() + timeoutMs);
      const intentId = input.allocationIntentId ?? crypto.randomUUID();

      const inserted = await client.query<SandboxSessionRow>(
        `INSERT INTO agent_sandbox_sessions (
           owner_id, workspace_id, run_id, attempt_number, mode, provider_type,
           lifecycle_state, allocation_state, cleanup_state, worker_id, lease_token,
           allocation_intent_id, allocation_expires_at, diagnostics, attempt_generation
         ) VALUES ($1, $2, $3, $4, $5, $6, 'allocating', 'pending', 'none', $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          input.ownerId,
          input.workspaceId,
          input.runId,
          input.attemptNumber,
          input.mode,
          input.providerType,
          input.workerId,
          input.leaseToken,
          intentId,
          expiresAt,
          JSON.stringify({ allocationIntentId: intentId }),
          fence.generation,
        ]
      );

      await client.query(
        `INSERT INTO agent_sandbox_lifecycle_operations (
           id, session_id, owner_id, workspace_id, run_id, attempt_number, generation,
           operation_kind, state, operation_name
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'allocation', 'not_started', 'provider_create')`,
        [intentId, inserted.rows[0]!.id, input.ownerId, input.workspaceId, input.runId,
          input.attemptNumber, fence.generation]
      );

      return { session: sandboxSession(inserted.rows[0]!), duplicate: false };
    });
  }

  /**
   * Finalizes allocation after provider returned a sandbox identifier.
   * Fenced: verifies worker lease is still active. If stale or cancelled, marks session for cleanup.
   */
  async commitSandboxSessionAllocated(params: {
    sessionId: string;
    ownerId: string;
    runId: string;
    leaseToken: string;
    providerSessionId: string;
  }): Promise<DurableSandboxSession> {
    try {
      const identity = await this.pool.query<{
        owner_id: string; run_id: string; attempt_number: number; attempt_generation: string;
      }>(
        'SELECT owner_id, run_id, attempt_number, attempt_generation FROM agent_sandbox_sessions WHERE id = $1',
        [params.sessionId]
      );
      const rowIdentity = identity.rows[0];
      if (!rowIdentity || rowIdentity.owner_id !== params.ownerId || rowIdentity.run_id !== params.runId) {
        throw new NotFoundError();
      }
      const result = await this.lifecycleFinalizationPool.query<SandboxSessionRow>(
        'SELECT * FROM settle_agent_sandbox_allocation($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid, $6::varchar, $7::varchar, $8::varchar)',
        [params.sessionId, params.ownerId, params.runId, rowIdentity.attempt_number,
          rowIdentity.attempt_generation, 'resource', params.providerSessionId, params.leaseToken]
      );
      if (!result.rows[0]) throw new NotFoundError();
      const settled = result.rows[0];
      if (settled.lifecycle_state === 'cleanup_pending') {
        await this.pool.query(
          `UPDATE agent_sandbox_sessions SET diagnostics = $1, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify({ ...(settled.diagnostics ?? {}), fence_reason: 'late_or_stale_allocation_callback' }), params.sessionId]
        );
        settled.diagnostics = { ...(settled.diagnostics ?? {}), fence_reason: 'late_or_stale_allocation_callback' };
      }
      return sandboxSession(settled);
    } catch (err: any) {
      if (!isMissingLifecycleFunction(err, 'settle_agent_sandbox_allocation')) {
        if (err instanceof NotFoundError) throw err;
        if (err?.message?.includes('conflicts')) throw new ConflictError(err.message);
        if (err?.message?.includes('not found')) throw new NotFoundError();
        throw err;
      }
      // In-memory test adapters do not implement PostgreSQL SECURITY DEFINER functions.
      // Their fallback remains fail-closed against a real runtime role by table privileges.
    }
    return this.transaction(async (client) => {
      // All admission, callback, tool-start and fence paths lock run -> fence -> session.
      const runRes = await client.query<RunRow>(
        'SELECT * FROM agent_runs WHERE owner_id = $1 AND id = $2 FOR UPDATE',
        [params.ownerId, params.runId]
      );
      const runRow = runRes.rows[0];
      if (!runRow) throw new NotFoundError();
      const sessionRes = await client.query<SandboxSessionRow>(
        'SELECT * FROM agent_sandbox_sessions WHERE id = $1 AND owner_id = $2 AND run_id = $3',
        [params.sessionId, params.ownerId, params.runId]
      );
      const session = sessionRes.rows[0];
      if (!session) throw new NotFoundError();
      const fenceRes = await client.query<{ fenced_at: Date | null }>(
        `SELECT fenced_at FROM agent_sandbox_attempt_fences
         WHERE owner_id = $1 AND workspace_id = $2 AND run_id = $3 AND attempt_number = $4 AND generation = $5
         FOR UPDATE`,
        [session.owner_id, session.workspace_id, session.run_id, session.attempt_number, session.attempt_generation]
      );
      const fence = fenceRes.rows[0];
      if (!fence) throw new ConflictError('Sandbox attempt generation no longer exists');

      const operationRes = await client.query<{
        state: string; outcome: string | null; provider_resource_id: string | null;
      }>(
        `SELECT state, outcome, provider_resource_id FROM agent_sandbox_lifecycle_operations
         WHERE id = $1 AND session_id = $2 AND operation_kind = 'allocation' FOR UPDATE`,
        [session.allocation_intent_id, session.id]
      );
      const operation = operationRes.rows[0];
      if (!operation) throw new ConflictError('Durable allocation operation is missing');
      if (operation.state === 'settled') {
        if (operation.outcome !== 'resource' || operation.provider_resource_id !== params.providerSessionId) {
          throw new ConflictError('Allocation callback conflicts with its settled provider outcome');
        }
        return session.lifecycle_state === 'active'
          ? sandboxSession(session)
          : sandboxSession(session);
      }
      if (operation.state === 'not_started') {
        throw new ConflictError('Provider allocation callback arrived before the durable operation started');
      }

      const leaseActive = runRow.status === 'running' && runRow.attempt_count === session.attempt_number &&
        runRow.lease_token === params.leaseToken && runRow.lease_expires_at !== null &&
        new Date(runRow.lease_expires_at).getTime() > Date.now();
      const fenced = Boolean(fence.fenced_at) || !leaseActive;
      if (!fence.fenced_at && !leaseActive) {
        await client.query(
          `UPDATE agent_sandbox_attempt_fences SET fenced_at = NOW(), fence_reason = 'stale_allocation_callback'
           WHERE owner_id = $1 AND workspace_id = $2 AND run_id = $3 AND attempt_number = $4 AND generation = $5`,
          [session.owner_id, session.workspace_id, session.run_id, session.attempt_number, session.attempt_generation]
        );
        if (runRow.attempt_count === session.attempt_number && runRow.lease_token === params.leaseToken) {
          await client.query(
            `UPDATE agent_runs SET lease_token = NULL, lease_expires_at = NOW(), updated_at = NOW()
             WHERE owner_id = $1 AND id = $2 AND attempt_count = $3 AND lease_token = $4`,
            [params.ownerId, params.runId, session.attempt_number, params.leaseToken]
          );
        }
      }

      try {
        const result = await client.query<SandboxSessionRow>(
          'SELECT * FROM settle_agent_sandbox_allocation($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid, $6::varchar, $7::varchar)',
          [session.id, params.ownerId, params.runId, session.attempt_number, session.attempt_generation, 'resource', params.providerSessionId]
        );
        const row = result.rows[0];
        if (row && row.id) {
          if (fenced) {
            const diagnostics = JSON.stringify({ ...(session.diagnostics ?? {}), fence_reason: 'late_or_stale_allocation_callback' });
            await client.query('UPDATE agent_sandbox_sessions SET diagnostics = $1 WHERE id = $2', [diagnostics, session.id]);
          }
          return sandboxSession({ ...row, diagnostics: fenced ? { ...(session.diagnostics ?? {}), fence_reason: 'late_or_stale_allocation_callback' } : session.diagnostics });
        }
      } catch (err: any) {
        if (!isMissingLifecycleFunction(err, 'settle_agent_sandbox_allocation')) {
          if (err?.message?.includes('conflicts')) throw new ConflictError(err.message);
          if (err?.message?.includes('not found')) throw new NotFoundError();
          throw err;
        }
      }

      await client.query(
        `UPDATE agent_sandbox_lifecycle_operations
         SET state = 'settled', outcome = 'resource', provider_resource_id = $1, settled_at = NOW()
         WHERE id = $2 AND session_id = $3 AND state IN ('in_progress', 'ambiguous')`,
        [params.providerSessionId, session.allocation_intent_id, session.id]
      );
      const lifecycleState = fenced ? 'cleanup_pending' : 'active';
      const diagnostics = fenced
        ? JSON.stringify({ ...(session.diagnostics ?? {}), fence_reason: 'late_or_stale_allocation_callback' })
        : JSON.stringify(session.diagnostics ?? {});
      const updated = await client.query<SandboxSessionRow>(
        `UPDATE agent_sandbox_sessions
         SET provider_session_id = $1, lifecycle_state = $2,
             allocation_state = 'allocated', cleanup_state = $3,
             diagnostics = $4,
             updated_at = NOW()
         WHERE id = $5 RETURNING *`,
        [params.providerSessionId, lifecycleState, fenced ? 'pending' : session.cleanup_state, diagnostics, session.id]
      );
      return sandboxSession(updated.rows[0]!);
    });
  }

  /**
   * Durably marks the provider RPC as started immediately before invoking it.
   * A crash after this point is ambiguous until the provider can settle the operation.
   */
  async beginSandboxAllocationOperation(sessionId: string, generation: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const identity = (await client.query<{
        owner_id: string; workspace_id: string; run_id: string; attempt_number: number;
        lease_token: string;
      }>(
        `SELECT owner_id, workspace_id, run_id, attempt_number, lease_token
         FROM agent_sandbox_sessions WHERE id = $1`, [sessionId]
      )).rows[0];
      if (!identity) throw new NotFoundError();
      const runRow = (await client.query<RunRow>(
        'SELECT * FROM agent_runs WHERE owner_id = $1 AND workspace_id = $2 AND id = $3 FOR UPDATE',
        [identity.owner_id, identity.workspace_id, identity.run_id]
      )).rows[0];
      if (!runRow) throw new NotFoundError();
      const fence = (await client.query<{ fenced_at: Date | null }>(
        `SELECT fenced_at FROM agent_sandbox_attempt_fences
         WHERE owner_id = $1 AND workspace_id = $2 AND run_id = $3 AND attempt_number = $4 AND generation = $5
         FOR UPDATE`,
        [identity.owner_id, identity.workspace_id, identity.run_id, identity.attempt_number, generation]
      )).rows[0];
      if (!fence || fence.fenced_at || runRow.status !== 'running' ||
          runRow.attempt_count !== identity.attempt_number || runRow.lease_token !== identity.lease_token ||
          !runRow.lease_expires_at || new Date(runRow.lease_expires_at).getTime() <= Date.now()) {
        throw new ConflictError('Sandbox allocation is fenced by the durable attempt lease');
      }
      const sessionState = (await client.query<{ lifecycle_state: SandboxLifecycleState; attempt_generation: string }>(
        'SELECT lifecycle_state, attempt_generation FROM agent_sandbox_sessions WHERE id = $1 FOR UPDATE', [sessionId]
      )).rows[0];
      if (!sessionState || sessionState.lifecycle_state !== 'allocating' || sessionState.attempt_generation !== generation) {
        throw new ConflictError('Sandbox allocation intent is no longer eligible for provider submission');
      }
      const operation = await client.query(
        `UPDATE agent_sandbox_lifecycle_operations SET state = 'in_progress'
         WHERE id = (SELECT allocation_intent_id FROM agent_sandbox_sessions WHERE id = $1)
           AND session_id = $1 AND generation = $2 AND operation_kind = 'allocation' AND state = 'not_started'
         RETURNING id`,
        [sessionId, generation]
      );
      return (operation.rowCount ?? 0) === 1;
    });
  }

  /** A provider error after the RPC started is ambiguous until provider evidence settles it. */
  async markSandboxAllocationAmbiguous(sessionId: string, reason: string): Promise<void> {
    const safeReason = redactSensitiveContent(reason);
    await this.transaction(async (client) => {
      const row = (await client.query<{ allocation_intent_id: string; diagnostics: Record<string, unknown> }>(
        'SELECT allocation_intent_id, diagnostics FROM agent_sandbox_sessions WHERE id = $1 FOR UPDATE', [sessionId]
      )).rows[0];
      if (!row) throw new NotFoundError();
      await client.query(
        `UPDATE agent_sandbox_lifecycle_operations SET state = 'ambiguous'
         WHERE id = $1 AND state = 'in_progress'`, [row.allocation_intent_id]
      );
      const diagnostics = { ...(row.diagnostics ?? {}), allocation_outcome: 'ambiguous', allocation_error: safeReason };
      await client.query(
        `UPDATE agent_sandbox_sessions SET diagnostics = $1, updated_at = NOW()
         WHERE id = $2 AND provider_session_id IS NULL AND lifecycle_state = 'allocating'`,
        [JSON.stringify(diagnostics), sessionId]
      );
    });
  }

  /**
   * Starts a durable tool/snapshot operation while serialized with attempt fencing.
   * The returned operation must settle only when the underlying provider promise settles,
   * even when the user-facing timeout has already returned.
   */
  async beginSandboxRuntimeOperation(
    sessionId: string,
    generation: string,
    kind: 'tool' | 'snapshot',
    operationName: string
  ): Promise<string> {
    return this.transaction(async (client) => {
      const identity = (await client.query<{
        owner_id: string; workspace_id: string; run_id: string; attempt_number: number;
        lease_token: string; lifecycle_state: SandboxLifecycleState;
      }>(
        `SELECT owner_id, workspace_id, run_id, attempt_number, lease_token, lifecycle_state
         FROM agent_sandbox_sessions WHERE id = $1`, [sessionId]
      )).rows[0];
      if (!identity) throw new NotFoundError();
      const runRow = (await client.query<RunRow>(
        'SELECT * FROM agent_runs WHERE owner_id = $1 AND workspace_id = $2 AND id = $3 FOR UPDATE',
        [identity.owner_id, identity.workspace_id, identity.run_id]
      )).rows[0];
      if (!runRow) throw new NotFoundError();
      const fence = (await client.query<{ fenced_at: Date | null }>(
        `SELECT fenced_at FROM agent_sandbox_attempt_fences
         WHERE owner_id = $1 AND workspace_id = $2 AND run_id = $3 AND attempt_number = $4 AND generation = $5
         FOR UPDATE`,
        [identity.owner_id, identity.workspace_id, identity.run_id, identity.attempt_number, generation]
      )).rows[0];
      if (!fence || fence.fenced_at || identity.lifecycle_state !== 'active' ||
          runRow.status !== 'running' || runRow.attempt_count !== identity.attempt_number ||
          runRow.lease_token !== identity.lease_token || !runRow.lease_expires_at ||
          new Date(runRow.lease_expires_at).getTime() <= Date.now()) {
        throw new ConflictError('Sandbox runtime operation is fenced for this attempt');
      }
      const currentSession = (await client.query<{ lifecycle_state: SandboxLifecycleState; attempt_generation: string }>(
        'SELECT lifecycle_state, attempt_generation FROM agent_sandbox_sessions WHERE id = $1 FOR UPDATE', [sessionId]
      )).rows[0];
      if (!currentSession || currentSession.lifecycle_state !== 'active' || currentSession.attempt_generation !== generation) {
        throw new ConflictError('Sandbox session is stopping or fenced');
      }
      const opId = randomUUID();
      await client.query(
        `INSERT INTO agent_sandbox_lifecycle_operations (
           id, session_id, owner_id, workspace_id, run_id, attempt_number, generation,
           operation_kind, state, operation_name
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'in_progress', $9)`,
        [opId, sessionId, identity.owner_id, identity.workspace_id, identity.run_id,
          identity.attempt_number, generation, kind, operationName.slice(0, 128)]
      );
      return opId;
    });
  }

  async settleSandboxRuntimeOperation(operationId: string): Promise<void> {
    await this.pool.query(
      `UPDATE agent_sandbox_lifecycle_operations SET state = 'settled', settled_at = NOW()
       WHERE id = $1 AND operation_kind IN ('tool', 'snapshot') AND state IN ('in_progress', 'ambiguous')`,
      [operationId]
    );
  }

  async markSandboxRuntimeOperationAmbiguous(operationId: string): Promise<void> {
    await this.pool.query(
      `UPDATE agent_sandbox_lifecycle_operations SET state = 'ambiguous'
       WHERE id = $1 AND operation_kind IN ('tool', 'snapshot') AND state = 'in_progress'`,
      [operationId]
    );
  }

  /** Provider-confirmed absence of the exact allocation operation, never a TTL inference. */
  async confirmSandboxAllocationAbsent(sessionId: string, evidence: string): Promise<void> {
    const identity = (await this.pool.query<{
      owner_id: string; run_id: string; attempt_number: number;
      attempt_generation: string; allocation_intent_id: string;
    }>(
      'SELECT owner_id, run_id, attempt_number, attempt_generation, allocation_intent_id ' +
      'FROM agent_sandbox_sessions WHERE id = $1', [sessionId]
    )).rows[0];
    if (!identity) throw new NotFoundError();
    try {
      const result = await this.lifecycleFinalizationPool.query<SandboxSessionRow>(
        'SELECT * FROM settle_agent_sandbox_allocation($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid, $6::varchar, NULL::varchar, NULL::varchar)',
        [sessionId, identity.owner_id, identity.run_id, identity.attempt_number, identity.attempt_generation, 'no_resource']
      );
      if (!result.rows[0]) throw new NotFoundError();
      await this.pool.query(
        'UPDATE agent_sandbox_lifecycle_operations SET operation_name = $1 WHERE id = $2 AND operation_kind = \'allocation\'',
        [`provider_absence:${evidence}`.slice(0, 128), identity.allocation_intent_id]
      );
      return;
    } catch (err: any) {
      if (!isMissingLifecycleFunction(err, 'settle_agent_sandbox_allocation')) {
        if (err instanceof NotFoundError) throw err;
        if (err?.message?.includes('conflicts')) throw new ConflictError(err.message);
        if (err?.message?.includes('not found')) throw new NotFoundError();
        throw err;
      }
      // In-memory test adapters do not implement PostgreSQL SECURITY DEFINER functions.
    }
    await this.transaction(async (client) => {
      const identity = (await client.query<{
        owner_id: string; workspace_id: string; run_id: string; attempt_number: number;
        attempt_generation: string; allocation_intent_id: string;
      }>('SELECT owner_id, workspace_id, run_id, attempt_number, attempt_generation, allocation_intent_id FROM agent_sandbox_sessions WHERE id = $1', [sessionId])).rows[0];
      if (!identity) throw new NotFoundError();
      await client.query(
        'SELECT id FROM agent_runs WHERE owner_id = $1 AND workspace_id = $2 AND id = $3 FOR UPDATE',
        [identity.owner_id, identity.workspace_id, identity.run_id]
      );
      const fence = (await client.query<{ fenced_at: Date | null }>(
        `SELECT fenced_at FROM agent_sandbox_attempt_fences WHERE owner_id = $1 AND workspace_id = $2
           AND run_id = $3 AND attempt_number = $4 AND generation = $5 FOR UPDATE`,
        [identity.owner_id, identity.workspace_id, identity.run_id, identity.attempt_number, identity.attempt_generation]
      )).rows[0];
      if (!fence?.fenced_at) throw new ConflictError('Allocation absence cannot be accepted before the attempt is fenced');
      const operation = (await client.query<{ state: string; outcome: string | null }>(
        `SELECT state, outcome FROM agent_sandbox_lifecycle_operations WHERE id = $1 FOR UPDATE`,
        [identity.allocation_intent_id]
      )).rows[0];
      if (!operation || (operation.state === 'settled' && operation.outcome !== 'no_resource')) {
        throw new ConflictError('Provider absence conflicts with an already settled allocation resource');
      }
      if (operation.state !== 'settled') {
        if (operation.state !== 'not_started') {
          throw new ConflictError('Cannot confirm allocation absence for an operation that was already submitted to provider');
        }
        try {
          await client.query(
            'SELECT * FROM settle_agent_sandbox_allocation($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid, $6::varchar, NULL::varchar)',
            [sessionId, identity.owner_id, identity.run_id, identity.attempt_number, identity.attempt_generation, 'no_resource']
          );
        } catch (err: any) {
          if (!isMissingLifecycleFunction(err, 'settle_agent_sandbox_allocation')) {
            throw err;
          }
          await client.query(
            `UPDATE agent_sandbox_lifecycle_operations SET state = 'settled', outcome = 'no_resource',
               provider_resource_id = NULL, operation_name = $2, settled_at = NOW() WHERE id = $1`,
            [identity.allocation_intent_id, `provider_absence:${evidence}`.slice(0, 128)]
          );
        }
      }
      const session = (await client.query<SandboxSessionRow>(
        'SELECT * FROM agent_sandbox_sessions WHERE id = $1 FOR UPDATE', [sessionId]
      )).rows[0];
      if (!session) throw new NotFoundError();
      const diagnostics = {
        ...(session.diagnostics ?? {}),
        allocation_outcome: 'provider_confirmed_absent',
        allocation_evidence: evidence.slice(0, 128),
      };
      await client.query(
        `UPDATE agent_sandbox_sessions SET lifecycle_state = 'failed', allocation_state = 'failed',
           diagnostics = $2, updated_at = NOW()
         WHERE id = $1 AND provider_session_id IS NULL AND lifecycle_state = 'allocating'`,
        [sessionId, JSON.stringify(diagnostics)]
      );
    });
  }

  /**
   * Fences one exact attempt while holding the same run -> fence lock order as allocation
   * and runtime-operation admission. It revokes the current lease for that attempt.
   */
  async fenceSandboxAttempt(reference: {
    ownerId: string; workspaceId: string; runId: string; attemptNumber: number;
  }, reason = 'quota_reconciliation'): Promise<void> {
    let neverStartedSessionId: string | undefined;
    await this.transaction(async (client) => {
      const runRow = (await client.query<RunRow>(
        'SELECT * FROM agent_runs WHERE owner_id = $1 AND workspace_id = $2 AND id = $3 FOR UPDATE',
        [reference.ownerId, reference.workspaceId, reference.runId]
      )).rows[0];
      if (!runRow) throw new NotFoundError();
      if (reference.attemptNumber > runRow.attempt_count) {
        throw new ConflictError('Cannot fence an attempt that is not present on the durable run');
      }
      let fence = (await client.query<{ generation: string; fenced_at: Date | null }>(
        `SELECT generation, fenced_at FROM agent_sandbox_attempt_fences
         WHERE owner_id = $1 AND workspace_id = $2 AND run_id = $3 AND attempt_number = $4 FOR UPDATE`,
        [reference.ownerId, reference.workspaceId, reference.runId, reference.attemptNumber]
      )).rows[0];
      if (!fence) {
        fence = (await client.query<{ generation: string; fenced_at: Date | null }>(
          `INSERT INTO agent_sandbox_attempt_fences
             (owner_id, workspace_id, run_id, attempt_number, generation, fenced_at, fence_reason)
           VALUES ($1, $2, $3, $4, $5, NOW(), $6) RETURNING generation, fenced_at`,
          [reference.ownerId, reference.workspaceId, reference.runId, reference.attemptNumber, randomUUID(), reason]
        )).rows[0]!;
      } else if (!fence.fenced_at) {
        await client.query(
          `UPDATE agent_sandbox_attempt_fences SET fenced_at = NOW(), fence_reason = $5
           WHERE owner_id = $1 AND workspace_id = $2 AND run_id = $3 AND attempt_number = $4`,
          [reference.ownerId, reference.workspaceId, reference.runId, reference.attemptNumber, reason]
        );
      }
      if (runRow.status === 'running' && runRow.attempt_count === reference.attemptNumber && runRow.lease_token) {
        await client.query(
          `UPDATE agent_runs SET lease_token = NULL, lease_expires_at = NOW(), updated_at = NOW()
           WHERE owner_id = $1 AND workspace_id = $2 AND id = $3 AND attempt_count = $4`,
          [reference.ownerId, reference.workspaceId, reference.runId, reference.attemptNumber]
        );
      }
      const session = (await client.query<SandboxSessionRow>(
        `SELECT * FROM agent_sandbox_sessions WHERE owner_id = $1 AND workspace_id = $2 AND run_id = $3
           AND attempt_number = $4 AND attempt_generation = $5 FOR UPDATE`,
        [reference.ownerId, reference.workspaceId, reference.runId, reference.attemptNumber, fence.generation]
      )).rows[0];
      if (session) {
        const diagnostics = { ...(session.diagnostics ?? {}), fence_reason: 'attempt_fenced' };
        // An operation not yet submitted to the provider is provably resource-free.
        const allocOp = (await client.query<{ state: string }>(
          `SELECT state FROM agent_sandbox_lifecycle_operations WHERE id = $1 AND session_id = $2 AND operation_kind = 'allocation'`,
          [session.allocation_intent_id, session.id]
        )).rows[0];
        if (allocOp?.state === 'not_started') {
          neverStartedSessionId = session.id;
        }
        const allocation = (await client.query<{ state: string; outcome: string | null }>(
          `SELECT state, outcome FROM agent_sandbox_lifecycle_operations
           WHERE session_id = $1 AND operation_kind = 'allocation'`, [session.id]
        )).rows[0];
        if (allocation?.state === 'settled' && allocation.outcome === 'no_resource' && !session.provider_session_id) {
          const failedDiagnostics = { ...diagnostics, allocation_outcome: 'no_resource' };
          await client.query(
            `UPDATE agent_sandbox_sessions SET lifecycle_state = 'failed', allocation_state = 'failed',
               diagnostics = $2,
               updated_at = NOW() WHERE id = $1 AND lifecycle_state = 'allocating'`,
            [session.id, JSON.stringify(failedDiagnostics)]
          );
        }
        if (session.provider_session_id && session.lifecycle_state !== 'destroyed') {
          await client.query(
            `UPDATE agent_sandbox_sessions
             SET lifecycle_state = CASE
                   WHEN cleanup_state = 'in_progress' AND cleanup_lease_expires_at > NOW()
                     THEN 'destroying' ELSE 'cleanup_pending' END,
                 cleanup_state = CASE
                   WHEN cleanup_state = 'in_progress' AND cleanup_lease_expires_at > NOW()
                     THEN 'in_progress' ELSE 'pending' END,
               diagnostics = $2, updated_at = NOW()
             WHERE id = $1 AND lifecycle_state IN ('allocating', 'active', 'stopping', 'destroying', 'cleanup_pending')`,
            [session.id, JSON.stringify(diagnostics)]
          );
        } else if (!session.provider_session_id) {
          await client.query(
            `UPDATE agent_sandbox_sessions SET diagnostics = $2,
               updated_at = NOW() WHERE id = $1 AND lifecycle_state = 'allocating'`,
            [session.id, JSON.stringify(diagnostics)]
          );
        }
      }
    });
    if (neverStartedSessionId) {
      await this.confirmSandboxAllocationAbsent(neverStartedSessionId, 'attempt_fenced_before_provider_submit');
    }
  }

  async getSandboxAttemptLifecycle(reference: {
    ownerId: string; workspaceId: string; runId: string; attemptNumber: number;
  }): Promise<SandboxAttemptLifecycleSnapshot> {
    const fence = await this.pool.query<{ fenced_at: Date | null }>(
      `SELECT fenced_at FROM agent_sandbox_attempt_fences
       WHERE owner_id = $1 AND workspace_id = $2 AND run_id = $3 AND attempt_number = $4`,
      [reference.ownerId, reference.workspaceId, reference.runId, reference.attemptNumber]
    );
    const session = await this.pool.query<SandboxSessionRow>(
      `SELECT * FROM agent_sandbox_sessions WHERE owner_id = $1 AND workspace_id = $2 AND run_id = $3
       AND attempt_number = $4`, [reference.ownerId, reference.workspaceId, reference.runId, reference.attemptNumber]
    );
    const operations = await this.pool.query<{
      id: string; session_id: string; owner_id: string; workspace_id: string; run_id: string;
      attempt_number: number; generation: string; operation_kind: SandboxLifecycleOperation['kind'];
      state: SandboxLifecycleOperation['state']; outcome: SandboxLifecycleOperation['outcome'];
      provider_resource_id: string | null;
    }>(
      `SELECT id, session_id, owner_id, workspace_id, run_id, attempt_number, generation,
              operation_kind, state, outcome, provider_resource_id
       FROM agent_sandbox_lifecycle_operations WHERE owner_id = $1 AND workspace_id = $2 AND run_id = $3
         AND attempt_number = $4 ORDER BY created_at, id`,
      [reference.ownerId, reference.workspaceId, reference.runId, reference.attemptNumber]
    );
    return {
      fenced: Boolean(fence.rows[0]?.fenced_at),
      session: session.rows[0] ? sandboxSession(session.rows[0]) : null,
      operations: operations.rows.map((row) => ({
        id: row.id, sessionId: row.session_id, ownerId: row.owner_id, workspaceId: row.workspace_id,
        runId: row.run_id, attemptNumber: row.attempt_number, generation: row.generation,
        kind: row.operation_kind, state: row.state, outcome: row.outcome,
        providerResourceId: row.provider_resource_id,
      })),
    };
  }

  /**
   * Records that sandbox allocation failed or timed out.
   */
  async recordSandboxAllocationFailed(
    sessionId: string,
    reason: string,
    diagnostics?: Record<string, unknown>
  ): Promise<DurableSandboxSession> {
    const cleanReason = redactSensitiveContent(reason);
    const cleanDiag = diagnostics
      ? (AgentRepository.redactJsonValue(diagnostics) as Record<string, unknown>)
      : {};
    let needsNoResourceSettlement = false;
    const result = await this.transaction(async (client) => {
      const identity = (await client.query<{
        owner_id: string; workspace_id: string; run_id: string; attempt_number: number;
        attempt_generation: string; allocation_intent_id: string;
      }>('SELECT owner_id, workspace_id, run_id, attempt_number, attempt_generation, allocation_intent_id FROM agent_sandbox_sessions WHERE id = $1', [sessionId])).rows[0];
      if (!identity) throw new NotFoundError();
      await client.query(
        'SELECT id FROM agent_runs WHERE owner_id = $1 AND workspace_id = $2 AND id = $3 FOR UPDATE',
        [identity.owner_id, identity.workspace_id, identity.run_id]
      );
      const fence = (await client.query<{ fenced_at: Date | null }>(
        `SELECT fenced_at FROM agent_sandbox_attempt_fences WHERE owner_id = $1 AND workspace_id = $2
           AND run_id = $3 AND attempt_number = $4 AND generation = $5 FOR UPDATE`,
        [identity.owner_id, identity.workspace_id, identity.run_id, identity.attempt_number, identity.attempt_generation]
      )).rows[0];
      const session = (await client.query<SandboxSessionRow>(
        "SELECT * FROM agent_sandbox_sessions WHERE id = $1 AND lifecycle_state IN ('allocating', 'destroying', 'failed') FOR UPDATE", [sessionId]
      )).rows[0];
      if (!session) throw new NotFoundError();
      const operation = (await client.query<{ state: string; outcome: string | null }>(
        `SELECT state, outcome FROM agent_sandbox_lifecycle_operations WHERE id = $1 FOR UPDATE`,
        [identity.allocation_intent_id]
      )).rows[0];
      if (!operation) throw new ConflictError('Durable allocation operation is missing');
      if (operation.state === 'in_progress' || operation.state === 'ambiguous' || operation.outcome === 'resource') {
        throw new ConflictError('Provider allocation outcome is not known to be resource-free');
      }
      if (!fence) throw new ConflictError('Sandbox attempt generation fence is missing');
      if (!fence.fenced_at) {
        await client.query(
          `UPDATE agent_sandbox_attempt_fences SET fenced_at = NOW(), fence_reason = 'allocation_confirmed_absent'
           WHERE owner_id = $1 AND workspace_id = $2 AND run_id = $3 AND attempt_number = $4
             AND generation = $5 AND fenced_at IS NULL`,
          [identity.owner_id, identity.workspace_id, identity.run_id, identity.attempt_number, identity.attempt_generation]
        );
      }
      if (operation.state === 'not_started') {
        needsNoResourceSettlement = true;
      }
      const existingDiag = session.diagnostics && typeof session.diagnostics === 'object' ? session.diagnostics : {};
      const mergedDiag = JSON.stringify({ ...existingDiag, reason: cleanReason, ...cleanDiag,
        fenced_before_failure_commit: true });
      const updated = await client.query<SandboxSessionRow>(
        `UPDATE agent_sandbox_sessions SET lifecycle_state = 'failed', allocation_state = 'failed',
           diagnostics = $1, updated_at = NOW() WHERE id = $2 RETURNING *`, [mergedDiag, sessionId]
      );
      return sandboxSession(updated.rows[0]!);
    });
    if (needsNoResourceSettlement) {
      await this.confirmSandboxAllocationAbsent(sessionId, 'attempt_fenced_before_provider_submit');
      return this.getSandboxSession(result.ownerId, sessionId);
    }
    return result;
  }

  /**
   * Gets a sandbox session by ID with tenant owner scoping.
   */
  async getSandboxSession(ownerId: string, sessionId: string): Promise<DurableSandboxSession> {
    const result = await this.pool.query<SandboxSessionRow>(
      'SELECT * FROM agent_sandbox_sessions WHERE owner_id = $1 AND id = $2',
      [ownerId, sessionId]
    );
    if (!result.rows[0]) throw new NotFoundError();
    return sandboxSession(result.rows[0]);
  }

  /**
   * Gets a sandbox session by ID without owner scoping (internal use).
   */
  async getSandboxSessionById(sessionId: string): Promise<DurableSandboxSession | null> {
    const result = await this.pool.query<SandboxSessionRow>(
      'SELECT * FROM agent_sandbox_sessions WHERE id = $1',
      [sessionId]
    );
    return result.rows[0] ? sandboxSession(result.rows[0]) : null;
  }

  /**
   * Gets the latest sandbox session for a run.
   */
  async getSandboxSessionByRunId(ownerId: string, runId: string): Promise<DurableSandboxSession | null> {
    const result = await this.pool.query<SandboxSessionRow>(
      'SELECT * FROM agent_sandbox_sessions WHERE owner_id = $1 AND run_id = $2 ORDER BY created_at DESC LIMIT 1',
      [ownerId, runId]
    );
    return result.rows[0] ? sandboxSession(result.rows[0]) : null;
  }

  /**
   * Gets the active non-terminal sandbox session for a run.
   */
  async getActiveSandboxSessionForRun(ownerId: string, runId: string): Promise<DurableSandboxSession | null> {
    const result = await this.pool.query<SandboxSessionRow>(
      `SELECT * FROM agent_sandbox_sessions
       WHERE owner_id = $1 AND run_id = $2 AND lifecycle_state IN ('allocating', 'active', 'stopping')
       LIMIT 1`,
      [ownerId, runId]
    );
    return result.rows[0] ? sandboxSession(result.rows[0]) : null;
  }

  /**
   * Marks a sandbox session as stopping.
   */
  async markSandboxStopping(ownerId: string, sessionId: string): Promise<DurableSandboxSession> {
    return this.transaction(async (client) => {
      const identity = (await client.query<{ workspace_id: string; run_id: string; attempt_number: number }>(
        'SELECT workspace_id, run_id, attempt_number FROM agent_sandbox_sessions WHERE owner_id = $1 AND id = $2',
        [ownerId, sessionId]
      )).rows[0];
      if (!identity) throw new NotFoundError();
      await client.query(
        'SELECT id FROM agent_runs WHERE owner_id = $1 AND workspace_id = $2 AND id = $3 FOR UPDATE',
        [ownerId, identity.workspace_id, identity.run_id]
      );
      await client.query(
        `SELECT generation FROM agent_sandbox_attempt_fences WHERE owner_id = $1 AND workspace_id = $2
           AND run_id = $3 AND attempt_number = $4 FOR UPDATE`,
        [ownerId, identity.workspace_id, identity.run_id, identity.attempt_number]
      );
      const result = await client.query<SandboxSessionRow>(
        `UPDATE agent_sandbox_sessions SET lifecycle_state = 'stopping', updated_at = NOW()
         WHERE owner_id = $1 AND id = $2 AND lifecycle_state IN ('allocating', 'active') RETURNING *`,
        [ownerId, sessionId]
      );
      if (!result.rows[0]) throw new NotFoundError();
      return sandboxSession(result.rows[0]);
    });
  }

  /**
   * Marks a sandbox session as destroyed (durable tombstone), fenced by cleanup lease token.
   * Preserves existing destroyed_at timestamp if already destroyed.
   */
  async markSandboxDestroyed(
    sessionId: string,
    providerSessionId?: string,
    leaseToken?: string
  ): Promise<DurableSandboxSession> {
    if (!providerSessionId) throw new ConflictError('Provider destruction requires the exact resource identity');
    try {
      const result = await this.lifecycleFinalizationPool.query<SandboxSessionRow>(
        'SELECT * FROM finalize_agent_sandbox_destruction($1::uuid, $2::varchar, $3::varchar)',
        [sessionId, providerSessionId, leaseToken ?? null]
      );
      const row = result.rows[0];
      if (!row || !row.id) throw new NotFoundError();
      return sandboxSession(row);
    } catch (err: any) {
      if (!isMissingLifecycleFunction(err, 'finalize_agent_sandbox_destruction')) {
        if (err?.message?.includes('not found') || err?.message?.includes('Sandbox session not found')) throw new NotFoundError();
        if (
          err?.message?.includes('fenced') || err?.message?.includes('conflicts') ||
          err?.message?.includes('expired') || err?.message?.includes('unverified') ||
          err?.message?.includes('forbidden') || err?.message?.includes('mismatch') ||
          err?.message?.includes('requires')
        ) {
          throw new ConflictError(err.message);
        }
        throw err;
      }
    }
    return this.transaction(async (client) => {
      const session = (await client.query<SandboxSessionRow>(
        'SELECT * FROM agent_sandbox_sessions WHERE id = $1 FOR UPDATE', [sessionId]
      )).rows[0];
      if (!session) throw new NotFoundError();
      if (session.lifecycle_state === 'destroyed') {
        if (session.provider_session_id !== providerSessionId) {
          throw new ConflictError('Repeated destruction callback conflicts with the tombstoned provider identity');
        }
        return sandboxSession(session);
      }
      if (session.provider_session_id && session.provider_session_id !== providerSessionId) {
        throw new ConflictError('Provider destruction identity conflicts with the durable sandbox session');
      }
      if (leaseToken && session.cleanup_lease_token !== leaseToken) {
        throw new ConflictError('Cleanup lease was fenced before destruction could be recorded');
      }
      if (
        session.lifecycle_state === 'destroying' &&
        session.cleanup_state === 'in_progress' &&
        session.cleanup_lease_expires_at &&
        new Date(session.cleanup_lease_expires_at).getTime() <= Date.now()
      ) {
        throw new ConflictError('Cleanup lease expired before destruction could be committed');
      }
      const allocation = (await client.query<{
        state: string; outcome: string | null; provider_resource_id: string | null;
      }>(
        `SELECT state, outcome, provider_resource_id FROM agent_sandbox_lifecycle_operations
         WHERE session_id = $1 AND operation_kind = 'allocation' FOR UPDATE`, [sessionId]
      )).rows[0];
      if (!allocation || allocation.state !== 'settled' || allocation.outcome !== 'resource' ||
          allocation.provider_resource_id !== providerSessionId) {
        throw new ConflictError('Provider destruction cannot settle an unverified allocation identity');
      }

      if (session.lifecycle_state !== 'destroying') {
        const leaseTokenToUse = leaseToken ?? randomUUID();
        const leaseExpiresAt = new Date(Date.now() + 30_000);
        await client.query(
          `UPDATE agent_sandbox_sessions
           SET lifecycle_state = 'destroying',
               cleanup_state = 'in_progress',
               cleanup_lease_token = $2,
               cleanup_lease_expires_at = $3,
               cleanup_worker_id = COALESCE(cleanup_worker_id, 'direct_destroy'),
               updated_at = NOW()
           WHERE id = $1`,
          [sessionId, leaseTokenToUse, leaseExpiresAt.toISOString()]
        );
      }

      const updated = await client.query<SandboxSessionRow>(
        `UPDATE agent_sandbox_sessions SET lifecycle_state = 'destroyed', cleanup_state = 'completed',
           cleanup_lease_token = NULL, cleanup_lease_expires_at = NULL,
           destroyed_at = COALESCE(destroyed_at, NOW()), updated_at = NOW(),
           provider_session_id = $2 WHERE id = $1 RETURNING *`,
        [sessionId, providerSessionId]
      );
      if (!updated.rows[0]) throw new NotFoundError();
      return sandboxSession(updated.rows[0]);
    });
  }

  /**
   * Records that provider allocation succeeded but commit/abort failed to destroy immediately;
   * marks session for background cleanup reconciliation.
   */
  async recordSandboxAllocationCleanupPending(
    sessionId: string,
    providerSessionId: string,
    errorReason: string,
    retryDelayMs = 5000
  ): Promise<DurableSandboxSession> {
    const cleanError = redactSensitiveContent(errorReason);
    const retryAt = new Date(Date.now() + retryDelayMs);
    const session = await this.getSandboxSessionById(sessionId);
    if (!session) throw new NotFoundError();
    await this.commitSandboxSessionAllocated({
      sessionId,
      ownerId: session.ownerId,
      runId: session.runId,
      leaseToken: session.leaseToken,
      providerSessionId,
    });
    return this.transaction(async (client) => {
      const row = (await client.query<SandboxSessionRow>(
        'SELECT * FROM agent_sandbox_sessions WHERE id = $1 FOR UPDATE', [sessionId]
      )).rows[0];
      if (!row) throw new NotFoundError();
      const operation = (await client.query<{ state: string; outcome: string | null; provider_resource_id: string | null }>(
        `SELECT state, outcome, provider_resource_id FROM agent_sandbox_lifecycle_operations
         WHERE id = $1 AND session_id = $2 AND operation_kind = 'allocation' FOR UPDATE`,
        [row.allocation_intent_id, sessionId]
      )).rows[0];
      if (!operation || operation.state !== 'settled' || operation.outcome !== 'resource' ||
          operation.provider_resource_id !== providerSessionId) {
        throw new ConflictError('Provider cleanup identity conflicts with the durable allocation outcome');
      }
      const existingDiag = row.diagnostics && typeof row.diagnostics === 'object' ? row.diagnostics : {};
      const mergedDiag = JSON.stringify({ ...existingDiag, allocation_cleanup_error: cleanError });
      const result = await client.query<SandboxSessionRow>(
        `UPDATE agent_sandbox_sessions SET lifecycle_state = 'cleanup_pending',
           cleanup_state = 'retry_scheduled', allocation_state = 'allocated',
           next_cleanup_retry_at = $2, diagnostics = $3, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [sessionId, retryAt.toISOString(), mergedDiag]
      );
      return sandboxSession(result.rows[0]!);
    });
  }

  /**
   * Marks a sandbox session for cleanup retry with exponential backoff delay,
   * fenced by cleanup lease token.
   */
  async markSandboxCleanupPending(
    sessionId: string,
    errorReason: string,
    retryDelayMs = 5000,
    leaseToken?: string
  ): Promise<DurableSandboxSession> {
    const cleanError = redactSensitiveContent(errorReason);
    const retryAt = new Date(Date.now() + retryDelayMs);

    const sessionRes = await this.pool.query<SandboxSessionRow>(
      'SELECT id, diagnostics FROM agent_sandbox_sessions WHERE id = $1',
      [sessionId]
    );
    const row = sessionRes.rows[0];
    if (!row) throw new NotFoundError();

    const existingDiag = (row.diagnostics && typeof row.diagnostics === 'object') ? row.diagnostics : {};
    const mergedDiag = JSON.stringify({ ...existingDiag, last_cleanup_error: cleanError });

    const result = await this.pool.query<SandboxSessionRow>(
      `UPDATE agent_sandbox_sessions
       SET lifecycle_state = 'cleanup_pending',
           cleanup_state = 'retry_scheduled',
           cleanup_attempts = cleanup_attempts + 1,
           next_cleanup_retry_at = $2,
           cleanup_lease_token = NULL,
           cleanup_lease_expires_at = NULL,
           diagnostics = $3,
           updated_at = NOW()
       WHERE id = $1
         AND lifecycle_state <> 'destroyed'
         AND ($4::text IS NULL OR cleanup_lease_token = $4)
       RETURNING *`,
      [sessionId, retryAt.toISOString(), mergedDiag, leaseToken ?? null]
    );
    if (!result.rows[0]) {
      const existing = await this.getSandboxSessionById(sessionId);
      if (existing) return existing;
      throw new NotFoundError();
    }
    return sandboxSession(result.rows[0]);
  }

  /**
   * Marks cleanup permanently failed when retry limit is exceeded, retaining durable record.
   */
  async markSandboxCleanupFailed(
    sessionId: string,
    errorReason: string,
    leaseToken?: string
  ): Promise<DurableSandboxSession> {
    const cleanError = redactSensitiveContent(errorReason);
    const sessionRes = await this.pool.query<SandboxSessionRow>(
      'SELECT id, diagnostics FROM agent_sandbox_sessions WHERE id = $1',
      [sessionId]
    );
    const row = sessionRes.rows[0];
    if (!row) throw new NotFoundError();

    const existingDiag = (row.diagnostics && typeof row.diagnostics === 'object') ? row.diagnostics : {};
    const mergedDiag = JSON.stringify({ ...existingDiag, last_cleanup_error: cleanError, max_cleanup_attempts_exceeded: true });

    const result = await this.pool.query<SandboxSessionRow>(
      `UPDATE agent_sandbox_sessions
       SET lifecycle_state = 'cleanup_pending',
           cleanup_state = 'failed',
           cleanup_attempts = cleanup_attempts + 1,
           cleanup_lease_token = NULL,
           cleanup_lease_expires_at = NULL,
           diagnostics = $2,
           updated_at = NOW()
       WHERE id = $1
         AND lifecycle_state <> 'destroyed'
         AND ($3::text IS NULL OR cleanup_lease_token = $3)
       RETURNING *`,
      [sessionId, mergedDiag, leaseToken ?? null]
    );
    if (!result.rows[0]) {
      const existing = await this.getSandboxSessionById(sessionId);
      if (existing) return existing;
      throw new NotFoundError();
    }
    return sandboxSession(result.rows[0]);
  }

  /**
   * Updates verified checks array on active session.
   */
  async updateSandboxVerifiedChecks(
    ownerId: string,
    sessionId: string,
    checks: readonly VerifiedCheck[]
  ): Promise<void> {
    await this.pool.query(
      `UPDATE agent_sandbox_sessions
       SET verified_checks = $1, updated_at = NOW()
       WHERE owner_id = $2 AND id = $3 AND lifecycle_state IN ('active', 'allocating')`,
      [JSON.stringify(checks), ownerId, sessionId]
    );
  }

  /**
   * Queries sessions needing cleanup with FOR UPDATE OF s SKIP LOCKED.
   */
  async listSandboxSessionsNeedingCleanup(limit = 10): Promise<readonly DurableSandboxSession[]> {
    const result = await this.pool.query<SandboxSessionRow>(
      `SELECT s.* FROM agent_sandbox_sessions s
       LEFT JOIN agent_runs r ON r.id = s.run_id
       WHERE (
         (s.lifecycle_state = 'allocating' AND s.allocation_expires_at <= NOW())
         OR (s.lifecycle_state = 'cleanup_pending' AND (s.next_cleanup_retry_at IS NULL OR s.next_cleanup_retry_at <= NOW()))
         OR (s.lifecycle_state = 'destroying' AND (s.cleanup_lease_expires_at IS NULL OR s.cleanup_lease_expires_at <= NOW()))
         OR (s.lifecycle_state IN ('active', 'stopping') AND (r.status IN ('completed', 'failed', 'cancelled') OR r.lease_expires_at <= NOW()))
       )
       AND s.lifecycle_state <> 'destroyed'
       AND (
         s.cleanup_state <> 'in_progress'
         OR s.cleanup_lease_expires_at IS NULL
         OR s.cleanup_lease_expires_at <= NOW()
       )
       ORDER BY s.created_at ASC
       LIMIT $1
       FOR UPDATE OF s SKIP LOCKED`,
      [limit]
    );
    return result.rows.map(sandboxSession);
  }

  /**
   * Claims a single session for cleanup processing with an expiring lease.
   */
  async claimSandboxSessionForCleanup(params: {
    sessionId: string;
    workerId: string;
    leaseToken: string;
    leaseDurationMs?: number;
  }): Promise<DurableSandboxSession | null> {
    const durationMs = params.leaseDurationMs ?? 30_000;
    try {
      const result = await this.lifecycleFinalizationPool.query<SandboxSessionRow>(
        'SELECT * FROM claim_agent_sandbox_cleanup($1::uuid, $2::varchar, $3::varchar, $4::integer)',
        [params.sessionId, params.workerId, params.leaseToken, durationMs]
      );
      const row = result.rows[0];
      return row && row.id ? sandboxSession(row) : null;
    } catch (err: any) {
      if (!isMissingLifecycleFunction(err, 'claim_agent_sandbox_cleanup')) {
        throw err;
      }
      const expiresAt = new Date(Date.now() + durationMs);
      const result = await this.pool.query<SandboxSessionRow>(
        `UPDATE agent_sandbox_sessions
         SET cleanup_state = 'in_progress',
             lifecycle_state = 'destroying',
             cleanup_worker_id = $2,
             cleanup_lease_token = $3,
             cleanup_lease_expires_at = $4,
             updated_at = NOW()
         WHERE id = $1
           AND lifecycle_state <> 'destroyed'
           AND (
             cleanup_state <> 'in_progress'
             OR cleanup_lease_expires_at IS NULL
             OR cleanup_lease_expires_at <= NOW()
           )
         RETURNING *`,
        [params.sessionId, params.workerId, params.leaseToken, expiresAt.toISOString()]
      );
      return result.rows[0] ? sandboxSession(result.rows[0]) : null;
    }
  }
}
