import { ConflictError } from '../auth/auth-validation.js';
import type { AgentRepository } from './repository.js';
import type { ToolRegistry } from './tool-registry.js';
import type { AgentDecisionProvider, AgentPlan, StepObservation } from './decision-provider.js';
import type { ExecutionRuntime } from './execution-runtime.js';
import type { AgentRun } from './types.js';

export interface OrchestratorOptions {
  readonly workerId?: string;
  readonly maxSteps?: number;
  readonly maxRepairs?: number;
  readonly leaseDurationMs?: number;
}

export type OrchestrationOutcome =
  | { readonly status: 'completed'; readonly run: AgentRun }
  | { readonly status: 'failed'; readonly run: AgentRun }
  | { readonly status: 'cancelled'; readonly run: AgentRun }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'fenced'; readonly reason: string };

export class AgentOrchestrator {
  private readonly workerId: string;
  private readonly maxSteps: number;
  private readonly maxRepairs: number;
  private readonly leaseDurationMs: number;

  constructor(
    private readonly repository: AgentRepository,
    private readonly toolRegistry: ToolRegistry,
    private readonly decisionProvider: AgentDecisionProvider,
    private readonly executionRuntime: ExecutionRuntime,
    options: OrchestratorOptions = {}
  ) {
    this.workerId = options.workerId ?? `worker-${crypto.randomUUID()}`;
    this.maxSteps = options.maxSteps ?? 30;
    this.maxRepairs = options.maxRepairs ?? 3;
    this.leaseDurationMs = options.leaseDurationMs ?? 30000;
  }

  /**
   * Executes a durable orchestration turn for a specified run.
   * Guarantees:
   * 1. Claims an eligible queued or stale run
   * 2. Transitions it durably to running
   * 3. Obtains plan/action from injected AgentDecisionProvider
   * 4. Validates requested tool and arguments
   * 5. Checks mode/permission policy
   * 6. Invokes injected ExecutionRuntime
   * 7. Persists tool/step/events atomically
   * 8. Observes the result
   * 9. Retries/repairs within explicit limits
   * 10. Finalizes completed/failed truthfully
   * 11. Releases/fences worker on every exit path
   */
  async executeRun(ownerId: string, runId: string, signal?: AbortSignal): Promise<OrchestrationOutcome> {
    const claim = await this.repository.claimRun(ownerId, runId, this.workerId, this.leaseDurationMs);
    if (!claim) {
      return { status: 'skipped', reason: 'Run is not eligible or already claimed by another active worker' };
    }

    const { leaseToken } = claim;
    let currentRun = claim.run;

    try {
      if (signal?.aborted) {
        const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, { status: 'cancelled' });
        return { status: 'cancelled', run: finalized.run };
      }

      // Prepare execution runtime session
      const prep = await this.executionRuntime.prepare({
        runId,
        workspaceId: currentRun.workspaceId,
        ownerId,
        mode: currentRun.mode,
        task: currentRun.task,
        modelId: currentRun.modelId,
        signal: signal ?? new AbortController().signal,
      });

      if (!prep.available) {
        const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, {
          status: 'failed',
          errorCode: prep.code,
          errorMessage: 'Agent execution runtime is not available',
        });
        return { status: 'failed', run: finalized.run };
      }

      const sessionId = prep.sessionId;

      try {
        let completedSteps = await this.repository.listSteps(ownerId, runId);
        let lastStepResult: StepObservation | undefined;
        let currentPlan: AgentPlan | undefined;
        let repairCount = 0;

        while (true) {
          if (signal?.aborted) {
            const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, { status: 'cancelled' });
            return { status: 'cancelled', run: finalized.run };
          }

          if (completedSteps.length >= this.maxSteps) {
            const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, {
              status: 'failed',
              errorCode: 'STEP_LIMIT_EXCEEDED',
              errorMessage: `Exceeded maximum allowed step limit of ${this.maxSteps}`,
            });
            return { status: 'failed', run: finalized.run };
          }

          const decision = await this.decisionProvider.decide({
            runId,
            workspaceId: currentRun.workspaceId,
            ownerId,
            task: currentRun.task,
            mode: currentRun.mode,
            modelId: currentRun.modelId,
            currentPlan,
            completedSteps,
            lastStepResult,
            attemptCount: currentRun.attemptCount ?? 1,
            signal: signal ?? new AbortController().signal,
          });

          if (decision.kind === 'plan') {
            await this.repository.appendPlanUpdatedEvent(ownerId, runId, leaseToken, decision.plan);
            currentPlan = decision.plan;
            continue;
          }

