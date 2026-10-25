import { createHash } from 'node:crypto';
import type pg from 'pg';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../auth/auth-validation.js';
import type { AgentMode } from './types.js';
import {
  DEFAULT_AGENT_QUOTA_POLICY,
  resourceLimitsForMode,
  validateAgentQuotaPolicy,
  type AgentDailyBudget,
  type AgentQuotaPolicy,
  type AgentResourceLimits,
} from './quota-policy.js';

export type AgentQuotaErrorCode = 'RATE_LIMITED' | 'LIMIT_EXCEEDED' | 'WORKSPACE_BUSY';
export type AgentQuotaReservationState = 'reserved' | 'active' | 'reconciliation_required' | 'committed' | 'released';
export type AgentQuotaUsageKind = 'provider_request' | 'tool_call' | 'measurement';

export interface AgentQuotaReference {
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptNumber: number;
}

export interface AgentExecutionReservation extends AgentQuotaReference {
  readonly id: string;
  readonly mode: AgentMode;
  readonly state: AgentQuotaReservationState;
  readonly resourceActive: boolean;
  readonly limits: AgentResourceLimits;
  readonly accounted: AgentResourceUsage;
  readonly actual: AgentResourceUsage;
  readonly createdAt: string;
  readonly deadlineAt: string;
}

export interface AgentResourceUsage {
  readonly sandboxRuntimeMs: number;
  readonly wallClockMs: number;
  readonly toolCalls: number;
  readonly providerRequests: number;
  readonly commandOutputBytes: number;
  readonly artifactBytes: number;
  readonly workspaceDiskBytes: number;
  readonly workspaceFileCount: number;
}

export type AgentResourceUsageInput = Partial<AgentResourceUsage>;

export interface QuotaQuiescenceVerifier {
  /** True only after this exact owner/workspace/run/attempt can no longer consume runtime resources. */
  isQuiescent(reference: AgentQuotaReference): Promise<boolean>;
}

export class AgentQuotaError extends AppError {
  readonly retryAfterSeconds?: number;

  constructor(code: AgentQuotaErrorCode) {
    const status = code === 'RATE_LIMITED' ? 429 : code === 'LIMIT_EXCEEDED' ? 422 : 409;
    const message = code === 'RATE_LIMITED'
      ? 'Agent request capacity is temporarily unavailable'
      : code === 'LIMIT_EXCEEDED'
        ? 'Agent execution exceeds a configured resource limit'
        : 'Workspace writable capacity is currently unavailable';
    super(code, message, status);
    this.name = 'AgentQuotaError';
    if (code === 'RATE_LIMITED') this.retryAfterSeconds = 60;
    if (code === 'WORKSPACE_BUSY') this.retryAfterSeconds = 5;
  }
}

interface RunQuotaRow {
  owner_id: string;
  workspace_id: string;
  mode: AgentMode;
  status: string;
  attempt_count: number;
  lease_token: string | null;
  lease_active: boolean;
}

interface ReservationRow extends Record<string, unknown> {
  id: string;
  owner_id: string;
  workspace_id: string;
  run_id: string;
  attempt_number: number;
  mode: AgentMode;
  state: AgentQuotaReservationState;
  resource_active: boolean;
  lease_token_hash: string;
  created_at: Date | string;
  started_at: Date | string | null;
  max_sandbox_runtime_ms: string | number;
  max_wall_clock_ms: string | number;
  max_tool_calls: string | number;
  max_provider_requests: string | number;
  max_command_output_bytes: string | number;
  max_artifact_bytes: string | number;
  max_workspace_disk_bytes: string | number;
  max_workspace_file_count: string | number;
  accounted_sandbox_runtime_ms: string | number;
  accounted_wall_clock_ms: string | number;
  accounted_tool_calls: string | number;
  accounted_provider_requests: string | number;
  accounted_command_output_bytes: string | number;
  accounted_artifact_bytes: string | number;
  accounted_workspace_disk_bytes: string | number;
  accounted_workspace_file_count: string | number;
  actual_sandbox_runtime_ms: string | number;
  actual_wall_clock_ms: string | number;
  actual_tool_calls: string | number;
  actual_provider_requests: string | number;
  actual_command_output_bytes: string | number;
  actual_artifact_bytes: string | number;
  actual_workspace_disk_bytes: string | number;
  actual_workspace_file_count: string | number;
}

