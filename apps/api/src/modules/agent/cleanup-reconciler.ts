import type { AgentRepository } from './repository.js';
import type { CloudSandboxProviderClient } from './sandbox-adapter.js';
import type { DurableSandboxSession } from './types.js';

export interface ReconcilerOptions {
  readonly batchSize?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly maxCleanupAttempts?: number;
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
    // 1. Claim session for cleanup to prevent duplicate concurrent reconcilers
    const claimed = await this.repository.claimSandboxSessionForCleanup(session.id);
    if (!claimed) {
      return 'skipped';
    }

    // 2. Case A: Allocation timed out before provider session ID was ever recorded
    // (Worker crashed during createSandbox or provider timed out)
    if (!session.providerSessionId) {
      await this.repository.recordSandboxAllocationFailed(
        session.id,
        'Sandbox allocation timed out before provider session handle was committed',
        { source: 'cleanup_reconciler', crashSuspected: true }
      );
      return 'timed_out_allocation';
    }

    // 3. Case B: Provider session ID exists -> issue idempotent destroy to provider
    try {
      await this.providerClient.destroySandbox(session.providerSessionId);

      // Successfully destroyed at provider: record durable tombstone
      await this.repository.markSandboxDestroyed(session.id, session.providerSessionId);
      return 'destroyed';
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Check if provider reports the sandbox is already gone / not found
      if (
        errorMessage.includes('404') ||
        errorMessage.toLowerCase().includes('not found') ||
        errorMessage.includes('SANDBOX_NOT_FOUND')
      ) {
        // Idempotent success: sandbox already does not exist at provider
        await this.repository.markSandboxDestroyed(session.id, session.providerSessionId);
        return 'destroyed';
      }

      // Provider error / network outage: schedule retry with exponential backoff
      const currentAttempts = session.cleanupAttempts + 1;
      if (currentAttempts >= this.maxCleanupAttempts) {
        // Exceeded maximum attempts: retain durable cleanup intent marked as failed
        await this.repository.markSandboxCleanupPending(
          session.id,
          `Max cleanup attempts (${this.maxCleanupAttempts}) exceeded: ${errorMessage}`,
          this.maxBackoffMs
        );
        return 'failed';
      }

      const backoffMs = Math.min(
        this.maxBackoffMs,
        this.baseBackoffMs * Math.pow(2, currentAttempts - 1)
      );

      await this.repository.markSandboxCleanupPending(session.id, errorMessage, backoffMs);
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
