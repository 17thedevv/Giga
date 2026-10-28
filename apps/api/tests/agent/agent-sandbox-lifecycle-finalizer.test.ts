import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabasePool } from '../../src/db/client.js';
import { AgentRepository } from '../../src/modules/agent/repository.js';
import { AgentQuotaService } from '../../src/modules/agent/quota-service.js';
import { DEFAULT_AGENT_QUOTA_POLICY } from '../../src/modules/agent/quota-policy.js';
import { SandboxAttemptLifecycleFence } from '../../src/modules/agent/sandbox-lifecycle-fence.js';
import { SandboxCleanupReconciler } from '../../src/modules/agent/cleanup-reconciler.js';
import type { CloudSandboxProviderClient } from '../../src/modules/agent/sandbox-adapter.js';
import type { TestDbInstance } from '../test-db-helper.js';
import { createTestDatabase } from '../test-db-helper.js';

const SETTLE_FUNCTION = 'public.settle_agent_sandbox_allocation(uuid,uuid,uuid,integer,uuid,character varying,character varying,character varying)';
const CLAIM_FUNCTION = 'public.claim_agent_sandbox_cleanup(uuid,character varying,character varying,integer)';
const FINALIZE_FUNCTION = 'public.finalize_agent_sandbox_destruction(uuid,character varying,character varying)';

