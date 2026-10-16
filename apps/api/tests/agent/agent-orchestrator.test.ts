import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDbInstance } from '../test-db-helper.js';
import { AgentRepository } from '../../src/modules/agent/repository.js';
import { createDefaultToolRegistry } from '../../src/modules/agent/tool-registry.js';
import { DeterministicFakeExecutionRuntime } from '../../src/modules/agent/execution-runtime.js';
import { DeterministicDecisionProvider } from '../../src/modules/agent/decision-provider.js';
import { AgentOrchestrator } from '../../src/modules/agent/orchestrator.js';
import type { AgentRun, AgentMode } from '../../src/modules/agent/types.js';

describe('GigaAgent Durable Orchestrator & Deterministic Fake Runtime', () => {
  let db: TestDbInstance;
  let owner: string;
  let other: string;
  let workspaceId: string;
  let repository: AgentRepository;

  before(async () => {
    db = await createTestDatabase();
  });

  after(async () => {
    await db.cleanup();
    await db.pool.end();
  });

  beforeEach(async () => {
    await db.cleanup();
    owner = randomUUID();
    other = randomUUID();
    for (const id of [owner, other]) {
      await db.pool.query(
        "INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, 'User', 'unused')",
        [id, `${id}@example.com`]
      );
    }
    repository = new AgentRepository(db.pool);
    const ws = await repository.createWorkspace(owner, 'Test Workspace');
    workspaceId = ws.id;
  });

  async function enqueue(mode: AgentMode = 'execute', task = 'Build React app'): Promise<AgentRun> {
    const key = randomUUID();
    const result = await repository.enqueueRun(
      owner,
      { workspaceId, task, mode, runtime: 'cloud', modelId: 'giga-agent-default' },
      key,
      'f'.repeat(64)
    );
    return result.run;
  }

  it('executes queued -> running -> completed with one-step success and verified check', async () => {
    const run = await enqueue('execute', 'Run tests and finish');
    assert.equal(run.status, 'queued');

    const runtime = new DeterministicFakeExecutionRuntime();
    const decisionProvider = new DeterministicDecisionProvider({ scenario: 'one-step-success' });
    const registry = createDefaultToolRegistry();
    const orchestrator = new AgentOrchestrator(repository, registry, decisionProvider, runtime);

    const outcome = await orchestrator.executeRun(owner, run.id);
    assert.equal(outcome.status, 'completed');
    if (outcome.status === 'completed') {
      assert.equal(outcome.run.status, 'completed');
      assert.ok(outcome.run.finishedAt);
      assert.equal(outcome.run.result?.summary, 'Task completed: tests verified successfully');
      assert.equal(outcome.run.result?.verifiedChecks.length, 1);
      assert.equal(outcome.run.result?.verifiedChecks[0]!.name, 'run_tests');
      assert.equal(outcome.run.result?.verifiedChecks[0]!.outcome, 'passed');
    }

    // Verify persisted steps
    const steps = await repository.listSteps(owner, run.id);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.stepNumber, 1);
    assert.equal(steps[0]!.toolName, 'run_tests');
    assert.equal(steps[0]!.status, 'completed');

    // Verify persisted events sequence
    const { items: events } = await repository.events(owner, run.id, 0);
    assert.deepEqual(
      events.map((e) => e.type),
      ['run.status', 'run.status', 'tool.started', 'tool.completed', 'run.completed']
    );
    assert.equal(events[0]!.sequence, 1);
    assert.equal(events[1]!.sequence, 2);
    assert.equal(events[4]!.sequence, 5);
  });

  it('completes multi-step execution: plan.updated -> write_file -> run_build -> run_tests -> completed', async () => {
    const run = await enqueue('execute', 'Create React task manager');

    const runtime = new DeterministicFakeExecutionRuntime();
    const decisionProvider = new DeterministicDecisionProvider({ scenario: 'multi-step-success' });
    const registry = createDefaultToolRegistry();
    const orchestrator = new AgentOrchestrator(repository, registry, decisionProvider, runtime);

    const outcome = await orchestrator.executeRun(owner, run.id);
    assert.equal(outcome.status, 'completed');

    // Verify in-memory runtime file was written
    const fileContent = runtime.getFile(`fake-session-${run.id}`, 'src/App.tsx');
    assert.equal(fileContent, 'export const App = () => <div>Task Manager</div>;');

    // Verify steps
    const steps = await repository.listSteps(owner, run.id);
    assert.equal(steps.length, 3);
    assert.equal(steps[0]!.toolName, 'write_file');
    assert.equal(steps[0]!.status, 'completed');
    assert.equal(steps[1]!.toolName, 'run_build');
    assert.equal(steps[1]!.status, 'completed');
    assert.equal(steps[2]!.toolName, 'run_tests');
    assert.equal(steps[2]!.status, 'completed');

    // Verify event ordering
    const { items: events } = await repository.events(owner, run.id, 0);
    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      'run.status', // queued
      'run.status', // running
      'plan.updated',
      'tool.started', // write_file
      'tool.completed',
      'tool.started', // run_build
      'tool.completed',
      'tool.started', // run_tests
      'tool.completed',
      'run.completed',
    ]);
  });

  it('Ask mode denies write and execution tools before runtime dispatch', async () => {
    const run = await enqueue('ask', 'Attempt to write files in ask mode');
    const runtime = new DeterministicFakeExecutionRuntime();
    const decisionProvider = new DeterministicDecisionProvider({
      decisions: [
        {
          kind: 'tool_call',
          toolCall: {
            toolCallId: 'call-ask-write',
            toolName: 'write_file',
            arguments: { path: 'test.txt', content: 'forbidden' },
          },
        },
      ],
    });
    const registry = createDefaultToolRegistry();
    const orchestrator = new AgentOrchestrator(repository, registry, decisionProvider, runtime, { maxRepairs: 0 });

    const outcome = await orchestrator.executeRun(owner, run.id);
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') {
      assert.equal(outcome.run.status, 'failed');
      assert.equal(outcome.run.error?.code, 'POLICY_VIOLATION');
    }

    // Verify runtime received no files
    assert.equal(runtime.getFile(`fake-session-${run.id}`, 'test.txt'), undefined);

    // Verify failed step was persisted with safe error
    const steps = await repository.listSteps(owner, run.id);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.status, 'failed');
    assert.equal(steps[0]!.errorCode, 'POLICY_VIOLATION');
  });

  it('Plan mode allows read tools but denies write and execution tools', async () => {
    const run = await enqueue('plan', 'Inspect workspace without modifying');
    const runtime = new DeterministicFakeExecutionRuntime({
      initialFiles: { 'README.md': '# Project' },
    });
    const decisionProvider = new DeterministicDecisionProvider({
      decisions: [
        {
          kind: 'tool_call',
          toolCall: {
            toolCallId: 'call-plan-read',
            toolName: 'read_file',
            arguments: { path: 'README.md' },
          },
        },
        {
          kind: 'tool_call',
          toolCall: {
            toolCallId: 'call-plan-build',
            toolName: 'run_build',
            arguments: {},
          },
        },
      ],
    });
    const registry = createDefaultToolRegistry();
    const orchestrator = new AgentOrchestrator(repository, registry, decisionProvider, runtime, { maxRepairs: 0 });

    const outcome = await orchestrator.executeRun(owner, run.id);
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') {
      assert.equal(outcome.run.status, 'failed');
      assert.equal(outcome.run.error?.code, 'POLICY_VIOLATION');
    }

    const steps = await repository.listSteps(owner, run.id);
    assert.equal(steps.length, 2);
    assert.equal(steps[0]!.toolName, 'read_file');
    assert.equal(steps[0]!.status, 'completed');
    assert.equal(steps[1]!.toolName, 'run_build');
    assert.equal(steps[1]!.status, 'failed');
    assert.equal(steps[1]!.errorCode, 'POLICY_VIOLATION');
  });

  it('rejects unknown tool name before execution runtime dispatch', async () => {
    const run = await enqueue('execute');
    const runtime = new DeterministicFakeExecutionRuntime();
    const decisionProvider = new DeterministicDecisionProvider({ scenario: 'unknown-tool' });
    const registry = createDefaultToolRegistry();
    const orchestrator = new AgentOrchestrator(repository, registry, decisionProvider, runtime, { maxRepairs: 0 });

    const outcome = await orchestrator.executeRun(owner, run.id);
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') {
      assert.equal(outcome.run.error?.code, 'UNKNOWN_TOOL');
    }

    const steps = await repository.listSteps(owner, run.id);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.status, 'failed');
    assert.equal(steps[0]!.errorCode, 'UNKNOWN_TOOL');
  });

  it('rejects malformed arguments before runtime dispatch', async () => {
    const run = await enqueue('execute');
    const runtime = new DeterministicFakeExecutionRuntime();
    const decisionProvider = new DeterministicDecisionProvider({ scenario: 'malformed-args' });
    const registry = createDefaultToolRegistry();
    const orchestrator = new AgentOrchestrator(repository, registry, decisionProvider, runtime, { maxRepairs: 0 });

    const outcome = await orchestrator.executeRun(owner, run.id);
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') {
      assert.equal(outcome.run.error?.code, 'INVALID_ARGUMENTS');
    }

    const steps = await repository.listSteps(owner, run.id);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.status, 'failed');
    assert.equal(steps[0]!.errorCode, 'INVALID_ARGUMENTS');
  });

  it('handles tool failure then repair then verified success', async () => {
    const run = await enqueue('execute', 'Write code and repair build error');
    const runtime = new DeterministicFakeExecutionRuntime();
    const decisionProvider = new DeterministicDecisionProvider({ scenario: 'tool-failure-repair' });
    const registry = createDefaultToolRegistry();
    const orchestrator = new AgentOrchestrator(repository, registry, decisionProvider, runtime);

    const outcome = await orchestrator.executeRun(owner, run.id);
    assert.equal(outcome.status, 'completed');

    const steps = await repository.listSteps(owner, run.id);
    assert.equal(steps.length, 4);
    assert.equal(steps[0]!.toolName, 'write_file');
    assert.equal(steps[0]!.status, 'completed');
    // First build failed!
    assert.equal(steps[1]!.toolName, 'run_build');
    assert.equal(steps[1]!.status, 'failed');
    assert.equal(steps[1]!.errorCode, 'BUILD_FAILED');
    // Repair write
    assert.equal(steps[2]!.toolName, 'write_file');
    assert.equal(steps[2]!.status, 'completed');
    // Second build passed!
    assert.equal(steps[3]!.toolName, 'run_build');
    assert.equal(steps[3]!.status, 'completed');
  });

  it('stops truthfully with permanent failure', async () => {
    const run = await enqueue('execute');
    const runtime = new DeterministicFakeExecutionRuntime();
    const decisionProvider = new DeterministicDecisionProvider({ scenario: 'permanent-failure' });
    const registry = createDefaultToolRegistry();
    const orchestrator = new AgentOrchestrator(repository, registry, decisionProvider, runtime);

    const outcome = await orchestrator.executeRun(owner, run.id);
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') {
      assert.equal(outcome.run.status, 'failed');
      assert.equal(outcome.run.error?.code, 'PERMANENT_ERROR');
    }
  });

  it('enforces step/budget limit truthfully with STEP_LIMIT_EXCEEDED', async () => {
    const run = await enqueue('execute');
    const runtime = new DeterministicFakeExecutionRuntime();
    const decisionProvider = new DeterministicDecisionProvider({ scenario: 'step-limit' });
    const registry = createDefaultToolRegistry();
    const orchestrator = new AgentOrchestrator(repository, registry, decisionProvider, runtime, { maxSteps: 3 });

    const outcome = await orchestrator.executeRun(owner, run.id);
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') {
      assert.equal(outcome.run.status, 'failed');
      assert.equal(outcome.run.error?.code, 'STEP_LIMIT_EXCEEDED');
    }

    const steps = await repository.listSteps(owner, run.id);
    assert.equal(steps.length, 3);
  });

  it('denies completion when fake runtime provides no passed verification evidence', async () => {
    const run = await enqueue('execute');
    const runtime = new DeterministicFakeExecutionRuntime();
    const decisionProvider = new DeterministicDecisionProvider({ scenario: 'unverified-completion' });
    const registry = createDefaultToolRegistry();
    const orchestrator = new AgentOrchestrator(repository, registry, decisionProvider, runtime);

    const outcome = await orchestrator.executeRun(owner, run.id);
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') {
      assert.equal(outcome.run.status, 'failed');
      assert.equal(outcome.run.error?.code, 'VERIFICATION_FAILED');
    }
  });

  it('aborts execution runtime and marks run cancelled upon AbortSignal', async () => {
    const run = await enqueue('execute');
    const runtime = new DeterministicFakeExecutionRuntime();
    const controller = new AbortController();
    const decisionProvider = new DeterministicDecisionProvider({
      custom: () => {
        controller.abort();
        return {
          kind: 'tool_call',
          toolCall: {
            toolCallId: 'call-during-abort',
            toolName: 'list_files',
            arguments: {},
          },
        };
      },
    });
    const registry = createDefaultToolRegistry();
    const orchestrator = new AgentOrchestrator(repository, registry, decisionProvider, runtime);

    const outcome = await orchestrator.executeRun(owner, run.id, controller.signal);
    assert.equal(outcome.status, 'cancelled');
    if (outcome.status === 'cancelled') {
      assert.equal(outcome.run.status, 'cancelled');
      assert.ok(outcome.run.finishedAt);
    }
  });

  it('isolates steps and events between owners: User B cannot access User A steps', async () => {
    const run = await enqueue('execute');
    const runtime = new DeterministicFakeExecutionRuntime();
    const decisionProvider = new DeterministicDecisionProvider({ scenario: 'one-step-success' });
    const registry = createDefaultToolRegistry();
    const orchestrator = new AgentOrchestrator(repository, registry, decisionProvider, runtime);

    await orchestrator.executeRun(owner, run.id);

    // Owner can access steps
    const ownerSteps = await repository.listSteps(owner, run.id);
    assert.equal(ownerSteps.length, 1);

    // Other user cannot access steps (throws NotFoundError)
    await assert.rejects(repository.listSteps(other, run.id), { code: 'NOT_FOUND' });

    // Other user cannot read events
    await assert.rejects(repository.events(other, run.id, 0), { code: 'NOT_FOUND' });
  });

  it('durable SSE replay through plan, tool and completion', async () => {
    const run = await enqueue('execute');
    const runtime = new DeterministicFakeExecutionRuntime();
    const decisionProvider = new DeterministicDecisionProvider({ scenario: 'one-step-success' });
    const registry = createDefaultToolRegistry();
    const orchestrator = new AgentOrchestrator(repository, registry, decisionProvider, runtime);

    await orchestrator.executeRun(owner, run.id);

    // Replay from start (after = 0)
    const page0 = await repository.events(owner, run.id, 0);
    assert.equal(page0.items.length, 5);
    assert.deepEqual(
      page0.items.map((e) => e.type),
      ['run.status', 'run.status', 'tool.started', 'tool.completed', 'run.completed']
    );

    // Replay after sequence 3
    const page3 = await repository.events(owner, run.id, 3);
    assert.equal(page3.items.length, 2);
    assert.equal(page3.items[0]!.sequence, 4);
    assert.equal(page3.items[0]!.type, 'tool.completed');
    assert.equal(page3.items[1]!.sequence, 5);
    assert.equal(page3.items[1]!.type, 'run.completed');
  });
});