interface UsageEventRow {
  event_key: string;
  event_kind: string;
  request_fingerprint: string;
  sandbox_runtime_ms: string | number;
  wall_clock_ms: string | number;
  tool_calls: string | number;
  provider_requests: string | number;
  command_output_bytes: string | number;
  artifact_bytes: string | number;
  workspace_disk_bytes: string | number;
  workspace_file_count: string | number;
  limit_exceeded: boolean;
  created_at: Date | string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const METRICS = [
  { key: 'sandboxRuntimeMs', max: 'max_sandbox_runtime_ms', accounted: 'accounted_sandbox_runtime_ms', actual: 'actual_sandbox_runtime_ms', event: 'sandbox_runtime_ms', kind: 'sum' },
  { key: 'wallClockMs', max: 'max_wall_clock_ms', accounted: 'accounted_wall_clock_ms', actual: 'actual_wall_clock_ms', event: 'wall_clock_ms', kind: 'gauge' },
  { key: 'toolCalls', max: 'max_tool_calls', accounted: 'accounted_tool_calls', actual: 'actual_tool_calls', event: 'tool_calls', kind: 'sum' },
  { key: 'providerRequests', max: 'max_provider_requests', accounted: 'accounted_provider_requests', actual: 'actual_provider_requests', event: 'provider_requests', kind: 'sum' },
  { key: 'commandOutputBytes', max: 'max_command_output_bytes', accounted: 'accounted_command_output_bytes', actual: 'actual_command_output_bytes', event: 'command_output_bytes', kind: 'sum' },
  { key: 'artifactBytes', max: 'max_artifact_bytes', accounted: 'accounted_artifact_bytes', actual: 'actual_artifact_bytes', event: 'artifact_bytes', kind: 'sum' },
  { key: 'workspaceDiskBytes', max: 'max_workspace_disk_bytes', accounted: 'accounted_workspace_disk_bytes', actual: 'actual_workspace_disk_bytes', event: 'workspace_disk_bytes', kind: 'gauge' },
  { key: 'workspaceFileCount', max: 'max_workspace_file_count', accounted: 'accounted_workspace_file_count', actual: 'actual_workspace_file_count', event: 'workspace_file_count', kind: 'gauge' },
] as const;

type MetricKey = typeof METRICS[number]['key'];
type MetricValues = Record<MetricKey, number>;
type DailyKey = keyof AgentDailyBudget;

const DAILY_METRICS: readonly { readonly key: DailyKey; readonly column: string }[] = [
  { key: 'sandboxRuntimeMs', column: 'accounted_sandbox_runtime_ms' },
  { key: 'providerRequests', column: 'accounted_provider_requests' },
  { key: 'commandOutputBytes', column: 'accounted_command_output_bytes' },
  { key: 'artifactBytes', column: 'accounted_artifact_bytes' },
];

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ValidationError(label + ' must be a non-negative safe integer');
  }
  return value as number;
}

function validateReference(reference: AgentQuotaReference): void {
  for (const [key, value] of Object.entries(reference)) {
    if (key === 'attemptNumber') continue;
    if (typeof value !== 'string' || !UUID.test(value)) throw new ValidationError('Invalid Agent reservation identity');
  }
  if (!Number.isSafeInteger(reference.attemptNumber) || reference.attemptNumber < 1) {
    throw new ValidationError('Invalid Agent reservation attempt');
  }
}

function validateLeaseToken(leaseToken: string): string {
  if (typeof leaseToken !== 'string' || leaseToken.length < 16 || leaseToken.length > 128) {
    throw new ValidationError('Invalid worker lease');
  }
  return createHash('sha256').update(leaseToken).digest('hex');
}

function validateEventKey(key: string): string {
  if (typeof key !== 'string' || !EVENT_KEY.test(key)) throw new ValidationError('Invalid usage event key');
  return key;
}

