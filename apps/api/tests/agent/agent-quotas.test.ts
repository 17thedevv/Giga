import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDbInstance } from '../test-db-helper.js';
import { createDatabasePool } from '../../src/db/client.js';
import { AgentRepository } from '../../src/modules/agent/repository.js';
import {
  AgentQuotaError,
  AgentQuotaService,
  type AgentQuotaReference,
  type QuotaQuiescenceVerifier,
} from '../../src/modules/agent/quota-service.js';
import { DEFAULT_AGENT_QUOTA_POLICY, type AgentQuotaPolicy } from '../../src/modules/agent/quota-policy.js';

describe('GigaAgent durable quota reservations', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Agent quota persistence and privilege invariants require isolated PostgreSQL',
}, () => {
  let db: TestDbInstance;
  let repository: AgentRepository;
  let ownerId: string;
  let otherOwnerId: string;
  let workspaceId: string;
  let quotas: AgentQuotaService;

  before(async () => {
    db = await createTestDatabase();
  });

  after(async () => {
    await db.cleanup();
    await db.pool.end();
  });

  beforeEach(async () => {
    await db.cleanup();
    ownerId = randomUUID();
    otherOwnerId = randomUUID();
    for (const id of [ownerId, otherOwnerId]) {
      await db.pool.query(
        'INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)',
        [id, id + '@example.com', 'Quota test user', 'unused-test-hash']
      );
    }
    repository = new AgentRepository(db.pool);
    workspaceId = (await repository.createWorkspace(ownerId, 'Quota Workspace')).id;
    quotas = new AgentQuotaService(db.pool);
  });

  async function makeWorkspace(owner = ownerId): Promise<string> {
    return (await repository.createWorkspace(owner, 'Quota Workspace ' + randomUUID())).id;
  }

  async function createClaimedRun(
    mode: 'ask' | 'plan' | 'execute' = 'execute',
    targetWorkspace = workspaceId,
    owner = ownerId
  ): Promise<{ reference: AgentQuotaReference; leaseToken: string; runId: string }> {
    const key = randomUUID();
    const fingerprint = createHash('sha256').update(key).digest('hex');
    const admitted = await repository.enqueueRun(
      owner,
      { workspaceId: targetWorkspace, task: 'Quota test task', mode, runtime: 'cloud', modelId: 'giga-agent-default' },
      key,
      fingerprint
    );
    const claim = await repository.claimRun(owner, admitted.run.id, 'quota-worker-' + randomUUID(), 60_000);
    assert.ok(claim);
    return {
      runId: admitted.run.id,
      leaseToken: claim.leaseToken,
      reference: { ownerId: owner, workspaceId: targetWorkspace, runId: admitted.run.id, attemptNumber: claim.attemptCount },
    };
  }

  async function finalizeRun(run: { reference: AgentQuotaReference; leaseToken: string; runId: string }): Promise<void> {
    await repository.finalizeRun(run.reference.ownerId, run.runId, run.leaseToken, {
      status: 'completed',
      summary: 'Quota test completed',
      verifiedChecks: [],
    });
  }

  function customPolicy(input: {
    execute?: Partial<AgentQuotaPolicy['execute']>;
    readOnly?: Partial<AgentQuotaPolicy['readOnly']>;
    ownerBudget?: Partial<AgentQuotaPolicy['rolling24Hour']['owner']>;
    workspaceBudget?: Partial<AgentQuotaPolicy['rolling24Hour']['workspace']>;
    maxAttempts?: number;
  } = {}): AgentQuotaPolicy {
    return {
      ...DEFAULT_AGENT_QUOTA_POLICY,
      maxAttempts: input.maxAttempts ?? DEFAULT_AGENT_QUOTA_POLICY.maxAttempts,
      execute: { ...DEFAULT_AGENT_QUOTA_POLICY.execute, ...input.execute },
      readOnly: { ...DEFAULT_AGENT_QUOTA_POLICY.readOnly, ...input.readOnly },
      rolling24Hour: {
        owner: { ...DEFAULT_AGENT_QUOTA_POLICY.rolling24Hour.owner, ...input.ownerBudget },
        workspace: { ...DEFAULT_AGENT_QUOTA_POLICY.rolling24Hour.workspace, ...input.workspaceBudget },
      },
    };
  }

  function verifier(result: boolean): QuotaQuiescenceVerifier {
    return {
      fenceAttemptAndVerify: async () => {
        if (!result) throw new Error('The lifecycle layer has not fenced and drained this attempt');
      },
    };
  }

  async function assertQuotaCode(promise: Promise<unknown>, code: string): Promise<void> {
    await assert.rejects(promise, (error: unknown) => error instanceof AgentQuotaError && error.code === code);
  }

  it('two workers racing for the final owner writable slot produce one durable reservation', async (t) => {
    if (db.isMemory) return t.skip('Requires PostgreSQL row-lock arbitration');
    const first = await createClaimedRun('execute', workspaceId);
    const secondWorkspace = await makeWorkspace();
    const second = await createClaimedRun('execute', secondWorkspace);
    const serviceA = new AgentQuotaService(db.pool);
    const serviceB = new AgentQuotaService(db.pool);

    const results = await Promise.allSettled([
      serviceA.reserveExecutionAttempt(first.reference, first.leaseToken),
      serviceB.reserveExecutionAttempt(second.reference, second.leaseToken),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.ok(rejected.reason instanceof AgentQuotaError);
    assert.equal(rejected.reason.code, 'WORKSPACE_BUSY');
    assert.equal(rejected.reason.statusCode, 409);
    assert.equal(rejected.reason.retryAfterSeconds, 5);
    const rows = await db.pool.query('SELECT count(*)::int AS count FROM agent_execution_reservations');
    assert.equal(Number(rows.rows[0]!.count), 1);
  });

  it('two workers racing for the last rolling budget slot cannot oversubscribe it', async (t) => {
    if (db.isMemory) return t.skip('Requires PostgreSQL row-lock arbitration');
    const policy = customPolicy({
      execute: { providerRequests: 1 },
      readOnly: { providerRequests: 1 },
      ownerBudget: { providerRequests: 1 },
      workspaceBudget: { providerRequests: 1 },
    });
    const serviceA = new AgentQuotaService(db.pool, policy);
    const serviceB = new AgentQuotaService(db.pool, policy);
    const first = await createClaimedRun('ask', workspaceId);
    const second = await createClaimedRun('plan', await makeWorkspace());

    const results = await Promise.allSettled([
      serviceA.reserveExecutionAttempt(first.reference, first.leaseToken),
      serviceB.reserveExecutionAttempt(second.reference, second.leaseToken),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.ok(rejected.reason instanceof AgentQuotaError);
    assert.equal(rejected.reason.code, 'RATE_LIMITED');
    assert.equal(rejected.reason.statusCode, 429);
    assert.equal(rejected.reason.retryAfterSeconds, 60);
    const rows = await db.pool.query('SELECT count(*)::int AS count FROM agent_execution_reservations');
    assert.equal(Number(rows.rows[0]!.count), 1);
  });

  it('repeated reservation for one run and attempt returns the same reservation', async () => {
    const run = await createClaimedRun();
    const first = await quotas.reserveExecutionAttempt(run.reference, run.leaseToken);
    const replay = await quotas.reserveExecutionAttempt(run.reference, run.leaseToken);
    assert.equal(replay.id, first.id);
    const events = await quotas.listUsageEvents(run.reference);
    assert.deepEqual(events.map((event) => event.kind), ['reservation']);
    const rows = await db.pool.query(
      'SELECT count(*)::int AS count FROM agent_execution_reservations WHERE owner_id = $1 AND run_id = $2',
      [ownerId, run.runId]
    );
    assert.equal(Number(rows.rows[0]!.count), 1);
  });

  it('invalid server policy fails closed and cannot grant read-only writes', () => {
    assert.throws(() => new AgentQuotaService(db.pool, {} as AgentQuotaPolicy), /Invalid Agent quota policy/);
    const invalid = {
      ...DEFAULT_AGENT_QUOTA_POLICY,
      readOnly: { ...DEFAULT_AGENT_QUOTA_POLICY.readOnly, artifactBytes: 1 },
    };
    assert.throws(() => new AgentQuotaService(db.pool, invalid), /readOnly mode cannot reserve write/);
  });

  it('quota usage is immutable directly and cascades with workspace data', async (t) => {
    if (db.isMemory) return t.skip('Requires PostgreSQL trigger and FK cascade enforcement');
    const run = await createClaimedRun();
    const reservation = await quotas.reserveExecutionAttempt(run.reference, run.leaseToken);
    await quotas.markAllocationStarted(run.reference, run.leaseToken);
    await quotas.recordUsage(run.reference, run.leaseToken, {
      eventKey: 'provider:immutable', kind: 'provider_request', usage: { providerRequests: 1 },
    });

    await assert.rejects(db.pool.query(
      'UPDATE agent_execution_usage_events SET provider_requests = 0 WHERE reservation_id = $1', [reservation.id]
    ));
    await assert.rejects(db.pool.query(
      'DELETE FROM agent_execution_usage_events WHERE reservation_id = $1', [reservation.id]
    ));
    await assert.rejects(db.pool.query(
      'DELETE FROM agent_execution_reservations WHERE id = $1', [reservation.id]
    ));

    await db.pool.query('DELETE FROM agent_workspaces WHERE owner_id = $1 AND id = $2', [ownerId, workspaceId]);
    const remaining = await db.pool.query(
      'SELECT (SELECT COUNT(*) FROM agent_execution_reservations WHERE id = $1) AS reservations, ' +
      '(SELECT COUNT(*) FROM agent_execution_usage_events WHERE reservation_id = $1) AS events',
      [reservation.id]
    );
    assert.equal(Number(remaining.rows[0]!.reservations), 0);
    assert.equal(Number(remaining.rows[0]!.events), 0);
  });

  it('owner and workspace mismatch return not-found without exposing another tenant reservation', async () => {
    const run = await createClaimedRun();
    await quotas.reserveExecutionAttempt(run.reference, run.leaseToken);
    await assert.rejects(
      quotas.reserveExecutionAttempt({ ...run.reference, ownerId: otherOwnerId }, run.leaseToken),
      (error: unknown) => error instanceof Error && error.message === 'Resource not found'
    );
    await assert.rejects(
      quotas.getReservation({ ...run.reference, workspaceId: await makeWorkspace(otherOwnerId) }),
      (error: unknown) => error instanceof Error && error.message === 'Resource not found'
    );
  });

  it('budget exhaustion rejects before allocation can be marked started', async () => {
    const policy = customPolicy({
      execute: { providerRequests: 1 },
      readOnly: { providerRequests: 1 },
      ownerBudget: { providerRequests: 1 },
      workspaceBudget: { providerRequests: 1 },
    });
    const service = new AgentQuotaService(db.pool, policy);
    const first = await createClaimedRun('ask');
    const second = await createClaimedRun('plan', await makeWorkspace());
    await service.reserveExecutionAttempt(first.reference, first.leaseToken);
    await assertQuotaCode(service.reserveExecutionAttempt(second.reference, second.leaseToken), 'RATE_LIMITED');
    const events = await service.listUsageEvents(second.reference).catch(() => []);
    assert.equal(events.length, 0);
    const rows = await db.pool.query('SELECT count(*)::int AS count FROM agent_execution_reservations WHERE run_id = $1', [second.runId]);
    assert.equal(Number(rows.rows[0]!.count), 0);
  });

  it('cancellation before allocation refunds once; cancellation after allocation holds until a durable fence', async () => {
    const beforeAllocation = await createClaimedRun();
    const firstReservation = await quotas.reserveExecutionAttempt(beforeAllocation.reference, beforeAllocation.leaseToken);
    const released = await quotas.releaseBeforeAllocation(beforeAllocation.reference, beforeAllocation.leaseToken, 'cancel:before');
    assert.equal(released.state, 'released');
    assert.equal(released.resourceActive, false);
    assert.equal((await quotas.releaseBeforeAllocation(beforeAllocation.reference, beforeAllocation.leaseToken, 'cancel:before')).id, firstReservation.id);

    const duringAllocation = await createClaimedRun();
    await quotas.reserveExecutionAttempt(duringAllocation.reference, duringAllocation.leaseToken);
    await quotas.markAllocationStarted(duringAllocation.reference, duringAllocation.leaseToken);
    await quotas.markOutcomeUnknown(duringAllocation.reference, duringAllocation.leaseToken, 'cancel:ambiguous');
    const held = await quotas.getReservation(duringAllocation.reference);
    assert.equal(held.state, 'reconciliation_required');
    assert.equal(held.resourceActive, true);
    const noProof = new AgentQuotaService(db.pool, DEFAULT_AGENT_QUOTA_POLICY, verifier(false));
    await assert.rejects(noProof.reconcileAfterQuiescent(duringAllocation.reference, {}, 'cleanup:not-fenced'));
    await repository.releaseLease(ownerId, duringAllocation.runId, duringAllocation.leaseToken);
    const reconciled = await new AgentQuotaService(db.pool, DEFAULT_AGENT_QUOTA_POLICY, verifier(true))
      .reconcileAfterQuiescent(duringAllocation.reference, {}, 'cleanup:confirmed');
    assert.equal(reconciled.state, 'committed');
    assert.equal(reconciled.resourceActive, false);
  });

  it('does not release an active attempt when allocation races with reconciliation', async (t) => {
    if (db.isMemory) return t.skip('Requires PostgreSQL row-lock arbitration');
    const run = await createClaimedRun();
    const second = await createClaimedRun('execute', await makeWorkspace());
    await quotas.reserveExecutionAttempt(run.reference, run.leaseToken);
    await quotas.markAllocationStarted(run.reference, run.leaseToken);

    let enteredFence!: () => void;
    let finishFence!: () => void;
    const fenceStarted = new Promise<void>((resolve) => { enteredFence = resolve; });
    const fenceMayComplete = new Promise<void>((resolve) => { finishFence = resolve; });
    const reconciler = new AgentQuotaService(db.pool, DEFAULT_AGENT_QUOTA_POLICY, {
      fenceAttemptAndVerify: async () => {
        enteredFence();
        await fenceMayComplete;
      },
    });
    const reconciliation = reconciler.reconcileAfterQuiescent(run.reference, {}, 'cleanup:raced');
    await fenceStarted;

    // This is the allocation admission boundary: it shares the run and reservation locks that
    // reconciliation must recheck after its external lifecycle operation returns.
    await quotas.markAllocationStarted(run.reference, run.leaseToken);
    finishFence();
    await assert.rejects(reconciliation, /lease is still active/i);

    const held = await quotas.getReservation(run.reference);
    assert.equal(held.resourceActive, true);
    await assertQuotaCode(quotas.reserveExecutionAttempt(second.reference, second.leaseToken), 'WORKSPACE_BUSY');
  });

  it('partial usage is committed and unused reservation capacity is released', async () => {
    const first = await createClaimedRun();
    await quotas.reserveExecutionAttempt(first.reference, first.leaseToken);
    await quotas.markAllocationStarted(first.reference, first.leaseToken);
    await quotas.recordUsage(first.reference, first.leaseToken, {
      eventKey: 'provider:1',
      kind: 'provider_request',
      usage: { providerRequests: 1 },
    });
    await quotas.recordUsage(first.reference, first.leaseToken, {
      eventKey: 'tool:1',
      kind: 'tool_call',
      usage: { toolCalls: 1, commandOutputBytes: 100, artifactBytes: 512, workspaceDiskBytes: 2048, workspaceFileCount: 3 },
    });
    const committed = await quotas.commitAttempt(first.reference, first.leaseToken, 'complete:1');
    assert.equal(committed.state, 'committed');
    assert.equal(committed.resourceActive, true);
    assert.equal(committed.accounted.providerRequests, 1);
    assert.equal(committed.accounted.artifactBytes, 512);
    await finalizeRun(first);
    const quiescent = await new AgentQuotaService(db.pool, DEFAULT_AGENT_QUOTA_POLICY, verifier(true))
      .reconcileAfterQuiescent(first.reference, {}, 'cleanup:1');
    assert.equal(quiescent.resourceActive, false);
    assert.equal(quiescent.accounted.commandOutputBytes, 100);
    assert.equal(quiescent.actual.workspaceDiskBytes, 2048);
  });

  it('duplicate completion and reconciliation events cannot double charge or double refund', async () => {
    const run = await createClaimedRun();
    await quotas.reserveExecutionAttempt(run.reference, run.leaseToken);
    await quotas.markAllocationStarted(run.reference, run.leaseToken);
    await quotas.recordUsage(run.reference, run.leaseToken, {
      eventKey: 'provider:1',
      kind: 'provider_request',
      usage: { providerRequests: 1 },
    });
    const first = await quotas.commitAttempt(run.reference, run.leaseToken, 'complete:stable');
    const duplicate = await quotas.commitAttempt(run.reference, run.leaseToken, 'complete:stable');
    assert.equal(duplicate.actual.providerRequests, first.actual.providerRequests);
    await finalizeRun(run);
    const service = new AgentQuotaService(db.pool, DEFAULT_AGENT_QUOTA_POLICY, verifier(true));
    await service.reconcileAfterQuiescent(run.reference, {}, 'cleanup:stable');
    await service.reconcileAfterQuiescent(run.reference, {}, 'cleanup:stable');
    const events = await service.listUsageEvents(run.reference);
    assert.equal(events.filter((event) => event.kind === 'attempt_committed').length, 1);
    assert.equal(events.filter((event) => event.kind === 'reconciled').length, 1);
    assert.equal(events.filter((event) => event.kind === 'provider_request' && event.usage.providerRequests === 1).length, 1);
  });

  it('commits zero-usage reservations after verified quiescence and never reopens their slot', async (t) => {
    if (db.isMemory) return t.skip('Requires PostgreSQL trigger and transaction enforcement');
    const run = await createClaimedRun();
    await quotas.reserveExecutionAttempt(run.reference, run.leaseToken);
    await quotas.markAllocationStarted(run.reference, run.leaseToken);
    const committed = await quotas.commitAttempt(run.reference, run.leaseToken, 'complete:zero-usage');
    assert.equal(committed.state, 'committed');
    assert.equal(committed.resourceActive, true);
    assert.equal(committed.accounted.wallClockMs, committed.actual.wallClockMs);
    assert.ok(committed.accounted.sandboxRuntimeMs === 0 && committed.accounted.toolCalls === 0 &&
      committed.accounted.providerRequests === 0 && committed.accounted.commandOutputBytes === 0 &&
      committed.accounted.artifactBytes === 0 && committed.accounted.workspaceDiskBytes === 0 &&
      committed.accounted.workspaceFileCount === 0);
    await assert.rejects(
      db.pool.query('UPDATE agent_execution_reservations SET resource_active = FALSE WHERE run_id = $1', [run.runId]),
      /requires reconciliation finalization/i
    );
    await finalizeRun(run);

    const service = new AgentQuotaService(db.pool, DEFAULT_AGENT_QUOTA_POLICY, verifier(true));
    const reconciled = await service.reconcileAfterQuiescent(run.reference, {}, 'cleanup:zero-usage');
    assert.equal(reconciled.state, 'committed');
    assert.equal(reconciled.resourceActive, false);
    assert.ok(reconciled.actual.wallClockMs >= committed.actual.wallClockMs);
    for (const key of [
      'sandboxRuntimeMs', 'toolCalls', 'providerRequests', 'commandOutputBytes',
      'artifactBytes', 'workspaceDiskBytes', 'workspaceFileCount',
    ] as const) {
      assert.equal(reconciled.actual[key], committed.actual[key]);
    }
    assert.deepEqual(reconciled.accounted, reconciled.actual);
    const repeated = await service.reconcileAfterQuiescent(run.reference, {}, 'cleanup:zero-usage');
    assert.equal(repeated.state, 'committed');
    assert.equal(repeated.resourceActive, false);
    assert.equal((await service.listUsageEvents(run.reference)).filter((event) => event.kind === 'reconciled').length, 1);

    await assert.rejects(
      db.pool.query("UPDATE agent_execution_reservations SET resource_active = TRUE WHERE run_id = $1", [run.runId]),
      /cannot be reactivated/i
    );
    await assert.rejects(
      db.pool.query("UPDATE agent_execution_reservations SET state = 'released' WHERE run_id = $1", [run.runId]),
      /cannot be reopened/i
    );
  });

  it('reconciles zero usage after an ambiguous outcome and keeps released reservations terminal', async (t) => {
    if (db.isMemory) return t.skip('Requires PostgreSQL trigger and transaction enforcement');
    const run = await createClaimedRun();
    await quotas.reserveExecutionAttempt(run.reference, run.leaseToken);
    await quotas.markAllocationStarted(run.reference, run.leaseToken);
    await quotas.markOutcomeUnknown(run.reference, run.leaseToken, 'provider:ambiguous-zero');
    await assert.rejects(
      db.pool.query(
        "UPDATE agent_execution_reservations SET state = 'released', resource_active = FALSE, finished_at = NOW() WHERE run_id = $1",
        [run.runId]
      ),
      /Invalid Agent quota reservation transition/i
    );
    await repository.releaseLease(ownerId, run.runId, run.leaseToken);

    const service = new AgentQuotaService(db.pool, DEFAULT_AGENT_QUOTA_POLICY, verifier(true));
    const reconciled = await service.reconcileAfterQuiescent(run.reference, {}, 'cleanup:ambiguous-zero');
    assert.equal(reconciled.state, 'committed');
    assert.equal(reconciled.resourceActive, false);
    assert.deepEqual(reconciled.actual, reconciled.accounted);
    assert.ok(reconciled.accounted.wallClockMs >= 0);
    assert.ok(reconciled.accounted.sandboxRuntimeMs === 0 && reconciled.accounted.toolCalls === 0 &&
      reconciled.accounted.providerRequests === 0 && reconciled.accounted.commandOutputBytes === 0 &&
      reconciled.accounted.artifactBytes === 0 && reconciled.accounted.workspaceDiskBytes === 0 &&
      reconciled.accounted.workspaceFileCount === 0);
    const repeated = await service.reconcileAfterQuiescent(run.reference, {}, 'cleanup:ambiguous-zero');
    assert.equal(repeated.state, 'committed');
    assert.equal(repeated.resourceActive, false);
    await assert.rejects(
      service.recordUsage(run.reference, run.leaseToken, {
        eventKey: 'late:after-zero-reconcile', kind: 'provider_request', usage: { providerRequests: 1 },
      }),
      /fenced/i
    );

    const preallocation = await createClaimedRun();
    await quotas.reserveExecutionAttempt(preallocation.reference, preallocation.leaseToken);
    await quotas.releaseBeforeAllocation(preallocation.reference, preallocation.leaseToken, 'cancel:released-terminal');
    await assert.rejects(
      db.pool.query("UPDATE agent_execution_reservations SET state = 'active', resource_active = TRUE WHERE run_id = $1", [preallocation.runId]),
      /Released Agent quota reservation is immutable/i
    );
  });

  it('derives and durably accounts an over-limit wall-clock duration at commit without usage events', async (t) => {
    if (db.isMemory) return t.skip('Requires PostgreSQL clock_timestamp and persisted usage auditing');
    const policy = customPolicy({ execute: { wallClockMs: 25 } });
    const service = new AgentQuotaService(db.pool, policy);
    const run = await createClaimedRun();
    await service.reserveExecutionAttempt(run.reference, run.leaseToken);
    await service.markAllocationStarted(run.reference, run.leaseToken);

    const beforeCommit = await service.listUsageEvents(run.reference);
    assert.equal(beforeCommit.filter((event) => ['provider_request', 'tool_call', 'measurement'].includes(event.kind)).length, 0);
    await db.pool.query('SELECT pg_sleep(0.06)');

    const committed = await service.commitAttempt(run.reference, run.leaseToken, 'complete:wall-clock-overrun');
    assert.equal(committed.state, 'committed');
    assert.ok(committed.actual.wallClockMs >= policy.execute.wallClockMs);
    assert.equal(committed.accounted.wallClockMs, committed.actual.wallClockMs);
    assert.equal(committed.limitExceeded, true);
    const commitEvent = (await service.listUsageEvents(run.reference)).find((event) => event.kind === 'attempt_committed');
    assert.ok(commitEvent);
    assert.equal(commitEvent.limitExceeded, true);
    assert.equal(commitEvent.usage.wallClockMs, committed.actual.wallClockMs);
  });

  it('starts the execution deadline at durable allocation start, after queue wait', async (t) => {
    if (db.isMemory) return t.skip('Requires PostgreSQL timestamps and clock_timestamp');
    const wallClockMs = 80;
    const service = new AgentQuotaService(
      db.pool,
      customPolicy({ execute: { wallClockMs } }),
    );
    const run = await createClaimedRun();
    const reserved = await service.reserveExecutionAttempt(run.reference, run.leaseToken);
    assert.equal(reserved.startedAt, null);
    assert.equal(reserved.deadlineAt, null);

    await db.pool.query('SELECT pg_sleep(0.15)');
    const started = await service.markAllocationStarted(run.reference, run.leaseToken);
    assert.ok(started.startedAt);
    assert.equal(
      started.deadlineAt,
      new Date(Date.parse(started.startedAt!) + wallClockMs).toISOString(),
    );
    assert.ok(Date.parse(started.deadlineAt!) > Date.parse(reserved.createdAt) + wallClockMs);
    await assert.rejects(
      db.pool.query('UPDATE agent_execution_reservations SET started_at = created_at WHERE run_id = $1', [run.runId]),
      /start timestamp is immutable/i
    );
  });

  it('finalizes reconciliation once, preserves DB-measured time, and rejects later accounting mutations', async (t) => {
    if (db.isMemory) return t.skip('Requires PostgreSQL transaction and trigger enforcement');
    const policy = customPolicy({ execute: { wallClockMs: 25 } });
    const service = new AgentQuotaService(db.pool, policy, verifier(true));
    const runtimePool = createDatabasePool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: '-c role=giga_api_runtime',
    });
    const quotaOwnerPool = createDatabasePool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: '-c role=giga_agent_quota_owner',
    });
    const quotaFinalizerPool = createDatabasePool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: '-c role=giga_agent_quota_finalizer',
    });
    t.after(async () => {
      await Promise.all([runtimePool.end(), quotaOwnerPool.end(), quotaFinalizerPool.end()]);
    });
    const runtimeIdentity = await runtimePool.query<{
      current_user: string;
      is_superuser: boolean;
      is_quota_owner: boolean;
    }>(
      'SELECT current_user, role.rolsuper AS is_superuser, ' +
      "pg_has_role(current_user, 'giga_agent_quota_owner', 'MEMBER') AS is_quota_owner " +
      'FROM pg_roles AS role WHERE role.rolname = current_user'
    );
    assert.equal(runtimeIdentity.rows[0]?.current_user, 'giga_api_runtime');
    assert.equal(runtimeIdentity.rows[0]?.is_superuser, false);
    assert.equal(runtimeIdentity.rows[0]?.is_quota_owner, false);

    const run = await createClaimedRun();
    await service.reserveExecutionAttempt(run.reference, run.leaseToken);
    await service.markAllocationStarted(run.reference, run.leaseToken);
    await service.recordUsage(run.reference, run.leaseToken, {
      eventKey: 'provider:before-finalization',
      kind: 'provider_request',
      usage: { providerRequests: 1 },
    });
    await service.markOutcomeUnknown(run.reference, run.leaseToken, 'provider:reconciliation-finalization');
    await db.pool.query('SELECT pg_sleep(0.06)');
    await repository.releaseLease(ownerId, run.runId, run.leaseToken);

    const finalUsage = { providerRequests: 2, artifactBytes: 4 };
    const fabricatedFingerprint = createHash('sha256').update('fabricated-reconciliation').digest('hex');
    await assert.rejects(
      runtimePool.query(
        'INSERT INTO agent_execution_usage_events ' +
        '(reservation_id, owner_id, workspace_id, run_id, attempt_number, event_key, event_kind, request_fingerprint) ' +
        'SELECT id, owner_id, workspace_id, run_id, attempt_number, $2, \'reconciled\', $3 ' +
        'FROM agent_execution_reservations WHERE run_id = $1',
        [run.runId, 'cleanup:forged-runtime', fabricatedFingerprint]
      ),
      /controlled finalization operation/i
    );
    await assert.rejects(
      quotaFinalizerPool.query(
        'INSERT INTO agent_execution_usage_events ' +
        '(reservation_id, owner_id, workspace_id, run_id, attempt_number, event_key, event_kind, request_fingerprint) ' +
        'SELECT id, owner_id, workspace_id, run_id, attempt_number, $2, \'reconciled\', $3 ' +
        'FROM agent_execution_reservations WHERE run_id = $1',
        [run.runId, 'cleanup:forged-finalizer', fabricatedFingerprint]
      ),
      /permission denied.*agent_execution_usage_events/i
    );
    await assert.rejects(
      runtimePool.query(
        "UPDATE agent_execution_reservations SET state = 'committed', resource_active = FALSE, " +
        "finished_at = clock_timestamp(), reconciliation_event_key = 'cleanup:forged-runtime' WHERE run_id = $1",
        [run.runId]
      ),
      /permission denied.*agent_execution_reservations/i
    );
    await assert.rejects(
      quotaFinalizerPool.query(
        "UPDATE agent_execution_reservations SET resource_active = FALSE, " +
        "reconciliation_event_key = 'cleanup:forged-finalizer' WHERE run_id = $1",
        [run.runId]
      ),
      /permission denied.*agent_execution_reservations/i
    );

    // Exercise the table owner's direct SQL path: even this role cannot stage a
    // mismatched event or release the slot without the controlled finalizer.
    await quotaOwnerPool.query(
      "UPDATE agent_execution_reservations SET state = 'committed', finished_at = clock_timestamp(), " +
      'actual_provider_requests = 2, accounted_provider_requests = 2 WHERE run_id = $1',
      [run.runId]
    );
    await assert.rejects(
      quotaOwnerPool.query(
        'INSERT INTO agent_execution_usage_events ' +
        '(reservation_id, owner_id, workspace_id, run_id, attempt_number, event_key, event_kind, request_fingerprint, provider_requests) ' +
        'SELECT id, owner_id, workspace_id, run_id, attempt_number, $2, \'reconciled\', $3, 1 ' +
        'FROM agent_execution_reservations WHERE run_id = $1',
        [run.runId, 'cleanup:mismatched-owner', fabricatedFingerprint]
      ),
      /measurements do not match reservation accounting/i
    );
    await assert.rejects(
      quotaOwnerPool.query(
        "UPDATE agent_execution_reservations SET resource_active = FALSE, " +
        "reconciliation_event_key = 'cleanup:forged-owner' WHERE run_id = $1",
        [run.runId]
      ),
      /matching audit event and accounting/i
    );
    const held = await db.pool.query<{ resource_active: boolean; reconciliation_event_key: string | null }>(
      'SELECT resource_active, reconciliation_event_key FROM agent_execution_reservations WHERE run_id = $1',
      [run.runId]
    );
    assert.equal(held.rows[0]?.resource_active, true);
    assert.equal(held.rows[0]?.reconciliation_event_key, null);

    const runtimeService = new AgentQuotaService(runtimePool, policy, verifier(true), quotaFinalizerPool);
    const first = await runtimeService.reconcileAfterQuiescent(run.reference, finalUsage, 'cleanup:finalized');
    assert.equal(first.resourceActive, false);
    assert.ok(first.actual.wallClockMs >= policy.execute.wallClockMs);
    assert.equal(first.actual.providerRequests, 2);
    assert.equal(first.actual.artifactBytes, 4);
    assert.deepEqual(first.accounted, first.actual);
    assert.equal(first.limitExceeded, true);

    const beforeRepeat = await db.pool.query<{
      actual_wall_clock_ms: string;
      accounted_wall_clock_ms: string;
      accounted_provider_requests: string;
      event_count: number;
    }>(
      'SELECT r.actual_wall_clock_ms, r.accounted_wall_clock_ms, r.accounted_provider_requests, ' +
      '(SELECT count(*)::int FROM agent_execution_usage_events e WHERE e.reservation_id = r.id) AS event_count ' +
      'FROM agent_execution_reservations r WHERE r.run_id = $1',
      [run.runId]
    );
    const duplicate = await runtimeService.reconcileAfterQuiescent(run.reference, finalUsage, 'cleanup:finalized');
    assert.deepEqual(duplicate.actual, first.actual);
    assert.deepEqual(duplicate.accounted, first.accounted);
    await assert.rejects(
      runtimeService.reconcileAfterQuiescent(run.reference, finalUsage, 'cleanup:new-key-after-finalization'),
      /already finalized/i
    );
    await assert.rejects(
      runtimeService.reconcileAfterQuiescent(run.reference, { providerRequests: 3, artifactBytes: 4 }, 'cleanup:finalized'),
      /different measurements/i
    );

    await assert.rejects(
      db.pool.query(
        'UPDATE agent_execution_reservations SET actual_wall_clock_ms = actual_wall_clock_ms + 1, ' +
        'accounted_wall_clock_ms = accounted_wall_clock_ms + 1 WHERE run_id = $1',
        [run.runId]
      ),
      /finalized agent quota accounting is immutable/i
    );
    await assert.rejects(
      db.pool.query('UPDATE agent_execution_reservations SET resource_active = TRUE WHERE run_id = $1', [run.runId]),
      /cannot be reactivated/i
    );
    const postFinalizationFingerprint = createHash('sha256').update('post-finalization').digest('hex');
    await assert.rejects(
      db.pool.query(
        'INSERT INTO agent_execution_usage_events ' +
        '(reservation_id, owner_id, workspace_id, run_id, attempt_number, event_key, event_kind, request_fingerprint) ' +
        'SELECT id, owner_id, workspace_id, run_id, attempt_number, $2, \'reconciled\', $3 ' +
        'FROM agent_execution_reservations WHERE run_id = $1',
        [run.runId, 'cleanup:post-finalization-direct', postFinalizationFingerprint]
      ),
      /cannot accept usage events/i
    );

    const afterRepeat = await db.pool.query(
      'SELECT r.actual_wall_clock_ms, r.accounted_wall_clock_ms, r.accounted_provider_requests, ' +
      '(SELECT count(*)::int FROM agent_execution_usage_events e WHERE e.reservation_id = r.id) AS event_count ' +
      'FROM agent_execution_reservations r WHERE r.run_id = $1',
      [run.runId]
    );
    assert.deepEqual(afterRepeat.rows, beforeRepeat.rows);
    const events = await service.listUsageEvents(run.reference);
    assert.equal(events.filter((event) => event.kind === 'reconciled').length, 1);
    assert.equal(events.find((event) => event.kind === 'reconciled')?.limitExceeded, true);
  });

  it('ambiguous timeout survives service restart; stale callbacks are fenced after lease takeover', async () => {
    const first = await createClaimedRun();
    const serviceBeforeRestart = new AgentQuotaService(db.pool);
    await serviceBeforeRestart.reserveExecutionAttempt(first.reference, first.leaseToken);
    await serviceBeforeRestart.markAllocationStarted(first.reference, first.leaseToken);
    await serviceBeforeRestart.markOutcomeUnknown(first.reference, first.leaseToken, 'provider:timeout');
    await db.pool.query(
      "UPDATE agent_runs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE owner_id = $1 AND id = $2",
      [ownerId, first.runId]
    );
    const retry = await repository.claimRun(ownerId, first.runId, 'quota-recovery-worker', 60_000);
    assert.ok(retry);
    assert.equal(retry.attemptCount, 2);

    await assert.rejects(
      serviceBeforeRestart.recordUsage(first.reference, first.leaseToken, {
        eventKey: 'late:success',
        kind: 'provider_request',
        usage: { providerRequests: 1 },
      }),
      /fenced/i
    );
    const nextRun = await createClaimedRun('execute', await makeWorkspace());
    await assertQuotaCode(new AgentQuotaService(db.pool).reserveExecutionAttempt(nextRun.reference, nextRun.leaseToken), 'WORKSPACE_BUSY');

    const serviceAfterRestart = new AgentQuotaService(db.pool, DEFAULT_AGENT_QUOTA_POLICY, verifier(true));
    const reconciled = await serviceAfterRestart.reconcileAfterQuiescent(
      first.reference,
      { providerRequests: 1 },
      'provider:late-success-reconciled'
    );
    assert.equal(reconciled.state, 'committed');
    assert.equal(reconciled.resourceActive, false);
    const nextReservation = await serviceAfterRestart.reserveExecutionAttempt(
      { ...first.reference, attemptNumber: retry.attemptCount },
      retry.leaseToken
    );
    assert.equal(nextReservation.attemptNumber, 2);
  });

  it('wall-clock deadline and output, tool, artifact, disk and file limits fail closed', async () => {
    const policy = customPolicy({
      execute: {
        wallClockMs: 5000,
        toolCalls: 2,
        commandOutputBytes: 5,
        artifactBytes: 4,
        workspaceDiskBytes: 10,
        workspaceFileCount: 1,
      },
    });
    const service = new AgentQuotaService(db.pool, policy, verifier(true));
    const run = await createClaimedRun();
    const reserved = await service.reserveExecutionAttempt(run.reference, run.leaseToken);
    assert.equal(reserved.limits.wallClockMs, 5000);
    await service.markAllocationStarted(run.reference, run.leaseToken);

    await service.recordUsage(run.reference, run.leaseToken, { eventKey: 'tools:allowed', kind: 'tool_call', usage: { toolCalls: 2 } });
    await assert.rejects(
      service.recordUsage(run.reference, run.leaseToken, { eventKey: 'tools:overflow', kind: 'tool_call', usage: { toolCalls: 1 } }),
      (error: unknown) => error instanceof AgentQuotaError && error.code === 'LIMIT_EXCEEDED'
    );
    assert.equal(new AgentQuotaError('LIMIT_EXCEEDED').statusCode, 422);
    await service.recordUsage(run.reference, run.leaseToken, { eventKey: 'output:allowed', kind: 'measurement', usage: { commandOutputBytes: 5 } });
    await assertQuotaCode(service.recordUsage(run.reference, run.leaseToken, { eventKey: 'output:overflow', kind: 'measurement', usage: { commandOutputBytes: 1 } }), 'LIMIT_EXCEEDED');
    await service.recordUsage(run.reference, run.leaseToken, { eventKey: 'artifact:allowed', kind: 'measurement', usage: { artifactBytes: 4 } });
    await assertQuotaCode(service.recordUsage(run.reference, run.leaseToken, { eventKey: 'artifact:overflow', kind: 'measurement', usage: { artifactBytes: 1 } }), 'LIMIT_EXCEEDED');
    await service.recordUsage(run.reference, run.leaseToken, { eventKey: 'workspace:allowed', kind: 'measurement', usage: { workspaceDiskBytes: 10, workspaceFileCount: 1 } });
    await assertQuotaCode(service.recordUsage(run.reference, run.leaseToken, { eventKey: 'disk:overflow', kind: 'measurement', usage: { workspaceDiskBytes: 11 } }), 'LIMIT_EXCEEDED');
    await assertQuotaCode(service.recordUsage(run.reference, run.leaseToken, { eventKey: 'files:overflow', kind: 'measurement', usage: { workspaceFileCount: 2 } }), 'LIMIT_EXCEEDED');
    await service.commitAttempt(run.reference, run.leaseToken, 'complete:resource-caps');
    await finalizeRun(run);
    await service.reconcileAfterQuiescent(run.reference, {}, 'cleanup:resource-caps');

    // pg-mem cannot model PostgreSQL timestamptz subtraction; the isolated PostgreSQL suite
    // runs this elapsed-time enforcement path against clock_timestamp().
    if (db.isMemory) return;
    const deadlineService = new AgentQuotaService(db.pool, customPolicy({ execute: { wallClockMs: 30 } }), verifier(true));
    const deadlineRun = await createClaimedRun();
    await deadlineService.reserveExecutionAttempt(deadlineRun.reference, deadlineRun.leaseToken);
    await deadlineService.markAllocationStarted(deadlineRun.reference, deadlineRun.leaseToken);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await assertQuotaCode(
      deadlineService.recordUsage(deadlineRun.reference, deadlineRun.leaseToken, {
        eventKey: 'deadline:overflow', kind: 'tool_call', usage: { toolCalls: 0 },
      }),
      'LIMIT_EXCEEDED'
    );
    await deadlineService.markOutcomeUnknown(deadlineRun.reference, deadlineRun.leaseToken, 'deadline:unknown');
    await repository.releaseLease(ownerId, deadlineRun.runId, deadlineRun.leaseToken);
    const final = await deadlineService.reconcileAfterQuiescent(deadlineRun.reference, {}, 'deadline:reconciled');
    assert.equal(final.resourceActive, false);
    assert.equal((await deadlineService.listUsageEvents(deadlineRun.reference)).some((event) => event.limitExceeded), true);
  });

  it('Ask and Plan receive no Execute write capacity', async () => {
    const run = await createClaimedRun('ask');
    const reservation = await quotas.reserveExecutionAttempt(run.reference, run.leaseToken);
    assert.equal(reservation.mode, 'ask');
    assert.equal(reservation.limits.sandboxRuntimeMs, 0);
    assert.equal(reservation.limits.artifactBytes, 0);
    assert.equal(reservation.limits.workspaceDiskBytes, 0);
    await quotas.markAllocationStarted(run.reference, run.leaseToken);
    await assertQuotaCode(quotas.recordUsage(run.reference, run.leaseToken, {
      eventKey: 'ask:write-attempt',
      kind: 'measurement',
      usage: { workspaceDiskBytes: 1 },
    }), 'LIMIT_EXCEEDED');
    const storedMode = await db.pool.query('SELECT mode, writable FROM agent_execution_reservations WHERE id = $1', [reservation.id]);
    assert.equal(storedMode.rows[0]!.mode, 'ask');
    assert.equal(storedMode.rows[0]!.writable, false);
  });

  it('capacity becomes available only after cancellation reconciliation confirms quiescence', async () => {
    const first = await createClaimedRun();
    const second = await createClaimedRun('execute', await makeWorkspace());
    await quotas.reserveExecutionAttempt(first.reference, first.leaseToken);
    await quotas.markAllocationStarted(first.reference, first.leaseToken);
    await assertQuotaCode(quotas.reserveExecutionAttempt(second.reference, second.leaseToken), 'WORKSPACE_BUSY');
    await quotas.markOutcomeUnknown(first.reference, first.leaseToken, 'cancel:unknown');
    await repository.releaseLease(ownerId, first.runId, first.leaseToken);
    const reconciler = new AgentQuotaService(db.pool, DEFAULT_AGENT_QUOTA_POLICY, verifier(true));
    await reconciler.reconcileAfterQuiescent(first.reference, {}, 'cancel:confirmed');
    const replacement = await reconciler.reserveExecutionAttempt(second.reference, second.leaseToken);
    assert.equal(replacement.state, 'reserved');
  });

  it('usage audit stores numeric evidence only and never returns lease or cross-tenant data', async () => {
    const run = await createClaimedRun();
    await quotas.reserveExecutionAttempt(run.reference, run.leaseToken);
    await quotas.markAllocationStarted(run.reference, run.leaseToken);
    await quotas.recordUsage(run.reference, run.leaseToken, {
      eventKey: 'provider:private-check',
      kind: 'provider_request',
      usage: { providerRequests: 1 },
    });
    const serialized = JSON.stringify(await quotas.listUsageEvents(run.reference));
    assert.equal(serialized.includes(run.leaseToken), false);
    const stored = await db.pool.query(
      'SELECT lease_token_hash FROM agent_execution_reservations WHERE run_id = $1',
      [run.runId]
    );
    assert.notEqual(stored.rows[0]!.lease_token_hash, run.leaseToken);
    await assert.rejects(
      quotas.listUsageEvents({ ...run.reference, ownerId: otherOwnerId }),
      (error: unknown) => error instanceof Error && error.message === 'Resource not found'
    );
  });
});
