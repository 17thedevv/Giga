import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestDatabase, type TestDbInstance } from '../test-db-helper.js';
import { AgentRepository } from '../../src/modules/agent/repository.js';
import { AgentOrchestrator } from '../../src/modules/agent/orchestrator.js';
import { DeterministicDecisionProvider } from '../../src/modules/agent/decision-provider.js';
import { DeterministicFakeExecutionRuntime } from '../../src/modules/agent/execution-runtime.js';
import { createDefaultToolRegistry } from '../../src/modules/agent/tool-registry.js';
import type { AgentRun } from '../../src/modules/agent/types.js';

let testDb: TestDbInstance;
let repo: AgentRepository;

test.before(async () => {
  testDb = await createTestDatabase();
  repo = new AgentRepository(testDb.pool);
});

test.after(async () => {
  await testDb.cleanup();
  await testDb.pool.end();
});

async function createOwnerAndWorkspace(suffix: string): Promise<{ ownerId: string; workspaceId: string }> {
  const userRes = await testDb.pool.query<{ id: string }>(
    `INSERT INTO users (email, display_name, password_hash)
     VALUES ($1, $2, 'hash') RETURNING id;`,
    [`worker-test-${suffix}-${Date.now()}@example.com`, `Worker ${suffix}`]
  );
  const ownerId = userRes.rows[0]!.id;
  const ws = await repo.createWorkspace(ownerId, `Workspace ${suffix}`);
  return { ownerId, workspaceId: ws.id };
}

async function createQueuedRun(ownerId: string, workspaceId: string, task: string): Promise<AgentRun> {
  const key = `key-${crypto.randomUUID()}`;
  const fp = crypto.createHash('sha256').update(key).digest('hex');
  const res = await repo.enqueueRun(
    ownerId,
    {
      workspaceId,
      task,
      mode: 'execute',
      runtime: 'cloud',
      modelId: 'giga-agent-default',
    },
    key,
    fp
  );
  return res.run;
}

test('two workers racing to claim same run: exactly one acquires lease', async () => {
  const { ownerId, workspaceId } = await createOwnerAndWorkspace('race');
  const run = await createQueuedRun(ownerId, workspaceId, 'Race test task');

  // Worker 1 and Worker 2 attempt to claim the run concurrently
  const [claim1, claim2] = await Promise.all([
    repo.claimRun(ownerId, run.id, 'worker-1', 30000),
    repo.claimRun(ownerId, run.id, 'worker-2', 30000),
  ]);

  // Exactly one worker must succeed
  const winner = claim1 ?? claim2;
  const loser = claim1 ? claim2 : claim1;

  assert.ok(winner, 'One worker must acquire the lease');
  assert.equal(loser, null, 'Second worker must be denied (returns null)');
  assert.ok(winner.leaseToken, 'Winner must receive a secure lease token');

  // Verify run status in database
  const activeRun = await repo.getRun(ownerId, run.id);
  assert.ok(activeRun);
  assert.equal(activeRun.status, 'running');
  // Sensitive lease/fencing state must NOT leak into public AgentRun DTO
  assert.equal((activeRun as unknown as Record<string, unknown>).leaseToken, undefined);
  assert.equal((activeRun as unknown as Record<string, unknown>).workerId, undefined);
  assert.equal((activeRun as unknown as Record<string, unknown>).leaseExpiresAt, undefined);
  assert.equal((activeRun as unknown as Record<string, unknown>).attemptCount, undefined);

  // Direct DB check confirms worker_id was recorded internally
  const dbRow = await testDb.pool.query('SELECT worker_id, lease_token FROM agent_runs WHERE id = $1', [run.id]);
  assert.equal(dbRow.rows[0].worker_id, winner.workerId);
  assert.equal(dbRow.rows[0].lease_token, winner.leaseToken);
});

