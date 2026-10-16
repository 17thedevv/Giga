import crypto from 'node:crypto';
import { ConflictError } from '../auth/auth-validation.js';
import type { AgentRepository } from './repository.js';
import type { ToolRegistry } from './tool-registry.js';
import type { AgentDecision, AgentDecisionProvider, AgentPlan, StepObservation } from './decision-provider.js';
import type { ExecutionRuntime } from './execution-runtime.js';
import { AGENT_ERROR_CODES, type AgentRun } from './types.js';

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

function validateDecision(decision: AgentDecision): { valid: true } | { valid: false; error: string } {
  if (!decision || typeof decision !== 'object' || !('kind' in decision)) {
    return { valid: false, error: 'Malformed decision: object with kind required' };
  }
  switch (decision.kind) {
    case 'plan': {
      if (!decision.plan || typeof decision.plan !== 'object') {
        return { valid: false, error: 'Malformed plan: plan object required' };
      }
      if (typeof decision.plan.version !== 'number' || decision.plan.version < 1) {
        return { valid: false, error: 'Malformed plan: version must be integer >= 1' };
      }
      if (!Array.isArray(decision.plan.steps) || decision.plan.steps.length === 0 || decision.plan.steps.length > 20) {
        return { valid: false, error: 'Malformed plan: steps must be array of 1..20 items' };
      }
      for (const s of decision.plan.steps) {
        if (typeof s !== 'string' || s.trim().length === 0 || s.length > 256) {
          return { valid: false, error: 'Malformed plan step: each step must be string <= 256 chars' };
        }
      }
      return { valid: true };
    }
    case 'tool_call': {
      if (!decision.toolCall || typeof decision.toolCall !== 'object') {
        return { valid: false, error: 'Malformed tool_call: toolCall object required' };
      }
      const { toolCallId, toolName, arguments: args } = decision.toolCall;
      if (typeof toolCallId !== 'string' || toolCallId.trim().length === 0 || toolCallId.length > 64) {
        return { valid: false, error: 'Malformed toolCallId: must be non-empty string <= 64 chars' };
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(toolCallId)) {
        return { valid: false, error: 'Malformed toolCallId: must contain only alphanumeric, _, -' };
      }
      if (typeof toolName !== 'string' || toolName.trim().length === 0 || toolName.length > 64) {
        return { valid: false, error: 'Malformed toolName: must be non-empty string <= 64 chars' };
      }
      if (args === undefined || typeof args !== 'object' || Array.isArray(args)) {
        return { valid: false, error: 'Malformed tool arguments: must be an object' };
      }
      return { valid: true };
    }
    case 'complete': {
      if (typeof decision.summary !== 'string' || decision.summary.trim().length === 0 || decision.summary.length > 2048) {
        return { valid: false, error: 'Malformed completion summary: must be non-empty string <= 2048 chars' };
      }
      return { valid: true };
    }
    case 'fail': {
      if (typeof decision.code !== 'string' || decision.code.length === 0 || decision.code.length > 40) {
        return { valid: false, error: 'Malformed failure code: must be non-empty string <= 40 chars' };
      }
      if (typeof decision.message !== 'string' || decision.message.length === 0 || decision.message.length > 1024) {
        return { valid: false, error: 'Malformed failure message: must be non-empty string <= 1024 chars' };
      }
      return { valid: true };
    }
    default:
      return { valid: false, error: `Unknown decision kind: ${(decision as { kind: string }).kind}` };
  }
}

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
   * 3. Proactively renews worker lease with periodic heartbeat
   * 4. Obtains plan/action from injected AgentDecisionProvider
   * 5. Validates decision fields and requested tool/arguments bounds
   * 6. Checks mode/permission policy (Ask = read only, Plan = read only, Execute = writes/exec)
   * 7. Invokes injected ExecutionRuntime
   * 8. Persists tool/step/events atomically with strict lease fencing
   * 9. Observes the result
   * 10. Retries/repairs within explicit limits
   * 11. Finalizes completed/failed truthfully with verified evidence gate for execute mode
   * 12. Releases/fences worker on every exit path
   */
  async executeRun(ownerId: string, runId: string, signal?: AbortSignal): Promise<OrchestrationOutcome> {
    const claim = await this.repository.claimRun(ownerId, runId, this.workerId, this.leaseDurationMs);
    if (!claim) {
      return { status: 'skipped', reason: 'Run is not eligible or already claimed by another active worker' };
    }

    const { leaseToken, attemptCount } = claim;
    const currentRun = claim.run;

    const runAbortController = new AbortController();
    if (signal) {
      if (signal.aborted) {
        runAbortController.abort();
      } else {
        signal.addEventListener('abort', () => runAbortController.abort(), { once: true });
      }
    }

    let heartbeatActive = true;
    const heartbeatIntervalMs = Math.max(100, Math.floor(this.leaseDurationMs / 3));
    const heartbeatTimer = setInterval(async () => {
      if (!heartbeatActive) return;
      try {
        const renewed = await this.repository.renewLease(ownerId, runId, leaseToken, this.leaseDurationMs);
        if (!renewed) {
          heartbeatActive = false;
          runAbortController.abort();
        }
      } catch {
        heartbeatActive = false;
        runAbortController.abort();
      }
    }, heartbeatIntervalMs);

    try {
      if (runAbortController.signal.aborted) {
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
        signal: runAbortController.signal,
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
          if (runAbortController.signal.aborted) {
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

          // Proactively renew lease before decision provider invocation
          const renewedBeforeDecision = await this.repository.renewLease(ownerId, runId, leaseToken, this.leaseDurationMs);
          if (!renewedBeforeDecision) {
            runAbortController.abort();
            return { status: 'fenced', reason: 'Worker lease expired before decision' };
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
            attemptCount,
            signal: runAbortController.signal,
          });

          // Validate decision structure and field bounds
          const decisionValidation = validateDecision(decision);
          if (!decisionValidation.valid) {
            const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, {
              status: 'failed',
              errorCode: 'INVALID_ARGUMENTS',
              errorMessage: decisionValidation.error,
            });
            return { status: 'failed', run: finalized.run };
          }

          if (decision.kind === 'plan') {
            await this.repository.appendPlanUpdatedEvent(ownerId, runId, leaseToken, decision.plan);
            currentPlan = decision.plan;
            continue;
          }

          if (decision.kind === 'fail') {
            const safeErrorCode = (AGENT_ERROR_CODES as readonly string[]).includes(decision.code)
              ? decision.code
              : 'EXECUTION_FAILED';
            const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, {
              status: 'failed',
              errorCode: safeErrorCode,
              errorMessage: decision.message,
            });
            return { status: 'failed', run: finalized.run };
          }

          if (decision.kind === 'complete') {
            if (currentRun.mode === 'execute') {
              // VERIFIED COMPLETION GATE for execute mode:
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
            } else {
              // Read-only Ask / Plan modes:
              // They do not run sandbox build/tests, so they complete with decision summary and empty verified checks.
              const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, {
                status: 'completed',
                summary: decision.summary,
                verifiedChecks: [],
              });
              return { status: 'completed', run: finalized.run };
            }
          }

          if (decision.kind === 'tool_call') {
            const toolCall = decision.toolCall;
            const toolValidation = this.toolRegistry.validate(toolCall.toolName, toolCall.arguments, currentRun.mode);

            if (!toolValidation.valid) {
              // Fails before runtime dispatch!
              const { step } = await this.repository.recordStepStarted(ownerId, runId, leaseToken, {
                toolName: toolCall.toolName,
                toolCallId: toolCall.toolCallId,
                risk: toolValidation.tool?.risk ?? 'read',
                arguments: typeof toolCall.arguments === 'object' && toolCall.arguments !== null ? toolCall.arguments : {},
              });

              await this.repository.recordStepFailed(ownerId, runId, leaseToken, step.stepNumber, {
                errorCode: toolValidation.errorCode,
                errorMessage: toolValidation.error,
              });

              lastStepResult = {
                stepNumber: step.stepNumber,
                toolName: toolCall.toolName,
                toolCallId: toolCall.toolCallId,
                success: false,
                errorCode: toolValidation.errorCode,
                errorMessage: toolValidation.error,
              };

              completedSteps = await this.repository.listSteps(ownerId, runId);
              repairCount++;

              if (repairCount > this.maxRepairs) {
                const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, {
                  status: 'failed',
                  errorCode: toolValidation.errorCode,
                  errorMessage: `Exceeded repair limit of ${this.maxRepairs} after validation error: ${toolValidation.error}`,
                });
                return { status: 'failed', run: finalized.run };
              }
              continue;
            }

            // Valid tool and arguments: record step started
            const { step } = await this.repository.recordStepStarted(ownerId, runId, leaseToken, {
              toolName: toolValidation.tool.name,
              toolCallId: toolCall.toolCallId,
              risk: toolValidation.tool.risk,
              arguments: toolValidation.args,
            });

            // Proactively renew lease before tool execution
            const renewedBeforeInvoke = await this.repository.renewLease(ownerId, runId, leaseToken, this.leaseDurationMs);
            if (!renewedBeforeInvoke) {
              runAbortController.abort();
              return { status: 'fenced', reason: 'Worker lease expired before tool execution' };
            }

            const result = await this.executionRuntime.invoke(
              sessionId,
              {
                toolCallId: toolCall.toolCallId,
                toolName: toolValidation.tool.name,
                risk: toolValidation.tool.risk,
                args: toolValidation.args,
              },
              runAbortController.signal
            );

            if (result.success) {
              await this.repository.recordStepCompleted(ownerId, runId, leaseToken, step.stepNumber, {
                output: result.output,
                durationMs: result.durationMs,
                summary: `Tool '${toolValidation.tool.name}' succeeded`,
              });

              lastStepResult = {
                stepNumber: step.stepNumber,
                toolName: toolValidation.tool.name,
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
                toolName: toolValidation.tool.name,
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
      heartbeatActive = false;
      clearInterval(heartbeatTimer);
      await this.repository.releaseLease(ownerId, runId, leaseToken).catch(() => {});
    }
  }
}
