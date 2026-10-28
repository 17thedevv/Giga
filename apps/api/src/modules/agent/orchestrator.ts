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
  readonly maxDecisions?: number;
  readonly maxRepairs?: number;
  readonly maxIdenticalToolCalls?: number;
  readonly leaseDurationMs?: number;
}

export type OrchestrationOutcome =
  | { readonly status: 'completed'; readonly run: AgentRun }
  | { readonly status: 'failed'; readonly run: AgentRun }
  | { readonly status: 'cancelled'; readonly run: AgentRun }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'fenced'; readonly reason: string };

function hasExactKeys(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}

function validateDecision(decision: AgentDecision): { valid: true } | { valid: false; error: string } {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision) || !('kind' in decision)) {
    return { valid: false, error: 'Malformed decision: object with kind required' };
  }
  switch (decision.kind) {
    case 'plan': {
      if (!hasExactKeys(decision, ['kind', 'plan']) || !hasExactKeys(decision.plan, ['version', 'steps'])) {
        return { valid: false, error: 'Malformed plan: plan object required' };
      }
      if (!Number.isSafeInteger(decision.plan.version) || (decision.plan.version as number) < 1) {
        return { valid: false, error: 'Malformed plan: version must be integer >= 1' };
      }
      if (!Array.isArray(decision.plan.steps) || decision.plan.steps.length === 0 || decision.plan.steps.length > 20) {
        return { valid: false, error: 'Malformed plan: steps must be array of 1..20 items' };
      }
      for (const s of decision.plan.steps) {
        if (typeof s !== 'string' || s.trim().length === 0 || Buffer.byteLength(s, 'utf8') > 256) {
          return { valid: false, error: 'Malformed plan step: each step must be string <= 256 chars' };
        }
      }
      return { valid: true };
    }
    case 'tool_call': {
      if (!hasExactKeys(decision, ['kind', 'toolCall']) || !hasExactKeys(decision.toolCall, ['toolCallId', 'toolName', 'arguments'])) {
        return { valid: false, error: 'Malformed tool_call: toolCall object required' };
      }
      const { toolCallId, toolName, arguments: args } = decision.toolCall;
      if (typeof toolCallId !== 'string' || toolCallId.trim().length === 0 || Buffer.byteLength(toolCallId, 'utf8') > 64) {
        return { valid: false, error: 'Malformed toolCallId: must be non-empty string <= 64 chars' };
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(toolCallId)) {
        return { valid: false, error: 'Malformed toolCallId: must contain only alphanumeric, _, -' };
      }
      if (typeof toolName !== 'string' || toolName.trim().length === 0 || Buffer.byteLength(toolName, 'utf8') > 64) {
        return { valid: false, error: 'Malformed toolName: must be non-empty string <= 64 chars' };
      }
      if (args === undefined || args === null || typeof args !== 'object' || Array.isArray(args)) {
        return { valid: false, error: 'Malformed tool arguments: must be an object' };
      }
      return { valid: true };
    }
    case 'complete': {
      if (!hasExactKeys(decision, ['kind', 'summary', 'verifiedChecks'], ['kind', 'summary'])) {
        return { valid: false, error: 'Malformed completion: unknown field' };
      }
      if (typeof decision.summary !== 'string' || decision.summary.trim().length === 0 || Buffer.byteLength(decision.summary, 'utf8') > 2048) {
        return { valid: false, error: 'Malformed completion summary: must be non-empty string <= 2048 chars' };
      }
      if (decision.verifiedChecks !== undefined) {
        if (!Array.isArray(decision.verifiedChecks) || decision.verifiedChecks.length > 32) return { valid: false, error: 'Malformed completion checks' };
        for (const check of decision.verifiedChecks) {
          if (!hasExactKeys(check, ['name', 'outcome', 'summary'], ['name', 'outcome']) ||
              typeof check.name !== 'string' || Buffer.byteLength(check.name, 'utf8') > 128 ||
              !['passed', 'failed', 'not_run'].includes(String(check.outcome)) ||
              (check.summary !== undefined && (typeof check.summary !== 'string' || Buffer.byteLength(check.summary, 'utf8') > 512))) {
            return { valid: false, error: 'Malformed completion checks' };
          }
        }
      }
      return { valid: true };
    }
    case 'fail': {
      if (!hasExactKeys(decision, ['kind', 'code', 'message'])) return { valid: false, error: 'Malformed failure: unknown field' };
      if (typeof decision.code !== 'string' || decision.code.length === 0 || decision.code.length > 40) {
        return { valid: false, error: 'Malformed failure code: must be non-empty string <= 40 chars' };
      }
      if (typeof decision.message !== 'string' || decision.message.length === 0 || Buffer.byteLength(decision.message, 'utf8') > 1024) {
        return { valid: false, error: 'Malformed failure message: must be non-empty string <= 1024 chars' };
      }
      return { valid: true };
    }
    default:
      return { valid: false, error: 'Unknown decision kind' };
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return '{' + Object.keys(object).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(object[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export class AgentOrchestrator {
  private readonly workerId: string;
  private readonly maxSteps: number;
  private readonly maxDecisions: number;
  private readonly maxRepairs: number;
  private readonly maxIdenticalToolCalls: number;
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
    this.maxDecisions = options.maxDecisions ?? 60;
    this.maxRepairs = options.maxRepairs ?? 3;
    this.maxIdenticalToolCalls = options.maxIdenticalToolCalls ?? 3;
    this.leaseDurationMs = options.leaseDurationMs ?? 30000;
    if (![this.maxSteps, this.maxDecisions, this.maxIdenticalToolCalls, this.leaseDurationMs].every((value) => Number.isSafeInteger(value) && value > 0) ||
        !Number.isSafeInteger(this.maxRepairs) || this.maxRepairs < 0) {
      throw new Error('Agent orchestrator limits must be positive safe integers');
    }
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
        workerId: this.workerId,
        leaseToken,
        attemptNumber: attemptCount,
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
        let decisionCount = 0;
        const equivalentToolCalls = new Map<string, number>();

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

          if (decisionCount >= this.maxDecisions) {
            const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, {
              status: 'failed',
              errorCode: 'STEP_LIMIT_EXCEEDED',
              errorMessage: `Exceeded maximum allowed decision limit of ${this.maxDecisions}`,
            });
            return { status: 'failed', run: finalized.run };
          }

          // Proactively renew lease before decision provider invocation
          const renewedBeforeDecision = await this.repository.renewLease(ownerId, runId, leaseToken, this.leaseDurationMs);
          if (!renewedBeforeDecision) {
            runAbortController.abort();
            return { status: 'fenced', reason: 'Worker lease expired before decision' };
          }

          const conversationContext = await this.repository.getConversationContext(ownerId, runId);
          if (runAbortController.signal.aborted) {
            const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, { status: 'cancelled' });
            return { status: 'cancelled', run: finalized.run };
          }
          const currentRunMessages = conversationContext.messages.filter((m) => !m.runId || m.runId === runId);
          const maxProcessedRunSequence = currentRunMessages.length > 0
            ? Math.max(...currentRunMessages.map((m) => m.sequence))
            : 0;

          decisionCount++;
          let decision: AgentDecision;
          try {
            decision = await this.decisionProvider.decide({
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
              conversationContext,
            });
          } catch {
            if (runAbortController.signal.aborted) {
              const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, { status: 'cancelled' });
              return { status: 'cancelled', run: finalized.run };
            }
            const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, {
              status: 'failed',
              errorCode: 'RUNTIME_UNAVAILABLE',
              errorMessage: 'Agent decision provider is unavailable',
            });
            return { status: 'failed', run: finalized.run };
          }

          if (runAbortController.signal.aborted) {
            const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, { status: 'cancelled' });
            return { status: 'cancelled', run: finalized.run };
          }

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
            try {
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

                const finalized = await this.repository.finalizeRun(
                  ownerId,
                  runId,
                  leaseToken,
                  {
                    status: 'completed',
                    summary: decision.summary,
                    verifiedChecks: evidence,
                  },
                  { expectedMaxSequence: maxProcessedRunSequence }
                );
                return { status: 'completed', run: finalized.run };
              } else {
                // Read-only Ask / Plan modes:
                // They do not run sandbox build/tests, so they complete with decision summary and empty verified checks.
                const finalized = await this.repository.finalizeRun(
                  ownerId,
                  runId,
                  leaseToken,
                  {
                    status: 'completed',
                    summary: decision.summary,
                    verifiedChecks: [],
                  },
                  { expectedMaxSequence: maxProcessedRunSequence }
                );
                return { status: 'completed', run: finalized.run };
              }
            } catch (err) {
              if (err instanceof ConflictError && err.message.includes('follow-up message')) {
                // A new user follow-up message arrived while deciding / verifying!
                // Continue execution loop to process the new message with fresh context.
                continue;
              }
              throw err;
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

            const equivalenceKey = toolValidation.tool.name + ':' + canonicalJson(toolValidation.args);
            const equivalentCount = (equivalentToolCalls.get(equivalenceKey) ?? 0) + 1;
            equivalentToolCalls.set(equivalenceKey, equivalentCount);
            if (equivalentCount > this.maxIdenticalToolCalls) {
              const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, {
                status: 'failed',
                errorCode: 'POLICY_VIOLATION',
                errorMessage: 'Repeated equivalent tool calls exceeded the server limit',
              });
              return { status: 'failed', run: finalized.run };
            }

            // Refresh fencing before persisting or dispatching a model-proposed action.
            const renewedBeforeInvoke = await this.repository.renewLease(ownerId, runId, leaseToken, this.leaseDurationMs);
            if (!renewedBeforeInvoke) {
              runAbortController.abort();
              return { status: 'fenced', reason: 'Worker lease expired before tool execution' };
            }
            if (runAbortController.signal.aborted) {
              const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, { status: 'cancelled' });
              return { status: 'cancelled', run: finalized.run };
            }

            // Valid tool and arguments: record step started
            const { step } = await this.repository.recordStepStarted(ownerId, runId, leaseToken, {
              toolName: toolValidation.tool.name,
              toolCallId: toolCall.toolCallId,
              risk: toolValidation.tool.risk,
              arguments: toolValidation.args,
            });

            if (runAbortController.signal.aborted) {
              await this.repository.recordStepFailed(ownerId, runId, leaseToken, step.stepNumber, {
                errorCode: 'ABORTED', errorMessage: 'Execution was cancelled before tool dispatch',
              });
              const finalized = await this.repository.finalizeRun(ownerId, runId, leaseToken, { status: 'cancelled' });
              return { status: 'cancelled', run: finalized.run };
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
