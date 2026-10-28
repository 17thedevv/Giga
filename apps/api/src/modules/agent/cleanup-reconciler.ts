import crypto from 'node:crypto';
import type { AgentRepository } from './repository.js';
import type { CloudSandboxProviderClient } from './sandbox-adapter.js';
import type { DurableSandboxSession } from './types.js';

export interface ReconcilerOptions {
  readonly batchSize?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly maxCleanupAttempts?: number;
  readonly workerId?: string;
  readonly leaseDurationMs?: number;
}

export interface ReconciliationBatchResult {
  readonly processed: number;
  readonly destroyed: number;
  readonly retried: number;
  readonly failed: number;
  readonly timedOutAllocations: number;
}

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000; // 5 minutes
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Durable Crash-Safe Sandbox Cleanup Reconciler.
 *
 * Scans PostgreSQL for orphan, failed, abandoned, or timed-out sandbox sessions and reconciles
 * them with the remote provider client.
 *
 * Invariant Guarantees:
 * 1. Zero orphan cloud sandboxes: Any session whose worker crashed or whose run was finalized
 *    is claimed via `FOR UPDATE SKIP LOCKED` and destroyed.
 * 2. Idempotent destruction: Provider "not found" / "404" responses are treated as successful cleanup.
 * 3. Durable retry with exponential backoff: Provider outages do not delete database records
 *    or fake success; retry intents are durably scheduled with backoff.
 * 4. Stale-worker fencing: Terminal destroyed sessions remain durable tombstones, preventing
 *    late callbacks from reviving them.
 * 5. Safe multi-process concurrency: Multiple reconcilers can run concurrently without race conditions.
 */