function parseUsage(input: unknown): MetricValues {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Usage measurement must be an object');
  }
  const source = input as Record<string, unknown>;
  const allowed = new Set<string>(METRICS.map((metric) => metric.key));
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new ValidationError('Unknown usage measurement');
  }
  const result = {} as MetricValues;
  for (const metric of METRICS) result[metric.key] = safeInteger(source[metric.key] ?? 0, metric.key);
  return result;
}

function eventFingerprint(kind: string, usage: MetricValues): string {
  return createHash('sha256').update(JSON.stringify([kind, METRICS.map((metric) => usage[metric.key])])).digest('hex');
}

function numberFromDb(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Persisted quota counter is invalid');
  return parsed;
}

function epochMilliseconds(value: Date | string): number {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error('Database returned an invalid quota timestamp');
  return milliseconds;
}

function dateFromDb(value: Date | string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Persisted quota timestamp is invalid');
  return parsed;
}

function mapMetrics(row: ReservationRow, prefix: 'max' | 'accounted' | 'actual'): MetricValues {
  const columns = row as unknown as Record<string, string | number>;
  const result = {} as MetricValues;
  for (const metric of METRICS) {
    const column = prefix === 'max' ? metric.max : prefix === 'accounted' ? metric.accounted : metric.actual;
    result[metric.key] = numberFromDb(columns[column]!);
  }
  return result;
}

function mapReservation(row: ReservationRow): AgentExecutionReservation {
  const createdAt = dateFromDb(row.created_at);
  const limits = mapMetrics(row, 'max');
  return {
    id: row.id,
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    attemptNumber: row.attempt_number,
    mode: row.mode,
    state: row.state,
    resourceActive: row.resource_active,
    limits,
    accounted: mapMetrics(row, 'accounted'),
    actual: mapMetrics(row, 'actual'),
    createdAt: createdAt.toISOString(),
    deadlineAt: new Date(createdAt.getTime() + limits.wallClockMs).toISOString(),
  };
}

function dbMetrics(values: MetricValues): number[] {
  return METRICS.map((metric) => values[metric.key]);
}

function isOverLimit(actual: MetricValues, limits: MetricValues): boolean {
  return METRICS.some((metric) => actual[metric.key] > limits[metric.key]);
}

export class AgentQuotaService {
  readonly policy: AgentQuotaPolicy;

  constructor(
    private readonly pool: pg.Pool,
    policy: AgentQuotaPolicy = DEFAULT_AGENT_QUOTA_POLICY,
    private readonly quiescenceVerifier?: QuotaQuiescenceVerifier
  ) {
    this.policy = validateAgentQuotaPolicy(policy);
  }

