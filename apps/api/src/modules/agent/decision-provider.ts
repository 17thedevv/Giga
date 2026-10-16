import type { AgentMode, AgentStep, ConversationContextBoundary, VerifiedCheck } from './types.js';

export interface AgentPlan {
  readonly version: number;
  readonly steps: readonly string[];
}

export interface ToolCallRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
}

export type AgentDecision =
  | { readonly kind: 'plan'; readonly plan: AgentPlan }
  | { readonly kind: 'tool_call'; readonly toolCall: ToolCallRequest }
  | { readonly kind: 'complete'; readonly summary: string; readonly verifiedChecks?: readonly VerifiedCheck[] }
  | { readonly kind: 'fail'; readonly code: string; readonly message: string };

export interface StepObservation {
  readonly stepNumber: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly success: boolean;
  readonly output?: Record<string, unknown>;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface AgentDecisionContext {
  readonly runId: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly task: string;
  readonly mode: AgentMode;
  readonly modelId: string;
  readonly currentPlan?: AgentPlan;
  readonly completedSteps: readonly AgentStep[];
  readonly lastStepResult?: StepObservation;
  readonly attemptCount: number;
  readonly signal: AbortSignal;
  readonly conversationContext?: ConversationContextBoundary;
}

export interface AgentDecisionProvider {
  decide(context: AgentDecisionContext): Promise<AgentDecision>;
}

export type ScenarioType =
  | 'one-step-success'
  | 'multi-step-success'
  | 'unknown-tool'
  | 'malformed-args'
  | 'tool-failure-repair'
  | 'permanent-failure'
  | 'step-limit'
  | 'unverified-completion';

export class DeterministicDecisionProvider implements AgentDecisionProvider {
  private stepIndex = 0;
  private repaired = false;

  constructor(
    private readonly config:
      | { readonly scenario: ScenarioType }
      | { readonly decisions: readonly AgentDecision[] }
      | { readonly custom: (context: AgentDecisionContext) => Promise<AgentDecision> | AgentDecision }
  ) {}

  async decide(context: AgentDecisionContext): Promise<AgentDecision> {
    if ('custom' in this.config) {
      return this.config.custom(context);
    }

    if ('decisions' in this.config) {
      const decision = this.config.decisions[this.stepIndex];
      if (!decision) {
        return {
          kind: 'complete',
          summary: 'All scripted decisions finished',
        };
      }
      this.stepIndex++;
      return decision;
    }

    const { scenario } = this.config;
    switch (scenario) {
      case 'one-step-success': {
        if (this.stepIndex === 0) {
          this.stepIndex++;
          return {
            kind: 'tool_call',
            toolCall: {
              toolCallId: `call-tests-${context.runId}`,
              toolName: 'run_tests',
              arguments: {},
            },
          };
        }
        return {
          kind: 'complete',
          summary: 'Task completed: tests verified successfully',
        };
      }

      case 'multi-step-success': {
        switch (this.stepIndex) {
          case 0:
            this.stepIndex++;
            return {
              kind: 'plan',
              plan: {
                version: 1,
                steps: ['Inspect files', 'Create task manager component', 'Run build', 'Run tests'],
              },
            };
          case 1:
            this.stepIndex++;
            return {
              kind: 'tool_call',
              toolCall: {
                toolCallId: `call-write-${context.runId}`,
                toolName: 'write_file',
                arguments: {
                  path: 'src/App.tsx',
                  content: 'export const App = () => <div>Task Manager</div>;',
                },
              },
            };
          case 2:
            this.stepIndex++;
            return {
              kind: 'tool_call',
              toolCall: {
                toolCallId: `call-build-${context.runId}`,
                toolName: 'run_build',
                arguments: {},
              },
            };
          case 3:
            this.stepIndex++;
            return {
              kind: 'tool_call',
              toolCall: {
                toolCallId: `call-tests-${context.runId}`,
                toolName: 'run_tests',
                arguments: {},
              },
            };
          default:
            return {
              kind: 'complete',
              summary: 'React task manager created and verified with passing build and tests',
            };
        }
      }

      case 'unknown-tool': {
        return {
          kind: 'tool_call',
          toolCall: {
            toolCallId: `call-unknown-${context.runId}`,
            toolName: 'non_existent_unregistered_tool',
            arguments: {},
          },
        };
      }

      case 'malformed-args': {
        return {
          kind: 'tool_call',
          toolCall: {
            toolCallId: `call-malformed-${context.runId}`,
            toolName: 'write_file',
            arguments: { invalid: 123 },
          },
        };
      }

      case 'tool-failure-repair': {
        if (!this.repaired) {
          if (this.stepIndex === 0) {
            this.stepIndex++;
            return {
              kind: 'tool_call',
              toolCall: {
                toolCallId: `call-write-broken-${context.runId}`,
                toolName: 'write_file',
                arguments: {
                  path: 'src/index.ts',
                  content: 'export const broken = SYNTAX_ERROR;',
                },
              },
            };
          }
          if (this.stepIndex === 1) {
            this.stepIndex++;
            return {
              kind: 'tool_call',
              toolCall: {
                toolCallId: `call-build-fail-${context.runId}`,
                toolName: 'run_build',
                arguments: {},
              },
            };
          }
          // We observed failure in lastStepResult! Repair it!
          if (context.lastStepResult && !context.lastStepResult.success) {
            this.repaired = true;
            return {
              kind: 'tool_call',
              toolCall: {
                toolCallId: `call-repair-${context.runId}`,
                toolName: 'write_file',
                arguments: {
                  path: 'src/index.ts',
                  content: 'export const valid = 42;',
                },
              },
            };
          }
        }

        if (this.repaired) {
          if (this.stepIndex === 2) {
            this.stepIndex++;
            return {
              kind: 'tool_call',
              toolCall: {
                toolCallId: `call-build-pass-${context.runId}`,
                toolName: 'run_build',
                arguments: {},
              },
            };
          }
          return {
            kind: 'complete',
            summary: 'Repaired syntax error and verified build succeeded',
          };
        }

        return {
          kind: 'fail',
          code: 'UNEXPECTED_STATE',
          message: 'Unexpected repair state reached',
        };
      }

      case 'permanent-failure': {
        return {
          kind: 'fail',
          code: 'PERMANENT_ERROR',
          message: 'Task cannot be completed due to unrecoverable errors',
        };
      }

      case 'step-limit': {
        // Keeps calling tools indefinitely to exceed step limit
        this.stepIndex++;
        return {
          kind: 'tool_call',
          toolCall: {
            toolCallId: `call-infinite-${this.stepIndex}-${context.runId}`,
            toolName: 'list_files',
            arguments: {},
          },
        };
      }

      case 'unverified-completion': {
        // Claims complete immediately without any verification tool or passed checks
        return {
          kind: 'complete',
          summary: 'Model says done without running build or tests',
        };
      }
    }
  }
}
