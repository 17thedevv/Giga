import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import ts from 'typescript';
import { createTestDatabase, type TestDbInstance } from '../test-db-helper.js';
import { AgentRepository } from '../../src/modules/agent/repository.js';
import { AgentService } from '../../src/modules/agent/service.js';
import { AGENT_MODEL_ALIAS } from '../../src/modules/agent/types.js';
import { UnavailableExecutionRuntime, type ExecutionRuntime } from '../../src/modules/agent/execution-runtime.js';

it('execution port returns unavailable without executing task text; Agent sources contain no host execution or Chat/provider path', async () => {
  const runtime: ExecutionRuntime = new UnavailableExecutionRuntime();
  assert.deepEqual(await runtime.prepare({ runId: randomUUID(), workspaceId: randomUUID(), ownerId: randomUUID(),
    mode: 'execute', task: 'run arbitrary host commands', modelId: AGENT_MODEL_ALIAS, signal: new AbortController().signal }),
  { available: false, code: 'RUNTIME_UNAVAILABLE' });
  const root = new URL('../../src/modules/agent/', import.meta.url);
  for (const name of await readdir(root)) {
    if (!name.endsWith('.ts')) continue;
    const content = await readFile(new URL(name, root), 'utf8');
    const source = ts.createSourceFile(name, content, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const imported = node.moduleSpecifier.text;
        assert.doesNotMatch(imported, /child_process|worker_threads|node:vm|node:fs|shell|execa|cross-spawn|\/chat\/|\/credentials\/|\/llm\//);
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        assert.doesNotMatch(node.expression.getText(source), /^(eval|Function|require|import)$|process\.(binding|dlopen)/);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});

describe('Agent PostgreSQL constraints and terminal fencing', () => {
  let db: TestDbInstance; let owner: string; let other: string; let workspaceId: string;
  let repository: AgentRepository; let service: AgentService;
  before(async () => { db = await createTestDatabase(); });
  after(async () => { await db.cleanup(); await db.pool.end(); });
  beforeEach(async () => {
    await db.cleanup(); owner = randomUUID(); other = randomUUID();
    for (const id of [owner, other]) await db.pool.query("INSERT INTO users (id,email,display_name,password_hash) VALUES ($1,$2,'Test','unused')", [id, `${id}@example.com`]);
    repository = new AgentRepository(db.pool); service = new AgentService(repository);
    workspaceId = (await service.createWorkspace(owner, { source: { kind: 'blank' } })).id;
  });

  it('real PostgreSQL rejects mismatched owner FKs and inconsistent terminal status/timestamps', async (t) => {
    if (db.isMemory) return t.skip('Requires PostgreSQL composite FK and CHECK enforcement');
    for (const [user, mode, runtime, status, finishedAt, code] of [
      [other, 'ask', 'cloud', 'queued', null, null], [owner, 'invalid', 'cloud', 'queued', null, null],
      [owner, 'ask', 'local', 'queued', null, null], [owner, 'ask', 'cloud', 'invalid', null, null],
      [owner, 'ask', 'cloud', 'completed', null, null], [owner, 'ask', 'cloud', 'failed', new Date(), null],
      [owner, 'ask', 'cloud', 'queued', new Date(), null],
    ] as const) {
      await assert.rejects(db.pool.query(`INSERT INTO agent_runs
        (owner_id,workspace_id,task,mode,runtime,model_alias,status,finished_at,error_code,idempotency_key,request_fingerprint)
        VALUES ($1,$2,'Question',$3,$4,$5,$6,$7,$8,$9,$10)`, [user, workspaceId, mode, runtime, AGENT_MODEL_ALIAS, status, finishedAt, code, randomUUID(), 'f'.repeat(64)]));
    }
    const created = await service.createRun(owner, { workspaceId, task: 'Question' }, randomUUID());
    await assert.rejects(db.pool.query(`INSERT INTO agent_run_events (owner_id,run_id,sequence,event_type,status,error_code)
      VALUES ($1,$2,3,'run.failed','failed','RUNTIME_UNAVAILABLE')`, [other, created.run.id]));
  });

  it('real PostgreSQL fences terminal rewrites, gaps, duplicates, state mismatch and event mutation', async (t) => {
    if (db.isMemory) return t.skip('Requires PostgreSQL PL/pgSQL trigger enforcement');
    const created = await service.createRun(owner, { workspaceId, task: 'Question' }, randomUUID());
    for (const sql of ["UPDATE agent_runs SET status = 'queued', finished_at = NULL, error_code = NULL WHERE id = $1",
      "UPDATE agent_runs SET task = 'Changed' WHERE id = $1", 'UPDATE agent_runs SET last_event_id = 3 WHERE id = $1',
      "UPDATE agent_run_events SET status = 'running' WHERE run_id = $1"]) {
      await assert.rejects(db.pool.query(sql, [created.run.id]));
    }
    for (const sequence of [0, 1, 3, 10]) {
      await assert.rejects(db.pool.query(`INSERT INTO agent_run_events (owner_id,run_id,sequence,event_type,status,error_code)
        VALUES ($1,$2,$3,'run.failed','failed','RUNTIME_UNAVAILABLE')`, [owner, created.run.id, sequence]));
    }
    const pendingId = randomUUID();
    await db.pool.query(`INSERT INTO agent_runs (id,owner_id,workspace_id,task,mode,runtime,model_alias,status,last_event_id,idempotency_key,request_fingerprint)
      VALUES ($1,$2,$3,'Pending','ask','cloud',$4,'queued',1,$5,$6)`, [pendingId, owner, workspaceId, AGENT_MODEL_ALIAS, randomUUID(), 'f'.repeat(64)]);
    await assert.rejects(db.pool.query("INSERT INTO agent_run_events (owner_id,run_id,sequence,event_type,status) VALUES ($1,$2,1,'run.status','running')",
      [owner, pendingId]), /event must match/);
    assert.deepEqual((await repository.events(owner, created.run.id, 0)).items.map((event) => event.sequence), [1, 2]);
    const indexes = await db.pool.query("SELECT indexname FROM pg_indexes WHERE tablename IN ('agent_workspaces','agent_runs','agent_run_events')");
    for (const name of ['idx_agent_workspace_history', 'idx_agent_run_history', 'idx_agent_workspace_runs', 'idx_agent_event_replay']) {
      assert.ok(indexes.rows.some((row) => row.indexname === name));
    }
  });

  it('real PostgreSQL arbitrates conflicting keys across different owned workspaces', async (t) => {
    if (db.isMemory) return t.skip('Requires PostgreSQL concurrent unique arbitration');
    const second = (await service.createWorkspace(owner, { source: { kind: 'blank' } })).id;
    const key = randomUUID();
    const results = await Promise.allSettled([workspaceId, second].map((id) => service.createRun(owner, { workspaceId: id, task: 'Question' }, key)));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected?.status === 'rejected' && rejected.reason.code, 'CONFLICT');
    assert.equal((await db.pool.query('SELECT id FROM agent_runs WHERE owner_id = $1', [owner])).rows.length, 1);
    assert.equal((await db.pool.query('SELECT sequence FROM agent_run_events WHERE owner_id = $1', [owner])).rows.length, 2);
  });
});