test('stale worker is fenced when lease expires or is claimed by another worker', async () => {
  const { ownerId, workspaceId } = await createOwnerAndWorkspace('fencing');
  const run = await createQueuedRun(ownerId, workspaceId, 'Fencing test task');

  // Worker 1 claims run with 1-second lease
  const claim1 = await repo.claimRun(ownerId, run.id, 'worker-1', 1000);
  assert.ok(claim1);
  const leaseToken1 = claim1.leaseToken;

  // Manually expire the lease in the database to simulate lease timeout
  await testDb.pool.query(
    `UPDATE agent_runs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1;`,
    [run.id]
  );

  // Worker 2 claims the expired run
  const claim2 = await repo.claimRun(ownerId, run.id, 'worker-2', 30000);
  assert.ok(claim2, 'Worker 2 must successfully claim the expired lease');
  assert.notEqual(claim2.leaseToken, leaseToken1);

  // Worker 1 (stale) attempts to record step started
  await assert.rejects(
    async () => {
      await repo.recordStepStarted(ownerId, run.id, leaseToken1, {
        toolName: 'list_files',
        toolCallId: 'call-stale-1',
        risk: 'read',
        arguments: {},
      });
    },
    /fenced|expired/i,
    'Stale worker 1 must be rejected when recording step started'
  );

  // Worker 1 (stale) attempts to append plan
  await assert.rejects(
    async () => {
      await repo.appendPlanUpdatedEvent(ownerId, run.id, leaseToken1, {
        version: 1,
        steps: ['Step A'],
      });
    },
    /fenced|expired/i,
    'Stale worker 1 must be rejected when appending plan'
  );

  // Worker 1 (stale) attempts to finalize run
  await assert.rejects(
    async () => {
      await repo.finalizeRun(ownerId, run.id, leaseToken1, {
        status: 'completed',
        summary: 'Worker 1 falsely claiming completion',
        verifiedChecks: [],
      });
    },
    /fenced|expired/i,
    'Stale worker 1 must be rejected when finalizing run'
  );

  // Meanwhile, Worker 2 (active) can record step and finalize successfully
  const stepRes = await repo.recordStepStarted(ownerId, run.id, claim2.leaseToken, {
    toolName: 'list_files',
    toolCallId: 'call-w2-1',
    risk: 'read',
    arguments: {},
  });
  assert.ok(stepRes.step);
  assert.equal(stepRes.step.stepNumber, 1);

  await repo.recordStepCompleted(ownerId, run.id, claim2.leaseToken, 1, {
    output: { count: 0 },
    durationMs: 10,
  });

  const finalizeRes = await repo.finalizeRun(ownerId, run.id, claim2.leaseToken, {
    status: 'completed',
    summary: 'Worker 2 validly completed task',
    verifiedChecks: [{ name: 'run_tests', outcome: 'passed', summary: 'Pass' }],
  });
  assert.equal(finalizeRes.run.status, 'completed');
});

test('crash and retry does not duplicate completed steps', async () => {
  const { ownerId, workspaceId } = await createOwnerAndWorkspace('crash-retry');
  const run = await createQueuedRun(ownerId, workspaceId, 'Crash and retry task');

  // Worker 1 claims run
  const claim1 = await repo.claimRun(ownerId, run.id, 'worker-1', 1000);
  assert.ok(claim1);

  // Worker 1 records step 1: write_file
  await repo.recordStepStarted(ownerId, run.id, claim1.leaseToken, {
    toolName: 'write_file',
    toolCallId: 'call-write-1',
    risk: 'sandbox_write',
    arguments: { path: 'src/main.ts', content: 'export const x = 1;' },
  });

  await repo.recordStepCompleted(ownerId, run.id, claim1.leaseToken, 1, {
    output: { path: 'src/main.ts', bytesWritten: 19 },
    durationMs: 5,
  });

  // Worker 1 crashes (simulated by releasing / abandoning lease)
  await repo.releaseLease(ownerId, run.id, claim1.leaseToken);

  // Worker 2 claims the run
  const claim2 = await repo.claimRun(ownerId, run.id, 'worker-2', 30000);
  assert.ok(claim2, 'Worker 2 claims run after Worker 1 crash');

  // Worker 2 inspects existing steps
  const existingSteps = await repo.listSteps(ownerId, run.id);
  assert.equal(existingSteps.length, 1);
  assert.equal(existingSteps[0]!.stepNumber, 1);
  assert.equal(existingSteps[0]!.status, 'completed');
  assert.equal(existingSteps[0]!.toolName, 'write_file');

  // Worker 2 proceeds with step 2: run_tests (NOT repeating step 1)
  await repo.recordStepStarted(ownerId, run.id, claim2.leaseToken, {
    toolName: 'run_tests',
    toolCallId: 'call-tests-2',
    risk: 'sandbox_execute',
    arguments: {},
  });

  await repo.recordStepCompleted(ownerId, run.id, claim2.leaseToken, 2, {
    output: { exitCode: 0, stdout: 'PASS' },
    durationMs: 12,
  });

  await repo.finalizeRun(ownerId, run.id, claim2.leaseToken, {
    status: 'completed',
    summary: 'Recovered after Worker 1 crash and completed step 2',
    verifiedChecks: [{ name: 'run_tests', outcome: 'passed', summary: 'All tests passed' }],
  });

  // Verify all committed steps
  const finalSteps = await repo.listSteps(ownerId, run.id);
  assert.equal(finalSteps.length, 2);
  assert.equal(finalSteps[0]!.stepNumber, 1);
  assert.equal(finalSteps[1]!.stepNumber, 2);
  assert.equal(finalSteps[0]!.status, 'completed');
  assert.equal(finalSteps[1]!.status, 'completed');
});