          if (decision.kind === 'fail') {
            const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, {
              status: 'failed',
              errorCode: decision.code,
              errorMessage: decision.message,
            });
            return { status: 'failed', run: finalized.run };
          }

          if (decision.kind === 'complete') {
            // VERIFIED COMPLETION GATE:
            // "completed must require actual durable verification evidence from the fake runtime.
            // Never do: model says done -> run.completed"
            const evidence = await this.executionRuntime.getVerificationEvidence(sessionId);
            const hasPassed = evidence.some((c) => c.outcome === 'passed');
            const hasFailed = evidence.some((c) => c.outcome === 'failed');

            if (!hasPassed || hasFailed) {
              const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, {
                status: 'failed',
                errorCode: 'VERIFICATION_FAILED',
                errorMessage: 'Run completion denied: required verification checks failed or were not run',
              });
              return { status: 'failed', run: finalized.run };
            }

            const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, {
              status: 'completed',
              summary: decision.summary,
              verifiedChecks: evidence,
            });
            return { status: 'completed', run: finalized.run };
          }

          if (decision.kind === 'tool_call') {
            const toolCall = decision.toolCall;
            const validation = this.toolRegistry.validate(toolCall.toolName, toolCall.arguments, currentRun.mode);

            if (!validation.valid) {
              // Fails before runtime dispatch!
              const { step } = await this.repository.recordStepStarted(ownerId, runId, leaseToken, {
                toolName: toolCall.toolName,
                toolCallId: toolCall.toolCallId,
                risk: validation.tool?.risk ?? 'read',
                arguments: typeof toolCall.arguments === 'object' && toolCall.arguments !== null ? toolCall.arguments : {},
              });

              await this.repository.recordStepFailed(ownerId, runId, leaseToken, step.stepNumber, {
                errorCode: validation.errorCode,
                errorMessage: validation.error,
              });

              lastStepResult = {
                stepNumber: step.stepNumber,
                toolName: toolCall.toolName,
                toolCallId: toolCall.toolCallId,
                success: false,
                errorCode: validation.errorCode,
                errorMessage: validation.error,
              };

              completedSteps = await this.repository.listSteps(ownerId, runId);
              repairCount++;

              if (repairCount > this.maxRepairs) {
                const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, {
                  status: 'failed',
                  errorCode: validation.errorCode,
                  errorMessage: `Exceeded repair limit of ${this.maxRepairs} after validation error: ${validation.error}`,
                });
                return { status: 'failed', run: finalized.run };
              }
              continue;
            }

            // Valid tool and arguments: record step started and dispatch to execution runtime
            const { step } = await this.repository.recordStepStarted(ownerId, runId, leaseToken, {
              toolName: validation.tool.name,
              toolCallId: toolCall.toolCallId,
              risk: validation.tool.risk,
              arguments: validation.args,
            });

            const result = await this.executionRuntime.invoke(
              sessionId,
              {
                toolCallId: toolCall.toolCallId,
                toolName: validation.tool.name,
                risk: validation.tool.risk,
                args: validation.args,
              },
              signal ?? new AbortController().signal
            );

            if (result.success) {
              await this.repository.recordStepCompleted(ownerId, runId, leaseToken, step.stepNumber, {
                output: result.output,
                durationMs: result.durationMs,
                summary: `Tool '${validation.tool.name}' succeeded`,
              });

              lastStepResult = {
                stepNumber: step.stepNumber,
                toolName: validation.tool.name,
                toolCallId: toolCall.toolCallId,
                success: true,
                output: result.output,
              };
            } else {
              await this.repository.recordStepFailed(ownerId, runId, leaseToken, step.stepNumber, {
                errorCode: result.errorCode ?? 'TOOL_ERROR',
                errorMessage: result.errorMessage ?? 'Tool execution failed',
                durationMs: result.durationMs,
              });

              lastStepResult = {
                stepNumber: step.stepNumber,
                toolName: validation.tool.name,
                toolCallId: toolCall.toolCallId,
                success: false,
                errorCode: result.errorCode ?? 'TOOL_ERROR',
                errorMessage: result.errorMessage,
              };

              repairCount++;
              if (repairCount > this.maxRepairs) {
                const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, {
                  status: 'failed',
                  errorCode: result.errorCode ?? 'TOOL_ERROR',
                  errorMessage: result.errorMessage ?? 'Tool execution failed repeatedly',
                });
                return { status: 'failed', run: finalized.run };
              }
            }

            completedSteps = await this.repository.listSteps(ownerId, runId);
            continue;
          }
        }
      } finally {
        await this.executionRuntime.stop(sessionId).catch(() => {});
      }
    } catch (err: unknown) {
      if (err instanceof ConflictError && err.message.includes('Worker fenced')) {
        return { status: 'fenced', reason: err.message };
      }
      throw err;
    } finally {
      await this.repository.releaseLease(ownerId, runId, leaseToken).catch(() => {});
    }
  }
}