export class SandboxCleanupReconciler {
  private readonly batchSize: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxCleanupAttempts: number;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly repository: AgentRepository,
    private readonly providerClient: CloudSandboxProviderClient,
    options: ReconcilerOptions = {}
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.maxCleanupAttempts = options.maxCleanupAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.workerId = options.workerId ?? `reconciler-${crypto.randomUUID()}`;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
  }

  /**
   * Executes a single reconciliation pass over a bounded batch of sessions.
   */
  async reconcileBatch(limit = this.batchSize): Promise<ReconciliationBatchResult> {
    const isSupported = await this.repository.canPersistSandboxSessions();
    if (!isSupported) {
      return { processed: 0, destroyed: 0, retried: 0, failed: 0, timedOutAllocations: 0 };
    }

    const sessions = await this.repository.listSandboxSessionsNeedingCleanup(limit);
    let destroyed = 0;
    let retried = 0;
    let failed = 0;
    let timedOutAllocations = 0;

    for (const session of sessions) {
      const outcome = await this.reconcileSession(session);
      if (outcome === 'destroyed') destroyed++;
      else if (outcome === 'retried') retried++;
      else if (outcome === 'failed') failed++;
      else if (outcome === 'timed_out_allocation') timedOutAllocations++;
    }

    return {
      processed: sessions.length,
      destroyed,
      retried,
      failed,
      timedOutAllocations,
    };
  }

  /**
   * Reconciles a single claimed sandbox session.
   */
  async reconcileSession(
    session: DurableSandboxSession
  ): Promise<'destroyed' | 'retried' | 'failed' | 'timed_out_allocation' | 'skipped'> {
    const leaseToken = crypto.randomUUID();
    // 1. Claim session with an expiring lease to prevent duplicate concurrent reconcilers and fence stale workers
    let claimed = await this.repository.claimSandboxSessionForCleanup({
      sessionId: session.id,
      workerId: this.workerId,
      leaseToken,
      leaseDurationMs: this.leaseDurationMs,
    });
    if (!claimed) {
      return 'skipped';
    }

    // Fence the exact attempt before cleanup can authorize later allocation or tool work.
    await this.repository.fenceSandboxAttempt({
      ownerId: claimed.ownerId, workspaceId: claimed.workspaceId,
      runId: claimed.runId, attemptNumber: claimed.attemptNumber,
    }, 'sandbox_cleanup_reconciliation');

    // 2. No provider ID is not evidence of no allocation. Reconcile only when the
    // durable operation proves the RPC never started or the provider resolves its ID.
    if (!claimed.providerSessionId) {
      const lifecycle = await this.repository.getSandboxAttemptLifecycle({
        ownerId: claimed.ownerId, workspaceId: claimed.workspaceId,
        runId: claimed.runId, attemptNumber: claimed.attemptNumber,
      });
      const allocation = lifecycle.operations.find((operation) => operation.kind === 'allocation');
      if (allocation?.state === 'settled' && allocation.outcome === 'no_resource') {
        await this.repository.recordSandboxAllocationFailed(
          claimed.id,
          'Provider allocation was proven not to have started or exist',
          { source: 'cleanup_reconciler', allocationOutcome: 'no_resource', crashSuspected: true }
        );
        return 'timed_out_allocation';
      }
      if (!allocation || allocation.state === 'not_started') {
        // Fencing settles a not-started allocation atomically as resource-free.
        return 'skipped';
      }
      if (!this.providerClient.resolveAllocation) {
        await this.repository.markSandboxAllocationAmbiguous(
          claimed.id, 'Provider does not expose definitive allocation settlement lookup'
        ).catch(() => {});
        return 'skipped';
      }
      const resolution = await this.providerClient.resolveAllocation(allocation.id);
      if (resolution.status === 'pending') return 'skipped';
      if (resolution.status === 'ambiguous') {
        await this.repository.markSandboxAllocationAmbiguous(claimed.id, resolution.reason).catch(() => {});
        return 'skipped';
      }
      if (resolution.status === 'not_allocated') {
        await this.repository.confirmSandboxAllocationAbsent(claimed.id, 'provider_reported_not_allocated');
        return 'timed_out_allocation';
      }
      claimed = await this.repository.commitSandboxSessionAllocated({
        sessionId: claimed.id,
        ownerId: claimed.ownerId,
        runId: claimed.runId,
        leaseToken: claimed.leaseToken,
        providerSessionId: resolution.sandboxId,
      });
    }

    // 3. Case B: Provider session ID exists -> issue idempotent destroy to provider
    const providerSessionId = claimed.providerSessionId;
    if (!providerSessionId) return 'skipped';
    try {
      await this.providerClient.destroySandbox(providerSessionId);

      // Successfully destroyed at provider: record durable tombstone, fenced by leaseToken
      await this.repository.markSandboxDestroyed(claimed.id, providerSessionId, leaseToken);
      return 'destroyed';
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Check if provider reports the sandbox is already gone / not found
      const providerCode = typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code) : '';
      if (providerCode === 'SANDBOX_NOT_FOUND' ||
          /sandbox [^\n]*(?:not found|404)/i.test(errorMessage) ||
          errorMessage.includes('SANDBOX_NOT_FOUND')) {
        // Idempotent success: sandbox already does not exist at provider
        await this.repository.markSandboxDestroyed(claimed.id, providerSessionId, leaseToken);
        return 'destroyed';
      }

      // Provider error / network outage: schedule retry with exponential backoff
      const currentAttempts = claimed.cleanupAttempts + 1;
      if (currentAttempts >= this.maxCleanupAttempts) {
        // Exceeded maximum attempts: retain durable cleanup intent marked as failed
        await this.repository.markSandboxCleanupFailed(
          claimed.id,
          `Max cleanup attempts (${this.maxCleanupAttempts}) exceeded: ${errorMessage}`,
          leaseToken
        );
        return 'failed';
      }

      const backoffMs = Math.min(
        this.maxBackoffMs,
        this.baseBackoffMs * Math.pow(2, currentAttempts - 1)
      );

      await this.repository.markSandboxCleanupPending(claimed.id, errorMessage, backoffMs, leaseToken);
      return 'retried';
    }
  }

  /**
   * Starts periodic background reconciliation loop.
   */
  start(intervalMs = 10_000): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(async () => {
      if (!this.running) return;
      try {
        await this.reconcileBatch();
      } catch {
        // Background reconciler catches errors to avoid unhandled rejections
      }
    }, intervalMs);
  }

  /**
   * Stops the background reconciliation loop.
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