describe('17T-71 provider-authoritative lifecycle finalizer boundary', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Lifecycle finalizer security tests require isolated PostgreSQL',
}, () => {
  let db: TestDbInstance;
  let runtimePool: ReturnType<typeof createDatabasePool>;
  let lifecycleFinalizerPool: ReturnType<typeof createDatabasePool>;
  let quotaFinalizerPool: ReturnType<typeof createDatabasePool>;
  let repository: AgentRepository;
  let ownerId: string;
  let workspaceId: string;

  before(async () => {
    db = await createTestDatabase();
    runtimePool = createDatabasePool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: '-c role=giga_api_runtime',
      maxConnections: 4,
    });
    lifecycleFinalizerPool = createDatabasePool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: '-c role=giga_agent_lifecycle_finalizer',
      maxConnections: 4,
    });
    quotaFinalizerPool = createDatabasePool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: '-c role=giga_agent_quota_finalizer',
      maxConnections: 4,
    });
  });

  after(async () => {
    await db.cleanup();
    await Promise.all([runtimePool.end(), lifecycleFinalizerPool.end(), quotaFinalizerPool.end(), db.pool.end()]);
  });

  beforeEach(async () => {
    await db.cleanup();
    ownerId = randomUUID();
    await db.pool.query(
      'INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)',
      [ownerId, `${ownerId}@example.com`, 'Lifecycle finalizer test user', 'unused-test-hash']
    );
    repository = new AgentRepository(runtimePool, lifecycleFinalizerPool);
    workspaceId = (await repository.createWorkspace(ownerId, `Lifecycle Workspace ${randomUUID()}`)).id;
  });

  async function createClaimedRun(workerId = 'lifecycle-worker') {
    const queued = await repository.enqueueRun(
      ownerId,
      { workspaceId, task: 'Lifecycle finalizer test', mode: 'execute', runtime: 'cloud', modelId: 'giga-agent-default' },
      randomUUID(),
      'b'.repeat(64)
    );
    const claim = await repository.claimRun(ownerId, queued.run.id, workerId, 60_000);
    assert.ok(claim);
    const reference = { ownerId, workspaceId, runId: queued.run.id, attemptNumber: claim.attemptCount };
    const allocation = await repository.createSandboxAllocationIntent({
      ownerId,
      workspaceId,
      runId: queued.run.id,
      attemptNumber: claim.attemptCount,
      mode: 'execute',
      providerType: 'mock-e2b',
      workerId,
      leaseToken: claim.leaseToken,
    });
    return { run: queued.run, claim, reference, session: allocation.session };
  }

  async function settleAllocation(sessionId: string, owner: string, runId: string, attempt: number,
    generation: string, outcome: 'resource' | 'no_resource', providerId: string | null,
    workerToken: string | null = null) {
    return lifecycleFinalizerPool.query(
      `SELECT * FROM settle_agent_sandbox_allocation(
        $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid,
        $6::varchar, $7::varchar, $8::varchar)`,
      [sessionId, owner, runId, attempt, generation, outcome, providerId, workerToken]
    );
  }

  function assertPrivilegeDenied(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error &&
      (error as { code?: unknown }).code === '42501';
  }

  it('blocks runtime routine and raw-column attacks and verifies effective ownership and grants', async () => {
    const { run, claim, session } = await createClaimedRun('runtime-attack-worker');
    await repository.beginSandboxAllocationOperation(session.id, session.attemptGeneration);

    const forgedValues = [session.id, ownerId, run.id, claim.attemptCount, session.attemptGeneration];
    await assert.rejects(
      runtimePool.query(
        `SELECT * FROM settle_agent_sandbox_allocation(
          $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid,
          'resource'::varchar, 'fake-provider-resource'::varchar, $6::varchar)`,
        [...forgedValues, claim.leaseToken]
      ),
      assertPrivilegeDenied
    );
    await assert.rejects(
      runtimePool.query(
        `SELECT * FROM settle_agent_sandbox_allocation(
          $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid,
          'no_resource'::varchar, NULL::varchar, NULL::varchar)`,
        forgedValues
      ),
      assertPrivilegeDenied
    );
    await assert.rejects(
      runtimePool.query(
        'SELECT * FROM claim_agent_sandbox_cleanup($1::uuid, $2::varchar, $3::varchar, $4::integer)',
        [session.id, 'forged-worker', 'caller-chosen-token', 60_000]
      ),
      assertPrivilegeDenied
    );
    await assert.rejects(
      runtimePool.query(
        'SELECT * FROM finalize_agent_sandbox_destruction($1::uuid, $2::varchar, $3::varchar)',
        [session.id, 'fake-provider-resource', 'caller-chosen-token']
      ),
      assertPrivilegeDenied
    );
    await assert.rejects(
      runtimePool.query(
        `UPDATE agent_sandbox_lifecycle_operations
         SET state = 'settled', outcome = 'resource', provider_resource_id = 'fake-provider-resource',
             settled_at = clock_timestamp() WHERE id = $1`,
        [session.allocationIntentId]
      ),
      assertPrivilegeDenied
    );
    await assert.rejects(
      runtimePool.query(
        "UPDATE agent_sandbox_sessions SET provider_session_id = 'fake-provider-resource' WHERE id = $1",
        [session.id]
      ),
      assertPrivilegeDenied
    );

    const runtime = await runtimePool.query<{ current_user: string; is_superuser: boolean }>(
      'SELECT current_user, role.rolsuper AS is_superuser FROM pg_roles AS role WHERE role.rolname = current_user'
    );
    assert.equal(runtime.rows[0]?.current_user, 'giga_api_runtime');
    assert.equal(runtime.rows[0]?.is_superuser, false);
    const grants = await db.pool.query<{
      runtime_settle: boolean; runtime_claim: boolean; runtime_finalize: boolean;
      finalizer_settle: boolean; finalizer_claim: boolean; finalizer_finalize: boolean;
      runtime_resource_update: boolean; runtime_outcome_update: boolean;
      finalizer_table_update: boolean; runtime_is_lifecycle_owner: boolean;
      runtime_is_lifecycle_finalizer: boolean; finalizer_is_lifecycle_owner: boolean;
      lifecycle_owner_run_lease_update: boolean; lifecycle_owner_run_status_update: boolean;
      public_settle_execute: boolean;
      public_claim_execute: boolean; public_finalize_execute: boolean;
      session_owner: string; operation_owner: string; fence_owner: string;
      settle_owner: string; claim_owner: string; finalize_owner: string;
    }>(
      `SELECT
        has_function_privilege('giga_api_runtime', $1, 'EXECUTE') AS runtime_settle,
        has_function_privilege('giga_api_runtime', $2, 'EXECUTE') AS runtime_claim,
        has_function_privilege('giga_api_runtime', $3, 'EXECUTE') AS runtime_finalize,
        has_function_privilege('giga_agent_lifecycle_finalizer', $1, 'EXECUTE') AS finalizer_settle,
        has_function_privilege('giga_agent_lifecycle_finalizer', $2, 'EXECUTE') AS finalizer_claim,
        has_function_privilege('giga_agent_lifecycle_finalizer', $3, 'EXECUTE') AS finalizer_finalize,
        has_column_privilege('giga_api_runtime', 'agent_sandbox_sessions', 'provider_session_id', 'UPDATE') AS runtime_resource_update,
        has_column_privilege('giga_api_runtime', 'agent_sandbox_lifecycle_operations', 'outcome', 'UPDATE') AS runtime_outcome_update,
        has_table_privilege('giga_agent_lifecycle_finalizer', 'agent_sandbox_sessions', 'UPDATE') AS finalizer_table_update,
        pg_has_role('giga_api_runtime', 'giga_agent_lifecycle_owner', 'MEMBER') AS runtime_is_lifecycle_owner,
        pg_has_role('giga_api_runtime', 'giga_agent_lifecycle_finalizer', 'MEMBER') AS runtime_is_lifecycle_finalizer,
        pg_has_role('giga_agent_lifecycle_finalizer', 'giga_agent_lifecycle_owner', 'MEMBER') AS finalizer_is_lifecycle_owner,
        has_column_privilege('giga_agent_lifecycle_owner', 'agent_runs', 'lease_token', 'UPDATE') AS lifecycle_owner_run_lease_update,
        has_column_privilege('giga_agent_lifecycle_owner', 'agent_runs', 'status', 'UPDATE') AS lifecycle_owner_run_status_update,
        EXISTS (
          SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
          WHERE p.oid = to_regprocedure($1)::oid AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
        ) AS public_settle_execute,
        EXISTS (
          SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
          WHERE p.oid = to_regprocedure($2)::oid AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
        ) AS public_claim_execute,
        EXISTS (
          SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
          WHERE p.oid = to_regprocedure($3)::oid AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
        ) AS public_finalize_execute,
        (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'agent_sandbox_sessions'::regclass) AS session_owner,
        (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'agent_sandbox_lifecycle_operations'::regclass) AS operation_owner,
        (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'agent_sandbox_attempt_fences'::regclass) AS fence_owner,
        (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = to_regprocedure($1)::oid) AS settle_owner,
        (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = to_regprocedure($2)::oid) AS claim_owner,
        (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = to_regprocedure($3)::oid) AS finalize_owner`,
      [SETTLE_FUNCTION, CLAIM_FUNCTION, FINALIZE_FUNCTION]
    );
    const row = grants.rows[0]!;
    assert.equal(row.runtime_settle, false);
    assert.equal(row.runtime_claim, false);
    assert.equal(row.runtime_finalize, false);
    assert.equal(row.finalizer_settle, true);
    assert.equal(row.finalizer_claim, true);
    assert.equal(row.finalizer_finalize, true);
    assert.equal(row.runtime_resource_update, false);
    assert.equal(row.runtime_outcome_update, false);
    assert.equal(row.finalizer_table_update, false);
    assert.equal(row.runtime_is_lifecycle_owner, false);
    assert.equal(row.runtime_is_lifecycle_finalizer, false);
    assert.equal(row.finalizer_is_lifecycle_owner, false);
    assert.equal(row.lifecycle_owner_run_lease_update, true);
    assert.equal(row.lifecycle_owner_run_status_update, false);
    assert.equal(row.public_settle_execute, false);
    assert.equal(row.public_claim_execute, false);
    assert.equal(row.public_finalize_execute, false);
    for (const owner of [row.session_owner, row.operation_owner, row.fence_owner, row.settle_owner,
      row.claim_owner, row.finalize_owner]) {
      assert.equal(owner, 'giga_agent_lifecycle_owner');
    }
  });

  it('records provider allocation and destruction through the dedicated role with generation and lease fencing', async () => {
    const identity = await lifecycleFinalizerPool.query<{
      current_user: string; is_superuser: boolean; can_login: boolean; can_inherit: boolean;
    }>(
      'SELECT current_user, role.rolsuper AS is_superuser, role.rolcanlogin AS can_login, ' +
      'role.rolinherit AS can_inherit FROM pg_roles AS role WHERE role.rolname = current_user'
    );
    assert.equal(identity.rows[0]?.current_user, 'giga_agent_lifecycle_finalizer');
    assert.equal(identity.rows[0]?.is_superuser, false);
    assert.equal(identity.rows[0]?.can_login, false);
    assert.equal(identity.rows[0]?.can_inherit, false);

    const { run, claim, session, reference } = await createClaimedRun('provider-callback-worker');
    await repository.beginSandboxAllocationOperation(session.id, session.attemptGeneration);
    const providerId = 'sbx-provider-resource-exact';
    const allocated = await repository.commitSandboxSessionAllocated({
      sessionId: session.id, ownerId, runId: run.id,
      leaseToken: claim.leaseToken, providerSessionId: providerId,
    });
    assert.equal(allocated.providerSessionId, providerId);
    assert.equal(allocated.lifecycleState, 'active');

    const duplicateCallback = await repository.commitSandboxSessionAllocated({
      sessionId: session.id, ownerId, runId: run.id,
      leaseToken: claim.leaseToken, providerSessionId: providerId,
    });
    assert.equal(duplicateCallback.providerSessionId, providerId);
    await assert.rejects(
      settleAllocation(session.id, ownerId, run.id, reference.attemptNumber,
        randomUUID(), 'resource', 'sbx-stale-generation'),
      /generation/i
    );

    const cleanupClaim = await repository.claimSandboxSessionForCleanup({
      sessionId: session.id, workerId: 'trusted-cleanup-worker', leaseToken: 'cleanup-lease-correct', leaseDurationMs: 60_000,
    });
    assert.ok(cleanupClaim);
    await assert.rejects(
      repository.markSandboxDestroyed(session.id, 'sbx-wrong-provider-id', 'cleanup-lease-correct'),
      /identity|mismatch|conflict/i
    );
    await assert.rejects(
      repository.markSandboxDestroyed(session.id, providerId, 'cleanup-lease-wrong'),
      /lease|fenced/i
    );
    const destroyed = await repository.markSandboxDestroyed(session.id, providerId, 'cleanup-lease-correct');
    assert.equal(destroyed.lifecycleState, 'destroyed');
    const duplicateDestroy = await repository.markSandboxDestroyed(session.id, providerId, 'cleanup-lease-correct');
    assert.equal(duplicateDestroy.lifecycleState, 'destroyed');

    const absent = await createClaimedRun('provider-definitive-absence-worker');
    await repository.beginSandboxAllocationOperation(absent.session.id, absent.session.attemptGeneration);
    await repository.markSandboxAllocationAmbiguous(absent.session.id, 'provider returned an ambiguous response');
    await repository.fenceSandboxAttempt(absent.reference, 'provider_absence_test');
    await repository.confirmSandboxAllocationAbsent(absent.session.id, 'provider_reported_not_allocated');
    const absentState = await repository.getSandboxAttemptLifecycle(absent.reference);
    const absentOperation = absentState.operations.find((operation) => operation.kind === 'allocation');
    assert.equal(absentOperation?.state, 'settled');
    assert.equal(absentOperation?.outcome, 'no_resource');
    assert.equal(absentState.session?.lifecycleState, 'failed');

    const late = await createClaimedRun('late-provider-callback-worker');
    await repository.beginSandboxAllocationOperation(late.session.id, late.session.attemptGeneration);
    await repository.fenceSandboxAttempt(late.reference, 'late_callback_test');
    const lateCallback = await repository.commitSandboxSessionAllocated({
      sessionId: late.session.id, ownerId, runId: late.run.id,
      leaseToken: late.claim.leaseToken, providerSessionId: 'sbx-late-original-generation',
    });
    assert.equal(lateCallback.lifecycleState, 'cleanup_pending');
    assert.equal(lateCallback.attemptGeneration, late.session.attemptGeneration);
    assert.equal(lateCallback.providerSessionId, 'sbx-late-original-generation');

    const retrySession = await createClaimedRun('concurrent-cleanup-worker');
    await repository.beginSandboxAllocationOperation(retrySession.session.id, retrySession.session.attemptGeneration);
    await repository.commitSandboxSessionAllocated({
      sessionId: retrySession.session.id, ownerId, runId: retrySession.run.id,
      leaseToken: retrySession.claim.leaseToken, providerSessionId: 'sbx-concurrent-destroy-once',
    });
    let destroyCalls = 0;
    const provider = {
      async destroySandbox() {
        destroyCalls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    } as unknown as CloudSandboxProviderClient;
    const firstWorker = new SandboxCleanupReconciler(repository, provider, { workerId: 'cleanup-a' });
    const secondWorker = new SandboxCleanupReconciler(repository, provider, { workerId: 'cleanup-b' });
    const durable = await repository.getSandboxSession(ownerId, retrySession.session.id);
    const cleanupResults = await Promise.all([
      firstWorker.reconcileSession(durable), secondWorker.reconcileSession(durable),
    ]);
    assert.equal(cleanupResults.filter((result) => result === 'destroyed').length, 1);
    assert.equal(cleanupResults.filter((result) => result === 'skipped').length, 1);
    assert.equal(destroyCalls, 1);
  });

  it('keeps quota held on forged calls and ambiguous provider allocation', async () => {
    const ambiguous = await createClaimedRun('quota-ambiguous-provider-worker');
    const quotaService = new AgentQuotaService(
      runtimePool, DEFAULT_AGENT_QUOTA_POLICY, undefined, quotaFinalizerPool
    );
    await quotaService.reserveExecutionAttempt(ambiguous.reference, ambiguous.claim.leaseToken);
    await quotaService.markAllocationStarted(ambiguous.reference, ambiguous.claim.leaseToken);
    await repository.beginSandboxAllocationOperation(ambiguous.session.id, ambiguous.session.attemptGeneration);
    await repository.markSandboxAllocationAmbiguous(ambiguous.session.id, 'provider response lost');
    await quotaService.markOutcomeUnknown(ambiguous.reference, ambiguous.claim.leaseToken, 'provider:ambiguous');
    await assert.rejects(
      runtimePool.query(
        `SELECT * FROM settle_agent_sandbox_allocation(
          $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid,
          'resource'::varchar, 'sbx-forged-by-runtime'::varchar, $6::varchar)`,
        [ambiguous.session.id, ownerId, ambiguous.run.id, ambiguous.reference.attemptNumber,
          ambiguous.session.attemptGeneration, ambiguous.claim.leaseToken]
      ),
      assertPrivilegeDenied
    );
    const unresolvedProvider = {
      async resolveAllocation() { return { status: 'ambiguous' as const, reason: 'provider cannot prove settlement' }; },
      async destroySandbox() { throw new Error('must not destroy unknown resource'); },
    } as unknown as CloudSandboxProviderClient;
    const unresolvedFence = new SandboxAttemptLifecycleFence(repository, unresolvedProvider, { drainTimeoutMs: 50, pollIntervalMs: 1 });
    await assert.rejects(
      unresolvedFence.fenceAttemptAndVerify(ambiguous.reference),
      /cannot definitively settle allocation|ambiguous/i
    );
    const unresolvedQuotas = new AgentQuotaService(
      runtimePool, DEFAULT_AGENT_QUOTA_POLICY, unresolvedFence, quotaFinalizerPool
    );
    await assert.rejects(
      unresolvedQuotas.reconcileAfterQuiescent(ambiguous.reference, {}, 'quota:ambiguous-must-hold'),
      /durable attempt fence/i
    );
    assert.equal((await unresolvedQuotas.getReservation(ambiguous.reference)).resourceActive, true);
  });

  it('keeps quota held after provider destroy failure and releases it only after the finalizer records success', async () => {
    const quotaService = new AgentQuotaService(
      runtimePool, DEFAULT_AGENT_QUOTA_POLICY, undefined, quotaFinalizerPool
    );
    const allocated = await createClaimedRun('quota-destroy-failure-worker');
    await quotaService.reserveExecutionAttempt(allocated.reference, allocated.claim.leaseToken);
    await quotaService.markAllocationStarted(allocated.reference, allocated.claim.leaseToken);
    await repository.beginSandboxAllocationOperation(allocated.session.id, allocated.session.attemptGeneration);
    await repository.commitSandboxSessionAllocated({
      sessionId: allocated.session.id, ownerId, runId: allocated.run.id,
      leaseToken: allocated.claim.leaseToken, providerSessionId: 'sbx-quota-destroy-retry',
    });
    await quotaService.markOutcomeUnknown(allocated.reference, allocated.claim.leaseToken, 'provider:resource-created');

    let failDestroy = true;
    const recoveringProvider = {
      async resolveAllocation() { return { status: 'allocated' as const, sandboxId: 'sbx-quota-destroy-retry' }; },
      async destroySandbox() {
        if (failDestroy) throw new Error('provider destroy unavailable');
      },
    } as unknown as CloudSandboxProviderClient;
    const lifecycleFence = new SandboxAttemptLifecycleFence(repository, recoveringProvider, { drainTimeoutMs: 50, pollIntervalMs: 1 });
    const quotas = new AgentQuotaService(runtimePool, DEFAULT_AGENT_QUOTA_POLICY, lifecycleFence, quotaFinalizerPool);
    await assert.rejects(
      quotas.reconcileAfterQuiescent(allocated.reference, {}, 'quota:destroy-failure'),
      /not confirmed|cleanup-pending|destroy|fence/i
    );
    assert.equal((await quotas.getReservation(allocated.reference)).resourceActive, true);
    const pending = await repository.getSandboxSession(ownerId, allocated.session.id);
    assert.equal(pending.lifecycleState, 'cleanup_pending');

    failDestroy = false;
    await lifecycleFence.fenceAttemptAndVerify(allocated.reference);
    assert.equal((await repository.getSandboxSession(ownerId, allocated.session.id)).lifecycleState, 'destroyed');
    const finalized = await quotas.reconcileAfterQuiescent(allocated.reference, {}, 'quota:destroy-recovered');
    assert.equal(finalized.resourceActive, false);
    const destroyed = await repository.getSandboxSession(ownerId, allocated.session.id);
    assert.equal(destroyed.lifecycleState, 'destroyed');
    assert.equal((await quotas.getReservation(allocated.reference)).resourceActive, false);
  });
});