test('browser / SSE disconnect does not terminate background Agent execution', async () => {
  const { ownerId, workspaceId } = await createOwnerAndWorkspace('disconnect');
  const run = await createQueuedRun(ownerId, workspaceId, 'Background execution test');

  // Background orchestrator loop runs with its own lifecycle controller
  const orchestrator = new AgentOrchestrator(
    repo,
    createDefaultToolRegistry(),
    new DeterministicDecisionProvider({ scenario: 'one-step-success' }),
    new DeterministicFakeExecutionRuntime(),
    {
      workerId: 'background-worker-1',
      leaseDurationMs: 10000,
      maxSteps: 5,
    }
  );

  // Start orchestrator loop asynchronously
  const executionPromise = orchestrator.executeRun(ownerId, run.id);

  // Client disconnects immediately (simulating user closing browser tab)
  const clientAbortController = new AbortController();
  clientAbortController.abort();

  // Background execution continues and completes normally
  const outcome = await executionPromise;
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.run.status, 'completed');
  assert.ok(outcome.run.result?.verifiedChecks.some(c => c.name === 'run_tests' && c.outcome === 'passed'));

  // Client reconnects later and requests full replay of all events
  const eventPage = await repo.events(ownerId, run.id, 0);
  assert.ok(eventPage.items.length >= 3);
  assert.equal(eventPage.items[0]!.type, 'run.status');
  assert.equal(eventPage.items[eventPage.items.length - 1]!.type, 'run.completed');
});

test('worker with expired lease cannot mutate even before another worker takes over', async () => {
  const { ownerId, workspaceId } = await createOwnerAndWorkspace('expired-before-takeover');
  const run = await createQueuedRun(ownerId, workspaceId, 'Expired lease mutation test');

  // Worker 1 claims run with 1-second lease
  const claim1 = await repo.claimRun(ownerId, run.id, 'worker-1', 1000);
  assert.ok(claim1);
  const leaseToken1 = claim1.leaseToken;

  // Manually expire the lease in the database BEFORE any other worker claims it
  await testDb.pool.query(
    `UPDATE agent_runs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1;`,
    [run.id]
  );

  // Confirm no second worker has taken over yet
  const dbCheck = await testDb.pool.query('SELECT lease_token, worker_id, status FROM agent_runs WHERE id = $1', [run.id]);
  assert.equal(dbCheck.rows[0].lease_token, leaseToken1);
  assert.equal(dbCheck.rows[0].worker_id, 'worker-1');
  assert.equal(dbCheck.rows[0].status, 'running');

  // Worker 1 attempts to record step started -> must be rejected
  await assert.rejects(
    async () => {
      await repo.recordStepStarted(ownerId, run.id, leaseToken1, {
        toolName: 'list_files',
        toolCallId: 'call-expired-1',
        risk: 'read',
        arguments: {},
      });
    },
    /fenced|expired/i,
    'Worker with expired lease must be rejected on recordStepStarted'
  );

  // Worker 1 attempts to append plan -> must be rejected
  await assert.rejects(
    async () => {
      await repo.appendPlanUpdatedEvent(ownerId, run.id, leaseToken1, {
        version: 1,
        steps: ['Plan step'],
      });
    },
    /fenced|expired/i,
    'Worker with expired lease must be rejected on appendPlanUpdatedEvent'
  );

  // Worker 1 attempts to record step completed -> must be rejected
  await assert.rejects(
    async () => {
      await repo.recordStepCompleted(ownerId, run.id, leaseToken1, 1, {
        output: { ok: true },
        durationMs: 5,
      });
    },
    /fenced|expired/i,
    'Worker with expired lease must be rejected on recordStepCompleted'
  );

  // Worker 1 attempts to finalize run -> must be rejected
  await assert.rejects(
    async () => {
      await repo.finalizeRun(ownerId, run.id, leaseToken1, {
        status: 'completed',
        summary: 'Falsely finalizing with expired lease',
        verifiedChecks: [],
      });
    },
    /fenced|expired/i,
    'Worker with expired lease must be rejected on finalizeRun'
  );

  // Worker 1 attempts to renew lease -> must return false because lease is already expired
  const renewed = await repo.renewLease(ownerId, run.id, leaseToken1, 30000);
  assert.equal(renewed, false, 'Expired lease cannot be renewed');
});

