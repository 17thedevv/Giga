import { ConflictError } from '../auth/auth-validation.js';
import type { AgentQuotaReference, QuotaQuiescenceVerifier } from './quota-service.js';
import type { AgentRepository } from './repository.js';
import type { CloudSandboxProviderClient } from './sandbox-adapter.js';
import { SandboxCleanupReconciler } from './cleanup-reconciler.js';

export interface SandboxAttemptFenceOptions {
  readonly drainTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

/**
 * Quota finalization verifier backed by PostgreSQL attempt fences, provider settlement,
 * durable cleanup leases and the lifecycle operation ledger. Unknown outcomes fail closed.
 */
export class SandboxAttemptLifecycleFence implements QuotaQuiescenceVerifier {
  private readonly drainTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly cleanup: SandboxCleanupReconciler;

  constructor(
    private readonly repository: AgentRepository,
    private readonly provider: CloudSandboxProviderClient,
    options: SandboxAttemptFenceOptions = {}
  ) {
    this.drainTimeoutMs = options.drainTimeoutMs ?? 1_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
    this.cleanup = new SandboxCleanupReconciler(repository, provider, { maxCleanupAttempts: 3 });
  }

  async fenceAttemptAndVerify(reference: AgentQuotaReference): Promise<void> {
    await this.repository.fenceSandboxAttempt(reference, 'quota_reconciliation');
    const deadline = Date.now() + this.drainTimeoutMs;

    while (true) {
      let state = await this.repository.getSandboxAttemptLifecycle(reference);
      if (!state.fenced) throw new ConflictError('Durable attempt fence was not persisted');
      const session = state.session;
      const allocation = state.operations.find((operation) => operation.kind === 'allocation');

      if (session && !session.providerSessionId && allocation &&
          (allocation.state === 'in_progress' || allocation.state === 'ambiguous')) {
        if (!this.provider.resolveAllocation) {
          throw new ConflictError('Provider allocation outcome is ambiguous and cannot be queried');
        }
        const result = await this.provider.resolveAllocation(allocation.id);
        if (result.status === 'allocated') {
          await this.repository.commitSandboxSessionAllocated({
            sessionId: session.id,
            ownerId: session.ownerId,
            runId: session.runId,
            leaseToken: session.leaseToken,
            providerSessionId: result.sandboxId,
          });
        } else if (result.status === 'not_allocated') {
          await this.repository.confirmSandboxAllocationAbsent(session.id, 'provider_reported_not_allocated');
        } else if (result.status === 'ambiguous') {
          await this.repository.markSandboxAllocationAmbiguous(session.id, result.reason);
          throw new ConflictError('Provider cannot definitively settle allocation; quota capacity remains held');
        } else if (Date.now() >= deadline) {
          throw new ConflictError('Provider allocation has not settled; quota capacity remains held');
        }
        state = await this.repository.getSandboxAttemptLifecycle(reference);
      }

      if (state.session?.providerSessionId && state.session.lifecycleState !== 'destroyed') {
        const result = await this.cleanup.reconcileSession(state.session);
        if (result === 'retried' || result === 'failed') {
          throw new ConflictError('Sandbox destruction is not confirmed; quota capacity remains held');
        }
        state = await this.repository.getSandboxAttemptLifecycle(reference);
      }

      const unresolved = state.operations.filter((operation) => operation.state !== 'settled');
      if (unresolved.length > 0) {
        if (unresolved.some((operation) => operation.state === 'ambiguous' || operation.state === 'not_started')) {
          throw new ConflictError('A lifecycle operation has an unresolved provider or runtime outcome');
        }
        if (Date.now() >= deadline) {
          throw new ConflictError('In-flight runtime operations did not drain; quota capacity remains held');
        }
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        continue;
      }

      const finalAllocation = state.operations.find((operation) => operation.kind === 'allocation');
      if (finalAllocation?.outcome === 'resource') {
        if (!state.session?.providerSessionId || state.session.providerSessionId !== finalAllocation.providerResourceId ||
            state.session.lifecycleState !== 'destroyed') {
          throw new ConflictError('Allocated sandbox is not durably confirmed destroyed');
        }
      } else if (finalAllocation && finalAllocation.outcome !== 'no_resource') {
        throw new ConflictError('Allocation did not reach a definitive provider settlement');
      }

      if (state.session && state.session.providerSessionId && state.session.lifecycleState !== 'destroyed') {
        throw new ConflictError('Sandbox remains active or cleanup-pending');
      }
      return;
    }
  }
}