  private async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      client.release();
    }
  }

  private async lockAndVerifyAttempt(
    client: pg.PoolClient,
    reference: AgentQuotaReference,
    leaseToken: string
  ): Promise<RunQuotaRow> {
    const result = await client.query<RunQuotaRow>(
      'SELECT owner_id, workspace_id, mode, status, attempt_count, lease_token, (lease_expires_at > NOW()) AS lease_active ' +
      'FROM agent_runs WHERE owner_id = $1 AND id = $2 FOR UPDATE',
      [reference.ownerId, reference.runId]
    );
    const run = result.rows[0];
    if (!run || run.workspace_id !== reference.workspaceId) throw new NotFoundError();
    if (
      run.status !== 'running' ||
      run.attempt_count !== reference.attemptNumber ||
      run.lease_token !== leaseToken ||
      run.lease_active !== true
    ) {
      throw new ConflictError('Worker fenced: quota operation is stale');
    }
    return run;
  }

  private async lockOwnedReservation(client: pg.PoolClient, reference: AgentQuotaReference): Promise<ReservationRow> {
    const result = await client.query<ReservationRow>(
      'SELECT * FROM agent_execution_reservations ' +
      'WHERE owner_id = $1 AND workspace_id = $2 AND run_id = $3 AND attempt_number = $4 FOR UPDATE',
      [reference.ownerId, reference.workspaceId, reference.runId, reference.attemptNumber]
    );
    if (!result.rows[0]) throw new NotFoundError();
    return result.rows[0];
  }

  private async matchingEvent(
    client: pg.PoolClient,
    reservationId: string,
    eventKey: string,
    fingerprint: string
  ): Promise<boolean> {
    const result = await client.query<{ request_fingerprint: string }>(
      'SELECT request_fingerprint FROM agent_execution_usage_events WHERE reservation_id = $1 AND event_key = $2',
      [reservationId, eventKey]
    );
    if (!result.rows[0]) return false;
    if (result.rows[0].request_fingerprint !== fingerprint) {
      throw new ConflictError('Usage event key was reused with different measurements');
    }
    return true;
  }

  private async insertEvent(
    client: pg.PoolClient,
    reservation: ReservationRow,
    eventKey: string,
    kind: string,
    fingerprint: string,
    usage: MetricValues,
    limitExceeded = false
  ): Promise<void> {
    const values = dbMetrics(usage);
    await client.query(
      'INSERT INTO agent_execution_usage_events ' +
      '(reservation_id, owner_id, workspace_id, run_id, attempt_number, event_key, event_kind, request_fingerprint, ' +
      'sandbox_runtime_ms, wall_clock_ms, tool_calls, provider_requests, command_output_bytes, artifact_bytes, ' +
      'workspace_disk_bytes, workspace_file_count, limit_exceeded) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)',
      [
        reservation.id, reservation.owner_id, reservation.workspace_id, reservation.run_id, reservation.attempt_number,
        eventKey, kind, fingerprint, ...values, limitExceeded,
      ]
    );
  }

  private async updateActual(
    client: pg.PoolClient,
    reservationId: string,
    actual: MetricValues,
    accounted?: MetricValues,
    state?: AgentQuotaReservationState,
    resourceActive?: boolean
  ): Promise<void> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const metric of METRICS) {
      values.push(actual[metric.key]);
      assignments.push(metric.actual + ' = $' + values.length);
    }
    if (accounted) {
      for (const metric of METRICS) {
        values.push(accounted[metric.key]);
        assignments.push(metric.accounted + ' = $' + values.length);
      }
    }
    if (state) {
      values.push(state);
      assignments.push('state = $' + values.length);
    }
    if (resourceActive !== undefined) {
      values.push(resourceActive);
      assignments.push('resource_active = $' + values.length);
    }
    assignments.push('updated_at = NOW()');
    values.push(reservationId);
    await client.query(
      'UPDATE agent_execution_reservations SET ' + assignments.join(', ') + ' WHERE id = $' + values.length,
      values
    );
  }

  private async getOwnedReservation(
    client: pg.PoolClient | pg.Pool,
    reference: AgentQuotaReference,
    lock = false
  ): Promise<ReservationRow> {
    const suffix = lock ? ' FOR UPDATE' : '';
    const result = await client.query<ReservationRow>(
      'SELECT * FROM agent_execution_reservations ' +
      'WHERE owner_id = $1 AND workspace_id = $2 AND run_id = $3 AND attempt_number = $4' + suffix,
      [reference.ownerId, reference.workspaceId, reference.runId, reference.attemptNumber]
    );
    if (!result.rows[0]) throw new NotFoundError();
    return result.rows[0];
  }

  /** Reserve every configured upper bound before the runtime adapter allocates anything. */
  async reserveExecutionAttempt(
    reference: AgentQuotaReference,
    leaseToken: string
  ): Promise<AgentExecutionReservation> {
    validateReference(reference);
    const leaseHash = validateLeaseToken(leaseToken);
    return this.transaction(async (client) => {
      const run = await this.lockAndVerifyAttempt(client, reference, leaseToken);
      if (reference.attemptNumber > this.policy.maxAttempts) throw new AgentQuotaError('LIMIT_EXCEEDED');

      // All admission transactions serialize on the owner row, then lock the workspace row.
      // This enforces per-owner budgets across API processes and across all workspaces.
      const ownerLock = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [reference.ownerId]);
      if (!ownerLock.rows[0]) throw new NotFoundError();
      const workspaceLock = await client.query(
        'SELECT id FROM agent_workspaces WHERE owner_id = $1 AND id = $2 FOR UPDATE',
        [reference.ownerId, reference.workspaceId]
      );
      if (!workspaceLock.rows[0]) throw new NotFoundError();

      const existing = await this.getOwnedReservation(client, reference).catch((error) => {
        if (error instanceof NotFoundError) return undefined;
        throw error;
      });
      if (existing) {
        if (existing.lease_token_hash !== leaseHash) throw new ConflictError('Reservation attempt identity changed');
        return mapReservation(existing);
      }

      const limits = resourceLimitsForMode(this.policy, run.mode);
      const writable = run.mode === 'execute';
      if (writable) {
        const ownerActive = await client.query<{ count: string | number }>(
          'SELECT COUNT(*)::bigint AS count FROM agent_execution_reservations ' +
          'WHERE owner_id = $1 AND writable = TRUE AND resource_active = TRUE',
          [reference.ownerId]
        );
        if (numberFromDb(ownerActive.rows[0]!.count) >= this.policy.maxConcurrentWritableRunsPerOwner) {
          throw new AgentQuotaError('WORKSPACE_BUSY');
        }
        const workspaceActive = await client.query<{ count: string | number }>(
          'SELECT COUNT(*)::bigint AS count FROM agent_execution_reservations ' +
          'WHERE owner_id = $1 AND workspace_id = $2 AND writable = TRUE AND resource_active = TRUE',
          [reference.ownerId, reference.workspaceId]
        );
        if (numberFromDb(workspaceActive.rows[0]!.count) >= this.policy.maxConcurrentWritableRunsPerWorkspace) {
          throw new AgentQuotaError('WORKSPACE_BUSY');
        }
      }

      const window = this.policy.rolling24Hour;
      const ownerUsage = await client.query<Record<string, string | number>>(
        'SELECT ' + DAILY_METRICS.map((metric) => 'COALESCE(SUM(' + metric.column + '), 0)::bigint AS "' + metric.key + '"').join(', ') +
        ' FROM agent_execution_reservations WHERE owner_id = $1 AND state <> $2 AND created_at >= NOW() - INTERVAL \'24 hours\'',
        [reference.ownerId, 'released']
      );
      const workspaceUsage = await client.query<Record<string, string | number>>(
        'SELECT ' + DAILY_METRICS.map((metric) => 'COALESCE(SUM(' + metric.column + '), 0)::bigint AS "' + metric.key + '"').join(', ') +
        ' FROM agent_execution_reservations WHERE owner_id = $1 AND workspace_id = $2 ' +
        'AND state <> $3 AND created_at >= NOW() - INTERVAL \'24 hours\'',
        [reference.ownerId, reference.workspaceId, 'released']
      );
      this.assertDailyBudget(ownerUsage.rows[0]!, limits, window.owner);
      this.assertDailyBudget(workspaceUsage.rows[0]!, limits, window.workspace);

      const insert = await client.query<ReservationRow>(
        'INSERT INTO agent_execution_reservations ' +
        '(owner_id, workspace_id, run_id, attempt_number, mode, state, resource_active, writable, policy_version, ' +
        'lease_token_hash, ' + METRICS.map((metric) => metric.max).join(', ') + ', ' +
        METRICS.map((metric) => metric.accounted).join(', ' ) + ') ' +
        'VALUES ($1, $2, $3, $4, $5, \'reserved\', $6, $7, $8, $9, ' +
        dbMetrics(limits as MetricValues).map((_, i) => '$' + (10 + i)).join(', ') + ', ' +
        dbMetrics(limits as MetricValues).map((_, i) => '$' + (18 + i)).join(', ') + ') RETURNING *',
        [
          reference.ownerId, reference.workspaceId, reference.runId, reference.attemptNumber, run.mode,
          writable, writable, this.policy.version, leaseHash, ...dbMetrics(limits as MetricValues), ...dbMetrics(limits as MetricValues),
        ]
      );
      const reservation = insert.rows[0]!;
      const empty = parseUsage({});
      await this.insertEvent(
        client, reservation, 'reservation.created', 'reservation', eventFingerprint('reservation', empty), empty
      );
      return mapReservation(reservation);
    });
  }

  private assertDailyBudget(
    current: Record<string, string | number>,
    limits: AgentResourceLimits,
    budget: AgentDailyBudget
  ): void {
    for (const item of DAILY_METRICS) {
      const used = numberFromDb(current[item.key] ?? 0);
      if (used + limits[item.key] > budget[item.key]) throw new AgentQuotaError('RATE_LIMITED');
    }
  }

  async getReservation(reference: AgentQuotaReference): Promise<AgentExecutionReservation> {
    validateReference(reference);
    const row = await this.getOwnedReservation(this.pool, reference);
    return mapReservation(row);
  }

  /** Called immediately before allocation; after this point a worker cannot refund by itself. */
  async markAllocationStarted(reference: AgentQuotaReference, leaseToken: string): Promise<AgentExecutionReservation> {
    validateReference(reference);
    validateLeaseToken(leaseToken);
    return this.transaction(async (client) => {
      await this.lockAndVerifyAttempt(client, reference, leaseToken);
      const reservation = await this.lockOwnedReservation(client, reference);
      if (reservation.state === 'active') return mapReservation(reservation);
      if (reservation.state !== 'reserved') throw new ConflictError('Reservation is no longer allocatable');
      const empty = parseUsage({});
      const fingerprint = eventFingerprint('allocation_started', empty);
      await this.insertEvent(client, reservation, 'allocation.started', 'allocation_started', fingerprint, empty);
      const result = await client.query<ReservationRow>(
        'UPDATE agent_execution_reservations SET state = \'active\', started_at = NOW(), updated_at = NOW() ' +
        'WHERE id = $1 RETURNING *',
        [reservation.id]
      );
      return mapReservation(result.rows[0]!);
    });
  }

  /** Record bounded usage with a caller-generated stable event key before or after a measured action. */
  async recordUsage(
    reference: AgentQuotaReference,
    leaseToken: string,
    event: { readonly eventKey: string; readonly kind: AgentQuotaUsageKind; readonly usage: AgentResourceUsageInput }
  ): Promise<AgentExecutionReservation> {
    validateReference(reference);
    validateLeaseToken(leaseToken);
    const eventKey = validateEventKey(event.eventKey);
    if (!['provider_request', 'tool_call', 'measurement'].includes(event.kind)) {
      throw new ValidationError('Invalid usage event kind');
    }
    const usage = parseUsage(event.usage);
    const fingerprint = eventFingerprint(event.kind, usage);
    return this.transaction(async (client) => {
      await this.lockAndVerifyAttempt(client, reference, leaseToken);
      const reservation = await this.lockOwnedReservation(client, reference);
      if (await this.matchingEvent(client, reservation.id, eventKey, fingerprint)) {
        return mapReservation(reservation);
      }
      if (reservation.state !== 'active') throw new ConflictError('Usage cannot be recorded for this reservation');

      const limits = mapMetrics(reservation, 'max');
      const actual = mapMetrics(reservation, 'actual');
      const elapsed = await client.query<{ now: Date | string; started_at: Date | string }>(
        'SELECT NOW() AS now, COALESCE(started_at, created_at) AS started_at ' +
        'FROM agent_execution_reservations WHERE id = $1',
        [reservation.id]
      );
      const next = { ...actual } as MetricValues;
      for (const metric of METRICS) {
        const value = usage[metric.key];
        next[metric.key] = metric.kind === 'sum'
          ? actual[metric.key] + value
          : Math.max(actual[metric.key], value);
      }
      next.wallClockMs = Math.max(
        next.wallClockMs,
        Math.max(0, epochMilliseconds(elapsed.rows[0]!.now) - epochMilliseconds(elapsed.rows[0]!.started_at))
      );
      if (isOverLimit(next, limits)) throw new AgentQuotaError('LIMIT_EXCEEDED');

      const eventUsage = { ...usage, wallClockMs: next.wallClockMs };
      await this.insertEvent(client, reservation, eventKey, event.kind, fingerprint, eventUsage);
      await this.updateActual(client, reservation.id, next);
      return this.getOwnedReservation(client, reference).then(mapReservation);
    });
  }

  /** A timeout or uncertain provider response holds the reservation and writable slot for reconciliation. */
  async markOutcomeUnknown(
    reference: AgentQuotaReference,
    leaseToken: string,
    eventKey: string
  ): Promise<AgentExecutionReservation> {
    validateReference(reference);
    validateLeaseToken(leaseToken);
    const key = validateEventKey(eventKey);
    return this.transaction(async (client) => {
      await this.lockAndVerifyAttempt(client, reference, leaseToken);
      const reservation = await this.lockOwnedReservation(client, reference);
      const empty = parseUsage({});
      const fingerprint = eventFingerprint('outcome_unknown', empty);
      if (await this.matchingEvent(client, reservation.id, key, fingerprint)) return mapReservation(reservation);
      if (reservation.state === 'reconciliation_required') return mapReservation(reservation);
      if (reservation.state !== 'active') throw new ConflictError('Reservation cannot enter reconciliation');
      await this.insertEvent(client, reservation, key, 'outcome_unknown', fingerprint, empty);
      const updated = await client.query<ReservationRow>(
        'UPDATE agent_execution_reservations SET state = \'reconciliation_required\', updated_at = NOW() ' +
        'WHERE id = $1 RETURNING *',
        [reservation.id]
      );
      return mapReservation(updated.rows[0]!);
    });
  }

  /** A worker may release only a reservation that never crossed the allocation boundary. */
  async releaseBeforeAllocation(
    reference: AgentQuotaReference,
    leaseToken: string,
    eventKey: string
  ): Promise<AgentExecutionReservation> {
    validateReference(reference);
    validateLeaseToken(leaseToken);
    const key = validateEventKey(eventKey);
    return this.transaction(async (client) => {
      await this.lockAndVerifyAttempt(client, reference, leaseToken);
      const reservation = await this.lockOwnedReservation(client, reference);
      const empty = parseUsage({});
      const fingerprint = eventFingerprint('release_before_allocation', empty);
      if (await this.matchingEvent(client, reservation.id, key, fingerprint)) return mapReservation(reservation);
      if (reservation.state === 'released') throw new ConflictError('Reservation was released with another event');
      if (reservation.state !== 'reserved') throw new ConflictError('Runtime allocation may have started; reconciliation is required');
      await this.insertEvent(client, reservation, key, 'released_before_allocation', fingerprint, empty);
      const result = await client.query<ReservationRow>(
        'UPDATE agent_execution_reservations SET state = \'released\', resource_active = FALSE, finished_at = NOW(), ' +
        METRICS.map((metric) => metric.accounted + ' = 0').join(', ') + ', updated_at = NOW() WHERE id = $1 RETURNING *',
        [reservation.id]
      );
      return mapReservation(result.rows[0]!);
    });
  }

  /** Commit measured usage but retain the writable slot until sandbox cleanup confirms quiescence. */
  async commitAttempt(
    reference: AgentQuotaReference,
    leaseToken: string,
    eventKey: string
  ): Promise<AgentExecutionReservation> {
    validateReference(reference);
    validateLeaseToken(leaseToken);
    const key = validateEventKey(eventKey);
    return this.transaction(async (client) => {
      await this.lockAndVerifyAttempt(client, reference, leaseToken);
      const reservation = await this.lockOwnedReservation(client, reference);
      const actual = mapMetrics(reservation, 'actual');
      const fingerprint = eventFingerprint('attempt_committed', actual);
      if (await this.matchingEvent(client, reservation.id, key, fingerprint)) return mapReservation(reservation);
      if (!['active', 'reconciliation_required'].includes(reservation.state)) {
        throw new ConflictError('Reservation cannot be committed');
      }
      await this.insertEvent(client, reservation, key, 'attempt_committed', fingerprint, actual);
      const result = await client.query<ReservationRow>(
        'UPDATE agent_execution_reservations SET state = \'committed\', finished_at = NOW(), updated_at = NOW(), ' +
        METRICS.map((metric) => metric.accounted + ' = ' + metric.actual).join(', ') +
        ' WHERE id = $1 RETURNING *',
        [reservation.id]
      );
      return mapReservation(result.rows[0]!);
    });
  }

  /**
   * Release a held writable slot only after the 17T-71 lifecycle verifier confirms that
   * this exact attempt has no live or ambiguously allocated sandbox.
   */
  async reconcileAfterQuiescent(
    reference: AgentQuotaReference,
    finalUsage: AgentResourceUsageInput,
    eventKey: string
  ): Promise<AgentExecutionReservation> {
    validateReference(reference);
    const key = validateEventKey(eventKey);
    const reported = parseUsage(finalUsage);
    if (!this.quiescenceVerifier) throw new ConflictError('Sandbox reconciliation is unavailable');
    let quiescent = false;
    try {
      quiescent = await this.quiescenceVerifier.isQuiescent(reference);
    } catch {
      throw new ConflictError('Sandbox reconciliation could not confirm a safe stop');
    }
    if (!quiescent) throw new ConflictError('Sandbox reconciliation could not confirm a safe stop');

    return this.transaction(async (client) => {
      const reservation = await this.getOwnedReservation(client, reference, true);
      const actual = mapMetrics(reservation, 'actual');
      const limits = mapMetrics(reservation, 'max');
      const final = { ...actual } as MetricValues;
      for (const metric of METRICS) {
        final[metric.key] = Math.max(actual[metric.key], reported[metric.key]);
      }
      const exceeded = isOverLimit(final, limits);
      const fingerprint = eventFingerprint('reconciled', reported);
      if (await this.matchingEvent(client, reservation.id, key, fingerprint)) return mapReservation(reservation);
      if (!['active', 'reconciliation_required', 'committed'].includes(reservation.state)) {
        throw new ConflictError('Reservation is not awaiting reconciliation');
      }
      await this.insertEvent(client, reservation, key, 'reconciled', fingerprint, reported, exceeded);
      const hasUsage = METRICS.some((metric) => final[metric.key] > 0);
      const result = await client.query<ReservationRow>(
        'UPDATE agent_execution_reservations SET state = $1, resource_active = FALSE, finished_at = NOW(), updated_at = NOW(), ' +
        METRICS.map((metric) => metric.actual + ' = $' + (METRICS.indexOf(metric) + 2)).join(', ') + ', ' +
        METRICS.map((metric) => metric.accounted + ' = $' + (METRICS.length + METRICS.indexOf(metric) + 2)).join(', ') +
        ' WHERE id = $' + (METRICS.length * 2 + 2) + ' RETURNING *',
        [hasUsage ? 'committed' : 'released', ...dbMetrics(final), ...dbMetrics(final), reservation.id]
      );
      return mapReservation(result.rows[0]!);
    });
  }

  /** Tenant-scoped audit view; event rows contain numeric measurements only. */
  async listUsageEvents(reference: AgentQuotaReference): Promise<readonly {
    readonly eventKey: string;
    readonly kind: string;
    readonly usage: AgentResourceUsage;
    readonly limitExceeded: boolean;
    readonly createdAt: string;
  }[]> {
    validateReference(reference);
    const reservation = await this.getOwnedReservation(this.pool, reference);
    const result = await this.pool.query<UsageEventRow>(
      'SELECT event_key, event_kind, request_fingerprint, sandbox_runtime_ms, wall_clock_ms, tool_calls, provider_requests, ' +
      'command_output_bytes, artifact_bytes, workspace_disk_bytes, workspace_file_count, limit_exceeded, created_at ' +
      'FROM agent_execution_usage_events WHERE owner_id = $1 AND workspace_id = $2 AND run_id = $3 AND attempt_number = $4 ' +
      'ORDER BY created_at ASC, event_key ASC',
      [reservation.owner_id, reservation.workspace_id, reservation.run_id, reservation.attempt_number]
    );
    return result.rows.map((row) => ({
      eventKey: row.event_key,
      kind: row.event_kind,
      usage: {
        sandboxRuntimeMs: numberFromDb(row.sandbox_runtime_ms),
        wallClockMs: numberFromDb(row.wall_clock_ms),
        toolCalls: numberFromDb(row.tool_calls),
        providerRequests: numberFromDb(row.provider_requests),
        commandOutputBytes: numberFromDb(row.command_output_bytes),
        artifactBytes: numberFromDb(row.artifact_bytes),
        workspaceDiskBytes: numberFromDb(row.workspace_disk_bytes),
        workspaceFileCount: numberFromDb(row.workspace_file_count),
      },
      limitExceeded: row.limit_exceeded,
      createdAt: dateFromDb(row.created_at).toISOString(),
    }));
  }
}
