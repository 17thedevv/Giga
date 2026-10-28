import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDbInstance } from '../test-db-helper.js';
import { AgentRepository } from '../../src/modules/agent/repository.js';
import { AgentService } from '../../src/modules/agent/service.js';
import { AgentQuotaError, AgentQuotaService } from '../../src/modules/agent/quota-service.js';
import { DEFAULT_AGENT_QUOTA_POLICY } from '../../src/modules/agent/quota-policy.js';
import { SandboxAttemptLifecycleFence } from '../../src/modules/agent/sandbox-lifecycle-fence.js';
import { SandboxCleanupReconciler } from '../../src/modules/agent/cleanup-reconciler.js';
import {
  IsolatedCloudSandboxAdapter,
  type CloudSandboxProviderClient,
  type CreateSandboxParams,
} from '../../src/modules/agent/sandbox-adapter.js';
import { ConflictError, NotFoundError } from '../../src/modules/auth/auth-validation.js';

class MockCloudSandboxProviderClient implements CloudSandboxProviderClient {
  readonly providerName = 'mock-e2b';
  readonly isRealCloudProvider = true;
  public createdSandboxes: string[] = [];
  public destroyedSandboxes: string[] = [];
  public failDestroyWith?: Error;
  public destroyNotFoundIds: Set<string> = new Set();
  public executeDelayMs = 0;
  public allocationResults = new Map<string, { status: 'pending' } | { status: 'allocated'; sandboxId: string } | { status: 'not_allocated' }>();

  async createSandbox(params: CreateSandboxParams): Promise<{ sandboxId: string; endpoint?: string }> {
    const id = `sbx-mock-${randomUUID().slice(0, 8)}`;
    this.createdSandboxes.push(id);
    if (params.allocationOperationId) {
      this.allocationResults.set(params.allocationOperationId, { status: 'allocated', sandboxId: id });
    }
    return { sandboxId: id, endpoint: `https://${id}.mock.cloud` };
  }

  async resolveAllocation(operationId: string) {
    return this.allocationResults.get(operationId) ?? { status: 'pending' as const };
  }

  async executeCommand(_sandboxId: string, _params: { command: string }) {
    if (this.executeDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.executeDelayMs));
    }
    return { exitCode: 0, stdout: 'ok\n', stderr: '', durationMs: 50 };
  }

  async readFile(_sandboxId: string, _path: string) {
    return { content: 'test content', bytes: 12 };
  }

  async writeFile(_sandboxId: string, _path: string, content: string) {
    return { bytesWritten: content.length };
  }

  async listFiles(_sandboxId: string) {
    return [{ path: 'test.txt', size: 12 }];
  }

  async createSnapshot(_sandboxId: string) {
    return { files: [{ path: 'test.txt', size: 12 }] };
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    if (this.failDestroyWith) {
      throw this.failDestroyWith;
    }
    if (this.destroyNotFoundIds.has(sandboxId)) {
      throw new Error(`Sandbox ${sandboxId} not found (404)`);
    }
    this.destroyedSandboxes.push(sandboxId);
  }
}

