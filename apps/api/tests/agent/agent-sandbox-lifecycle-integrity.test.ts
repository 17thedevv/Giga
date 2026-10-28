import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createTestDatabase, type TestDbInstance } from '../test-db-helper.js';
import { AgentRepository } from '../../src/modules/agent/repository.js';
import { AgentQuotaService } from '../../src/modules/agent/quota-service.js';
import { DEFAULT_AGENT_QUOTA_POLICY } from '../../src/modules/agent/quota-policy.js';
import { SandboxAttemptLifecycleFence } from '../../src/modules/agent/sandbox-lifecycle-fence.js';

describe('17T-71 Review Fix: Database-Level Sandbox Lifecycle Integrity', {
  skip: process.env.TEST_DATABASE_URL ? false : 'PostgreSQL regression tests require TEST_DATABASE_URL',
}, () => {
  let db: TestDbInstance;
  let repo: AgentRepository;
  let ownerId: string;
  let workspaceId: string;
  let runtimeClient: pg.PoolClient;

  before(async () => {
    db = await createTestDatabase();
    repo = new AgentRepository(db.pool);
    runtimeClient = await db.pool.connect();
    await runtimeClient.query('SET ROLE giga_api_runtime');
  });

  after(async () => {
    try {
      await runtimeClient.query('RESET ROLE');
      runtimeClient.release();
    } catch {}
    await db.cleanup();
    await db.pool.end();
  });

  beforeEach(async () => {
    ownerId = randomUUID();
    workspaceId = randomUUID();

    // Privileged setup as database migration owner/superuser
    await db.pool.query(
      'INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)',
      [ownerId, `user-${ownerId}@example.com`, 'Test User', 'hash']
    );
    await db.pool.query(
      'INSERT INTO agent_workspaces (id, owner_id, name) VALUES ($1, $2, $3)',
      [workspaceId, ownerId, 'Default Workspace']
    );
  });

  async function createClaimedRun(workerId = 'worker-integrity-1', mode: 'ask' | 'plan' | 'execute' = 'execute') {
    const queued = await repo.enqueueRun(
      ownerId,
      { workspaceId, task: 'Integrity test task', mode, runtime: 'cloud', modelId: 'giga-agent-default' },
      randomUUID(),
      'a'.repeat(64)
    );
    const claimed = await repo.claimRun(ownerId, queued.run.id, workerId);
    assert.ok(claimed);
    return { run: queued.run, claim: claimed };
  }

  // 1. Attempt to change an in_progress allocation directly to settled/no_resource; assert rejection.
  it('Scenario 1: direct UPDATE of in_progress allocation to settled/no_resource is rejected by trigger', async () => {
    const { run, claim } = await createClaimedRun();
    const { session } = await repo.createSandboxAllocationIntent({
      ownerId,
      workspaceId,
      runId: run.id,
      attemptNumber: 1,
      mode: 'execute',
      providerType: 'mock-e2b',
      workerId: 'worker-integrity-1',
      leaseToken: claim.leaseToken,
    });

    const started = await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);
    assert.equal(started, true);

    // Direct SQL update by giga_api_runtime role attempting to forge no_resource outcome
    await assert.rejects(
      async () => {
        await runtimeClient.query(
          `UPDATE agent_sandbox_lifecycle_operations
           SET state = 'settled', outcome = 'no_resource', settled_at = NOW()
           WHERE session_id = $1 AND operation_kind = 'allocation'`,
          [session.id]
        );
      },
      /permission denied|Agent sandbox allocation settlement requires the controlled database operation|In-progress allocation cannot be settled as no_resource/i
    );
  });

  // 2. Attempt the same transition from ambiguous; assert rejection.
  it('Scenario 2: direct UPDATE of ambiguous allocation to settled/no_resource is rejected by trigger', async () => {
    const { run, claim } = await createClaimedRun();
    const { session } = await repo.createSandboxAllocationIntent({
      ownerId,
      workspaceId,
      runId: run.id,
      attemptNumber: 1,
      mode: 'execute',
      providerType: 'mock-e2b',
      workerId: 'worker-integrity-1',
      leaseToken: claim.leaseToken,
    });

    await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);
    await repo.markSandboxAllocationAmbiguous(session.id, 'Provider network timeout');

    // Direct SQL update by giga_api_runtime role attempting to forge no_resource outcome from ambiguous
    await assert.rejects(
      async () => {
        await runtimeClient.query(
          `UPDATE agent_sandbox_lifecycle_operations
           SET state = 'settled', outcome = 'no_resource', settled_at = NOW()
           WHERE session_id = $1 AND operation_kind = 'allocation'`,
          [session.id]
        );
      },
      /permission denied|Agent sandbox allocation settlement requires the controlled database operation|Ambiguous allocation cannot be settled as no_resource/i
    );
  });

  // 3. Attempt to rewrite an already-settled allocation outcome or provider ID; assert rejection.
  it('Scenario 3: rewrite of settled allocation outcome or provider ID is rejected as immutable', async () => {
    const { run, claim } = await createClaimedRun();
    const { session } = await repo.createSandboxAllocationIntent({
      ownerId,
      workspaceId,
      runId: run.id,
      attemptNumber: 1,
      mode: 'execute',
      providerType: 'mock-e2b',
      workerId: 'worker-integrity-1',
      leaseToken: claim.leaseToken,
    });

    await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);
    await repo.commitSandboxSessionAllocated({
      sessionId: session.id,
      ownerId,
      runId: run.id,
      leaseToken: claim.leaseToken,
      providerSessionId: 'sbx-settled-original',
    });

    // Attempt to change outcome to no_resource
    await assert.rejects(
      async () => {
        await runtimeClient.query(
          `UPDATE agent_sandbox_lifecycle_operations
           SET outcome = 'no_resource', provider_resource_id = NULL
           WHERE session_id = $1 AND operation_kind = 'allocation'`,
          [session.id]
        );
      },
      /permission denied|Settled sandbox lifecycle operations are immutable/i
    );

    // Attempt to rewrite provider_resource_id on settled row
    await assert.rejects(
      async () => {
        await runtimeClient.query(
          `UPDATE agent_sandbox_lifecycle_operations
           SET provider_resource_id = 'sbx-fabricated-id'
           WHERE session_id = $1 AND operation_kind = 'allocation'`,
          [session.id]
        );
      },
      /permission denied|Settled sandbox lifecycle operations are immutable/i
    );
  });

  // 4. Attempt to mark a live, stopping, or cleanup-pending session destroyed directly; assert rejection.
  it('Scenario 4: direct UPDATE to mark a live (active, stopping) or cleanup_pending session destroyed is rejected', async () => {
    const { run, claim } = await createClaimedRun();
    const { session } = await repo.createSandboxAllocationIntent({
      ownerId,
      workspaceId,
      runId: run.id,
      attemptNumber: 1,
      mode: 'execute',
      providerType: 'mock-e2b',
      workerId: 'worker-integrity-1',
      leaseToken: claim.leaseToken,
    });

    await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);
    const active = await repo.commitSandboxSessionAllocated({
      sessionId: session.id,
      ownerId,
      runId: run.id,
      leaseToken: claim.leaseToken,
      providerSessionId: 'sbx-live-test',
    });
    assert.equal(active.lifecycleState, 'active');

    // 4a. Direct SQL update from active -> destroyed
    await assert.rejects(
      async () => {
        await runtimeClient.query(
          `UPDATE agent_sandbox_sessions
           SET lifecycle_state = 'destroyed', cleanup_state = 'completed'
           WHERE id = $1`,
          [session.id]
        );
      },
      /Sandbox destruction finalization requires the controlled database operation|Direct transition to destroyed is forbidden from state active/i
    );

    // 4b. Bypass 1 check: transition to stopping, then attempt direct SQL update stopping -> destroyed
    await db.pool.query(
      `UPDATE agent_sandbox_sessions SET lifecycle_state = 'stopping' WHERE id = $1`,
      [session.id]
    );
    await assert.rejects(
      async () => {
        await runtimeClient.query(
          `UPDATE agent_sandbox_sessions
           SET lifecycle_state = 'destroyed', cleanup_state = 'completed',
               cleanup_lease_token = NULL, cleanup_lease_expires_at = NULL
           WHERE id = $1`,
          [session.id]
        );
      },
      /Sandbox destruction finalization requires the controlled database operation|Direct transition to destroyed is forbidden/i
    );

    // 4c. Bypass 2 check: attempt to manufacture active -> destroying with fabricated cleanup lease
    await assert.rejects(
      async () => {
        await runtimeClient.query(
          `UPDATE agent_sandbox_sessions
           SET lifecycle_state = 'destroying', cleanup_state = 'in_progress',
               cleanup_lease_token = 'fake-lease-token',
               cleanup_lease_expires_at = NOW() + INTERVAL '1 hour'
           WHERE id = $1`,
          [session.id]
        );
      },
      /Claiming sandbox cleanup lease requires the controlled database operation|requires active cleanup lease/i
    );

    // Transition to cleanup_pending via legitimate abort/fence
    await repo.markSandboxCleanupPending(session.id, 'Transient cleanup failure', 5000);
    const pending = await repo.getSandboxSession(ownerId, session.id);
    assert.equal(pending.lifecycleState, 'cleanup_pending');

    // 4d. Direct SQL update from cleanup_pending -> destroyed
    await assert.rejects(
      async () => {
        await runtimeClient.query(
          `UPDATE agent_sandbox_sessions
           SET lifecycle_state = 'destroyed', cleanup_state = 'completed'
           WHERE id = $1`,
          [session.id]
        );
      },
      /Sandbox destruction finalization requires the controlled database operation|Direct transition to destroyed is forbidden from state cleanup_pending/i
    );
  });

  // 5. Attempt to revive a destroyed session or change its attempt identity; assert rejection.
  it('Scenario 5: revival of destroyed session and mutation of attempt identity are strictly rejected', async () => {
    const { run, claim } = await createClaimedRun();
    const { session } = await repo.createSandboxAllocationIntent({
      ownerId,
      workspaceId,
      runId: run.id,
      attemptNumber: 1,
      mode: 'execute',
      providerType: 'mock-e2b',
      workerId: 'worker-integrity-1',
      leaseToken: claim.leaseToken,
    });

    await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);
    await repo.commitSandboxSessionAllocated({
      sessionId: session.id,
      ownerId,
      runId: run.id,
      leaseToken: claim.leaseToken,
      providerSessionId: 'sbx-tombstone-test',
    });

    const destroyed = await repo.markSandboxDestroyed(session.id, 'sbx-tombstone-test');
    assert.equal(destroyed.lifecycleState, 'destroyed');

    // Attempt to revive back to active
    await assert.rejects(
      async () => {
        await runtimeClient.query(
          `UPDATE agent_sandbox_sessions
           SET lifecycle_state = 'active'
           WHERE id = $1`,
          [session.id]
        );
      },
      /Destroyed sandbox session is terminal and immutable/i
    );

    // Attempt to mutate attempt identity column
    await assert.rejects(
      async () => {
        await runtimeClient.query(
          `UPDATE agent_sandbox_sessions
           SET attempt_number = 99
           WHERE id = $1`,
          [session.id]
        );
      },
      /permission denied|identity is immutable/i
    );
  });

  // 6. Confirm that a never-started allocation can still settle as no_resource after fencing through the valid path.
  it('Scenario 6: never-started allocation durably settles as no_resource when attempt is fenced', async () => {
    const { run, claim } = await createClaimedRun();
    await repo.createSandboxAllocationIntent({
      ownerId,
      workspaceId,
      runId: run.id,
      attemptNumber: 1,
      mode: 'execute',
      providerType: 'mock-e2b',
      workerId: 'worker-integrity-1',
      leaseToken: claim.leaseToken,
    });

    // Attempt is fenced before worker ever called provider
    await repo.fenceSandboxAttempt({
      ownerId,
      workspaceId,
      runId: run.id,
      attemptNumber: 1,
    }, 'timeout_fencing');

    const lifecycle = await repo.getSandboxAttemptLifecycle({
      ownerId,
      workspaceId,
      runId: run.id,
      attemptNumber: 1,
    });

    assert.equal(lifecycle.fenced, true);
    assert.ok(lifecycle.session);
    assert.equal(lifecycle.session.lifecycleState, 'failed');
    assert.equal(lifecycle.session.allocationState, 'failed');

    const allocOp = lifecycle.operations.find((op) => op.kind === 'allocation');
    assert.ok(allocOp);
    assert.equal(allocOp.state, 'settled');
    assert.equal(allocOp.outcome, 'no_resource');
    assert.equal(allocOp.providerResourceId, null);
  });

  // 7. Confirm that a late successful allocation remains durably recorded against its original generation and is subsequently destroyed.
  it('Scenario 7: late successful allocation is durably recorded against original generation and can be destroyed', async () => {
    const { run, claim } = await createClaimedRun();
    const { session } = await repo.createSandboxAllocationIntent({
      ownerId,
      workspaceId,
      runId: run.id,
      attemptNumber: 1,
      mode: 'execute',
      providerType: 'mock-e2b',
      workerId: 'worker-integrity-1',
      leaseToken: claim.leaseToken,
    });

    await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);

    // Attempt is fenced while allocation was in flight at provider
    await repo.fenceSandboxAttempt({
      ownerId,
      workspaceId,
      runId: run.id,
      attemptNumber: 1,
    }, 'lease_expired_while_allocating');

    // Late callback from provider arrives with resource ID
    const lateCommitted = await repo.commitSandboxSessionAllocated({
      sessionId: session.id,
      ownerId,
      runId: run.id,
      leaseToken: claim.leaseToken,
      providerSessionId: 'sbx-late-callback-999',
    });

    // Session is forced into cleanup_pending because the attempt was fenced
    assert.equal(lateCommitted.lifecycleState, 'cleanup_pending');
    assert.equal(lateCommitted.providerSessionId, 'sbx-late-callback-999');
    assert.equal(lateCommitted.attemptGeneration, session.attemptGeneration);

    // Verify operation ledger recorded resource against original generation
    const lifecycle = await repo.getSandboxAttemptLifecycle({
      ownerId,
      workspaceId,
      runId: run.id,
      attemptNumber: 1,
    });
    const op = lifecycle.operations.find((o) => o.kind === 'allocation');
    assert.ok(op);
    assert.equal(op.state, 'settled');
    assert.equal(op.outcome, 'resource');
    assert.equal(op.providerResourceId, 'sbx-late-callback-999');
    assert.equal(op.generation, session.attemptGeneration);

    // Background reconciler cleans it up
    const claimedCleanup = await repo.claimSandboxSessionForCleanup({
      sessionId: session.id,
      workerId: 'reconciler-worker',
      leaseToken: 'reconcile-lease-1',
      leaseDurationMs: 30000,
    });
    assert.ok(claimedCleanup);
    assert.equal(claimedCleanup.lifecycleState, 'destroying');

    const destroyed = await repo.markSandboxDestroyed(session.id, 'sbx-late-callback-999', 'reconcile-lease-1');
    assert.equal(destroyed.lifecycleState, 'destroyed');
    assert.equal(destroyed.providerSessionId, 'sbx-late-callback-999');
  });

  // 8. Confirm that valid cleanup retries still work and overlapping workers cannot destroy the same sandbox concurrently.
  it('Scenario 8: cleanup retries work and concurrent workers cannot double-destroy', async () => {
    const { run, claim } = await createClaimedRun();
    const { session } = await repo.createSandboxAllocationIntent({
      ownerId,
      workspaceId,
      runId: run.id,
      attemptNumber: 1,
      mode: 'execute',
      providerType: 'mock-e2b',
      workerId: 'worker-integrity-1',
      leaseToken: claim.leaseToken,
    });

    await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);
    await repo.commitSandboxSessionAllocated({
      sessionId: session.id,
      ownerId,
      runId: run.id,
      leaseToken: claim.leaseToken,
      providerSessionId: 'sbx-retry-test-1',
    });

    // Mark cleanup pending after initial transient failure
    await repo.markSandboxCleanupPending(session.id, 'Connection reset by peer', 10);
    const pendingSession = await repo.getSandboxSession(ownerId, session.id);
    assert.equal(pendingSession.lifecycleState, 'cleanup_pending');
    assert.equal(pendingSession.cleanupAttempts, 1);

    // Worker 1 claims cleanup lease
    const worker1Claim = await repo.claimSandboxSessionForCleanup({
      sessionId: session.id,
      workerId: 'worker-1',
      leaseToken: 'lease-w1',
      leaseDurationMs: 30000,
    });
    assert.ok(worker1Claim);
    assert.equal(worker1Claim.lifecycleState, 'destroying');

    // Worker 2 attempts concurrent claim while Worker 1 lease is active -> rejected (returns null)
    const worker2Claim = await repo.claimSandboxSessionForCleanup({
      sessionId: session.id,
      workerId: 'worker-2',
      leaseToken: 'lease-w2',
      leaseDurationMs: 30000,
    });
    assert.equal(worker2Claim, null);

    // Worker 2 attempts to mark destroyed with its invalid lease -> rejected
    await assert.rejects(
      async () => {
        await repo.markSandboxDestroyed(session.id, 'sbx-retry-test-1', 'lease-w2');
      },
      /Cleanup lease was fenced before destruction could be recorded/i
    );

    // Worker 1 completes destruction with valid lease
    const destroyed = await repo.markSandboxDestroyed(session.id, 'sbx-retry-test-1', 'lease-w1');
    assert.equal(destroyed.lifecycleState, 'destroyed');
  });

  // 9. Confirm that quota capacity remains held when provider settlement or destruction is unknown.
  it('Scenario 9: quota capacity remains held while provider allocation outcome is ambiguous', async () => {
    const { run, claim } = await createClaimedRun('quota-worker-ambiguous');
    const reference = { ownerId, workspaceId, runId: run.id, attemptNumber: claim.attemptCount };

    class MockProvider {
      public createdSandboxes: string[] = [];
      public destroyedSandboxes: string[] = [];
      async createSandbox() { return { sandboxId: 'sbx-ambiguous' }; }
      async resolveAllocation() { return { status: 'pending' as const }; }
      async destroySandbox(id: string) { this.destroyedSandboxes.push(id); }
    }
    const mockProvider = new MockProvider();
    const lifecycleFence = new SandboxAttemptLifecycleFence(repo, mockProvider as any, { drainTimeoutMs: 10, pollIntervalMs: 1 });
    const quotas = new AgentQuotaService(db.pool, DEFAULT_AGENT_QUOTA_POLICY, lifecycleFence);

    const reservation = await quotas.reserveExecutionAttempt(reference, claim.leaseToken);
    assert.equal(reservation.state, 'reserved');
    assert.equal(reservation.resourceActive, true);
    await quotas.markAllocationStarted(reference, claim.leaseToken);

    const { session } = await repo.createSandboxAllocationIntent({
      ownerId,
      workspaceId,
      runId: run.id,
      attemptNumber: claim.attemptCount,
      mode: 'execute',
      providerType: 'mock-e2b',
      workerId: 'quota-worker-ambiguous',
      leaseToken: claim.leaseToken,
    });

    await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);
    await repo.markSandboxAllocationAmbiguous(session.id, 'Gateway timeout 504');
    await quotas.markOutcomeUnknown(reference, claim.leaseToken, 'quota:allocation-ambiguous');

    // Attempting reconciliation fails because fence cannot prove absence
    await assert.rejects(
      quotas.reconcileAfterQuiescent(reference, {}, 'quota:must-remain-held'),
      /could not establish a durable attempt fence/i
    );

    // Check that reservation capacity is NOT refunded while allocation remains ambiguous
    const reservationAfter = await quotas.getReservation(reference);
    assert.equal(reservationAfter.resourceActive, true);
    assert.equal(reservationAfter.state, 'reconciliation_required');
  });

  // 10. Confirm that quota release succeeds after verified quiescence through the controlled quota finalization boundary.
  it('Scenario 10: quota release succeeds through controlled quota finalizer after verified quiescence', async () => {
    const { run, claim } = await createClaimedRun('quota-worker-recovery');
    const reference = { ownerId, workspaceId, runId: run.id, attemptNumber: claim.attemptCount };

    class MockProvider {
      public createdSandboxes: string[] = [];
      public destroyedSandboxes: string[] = [];
      async createSandbox() { return { sandboxId: 'sbx-quiescent-1' }; }
      async resolveAllocation() { return { status: 'allocated' as const, sandboxId: 'sbx-quiescent-1' }; }
      async destroySandbox(id: string) { this.destroyedSandboxes.push(id); }
    }
    const mockProvider = new MockProvider();
    const lifecycleFence = new SandboxAttemptLifecycleFence(repo, mockProvider as any, { drainTimeoutMs: 100, pollIntervalMs: 1 });
    const quotas = new AgentQuotaService(db.pool, DEFAULT_AGENT_QUOTA_POLICY, lifecycleFence);

    await quotas.reserveExecutionAttempt(reference, claim.leaseToken);
    await quotas.markAllocationStarted(reference, claim.leaseToken);

    const { session } = await repo.createSandboxAllocationIntent({
      ownerId,
      workspaceId,
      runId: run.id,
      attemptNumber: claim.attemptCount,
      mode: 'execute',
      providerType: 'mock-e2b',
      workerId: 'quota-worker-recovery',
      leaseToken: claim.leaseToken,
    });

    await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);
    await repo.markSandboxAllocationAmbiguous(session.id, 'simulated transient crash');
    await quotas.markOutcomeUnknown(reference, claim.leaseToken, 'quota:outcome-unknown');

    // Reconcile after quiescent - lifecycle fence resolves provider status, destroys sandbox, and finalizes quota
    const reconciled = await quotas.reconcileAfterQuiescent(reference, {}, 'quota:verified-cleanup');
    assert.equal(reconciled.state, 'committed');
    assert.equal(reconciled.resourceActive, false);
    assert.equal(mockProvider.destroyedSandboxes.length, 1);

    const reservationAfter = await quotas.getReservation(reference);
    assert.equal(reservationAfter.resourceActive, false);
  });

  // 11. Verify effective role privileges after the real 014 -> 015 -> 016 migration sequence.
  it('Scenario 11: verify effective role privileges of giga_api_runtime after migration sequence', async () => {
    const checkPrivilege = async (query: string): Promise<boolean> => {
      const res = await db.pool.query<{ has_priv: boolean }>(query);
      return Boolean(res.rows[0]?.has_priv);
    };

    // agent_sandbox_sessions: SELECT and INSERT granted, DELETE and TRUNCATE revoked
    assert.equal(await checkPrivilege("SELECT has_table_privilege('giga_api_runtime', 'agent_sandbox_sessions', 'SELECT') AS has_priv"), true);
    assert.equal(await checkPrivilege("SELECT has_table_privilege('giga_api_runtime', 'agent_sandbox_sessions', 'INSERT') AS has_priv"), true);
    assert.equal(await checkPrivilege("SELECT has_table_privilege('giga_api_runtime', 'agent_sandbox_sessions', 'DELETE') AS has_priv"), false);
    assert.equal(await checkPrivilege("SELECT has_table_privilege('giga_api_runtime', 'agent_sandbox_sessions', 'TRUNCATE') AS has_priv"), false);

    // Column privileges on agent_sandbox_sessions: provider resource identity, destroyed_at and identity columns CANNOT be updated
    assert.equal(await checkPrivilege("SELECT has_column_privilege('giga_api_runtime', 'agent_sandbox_sessions', 'lifecycle_state', 'UPDATE') AS has_priv"), true);
    assert.equal(await checkPrivilege("SELECT has_column_privilege('giga_api_runtime', 'agent_sandbox_sessions', 'provider_session_id', 'UPDATE') AS has_priv"), false);
    assert.equal(await checkPrivilege("SELECT has_column_privilege('giga_api_runtime', 'agent_sandbox_sessions', 'destroyed_at', 'UPDATE') AS has_priv"), false);
    assert.equal(await checkPrivilege("SELECT has_column_privilege('giga_api_runtime', 'agent_sandbox_sessions', 'owner_id', 'UPDATE') AS has_priv"), false);
    assert.equal(await checkPrivilege("SELECT has_column_privilege('giga_api_runtime', 'agent_sandbox_sessions', 'run_id', 'UPDATE') AS has_priv"), false);
    assert.equal(await checkPrivilege("SELECT has_column_privilege('giga_api_runtime', 'agent_sandbox_sessions', 'attempt_number', 'UPDATE') AS has_priv"), false);
    assert.equal(await checkPrivilege("SELECT has_column_privilege('giga_api_runtime', 'agent_sandbox_sessions', 'attempt_generation', 'UPDATE') AS has_priv"), false);

    // agent_sandbox_lifecycle_operations: SELECT, INSERT, specific column UPDATE granted; outcome, provider_resource_id, DELETE, TRUNCATE revoked
    assert.equal(await checkPrivilege("SELECT has_table_privilege('giga_api_runtime', 'agent_sandbox_lifecycle_operations', 'SELECT') AS has_priv"), true);
    assert.equal(await checkPrivilege("SELECT has_table_privilege('giga_api_runtime', 'agent_sandbox_lifecycle_operations', 'INSERT') AS has_priv"), true);
    assert.equal(await checkPrivilege("SELECT has_table_privilege('giga_api_runtime', 'agent_sandbox_lifecycle_operations', 'DELETE') AS has_priv"), false);
    assert.equal(await checkPrivilege("SELECT has_table_privilege('giga_api_runtime', 'agent_sandbox_lifecycle_operations', 'TRUNCATE') AS has_priv"), false);
    assert.equal(await checkPrivilege("SELECT has_column_privilege('giga_api_runtime', 'agent_sandbox_lifecycle_operations', 'state', 'UPDATE') AS has_priv"), true);
    assert.equal(await checkPrivilege("SELECT has_column_privilege('giga_api_runtime', 'agent_sandbox_lifecycle_operations', 'outcome', 'UPDATE') AS has_priv"), false);
    assert.equal(await checkPrivilege("SELECT has_column_privilege('giga_api_runtime', 'agent_sandbox_lifecycle_operations', 'provider_resource_id', 'UPDATE') AS has_priv"), false);
    assert.equal(await checkPrivilege("SELECT has_column_privilege('giga_api_runtime', 'agent_sandbox_lifecycle_operations', 'generation', 'UPDATE') AS has_priv"), false);
    assert.equal(await checkPrivilege("SELECT has_column_privilege('giga_api_runtime', 'agent_sandbox_lifecycle_operations', 'operation_kind', 'UPDATE') AS has_priv"), false);

    // Table ownership boundaries: tables and routines owned by giga_agent_lifecycle_owner
    const tableOwnerRes = await db.pool.query<{ tablename: string; tableowner: string }>(
      "SELECT tablename, tableowner FROM pg_tables WHERE tablename IN ('agent_sandbox_sessions', 'agent_sandbox_lifecycle_operations', 'agent_sandbox_attempt_fences')"
    );
    for (const row of tableOwnerRes.rows) {
      assert.equal(row.tableowner, 'giga_agent_lifecycle_owner');
    }

    // Provider-authoritative routines are not executable by giga_api_runtime.
    const checkRoutinePrivilege = async (routine: string, role = 'giga_api_runtime'): Promise<boolean> => {
      const res = await db.pool.query<{ has_priv: boolean }>(
        `SELECT has_function_privilege('${role}', '${routine}', 'EXECUTE') AS has_priv`
      );
      return Boolean(res.rows[0]?.has_priv);
    };
    assert.equal(await checkRoutinePrivilege('settle_agent_sandbox_allocation(uuid, uuid, uuid, integer, uuid, varchar, varchar, varchar)'), false);
    assert.equal(await checkRoutinePrivilege('claim_agent_sandbox_cleanup(uuid, varchar, varchar, integer)'), false);
    assert.equal(await checkRoutinePrivilege('finalize_agent_sandbox_destruction(uuid, varchar, varchar)'), false);
    assert.equal(await checkRoutinePrivilege('settle_agent_sandbox_allocation(uuid, uuid, uuid, integer, uuid, varchar, varchar, varchar)', 'giga_agent_lifecycle_finalizer'), true);
    assert.equal(await checkRoutinePrivilege('claim_agent_sandbox_cleanup(uuid, varchar, varchar, integer)', 'giga_agent_lifecycle_finalizer'), true);
    assert.equal(await checkRoutinePrivilege('finalize_agent_sandbox_destruction(uuid, varchar, varchar)', 'giga_agent_lifecycle_finalizer'), true);

    // agent_sandbox_attempt_fences: SELECT, INSERT, column UPDATE granted; DELETE revoked
    assert.equal(await checkPrivilege("SELECT has_table_privilege('giga_api_runtime', 'agent_sandbox_attempt_fences', 'SELECT') AS has_priv"), true);
    assert.equal(await checkPrivilege("SELECT has_table_privilege('giga_api_runtime', 'agent_sandbox_attempt_fences', 'INSERT') AS has_priv"), true);
    assert.equal(await checkPrivilege("SELECT has_table_privilege('giga_api_runtime', 'agent_sandbox_attempt_fences', 'DELETE') AS has_priv"), false);
    assert.equal(await checkPrivilege("SELECT has_column_privilege('giga_api_runtime', 'agent_sandbox_attempt_fences', 'fenced_at', 'UPDATE') AS has_priv"), true);
    assert.equal(await checkPrivilege("SELECT has_column_privilege('giga_api_runtime', 'agent_sandbox_attempt_fences', 'generation', 'UPDATE') AS has_priv"), false);
  });
});
