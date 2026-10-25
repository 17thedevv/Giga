import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDbInstance } from '../test-db-helper.js';
import { AgentRepository } from '../../src/modules/agent/repository.js';
import {
  AgentQuotaError,
  AgentQuotaService,
  type AgentQuotaReference,
  type QuotaQuiescenceVerifier,
} from '../../src/modules/agent/quota-service.js';
import { DEFAULT_AGENT_QUOTA_POLICY, type AgentQuotaPolicy } from '../../src/modules/agent/quota-policy.js';

describe('GigaAgent durable quota reservations', () => {
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
    return { isQuiescent: async () => result };
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

  it('cancellation before allocation refunds once; cancellation after allocation holds until quiescence', async () => {
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
    await assert.rejects(noProof.reconcileAfterQuiescent(duringAllocation.reference, {}, 'cleanup:not-done'));
    const reconciled = await new AgentQuotaService(db.pool, DEFAULT_AGENT_QUOTA_POLICY, verifier(true))
      .reconcileAfterQuiescent(duringAllocation.reference, {}, 'cleanup:confirmed');
    assert.equal(reconciled.state, 'released');
    assert.equal(reconciled.resourceActive, false);
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
    const quiescent = await new AgentQuotaService(db.pool, DEFAULT_AGENT_QUOTA_POLICY, verifier(true))
      .reconcileAfterQuiescent(first.reference, committed.actual, 'cleanup:1');
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
    const service = new AgentQuotaService(db.pool, DEFAULT_AGENT_QUOTA_POLICY, verifier(true));
    await service.reconcileAfterQuiescent(run.reference, first.actual, 'cleanup:stable');
    await service.reconcileAfterQuiescent(run.reference, first.actual, 'cleanup:stable');
    const events = await service.listUsageEvents(run.reference);
    assert.equal(events.filter((event) => event.kind === 'attempt_committed').length, 1);
    assert.equal(events.filter((event) => event.kind === 'reconciled').length, 1);
    assert.equal(events.filter((event) => event.kind === 'provider_request' && event.usage.providerRequests === 1).length, 1);
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
    await service.reconcileAfterQuiescent(run.reference, {}, 'cleanup:resource-caps');

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
    const final = await deadlineService.reconcileAfterQuiescent(deadlineRun.reference, { wallClockMs: 40 }, 'deadline:reconciled');
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