describe('GigaAgent Durable Sandbox Sessions & Crash-Safe Cleanup (17T-71)', { timeout: 30000 }, () => {
  let db: TestDbInstance;
  let repo: AgentRepository;
  let service: AgentService;
  let ownerId: string;
  let otherOwnerId: string;
  let workspaceId: string;

  before(async () => {
    db = await createTestDatabase();
  });

  after(async () => {
    await db.cleanup();
    await db.pool.end();
  });

  beforeEach(async () => {
    await db.cleanup();
    repo = new AgentRepository(db.pool);
    service = new AgentService(repo);

    ownerId = randomUUID();
    otherOwnerId = randomUUID();

    await db.pool.query(
      "INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, 'owner@example.com', 'Owner', 'hash')",
      [ownerId]
    );
    await db.pool.query(
      "INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, 'other@example.com', 'Other', 'hash')",
      [otherOwnerId]
    );

    const ws = await service.createWorkspace(ownerId, { source: { kind: 'blank' } });
    workspaceId = ws.id;
  });

  async function createClaimedRun(
    owner: string,
    workspace: string,
    workerId = 'worker-test-1',
    mode: 'ask' | 'plan' | 'execute' = 'execute'
  ) {
    const queued = await repo.enqueueRun(
      owner,
      { workspaceId: workspace, task: 'Test task', mode, runtime: 'cloud', modelId: 'giga-agent-default' },
      randomUUID(),
      'a'.repeat(64)
    );
    const claimed = await repo.claimRun(owner, queued.run.id, workerId);
    assert.ok(claimed);
    return { run: queued.run, claim: claimed };
  }

  describe('1. Allocation Races & Invariants', () => {
    it('PostgreSQL serializes attempt fencing ahead of a concurrent allocation intent', {
      skip: process.env.TEST_DATABASE_URL ? false : 'requires PostgreSQL row-lock semantics',
    }, async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId, 'worker-race');
      const blocker = await db.pool.connect();
      const waitForLockWaiters = async (minimum: number): Promise<void> => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const result = await db.pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
          );
          if (Number(result.rows[0]?.count ?? 0) >= minimum) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Timed out waiting for ${minimum} PostgreSQL row-lock waiters`);
      };

      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT id FROM agent_runs WHERE owner_id = $1 AND workspace_id = $2 AND id = $3 FOR UPDATE',
          [ownerId, workspaceId, run.id]
        );

        // Queue reconciliation first, then allocation behind it on the same run row.
        const fencePromise = repo.fenceSandboxAttempt({
          ownerId, workspaceId, runId: run.id, attemptNumber: claim.attemptCount,
        }, 'deterministic_allocation_race');
        await waitForLockWaiters(1);
        const allocationPromise = repo.createSandboxAllocationIntent({
          ownerId, workspaceId, runId: run.id, attemptNumber: claim.attemptCount,
          mode: 'execute', providerType: 'mock-e2b', workerId: 'worker-race', leaseToken: claim.leaseToken,
        });
        await waitForLockWaiters(2);
        await blocker.query('COMMIT');

        await fencePromise;
        await assert.rejects(allocationPromise, (error: unknown) =>
          error instanceof ConflictError &&
          (error.message.includes('durably fenced') || error.message.includes('Worker fenced')));
        const state = await repo.getSandboxAttemptLifecycle({
          ownerId, workspaceId, runId: run.id, attemptNumber: claim.attemptCount,
        });
        assert.equal(state.fenced, true);
        assert.equal(state.session, null);
      } catch (error) {
        await blocker.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        blocker.release();
      }
    });

    it('concurrent allocation intents: exactly one survivor, second gets duplicate or conflict', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId, 'worker-1');

      // First worker creates allocation intent
      const first = await repo.createSandboxAllocationIntent({
        ownerId,
        workspaceId,
        runId: run.id,
        attemptNumber: 1,
        mode: 'execute',
        providerType: 'e2b',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
      });
      assert.equal(first.duplicate, false);
      assert.equal(first.session.lifecycleState, 'allocating');

      // Same worker retries -> receives identical session with duplicate: true
      const replay = await repo.createSandboxAllocationIntent({
        ownerId,
        workspaceId,
        runId: run.id,
        attemptNumber: 1,
        mode: 'execute',
        providerType: 'e2b',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
      });
      assert.equal(replay.duplicate, true);
      assert.equal(replay.session.id, first.session.id);

      // Different worker attempts allocation while first is active -> throws ConflictError
      await assert.rejects(
        async () => {
          await repo.createSandboxAllocationIntent({
            ownerId,
            workspaceId,
            runId: run.id,
            attemptNumber: 1,
            mode: 'execute',
            providerType: 'e2b',
            workerId: 'worker-2',
            leaseToken: claim.leaseToken,
          });
        },
        ConflictError
      );
    });

    it('allocation rejects terminal runs (completed, failed, cancelled)', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);

      await repo.finalizeRun(ownerId, run.id, claim.leaseToken, {
        status: 'completed',
        summary: 'Finished successfully',
        verifiedChecks: [],
      });

      await assert.rejects(
        async () => {
          await repo.createSandboxAllocationIntent({
            ownerId,
            workspaceId,
            runId: run.id,
            attemptNumber: 1,
            mode: 'execute',
            providerType: 'e2b',
            workerId: 'worker-1',
            leaseToken: claim.leaseToken,
          });
        },
        (err: any) => err instanceof ConflictError && err.message.includes('terminal run')
      );
    });

    it('cross-attempt allocation succeeds after previous attempt destroyed or failed', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);

      // Attempt 1 fails
      const att1 = await repo.createSandboxAllocationIntent({
        ownerId,
        workspaceId,
        runId: run.id,
        attemptNumber: 1,
        mode: 'execute',
        providerType: 'e2b',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
      });
      await repo.recordSandboxAllocationFailed(att1.session.id, 'Provider capacity exceeded');

      // Retry advances the durable run attempt and obtains a new lease token.
      await db.pool.query("UPDATE agent_runs SET lease_expires_at = NOW() - interval '1 second' WHERE id = $1", [run.id]);
      const claim2 = await repo.claimRun(ownerId, run.id, 'worker-1');
      assert.ok(claim2);

      // Attempt 2 can now allocate successfully
      const att2 = await repo.createSandboxAllocationIntent({
        ownerId,
        workspaceId,
        runId: run.id,
        attemptNumber: 2,
        mode: 'execute',
        providerType: 'e2b',
        workerId: 'worker-1',
        leaseToken: claim2.leaseToken,
      });
      assert.equal(att2.duplicate, false);
      assert.equal(att2.session.attemptNumber, 2);
      assert.equal(att2.session.lifecycleState, 'allocating');
    });
  });

  describe('2. Crash Windows & Orphan Prevention', () => {
    it('worker crashes before provider submission: expired intent is fenced and safely settled as resource-free', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);
      const provider = new MockCloudSandboxProviderClient();
      const reconciler = new SandboxCleanupReconciler(repo, provider);

      // Create an expired allocation intent whose durable provider operation never started.
      const { session } = await repo.createSandboxAllocationIntent({
        ownerId,
        workspaceId,
        runId: run.id,
        attemptNumber: 1,
        mode: 'execute',
        providerType: 'e2b',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
        allocationTimeoutMs: -1000,
      });

      assert.equal(session.lifecycleState, 'allocating');

      // Run reconciler pass
      const result = await reconciler.reconcileBatch();
      assert.equal(result.processed, 1);
      assert.equal(result.timedOutAllocations, 1);

      // Session is now failed with crashSuspected diagnostics
      const updated = await repo.getSandboxSession(ownerId, session.id);
      assert.equal(updated.lifecycleState, 'failed');
      assert.equal(updated.allocationState, 'failed');
      assert.equal(updated.diagnostics['crashSuspected'], true);
    });

    it('worker crashes after provider allocation before DB commit: provider lookup recovers the late ID and cleanup', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);
      const provider = new MockCloudSandboxProviderClient();
      const reconciler = new SandboxCleanupReconciler(repo, provider);

      // Allocation intent created
      const { session } = await repo.createSandboxAllocationIntent({
        ownerId,
        workspaceId,
        runId: run.id,
        attemptNumber: 1,
        mode: 'execute',
        providerType: 'e2b',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
      });

      assert.equal(await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration), true);
      const { sandboxId: orphanSandboxId } = await provider.createSandbox({
        workspaceId, ownerId, timeoutMs: 1000,
        networkPolicy: { egressEnabled: false, allowlist: [] },
        allocationOperationId: session.allocationIntentId,
        attemptGeneration: session.attemptGeneration,
      });
      await db.pool.query("UPDATE agent_sandbox_sessions SET allocation_expires_at = NOW() - interval '1 second' WHERE id = $1", [session.id]);

      // Reconciler runs
      const result = await reconciler.reconcileBatch();
      assert.equal(result.destroyed, 1);
      assert.ok(provider.destroyedSandboxes.includes(orphanSandboxId));

      const finalSession = await repo.getSandboxSession(ownerId, session.id);
      assert.equal(finalSession.lifecycleState, 'destroyed');
      assert.equal(finalSession.cleanupState, 'completed');
    });

    it('worker crashes while stopping/destroying: reconciler sweeps and completes destruction', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);
      const provider = new MockCloudSandboxProviderClient();
      const reconciler = new SandboxCleanupReconciler(repo, provider);

      const { session } = await repo.createSandboxAllocationIntent({
        ownerId,
        workspaceId,
        runId: run.id,
        attemptNumber: 1,
        mode: 'execute',
        providerType: 'e2b',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
      });

      await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);

      const active = await repo.commitSandboxSessionAllocated({
        sessionId: session.id,
        ownerId,
        runId: run.id,
        leaseToken: claim.leaseToken,
        providerSessionId: 'sbx-stopping-crash',
      });

      // Mark stopping before crash
      await repo.markSandboxStopping(ownerId, active.id);

      // Finalize run to trigger orphan cleanup
      await repo.finalizeRun(ownerId, run.id, claim.leaseToken, {
        status: 'cancelled',
      });

      // Reconciler sweeps stopping session
      const result = await reconciler.reconcileBatch();
      assert.equal(result.destroyed, 1);
      assert.ok(provider.destroyedSandboxes.includes('sbx-stopping-crash'));

      const tombstone = await repo.getSandboxSession(ownerId, session.id);
      assert.equal(tombstone.lifecycleState, 'destroyed');
      assert.ok(tombstone.destroyedAt !== null);
    });
  });

  describe('3. Late Callbacks & Worker Lease Fencing', () => {
    it('late callback after lease expiry is persisted against the original attempt and cannot become active', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);

      const { session } = await repo.createSandboxAllocationIntent({
        ownerId,
        workspaceId,
        runId: run.id,
        attemptNumber: 1,
        mode: 'execute',
        providerType: 'e2b',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
      });
      await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);

      // Force lease expiration in database
      await db.pool.query(
        "UPDATE agent_runs SET lease_expires_at = NOW() - interval '1 second' WHERE id = $1",
        [run.id]
      );

      // Late provider callback arrives
      const lateCommit = await repo.commitSandboxSessionAllocated({
        sessionId: session.id,
        ownerId,
        runId: run.id,
        leaseToken: claim.leaseToken,
        providerSessionId: 'sbx-late-callback',
      });

      // Check session was automatically transitioned to cleanup_pending
      const fencedSession = await repo.getSandboxSession(ownerId, session.id);
      assert.equal(fencedSession.lifecycleState, 'cleanup_pending');
      assert.equal(fencedSession.cleanupState, 'pending');
      assert.equal(fencedSession.providerSessionId, 'sbx-late-callback');
      assert.equal(fencedSession.diagnostics['fence_reason'], 'late_or_stale_allocation_callback');
      assert.equal(lateCommit.lifecycleState, 'cleanup_pending');
    });

    it('lease takeover waits for ambiguous allocation, then late result is cleaned before a new attempt', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId, 'worker-1');

      const { session } = await repo.createSandboxAllocationIntent({
        ownerId,
        workspaceId,
        runId: run.id,
        attemptNumber: 1,
        mode: 'execute',
        providerType: 'e2b',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
      });
      await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);

      // Expired lease is fenced, but replacement claim waits while provider outcome
      // is unresolved. This prevents the old sandbox and a new sandbox overlapping.
      await db.pool.query(
        "UPDATE agent_runs SET lease_expires_at = NOW() - interval '1 second' WHERE id = $1",
        [run.id]
      );
      assert.equal(await repo.claimRun(ownerId, run.id, 'worker-2'), null);
      const afterFence = await repo.getSandboxAttemptLifecycle({
        ownerId, workspaceId, runId: run.id, attemptNumber: 1,
      });
      assert.equal(afterFence.fenced, true);

      // A late result remains associated with attempt 1 and is routed to cleanup.
      const lateCommit = await repo.commitSandboxSessionAllocated({
        sessionId: session.id,
        ownerId,
        runId: run.id,
        leaseToken: claim.leaseToken, // Old fenced lease token!
        providerSessionId: 'sbx-stolen-lease',
      });

      const fenced = await repo.getSandboxSession(ownerId, session.id);
      assert.equal(fenced.lifecycleState, 'cleanup_pending');
      assert.equal(fenced.providerSessionId, 'sbx-stolen-lease');
      assert.equal(lateCommit.attemptGeneration, session.attemptGeneration);

      const provider = new MockCloudSandboxProviderClient();
      const reconciler = new SandboxCleanupReconciler(repo, provider);
      assert.equal(await reconciler.reconcileSession(fenced), 'destroyed');
      assert.deepEqual(provider.destroyedSandboxes, ['sbx-stolen-lease']);

      const claim2 = await repo.claimRun(ownerId, run.id, 'worker-2');
      assert.ok(claim2);
      assert.equal(claim2.attemptCount, 2);
    });
  });

  describe('4. Durable Reconciler & Idempotent Cleanup', () => {
    it('reconciler treats 404 / NOT FOUND as idempotent destruction success', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);
      const provider = new MockCloudSandboxProviderClient();
      provider.destroyNotFoundIds.add('sbx-already-dead');
      const reconciler = new SandboxCleanupReconciler(repo, provider);

      const { session } = await repo.createSandboxAllocationIntent({
        ownerId,
        workspaceId,
        runId: run.id,
        attemptNumber: 1,
        mode: 'execute',
        providerType: 'e2b',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
      });

      await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);

      await repo.commitSandboxSessionAllocated({
        sessionId: session.id,
        ownerId,
        runId: run.id,
        leaseToken: claim.leaseToken,
        providerSessionId: 'sbx-already-dead',
      });

      await repo.markSandboxCleanupPending(session.id, 'orphan_sweep', 0);

      const result = await reconciler.reconcileBatch();
      assert.equal(result.destroyed, 1);

      const finalSession = await repo.getSandboxSession(ownerId, session.id);
      assert.equal(finalSession.lifecycleState, 'destroyed');
      assert.equal(finalSession.cleanupState, 'completed');
    });

    it('reconciler handles transient provider errors with exponential backoff and attempt counter', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);
      const provider = new MockCloudSandboxProviderClient();
      provider.failDestroyWith = new Error('503 Service Unavailable: connection reset');
      const reconciler = new SandboxCleanupReconciler(repo, provider, {
        baseBackoffMs: 200,
        maxBackoffMs: 2000,
        maxCleanupAttempts: 3,
      });

      const { session } = await repo.createSandboxAllocationIntent({
        ownerId,
        workspaceId,
        runId: run.id,
        attemptNumber: 1,
        mode: 'execute',
        providerType: 'e2b',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
      });

      await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);

      await repo.commitSandboxSessionAllocated({
        sessionId: session.id,
        ownerId,
        runId: run.id,
        leaseToken: claim.leaseToken,
        providerSessionId: 'sbx-transient-fail',
      });

      await db.pool.query(
        "UPDATE agent_sandbox_sessions SET lifecycle_state = 'cleanup_pending', cleanup_state = 'pending', cleanup_attempts = 0 WHERE id = $1",
        [session.id]
      );

      // Pass 1: fails and schedules retry
      const res1 = await reconciler.reconcileBatch();
      assert.equal(res1.retried, 1);

      const after1 = await repo.getSandboxSession(ownerId, session.id);
      assert.equal(after1.cleanupAttempts, 1);
      assert.equal(after1.cleanupState, 'retry_scheduled');
      assert.ok(after1.nextCleanupRetryAt !== null);

      // Immediate pass: should NOT pick it up because next_cleanup_retry_at is in the future
      const resSkip = await reconciler.reconcileBatch();
      assert.equal(resSkip.processed, 0);

      // Fast forward next_cleanup_retry_at to past
      await db.pool.query(
        "UPDATE agent_sandbox_sessions SET next_cleanup_retry_at = NOW() - interval '1 second' WHERE id = $1",
        [session.id]
      );

      // Pass 2: retried again
      const res2 = await reconciler.reconcileBatch();
      assert.equal(res2.retried, 1);

      const after2 = await repo.getSandboxSession(ownerId, session.id);
      assert.equal(after2.cleanupAttempts, 2);

      // Fast forward again for pass 3
      await db.pool.query(
        "UPDATE agent_sandbox_sessions SET next_cleanup_retry_at = NOW() - interval '1 second' WHERE id = $1",
        [session.id]
      );

      // Pass 3: exceeds maxCleanupAttempts (3) -> marked failed
      const res3 = await reconciler.reconcileBatch();
      assert.equal(res3.failed, 1);

      const after3 = await repo.getSandboxSession(ownerId, session.id);
      assert.equal(after3.cleanupAttempts, 3);
      assert.equal(after3.lifecycleState, 'cleanup_pending');
      assert.ok(String(after3.diagnostics['last_cleanup_error']).includes('Max cleanup attempts (3) exceeded'));
    });

    it('reconciler bounded batching processes only up to batchSize items', async () => {
      const provider = new MockCloudSandboxProviderClient();
      const reconciler = new SandboxCleanupReconciler(repo, provider, { batchSize: 2 });

      // Create 3 sessions needing cleanup
      for (let i = 0; i < 3; i++) {
        const { run, claim } = await createClaimedRun(ownerId, workspaceId);
        const { session } = await repo.createSandboxAllocationIntent({
          ownerId,
          workspaceId,
          runId: run.id,
          attemptNumber: 1,
          mode: 'execute',
          providerType: 'e2b',
          workerId: 'worker-1',
          leaseToken: claim.leaseToken,
        });
        await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);
        await repo.commitSandboxSessionAllocated({
          sessionId: session.id,
          ownerId,
          runId: run.id,
          leaseToken: claim.leaseToken,
          providerSessionId: `sbx-batch-${i}`,
        });
        await repo.markSandboxCleanupPending(session.id, 'batch_test', 0);
      }

      // First batch processes at most 2
      const batch1 = await reconciler.reconcileBatch(2);
      assert.equal(batch1.processed, 2);
      assert.equal(batch1.destroyed, 2);

      // Second batch processes the remaining 1
      const batch2 = await reconciler.reconcileBatch(2);
      assert.equal(batch2.processed, 1);
      assert.equal(batch2.destroyed, 1);
    });
  });

  describe('5. Tenant Boundary & Immutability Security', () => {
    it('cross-owner query via getSandboxSession rejects with NotFoundError', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);
      const { session } = await repo.createSandboxAllocationIntent({
        ownerId,
        workspaceId,
        runId: run.id,
        attemptNumber: 1,
        mode: 'execute',
        providerType: 'e2b',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
      });

      // querying by different owner returns NotFoundError
      await assert.rejects(
        async () => {
          await repo.getSandboxSession(otherOwnerId, session.id);
        },
        NotFoundError
      );
    });

    it('cross-workspace allocation attempt rejected with NotFoundError or ConflictError', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);
      const otherWs = await service.createWorkspace(ownerId, { source: { kind: 'blank' } });

      await assert.rejects(
        async () => {
          await repo.createSandboxAllocationIntent({
            ownerId,
            workspaceId: otherWs.id, // Mismatched workspace!
            runId: run.id,
            attemptNumber: 1,
            mode: 'execute',
            providerType: 'e2b',
            workerId: 'worker-1',
            leaseToken: claim.leaseToken,
          });
        },
        NotFoundError
      );
    });

    it('destroyed session cannot be revived (immutable tombstone)', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);
      const { session } = await repo.createSandboxAllocationIntent({
        ownerId,
        workspaceId,
        runId: run.id,
        attemptNumber: 1,
        mode: 'execute',
        providerType: 'e2b',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
      });

      await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);
      await repo.commitSandboxSessionAllocated({
        sessionId: session.id, ownerId, runId: run.id, leaseToken: claim.leaseToken,
        providerSessionId: 'sbx-tombstone',
      });
      const destroyed = await repo.markSandboxDestroyed(session.id, 'sbx-tombstone');
      assert.equal(destroyed.lifecycleState, 'destroyed');

      await assert.rejects(
        async () => {
          await db.pool.query(
            "UPDATE agent_sandbox_sessions SET lifecycle_state = 'active' WHERE id = $1",
            [destroyed.id]
          );
        },
        /cannot modify destroyed sandbox session|terminal and immutable|check constraint/i
      );
    });

    it('diagnostics and error reasons redact sensitive tokens and credentials', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);
      const { session } = await repo.createSandboxAllocationIntent({
        ownerId,
        workspaceId,
        runId: run.id,
        attemptNumber: 1,
        mode: 'execute',
        providerType: 'e2b',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
      });

      // Record failure with sensitive credentials
      const failed = await repo.recordSandboxAllocationFailed(
        session.id,
        'Auth failed with token e2b_555555555555555555555555555555555555 and password Bearer supersecrettoken123',
        { apiKey: 'e2b_666666666666666666666666666666666666' }
      );

      assert.equal(failed.lifecycleState, 'failed');
      const diagStr = JSON.stringify(failed.diagnostics);
      assert.ok(!diagStr.includes('e2b_555555555555555555555555555555555555'));
      assert.ok(!diagStr.includes('e2b_666666666666666666666666666666666666'));
      assert.ok(diagStr.includes('[REDACTED]'));
    });
  });

  describe('6. Adapter Integration & Execution Flow', () => {
    it('IsolatedCloudSandboxAdapter with repository persists allocating intent and commits active session on prepare', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);
      const provider = new MockCloudSandboxProviderClient();
      const adapter = new IsolatedCloudSandboxAdapter({
        providerClient: provider,
        repository: repo,
      });

      const prep = await adapter.prepare({
        runId: run.id,
        workspaceId,
        ownerId,
        mode: 'execute',
        task: 'Execute test with adapter',
        modelId: 'giga-agent-default',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
        attemptNumber: 1,
        signal: new AbortController().signal,
      });

      assert.equal(prep.available, true);
      assert.ok(prep.sessionId);

      // Verify session was persisted in PostgreSQL
      const persisted = await repo.getActiveSandboxSessionForRun(ownerId, run.id);
      assert.ok(persisted);
      assert.equal(persisted.lifecycleState, 'active');
      assert.equal(persisted.providerType, 'mock-e2b');
      assert.equal(persisted.providerSessionId, provider.createdSandboxes[0]);

      // Adapter getSession retrieves state matching DB
      const sessionState = await adapter.getSession(prep.sessionId);
      assert.ok(sessionState);
      assert.equal(sessionState.active, true);
      assert.equal(sessionState.sessionId, prep.sessionId);

      // Step execution works through adapter
      const execResult = await adapter.invoke(
        prep.sessionId,
        {
          toolCallId: 'call-1',
          toolName: 'run_command',
          risk: 'sandbox_execute',
          args: { command: 'echo hello' },
        },
        new AbortController().signal
      );
      assert.equal(execResult.success, true);

      // Stop destroys the remote sandbox and records destroyed tombstone
      await adapter.stop(prep.sessionId);
      const destroyedSession = await repo.getSandboxSession(ownerId, persisted.id);
      assert.equal(destroyedSession.lifecycleState, 'destroyed');
      assert.ok(provider.destroyedSandboxes.includes(persisted.providerSessionId!));

      // Subsequent invoke fails because session is terminated
      const postStop = await adapter.invoke(
        prep.sessionId,
        {
          toolCallId: 'call-2',
          toolName: 'run_command',
          risk: 'sandbox_execute',
          args: { command: 'echo hello' },
        },
        new AbortController().signal
      );
      assert.equal(postStop.success, false);
      assert.equal(postStop.errorCode, 'SESSION_NOT_FOUND');
    });
  });

  describe('7. Concurrency & Robustness Scenarios (17T-71 Acceptance)', () => {
    it('mode mismatch between run mode and requested allocation mode throws ConflictError', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId, 'worker-1', 'ask');

      // Attempting to allocate 'execute' sandbox for an 'ask' run must fail closed
      await assert.rejects(
        async () => {
          await repo.createSandboxAllocationIntent({
            ownerId,
            workspaceId,
            runId: run.id,
            attemptNumber: 1,
            mode: 'execute', // Mismatched mode!
            providerType: 'e2b',
            workerId: 'worker-1',
            leaseToken: claim.leaseToken,
          });
        },
        (err: any) => err instanceof ConflictError && err.message.includes('MODE_MISMATCH')
      );
    });

    it('abort followed by failed destroy, then successful reconciliation retry', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);
      const provider = new MockCloudSandboxProviderClient();
      const reconciler = new SandboxCleanupReconciler(repo, provider);
      const adapter = new IsolatedCloudSandboxAdapter({
        providerClient: provider,
        repository: repo,
      });

      const prep = await adapter.prepare({
        runId: run.id,
        workspaceId,
        ownerId,
        mode: 'execute',
        task: 'Execute test with abort failure',
        modelId: 'giga-agent-default',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
        attemptNumber: 1,
        signal: new AbortController().signal,
      });

      assert.equal(prep.available, true);
      const activeSession = await repo.getActiveSandboxSessionForRun(ownerId, run.id);
      assert.ok(activeSession);

      // Simulate provider outage during stop/destroy
      provider.failDestroyWith = new Error('503 Service Unavailable: connection reset');

      // Adapter stop fails due to provider outage, but records cleanup_pending in PostgreSQL
      await assert.rejects(
        async () => {
          await adapter.stop(prep.sessionId!);
        },
        /503 Service Unavailable/
      );

      // Session must be in cleanup_pending state
      const pendingSession = await repo.getSandboxSession(ownerId, activeSession.id);
      assert.equal(pendingSession.lifecycleState, 'cleanup_pending');
      assert.equal(pendingSession.cleanupState, 'retry_scheduled');

      // Provider recovers
      provider.failDestroyWith = undefined;

      // Fast forward next_cleanup_retry_at to past so reconciler sweeps it
      await db.pool.query(
        "UPDATE agent_sandbox_sessions SET next_cleanup_retry_at = NOW() - interval '1 second' WHERE id = $1",
        [activeSession.id]
      );

      // Reconciler runs and sweeps cleanup_pending session
      const result = await reconciler.reconcileBatch();
      assert.equal(result.destroyed, 1);

      // Session is now confirmed destroyed
      const finalSession = await repo.getSandboxSession(ownerId, activeSession.id);
      assert.equal(finalSession.lifecycleState, 'destroyed');
      assert.equal(finalSession.cleanupState, 'completed');
      assert.ok(provider.destroyedSandboxes.includes(activeSession.providerSessionId!));
    });

    it('two concurrent reconciliation workers safely arbitrate multiple pending cleanups without duplicate destruction', async () => {
      const provider = new MockCloudSandboxProviderClient();
      const reconcilerA = new SandboxCleanupReconciler(repo, provider, { batchSize: 5 });
      const reconcilerB = new SandboxCleanupReconciler(repo, provider, { batchSize: 5 });

      // Create 4 sessions needing cleanup
      for (let i = 0; i < 4; i++) {
        const { run, claim } = await createClaimedRun(ownerId, workspaceId);
        const { session } = await repo.createSandboxAllocationIntent({
          ownerId,
          workspaceId,
          runId: run.id,
          attemptNumber: 1,
          mode: 'execute',
          providerType: 'e2b',
          workerId: 'worker-1',
          leaseToken: claim.leaseToken,
        });
        await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);
        await repo.commitSandboxSessionAllocated({
          sessionId: session.id,
          ownerId,
          runId: run.id,
          leaseToken: claim.leaseToken,
          providerSessionId: `sbx-concurrent-sweep-${i}`,
        });
        await repo.markSandboxCleanupPending(session.id, 'concurrency_test', 0);
      }

      // Hold the first provider destruction until the other worker has also
      // claimed work. This makes the overlap deterministic instead of relying
      // on scheduler timing between the two batches.
      const destroyProviderSandbox = provider.destroySandbox.bind(provider);
      let releaseDestroyBarrier!: () => void;
      const destroyBarrier = new Promise<void>((resolve) => {
        releaseDestroyBarrier = resolve;
      });
      let destroyRequests = 0;
      provider.destroySandbox = async (sandboxId) => {
        destroyRequests++;
        if (destroyRequests === 2) releaseDestroyBarrier();
        await destroyBarrier;
        await destroyProviderSandbox(sandboxId);
      };

      // Run both reconcilers concurrently
      const [resA, resB] = await Promise.all([
        reconcilerA.reconcileBatch(5),
        reconcilerB.reconcileBatch(5),
      ]);

      // Total destroyed across both workers must equal exactly 4
      assert.equal(resA.destroyed + resB.destroyed, 4);
      // No duplicate destroy calls at provider
      assert.equal(provider.destroyedSandboxes.length, 4,
        `Expected four provider destroy calls, got: ${provider.destroyedSandboxes.join(', ')}`);
      assert.equal(new Set(provider.destroyedSandboxes).size, 4,
        `Expected distinct provider IDs, got: ${provider.destroyedSandboxes.join(', ')}`);
    });

    it('two workers concurrently preparing the same run via IsolatedCloudSandboxAdapter', {
      skip: process.env.TEST_DATABASE_URL ? false : 'requires PostgreSQL row-lock semantics',
    }, async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);
      const provider = new MockCloudSandboxProviderClient();
      const adapter = new IsolatedCloudSandboxAdapter({
        providerClient: provider,
        repository: repo,
      });

      // Worker 1 and Worker 2 both call prepare on the same run
      const [prep1, prep2] = await Promise.allSettled([
        adapter.prepare({
          runId: run.id,
          workspaceId,
          ownerId,
          mode: 'execute',
          task: 'Concurrent prepare test',
          modelId: 'giga-agent-default',
          workerId: 'worker-1',
          leaseToken: claim.leaseToken,
          attemptNumber: 1,
          signal: new AbortController().signal,
        }),
        adapter.prepare({
          runId: run.id,
          workspaceId,
          ownerId,
          mode: 'execute',
          task: 'Concurrent prepare test',
          modelId: 'giga-agent-default',
          workerId: 'worker-2',
          leaseToken: claim.leaseToken,
          attemptNumber: 1,
          signal: new AbortController().signal,
        }),
      ]);

      // Exactly one succeeds with a writable active session, or both coordinate safely
      const successes = [prep1, prep2].filter((r) => r.status === 'fulfilled' && (r as PromiseFulfilledResult<any>).value.available);
      // Never allocates duplicate writable sessions at provider
      assert.equal(provider.createdSandboxes.length, 1);
      assert.ok(successes.length >= 1);
    });
  });

  describe('8. Independent Review Remediation Tests (Review Criteria A - G)', () => {
    it('Criterion A: fails closed without allocating remote sandbox when persistence is unavailable', async () => {
      const provider = new MockCloudSandboxProviderClient();
      // Adapter configured without repository and without allowInMemoryFallback
      const adapter = new IsolatedCloudSandboxAdapter({
        providerClient: provider,
      });

      const ac = new AbortController();
      const prep = await adapter.prepare({
        runId: randomUUID(),
        workspaceId,
        ownerId,
        mode: 'execute',
        task: 'Fail closed persistence test',
        modelId: 'giga-agent-default',
        workerId: 'worker-1',
        attemptNumber: 1,
        signal: ac.signal,
      });

      assert.equal(prep.available, false);
      assert.equal(prep.code, 'RUNTIME_UNAVAILABLE');
      assert.ok(prep.reason?.includes('persistence is unavailable'));
      // Invariant: ZERO remote sandbox allocations
      assert.equal(provider.createdSandboxes.length, 0);
    });

    it('Criterion B: post-allocation abort with failed provider destroy preserves session in cleanup_pending', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);
      const provider = new MockCloudSandboxProviderClient();
      const adapter = new IsolatedCloudSandboxAdapter({
        providerClient: provider,
        repository: repo,
      });

      // Provider destroy will fail with 503
      provider.failDestroyWith = new Error('503 Service Unavailable: network error during abort destroy');

      const abortCtrl = new AbortController();

      // Hook into createSandbox to abort before prepare completes
      const origCreate = provider.createSandbox.bind(provider);
      provider.createSandbox = async (params) => {
        const res = await origCreate(params);
        abortCtrl.abort(); // Signal aborted immediately after creation
        return res;
      };

      const prep = await adapter.prepare({
        runId: run.id,
        workspaceId,
        ownerId,
        mode: 'execute',
        task: 'Post-allocation abort failure test',
        modelId: 'giga-agent-default',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
        attemptNumber: 1,
        signal: abortCtrl.signal,
      });

      assert.equal(prep.available, false);
      assert.equal(prep.code, 'RUNTIME_UNAVAILABLE');

      // The created sandbox ID must NOT be marked destroyed since destroy failed!
      const activeOrPending = await repo.getSandboxSessionById(
        (await db.pool.query<{ id: string }>('SELECT id FROM agent_sandbox_sessions WHERE run_id = $1', [run.id])).rows[0]!.id
      );
      assert.ok(activeOrPending);
      assert.equal(activeOrPending.lifecycleState, 'cleanup_pending');
      assert.equal(activeOrPending.cleanupState, 'retry_scheduled');
      assert.equal(activeOrPending.providerSessionId, provider.createdSandboxes[0]);
      assert.ok(activeOrPending.destroyedAt === null);

      // Now recover provider and run reconciler:
      provider.failDestroyWith = undefined;
      await db.pool.query("UPDATE agent_sandbox_sessions SET next_cleanup_retry_at = NOW() - interval '1 second' WHERE id = $1", [activeOrPending.id]);

      const reconciler = new SandboxCleanupReconciler(repo, provider);
      const result = await reconciler.reconcileBatch();
      assert.equal(result.destroyed, 1);

      const reconciled = await repo.getSandboxSessionById(activeOrPending.id);
      assert.equal(reconciled?.lifecycleState, 'destroyed');
      assert.equal(reconciled?.cleanupState, 'completed');
    });

    it('Criterion C: worker crash during cleanup is recovered by second worker after lease expiry, fencing the stale worker', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);
      const { session } = await repo.createSandboxAllocationIntent({
        ownerId,
        workspaceId,
        runId: run.id,
        attemptNumber: 1,
        mode: 'execute',
        providerType: 'mock-e2b',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
      });

      await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);

      await repo.commitSandboxSessionAllocated({
        sessionId: session.id,
        ownerId,
        runId: run.id,
        leaseToken: claim.leaseToken,
        providerSessionId: 'sbx-lease-fence-1',
      });

      await repo.markSandboxCleanupPending(session.id, 'Initial cleanup need', 0);

      // Worker 1 claims cleanup with lease duration of 1000ms
      const claim1 = await repo.claimSandboxSessionForCleanup({
        sessionId: session.id,
        workerId: 'reconciler-worker-1',
        leaseToken: 'lease-token-1',
        leaseDurationMs: 1000,
      });
      assert.ok(claim1);
      assert.equal(claim1.cleanupState, 'in_progress');
      assert.equal(claim1.cleanupLeaseToken, 'lease-token-1');

      // Worker 2 attempts to claim immediately: must fail because lease is active
      const claim2Immediate = await repo.claimSandboxSessionForCleanup({
        sessionId: session.id,
        workerId: 'reconciler-worker-2',
        leaseToken: 'lease-token-2',
      });
      assert.equal(claim2Immediate, null);

      // Simulate Worker 1 crashing: fast forward lease expiration into the past
      await db.pool.query(
        "UPDATE agent_sandbox_sessions SET cleanup_lease_expires_at = NOW() - interval '1 second' WHERE id = $1",
        [session.id]
      );

      // Worker 2 reclaims the expired claim
      const claim2Reclaimed = await repo.claimSandboxSessionForCleanup({
        sessionId: session.id,
        workerId: 'reconciler-worker-2',
        leaseToken: 'lease-token-2',
      });
      assert.ok(claim2Reclaimed);
      assert.equal(claim2Reclaimed.cleanupLeaseToken, 'lease-token-2');

      // Worker 2 completes destruction
      await repo.markSandboxDestroyed(session.id, 'sbx-lease-fence-1', 'lease-token-2');

      const destroyedSession = await repo.getSandboxSession(ownerId, session.id);
      assert.equal(destroyedSession.lifecycleState, 'destroyed');

      // Stale Worker 1 wakes up late and tries to record cleanup retry with old leaseToken-1: fenced!
      await repo.markSandboxCleanupPending(session.id, 'Stale retry from worker 1', 5000, 'lease-token-1');

      // Invariant: session MUST remain destroyed; stale worker was fenced!
      const afterStaleAttempt = await repo.getSandboxSession(ownerId, session.id);
      assert.equal(afterStaleAttempt.lifecycleState, 'destroyed');
      assert.equal(afterStaleAttempt.cleanupState, 'completed');
    });

    it('Criterion E: prevent overlapping allocations - new attempt rejected while previous session is in cleanup_pending', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);
      const { session } = await repo.createSandboxAllocationIntent({
        ownerId,
        workspaceId,
        runId: run.id,
        attemptNumber: 1,
        mode: 'execute',
        providerType: 'mock-e2b',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
      });

      await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);

      await repo.commitSandboxSessionAllocated({
        sessionId: session.id,
        ownerId,
        runId: run.id,
        leaseToken: claim.leaseToken,
        providerSessionId: 'sbx-overlap-1',
      });

      // Session 1 is in cleanup_pending (remote sandbox still exists)
      await repo.markSandboxCleanupPending(session.id, 'Worker 1 died', 5000);

      // Attempt 2 tries to allocate a new sandbox for this run: MUST be rejected!
      await assert.rejects(
        async () => {
          await repo.createSandboxAllocationIntent({
            ownerId,
            workspaceId,
            runId: run.id,
            attemptNumber: 2,
            mode: 'execute',
            providerType: 'mock-e2b',
            workerId: 'worker-2',
            leaseToken: claim.leaseToken,
          });
        },
        (err: any) => err instanceof ConflictError && err.message.includes('SANDBOX_RESOURCE_EXISTS')
      );

      // Now cleanup finishes for Session 1
      await repo.markSandboxDestroyed(session.id, 'sbx-overlap-1');

      // Now attempt 2 can allocate after the old resource is destroyed and a new
      // durable run lease advances the attempt counter.
      await db.pool.query(
        "UPDATE agent_runs SET lease_expires_at = NOW() - interval '1 second' WHERE id = $1", [run.id]
      );
      const claim2 = await repo.claimRun(ownerId, run.id, 'worker-2');
      assert.ok(claim2);
      const intent2 = await repo.createSandboxAllocationIntent({
        ownerId,
        workspaceId,
        runId: run.id,
        attemptNumber: 2,
        mode: 'execute',
        providerType: 'mock-e2b',
        workerId: 'worker-2',
        leaseToken: claim2.leaseToken,
      });
      assert.ok(intent2.session);
      assert.equal(intent2.session.attemptNumber, 2);
      assert.equal(intent2.session.lifecycleState, 'allocating');
    });

    it('Criterion G: repeated markSandboxDestroyed preserves original destroyed_at and parent run cascade deletes session', async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId);
      const { session } = await repo.createSandboxAllocationIntent({
        ownerId,
        workspaceId,
        runId: run.id,
        attemptNumber: 1,
        mode: 'execute',
        providerType: 'mock-e2b',
        workerId: 'worker-1',
        leaseToken: claim.leaseToken,
      });

      await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);
      await repo.commitSandboxSessionAllocated({
        sessionId: session.id, ownerId, runId: run.id, leaseToken: claim.leaseToken,
        providerSessionId: 'sbx-tombstone-1',
      });
      const destroyed1 = await repo.markSandboxDestroyed(session.id, 'sbx-tombstone-1');
      assert.ok(destroyed1.destroyedAt);
      const originalDestroyedAt = destroyed1.destroyedAt;

      // Small delay
      await new Promise((r) => setTimeout(r, 10));

      // Repeated markSandboxDestroyed must succeed idempotently and preserve original timestamp
      const destroyed2 = await repo.markSandboxDestroyed(session.id, 'sbx-tombstone-1');
      assert.equal(destroyed2.destroyedAt, originalDestroyedAt);

      // Parent run deletion cascades and removes session audit row
      await db.pool.query('DELETE FROM agent_runs WHERE id = $1', [run.id]);
      if (db.isMemory) {
        // pg-mem lacks native foreign key CASCADE enforcement; emulate cascade in memory
        await db.pool.query('DELETE FROM agent_sandbox_sessions WHERE id = $1', [session.id]);
      }
      const sessionAfterCascade = await repo.getSandboxSessionById(session.id);
      assert.equal(sessionAfterCascade, null);
    });
  });

  describe('9. Quota and exact-attempt lifecycle integration', () => {
    it('keeps PostgreSQL writable capacity held while provider allocation remains ambiguous', {
      skip: process.env.TEST_DATABASE_URL ? false : 'Quota/lifecycle integration requires isolated PostgreSQL',
    }, async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId, 'quota-worker-ambiguous');
      const reference = { ownerId, workspaceId, runId: run.id, attemptNumber: claim.attemptCount };
      const provider = new MockCloudSandboxProviderClient();
      const quotas = new AgentQuotaService(
        db.pool, DEFAULT_AGENT_QUOTA_POLICY,
        new SandboxAttemptLifecycleFence(repo, provider, { drainTimeoutMs: 10, pollIntervalMs: 1 })
      );
      await quotas.reserveExecutionAttempt(reference, claim.leaseToken);
      await quotas.markAllocationStarted(reference, claim.leaseToken);

      const { session } = await repo.createSandboxAllocationIntent({
        ownerId, workspaceId, runId: run.id, attemptNumber: claim.attemptCount,
        mode: 'execute', providerType: 'mock-e2b', workerId: 'quota-worker-ambiguous',
        leaseToken: claim.leaseToken,
      });
      await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);
      await repo.markSandboxAllocationAmbiguous(session.id, 'simulated lost provider response');
      await quotas.markOutcomeUnknown(reference, claim.leaseToken, 'quota:allocation-ambiguous');

      await assert.rejects(
        quotas.reconcileAfterQuiescent(reference, {}, 'quota:must-remain-held'),
        /could not establish a durable attempt fence/i
      );
      const reservation = await quotas.getReservation(reference);
      assert.equal(reservation.resourceActive, true);
      assert.equal(reservation.state, 'reconciliation_required');

      const competing = await createClaimedRun(ownerId, workspaceId, 'quota-worker-competing', 'execute');
      await assert.rejects(
        quotas.reserveExecutionAttempt({
          ownerId, workspaceId, runId: competing.run.id, attemptNumber: competing.claim.attemptCount,
        }, competing.claim.leaseToken),
        (error: unknown) => error instanceof AgentQuotaError && error.code === 'WORKSPACE_BUSY'
      );
    });

    it('releases the PostgreSQL quota slot only after provider lookup, cleanup and lifecycle fencing succeed', {
      skip: process.env.TEST_DATABASE_URL ? false : 'Quota/lifecycle integration requires isolated PostgreSQL',
    }, async () => {
      const { run, claim } = await createClaimedRun(ownerId, workspaceId, 'quota-worker-recovery');
      const reference = { ownerId, workspaceId, runId: run.id, attemptNumber: claim.attemptCount };
      const provider = new MockCloudSandboxProviderClient();
      const quotas = new AgentQuotaService(
        db.pool, DEFAULT_AGENT_QUOTA_POLICY,
        new SandboxAttemptLifecycleFence(repo, provider, { drainTimeoutMs: 100, pollIntervalMs: 1 })
      );
      await quotas.reserveExecutionAttempt(reference, claim.leaseToken);
      await quotas.markAllocationStarted(reference, claim.leaseToken);

      const { session } = await repo.createSandboxAllocationIntent({
        ownerId, workspaceId, runId: run.id, attemptNumber: claim.attemptCount,
        mode: 'execute', providerType: 'mock-e2b', workerId: 'quota-worker-recovery',
        leaseToken: claim.leaseToken,
      });
      await repo.beginSandboxAllocationOperation(session.id, session.attemptGeneration);
      await provider.createSandbox({
        workspaceId, ownerId, timeoutMs: 1000,
        networkPolicy: { egressEnabled: false, allowlist: [] },
        allocationOperationId: session.allocationIntentId,
        attemptGeneration: session.attemptGeneration,
      });
      await repo.markSandboxAllocationAmbiguous(session.id, 'simulated process crash before provider ID commit');
      await quotas.markOutcomeUnknown(reference, claim.leaseToken, 'quota:provider-outcome-unknown');

      const reconciled = await quotas.reconcileAfterQuiescent(reference, {}, 'quota:verified-cleanup');
      assert.equal(reconciled.state, 'committed');
      assert.equal(reconciled.resourceActive, false);
      assert.equal(reconciled.accounted.providerRequests, 0);
      const lifecycle = await repo.getSandboxAttemptLifecycle(reference);
      assert.equal(lifecycle.fenced, true);
      assert.equal(lifecycle.session?.lifecycleState, 'destroyed');
      assert.equal(lifecycle.operations.find((operation) => operation.kind === 'allocation')?.outcome, 'resource');
      assert.equal(provider.destroyedSandboxes.length, 1);
    });
  });
});