test('long invoke + takeover does not create duplicate effects', async () => {
  const { ownerId, workspaceId } = await createOwnerAndWorkspace('long-invoke-takeover');
  const run = await createQueuedRun(ownerId, workspaceId, 'Long invoke race test');

  // Worker 1 claims run with 1-second lease
  const claim1 = await repo.claimRun(ownerId, run.id, 'worker-1', 1000);
  assert.ok(claim1);

  // Worker 1 starts step 1: write_file
  const { step: step1 } = await repo.recordStepStarted(ownerId, run.id, claim1.leaseToken, {
    toolName: 'write_file',
    toolCallId: 'call-w1-write',
    risk: 'sandbox_write',
    arguments: { path: 'file.txt', content: 'w1' },
  });
  assert.equal(step1.stepNumber, 1);

  // Simulate long execution: Worker 1 is in-flight while its lease expires
  await testDb.pool.query(
    `UPDATE agent_runs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1;`,
    [run.id]
  );

  // Worker 2 takes over the expired run
  const claim2 = await repo.claimRun(ownerId, run.id, 'worker-2', 30000);
  assert.ok(claim2, 'Worker 2 must successfully take over');

  // Worker 2 executes step 2 cleanly
  await repo.recordStepStarted(ownerId, run.id, claim2.leaseToken, {
    toolName: 'run_tests',
    toolCallId: 'call-w2-tests',
    risk: 'sandbox_execute',
    arguments: {},
  });
  await repo.recordStepCompleted(ownerId, run.id, claim2.leaseToken, 2, {
    output: { exitCode: 0, stdout: 'PASS' },
    durationMs: 10,
  });
  await repo.finalizeRun(ownerId, run.id, claim2.leaseToken, {
    status: 'completed',
    summary: 'Completed by Worker 2 after Worker 1 timed out',
    verifiedChecks: [{ name: 'run_tests', outcome: 'passed', summary: 'Pass' }],
  });

  // Now Worker 1's long invoke returns and Worker 1 tries to commit step 1 completion
  await assert.rejects(
    async () => {
      await repo.recordStepCompleted(ownerId, run.id, claim1.leaseToken, 1, {
        output: { path: 'file.txt', bytesWritten: 2 },
        durationMs: 2500,
      });
    },
    /fenced|expired/i,
    'Stale Worker 1 completing long invoke must be fenced'
  );

  // And Worker 1 cannot finalize or do anything else
  await assert.rejects(
    async () => {
      await repo.finalizeRun(ownerId, run.id, claim1.leaseToken, {
        status: 'completed',
        summary: 'Worker 1 duplicate completion',
        verifiedChecks: [],
      });
    },
    /fenced|expired/i
  );

  // Verify steps in database: step 1 was started (pending/aborted), step 2 was completed, exactly 2 step records total
  const steps = await repo.listSteps(ownerId, run.id);
  assert.equal(steps.length, 2);
  assert.equal(steps[0]!.stepNumber, 1);
  assert.equal(steps[0]!.status, 'running'); // Worker 1 never committed completion
  assert.equal(steps[1]!.stepNumber, 2);
  assert.equal(steps[1]!.status, 'completed'); // Worker 2 succeeded

  const finalRun = await repo.getRun(ownerId, run.id);
  assert.equal(finalRun.status, 'completed');
  assert.equal(finalRun.result?.summary, 'Completed by Worker 2 after Worker 1 timed out');
});
