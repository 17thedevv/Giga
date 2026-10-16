import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { createTestDatabase, type TestDbInstance } from '../test-db-helper.js';
import { createApp } from '../../src/app/create-app.js';
import { startServer } from '../../src/app/server.js';
import { loadConfig } from '../../src/app/config.js';
import { UserRepository } from '../../src/db/repositories/user-repository.js';
import { SessionRepository } from '../../src/db/repositories/session-repository.js';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../../src/modules/auth/session.js';
import { AgentRepository } from '../../src/modules/agent/repository.js';
import { AgentService } from '../../src/modules/agent/service.js';
import { AGENT_MODEL_ALIAS, RUNTIME_UNAVAILABLE, type AgentRun } from '../../src/modules/agent/types.js';
import { observeEvents } from '../../src/modules/agent/sse.js';

const origin = 'http://localhost:3000';
describe('GigaAgent owner-scoped control plane', { timeout: 30000 }, () => {
  let db: TestDbInstance; let owner: string; let other: string; let cookie: string; let otherCookie: string;
  let app: ReturnType<typeof createApp>; let repo: AgentRepository; let service: AgentService; let workspaceId: string;
  before(async () => { db = await createTestDatabase(); });
  after(async () => { await db.cleanup(); await db.pool.end(); });
  beforeEach(async () => {
    await db.cleanup();
    const users = new UserRepository(db.pool);
    async function user(): Promise<{ id: string; cookie: string }> {
      const id = (await users.createUser({ email: `${randomUUID()}@example.com`, displayName: 'Agent test', passwordHash: 'unused' })).id;
      const token = generateSessionToken();
      await new SessionRepository(db.pool).createSession({ userId: id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60000) });
      return { id, cookie: `${SESSION_COOKIE_NAME}=${token}` };
    }
    const a = await user(); const b = await user(); owner = a.id; other = b.id; cookie = a.cookie; otherCookie = b.cookie;
    repo = new AgentRepository(db.pool); service = new AgentService(repo);
    workspaceId = (await service.createWorkspace(owner, { source: { kind: 'blank' } })).id;
    app = createApp({ pool: db.pool, config: { nodeEnv: 'test', allowedOrigins: [origin] } });
  });
  function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    return app.request(`/api/v1/agent${path}`, { method, headers: { Cookie: cookie, Origin: origin,
      'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function admit(mode = 'ask', key = randomUUID()): Promise<AgentRun> {
    const response = await request('/runs', 'POST', { workspaceId, task: 'Explain this task', mode }, { 'Idempotency-Key': key });
    assert.equal(response.status, 201); return (await response.json()).run;
  }
  async function pending(): Promise<string> {
    const id = randomUUID();
    // Deterministic test orchestration only; no sandbox or successful execution is simulated.
    await db.pool.query(`INSERT INTO agent_runs (id,owner_id,workspace_id,task,mode,runtime,model_alias,status,last_event_id,idempotency_key,request_fingerprint)
      VALUES ($1,$2,$3,'Pending fixture','execute','cloud',$4,'queued',1,$5,$6)`, [id, owner, workspaceId, AGENT_MODEL_ALIAS, randomUUID(), 'f'.repeat(64)]);
    await db.pool.query("INSERT INTO agent_run_events (owner_id,run_id,sequence,event_type,status) VALUES ($1,$2,1,'run.status','queued')", [owner, id]);
    return id;
  }

  it('AG-01 creates, lists and fetches a durable blank workspace without GitHub', async () => {
    const response = await request('/workspaces', 'POST', { name: ' Task Manager ', source: { kind: 'blank' } });
    assert.equal(response.status, 201); const { workspace } = await response.json();
    assert.deepEqual(Object.keys(workspace).sort(), ['id', 'name', 'sourceKind', 'revision', 'createdAt', 'updatedAt'].sort());
    assert.equal(workspace.name, 'Task Manager'); assert.equal(workspace.sourceKind, 'blank'); assert.equal(workspace.revision, 1);
    assert.deepEqual((await (await request(`/workspaces/${workspace.id}`)).json()).workspace, workspace);
    const list = await (await request('/workspaces')).json(); assert.equal(list.items.length, 2); assert.equal(list.nextCursor, null);
    assert.ok(!JSON.stringify(workspace).includes('owner_id'));
    assert.deepEqual(await new AgentRepository(db.pool).getWorkspace(owner, workspace.id), workspace);
  });

  it('authenticates every route and applies existing CSRF/origin protections to both POSTs', async () => {
    const run = await admit();
    for (const path of ['/workspaces', `/workspaces/${workspaceId}`, '/runs', `/runs/${run.id}`, `/runs/${run.id}/events`]) {
      assert.equal((await request(path, 'GET', undefined, { Cookie: '' })).status, 401);
    }
    for (const [path, body] of [['/workspaces', { source: { kind: 'blank' } }], ['/runs', { workspaceId, task: 'Question' }]] as const) {
      assert.equal((await request(path, 'POST', body, { Cookie: '' })).status, 401);
      assert.equal((await request(path, 'POST', body, { Origin: 'https://attacker.invalid' })).status, 403);
      assert.equal((await request(path, 'POST', body, { Origin: '' })).status, 403);
    }
  });

  it('AG-02 hides cross-owner workspace, run and event existence with identical generic 404s', async () => {
    const ownedRun = await admit(); const foreignWorkspace = (await service.createWorkspace(other, { source: { kind: 'blank' } })).id;
    const foreignRun = (await service.createRun(other, { workspaceId: foreignWorkspace, task: 'Private task' }, randomUUID())).run;
    for (const [hidden, missing] of [[`/workspaces/${foreignWorkspace}`, `/workspaces/${randomUUID()}`],
      [`/runs/${foreignRun.id}`, `/runs/${randomUUID()}`], [`/runs/${foreignRun.id}/events`, `/runs/${randomUUID()}/events`],
      [`/runs?workspaceId=${foreignWorkspace}`, `/runs?workspaceId=${randomUUID()}`]]) {
      const a = await request(hidden!); const b = await request(missing!);
      assert.equal(a.status, 404); assert.equal(b.status, 404); assert.deepEqual(await a.json(), await b.json());
    }
    assert.equal((await request(`/runs/${ownedRun.id}/events`, 'GET', undefined, { Cookie: otherCookie, 'Last-Event-ID': 'bogus' })).status, 404);
    assert.equal((await request('/runs', 'POST', { workspaceId: foreignWorkspace, task: 'Question' }, { 'Idempotency-Key': randomUUID() })).status, 404);
    const list = await (await request('/runs')).json(); assert.deepEqual(list.items.map((item: AgentRun) => item.id), [ownedRun.id]);
    await assert.rejects(repo.events(other, ownedRun.id, 0), { code: 'NOT_FOUND' });
  });

  it('admits ask/plan/execute honestly as failed RUNTIME_UNAVAILABLE, with no result or native config', async () => {
    for (const mode of ['ask', 'plan', 'execute']) {
      const run = await admit(mode);
      assert.equal(run.mode, mode); assert.equal(run.runtime, 'cloud'); assert.equal(run.modelId, AGENT_MODEL_ALIAS);
      assert.equal(run.status, 'failed'); assert.deepEqual(run.error, RUNTIME_UNAVAILABLE); assert.ok(run.finishedAt);
      assert.equal('result' in run, false);
      assert.deepEqual((await (await request(`/runs/${run.id}`)).json()).run, run);
      const raw = JSON.stringify(run);
      for (const forbidden of ['provider', 'gemini', 'apiKey', 'sessionId', 'idempotency', 'fingerprint']) assert.ok(!raw.includes(forbidden));
    }
  });

  it('strictly validates workspace DTOs, nested source fields, JSON and body bounds', async () => {
    for (const body of [null, [], {}, { source: { kind: 'upload' } }, { source: { kind: 'import', url: 'https://example.invalid' } },
      { source: { kind: 'blank', path: '/host' } }, { source: { kind: 'blank' }, ownerId: owner },
      { source: { kind: 'blank' }, name: '' }, { source: { kind: 'blank' }, name: '🙂'.repeat(64) },
      { source: { kind: 'blank' }, name: 'bad\0name' }]) assert.equal((await request('/workspaces', 'POST', body)).status, 400);
    const malformed = await app.request('/api/v1/agent/workspaces', { method: 'POST', headers: { Cookie: cookie, Origin: origin }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal((await request('/workspaces', 'POST', { name: 'a'.repeat(100001), source: { kind: 'blank' } })).status, 400);
    assert.equal((await request('/workspaces/not-a-uuid')).status, 400);
    assert.equal((await db.pool.query('SELECT id FROM agent_workspaces')).rows.length, 1);
  });

  it('rejects invalid workspace/mode/runtime/model/task/key and native or out-of-scope controls before admission', async () => {
    const valid = { workspaceId, task: 'Question' };
    for (const body of [null, [], {}, { ...valid, workspaceId: 'bad' }, { ...valid, mode: 'autonomous' }, { ...valid, mode: null },
      { ...valid, runtime: 'local' }, { ...valid, runtime: null }, { ...valid, modelId: 'gemini-untrusted' }, { ...valid, modelId: null },
      { ...valid, task: '' }, { ...valid, task: 1 }, { ...valid, task: '\0' }, { ...valid, task: '🙂'.repeat(4097) },
      { ...valid, ownerId: owner }, { ...valid, providerUrl: 'https://example.invalid' }, { ...valid, reasoningEffort: 'high' },
      { ...valid, repository: 'private' }, { ...valid, tools: ['run_command'] }]) {
      assert.equal((await request('/runs', 'POST', body, { 'Idempotency-Key': randomUUID() })).status, 400);
    }
    for (const key of ['', 'bad key', 'a'.repeat(129)]) assert.equal((await request('/runs', 'POST', valid, { 'Idempotency-Key': key })).status, 400);
    assert.equal((await request('/runs', 'POST', { ...valid, workspaceId: randomUUID() }, { 'Idempotency-Key': randomUUID() })).status, 404);
    assert.equal((await db.pool.query('SELECT id FROM agent_runs')).rows.length, 0);
    assert.equal((await db.pool.query('SELECT sequence FROM agent_run_events')).rows.length, 0);
  });

  it('idempotency normalizes defaults and UUID casing, replays the same run, and conflicts on changed identity', async () => {
    const key = randomUUID(); const original = await admit('ask', key);
    const response = await request('/runs', 'POST', { workspaceId: workspaceId.toUpperCase(), task: ' Explain this task ',
      runtime: 'cloud', modelId: AGENT_MODEL_ALIAS }, { 'Idempotency-Key': key });
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).run, original);
    const secondWorkspace = (await service.createWorkspace(owner, { source: { kind: 'blank' } })).id;
    for (const change of [{ task: 'Different' }, { mode: 'plan' }, { workspaceId: secondWorkspace }]) {
      assert.equal((await request('/runs', 'POST', { workspaceId, task: 'Explain this task', ...change }, { 'Idempotency-Key': key })).status, 409);
    }
    const foreignWorkspace = (await service.createWorkspace(other, { source: { kind: 'blank' } })).id;
    assert.equal((await request('/runs', 'POST', { workspaceId: foreignWorkspace, task: 'Other' }, { Cookie: otherCookie, 'Idempotency-Key': key })).status, 201);
    assert.equal((await repo.events(owner, original.id, 0)).items.length, 2);
  });

  it('real PostgreSQL arbitrates simultaneous owner/key admissions without duplicate events', async (t) => {
    if (db.isMemory) return t.skip('Requires PostgreSQL unique arbitration and transaction isolation');
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 5 }, () => request('/runs', 'POST', { workspaceId, task: 'Concurrent' }, { 'Idempotency-Key': key })));
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200, 200, 200, 201]);
    const ids = await Promise.all(responses.map(async (response) => (await response.json()).run.id));
    assert.equal(new Set(ids).size, 1); assert.equal((await repo.events(owner, ids[0], 0)).items.length, 2);
  });

  it('rolls back run and events together if terminal event persistence fails', async () => {
    const failing = { connect: async () => {
      const client = await db.pool.connect();
      return new Proxy(client, { get(target, property) {
        if (property === 'query') return (sql: string, values?: unknown[]) => {
          if (sql.includes('INSERT INTO agent_run_events') && sql.includes("'run.failed'")) throw new Error('Simulated event persistence failure');
          return target.query(sql, values);
        };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } } as unknown as pg.Pool;
    await assert.rejects(new AgentService(new AgentRepository(failing)).createRun(owner, { workspaceId, task: 'Atomic' }, randomUUID()), /Simulated/);
    assert.equal((await db.pool.query('SELECT id FROM agent_runs')).rows.length, 0);
    assert.equal((await db.pool.query('SELECT sequence FROM agent_run_events')).rows.length, 0);
  });

  it('persists ordered events, replays strictly after Last-Event-ID, and closes after terminal replay', async () => {
    const run = await admit();
    const full = await request(`/runs/${run.id}/events`);
    assert.match(full.headers.get('content-type')!, /text\/event-stream/);
    const frames = await full.text();
    assert.deepEqual([...frames.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1])), [1, 2]);
    assert.match(frames, /event: run.status/); assert.match(frames, /"status":"queued"/);
    assert.match(frames, /event: run.failed/); assert.match(frames, /RUNTIME_UNAVAILABLE/);
    const replay = await (await request(`/runs/${run.id}/events`, 'GET', undefined, { 'Last-Event-ID': '1' })).text();
    assert.match(replay, /^id: 2/m); assert.doesNotMatch(replay, /id: 1/);
    assert.equal(await (await request(`/runs/${run.id}/events`, 'GET', undefined, { 'Last-Event-ID': '2' })).text(), '');
    for (const bad of ['-1', '01', '1.5', '1e0', '2147483648', '3', randomUUID()]) {
      assert.equal((await request(`/runs/${run.id}/events`, 'GET', undefined, { 'Last-Event-ID': bad })).status, 400);
    }
    assert.equal((await request(`/runs/${run.id}/events?after=1`)).status, 400);
    assert.deepEqual(await new AgentRepository(db.pool).events(owner, run.id, 0), await repo.events(owner, run.id, 0));
    const restarted = createApp({ pool: db.pool, config: { nodeEnv: 'test' } });
    assert.deepEqual((await (await restarted.request(`/api/v1/agent/runs/${run.id}`, { headers: { Cookie: cookie } })).json()).run, run);
  });

  it('observes new committed events from another connection and never persists heartbeat', async () => {
    const id = await pending();
    const response = observeEvents(repo, owner, id, 1, new AbortController().signal, { pollMs: 2, heartbeatMs: 5 });
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: heartbeat/); assert.doesNotMatch(first, /^id:/m);
    assert.equal((await repo.events(owner, id, 0)).items.length, 1);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE agent_runs SET status = 'failed', finished_at = NOW(), updated_at = NOW(), error_code = 'RUNTIME_UNAVAILABLE', last_event_id = 2 WHERE id = $1 AND owner_id = $2", [id, owner]);
      await client.query("INSERT INTO agent_run_events (owner_id,run_id,sequence,event_type,status,error_code) VALUES ($1,$2,2,'run.failed','failed','RUNTIME_UNAVAILABLE')", [owner, id]);
      await client.query('COMMIT');
    } finally { client.release(); }
    let next = '';
    for (let i = 0; i < 20 && !next.includes('run.failed'); i++) next = new TextDecoder().decode((await reader.read()).value);
    assert.match(next, /id: 2/); assert.match(next, /event: run.failed/);
    assert.equal((await reader.read()).done, true); assert.equal((await repo.events(owner, id, 0)).items.length, 2);
  });

  it('AG-17/18 actual HTTP disconnect/reconnect neither restarts nor cancels a durable pending run', async () => {
    const id = await pending();
    const { server } = await startServer({ pool: db.pool, config: loadConfig({ NODE_ENV: 'test', CHAT_ENABLED: 'false' }), port: 0, skipMigrations: true });
    try {
      if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/agent/runs/${id}/events`;
      const controller = new AbortController();
      const response = await fetch(url, { headers: { Cookie: cookie }, signal: controller.signal });
      const reader = response.body!.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /id: 1/);
      controller.abort(); await reader.cancel().catch(() => {});
      const reconnected = await fetch(url, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(3000) });
      const replay = reconnected.body!.getReader(); assert.match(new TextDecoder().decode((await replay.read()).value), /id: 1/);
      await replay.cancel();
      assert.equal((await repo.getRun(owner, id)).status, 'queued');
      assert.equal((await repo.events(owner, id, 0)).items.length, 1);
      assert.equal((await db.pool.query('SELECT id FROM agent_runs WHERE owner_id = $1', [owner])).rows.length, 1);
    } finally {
      if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('drains multiple bounded replay pages in exact sequence before terminal close', async () => {
    const id = await pending(); const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (let sequence = 2; sequence <= 105; sequence++) {
        await client.query('UPDATE agent_runs SET last_event_id = $1 WHERE id = $2 AND owner_id = $3', [sequence, id, owner]);
        await client.query("INSERT INTO agent_run_events (owner_id,run_id,sequence,event_type,status) VALUES ($1,$2,$3,'run.status','queued')", [owner, id, sequence]);
      }
      await client.query("UPDATE agent_runs SET last_event_id = 106, status = 'failed', error_code = 'RUNTIME_UNAVAILABLE', finished_at = NOW(), updated_at = NOW() WHERE id = $1 AND owner_id = $2", [id, owner]);
      await client.query("INSERT INTO agent_run_events (owner_id,run_id,sequence,event_type,status,error_code) VALUES ($1,$2,106,'run.failed','failed','RUNTIME_UNAVAILABLE')", [owner, id]);
      await client.query('COMMIT');
    } finally { client.release(); }
    assert.equal((await repo.events(owner, id, 0)).items.length, 100);
    const replay = await (await request(`/runs/${id}/events`)).text();
    assert.deepEqual([...replay.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1])), Array.from({ length: 106 }, (_, i) => i + 1));
    assert.match(replay, /id: 106\nevent: run.failed/);
  });

  it('real PostgreSQL preserves microsecond precision across equal-millisecond history cursors', async (t) => {
    if (db.isMemory) return t.skip('pg-mem timestamps only have millisecond precision');
    await db.pool.query('DELETE FROM agent_workspaces WHERE owner_id = $1', [owner]);
    const expected: string[] = [];
    for (const fraction of ['123100', '123200', '123300']) {
      const id = randomUUID(); expected.unshift(id);
      await db.pool.query("INSERT INTO agent_workspaces (id,owner_id,name,created_at,updated_at) VALUES ($1,$2,'Precision',$3,$3)", [id, owner, `2026-10-16T00:00:00.${fraction}Z`]);
    }
    const seen: string[] = []; let cursor: string | null = null;
    do {
      const page = await (await request(`/workspaces?limit=1${cursor ? `&cursor=${cursor}` : ''}`)).json();
      seen.push(...page.items.map((item: { id: string }) => item.id)); cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, expected);
  });

  it('observer timeout and AbortSignal close only the subscription, leaving run and event count unchanged', async () => {
    const id = await pending(); const controller = new AbortController();
    const response = observeEvents(repo, owner, id, 1, controller.signal, { pollMs: 2, maxConnectionMs: 10 });
    assert.equal(await response.text(), '');
    controller.abort();
    const aborted = new AbortController(); aborted.abort();
    assert.equal(await observeEvents(repo, owner, id, 1, aborted.signal).text(), '');
    assert.equal((await repo.getRun(owner, id)).status, 'queued'); assert.equal((await repo.events(owner, id, 0)).items.length, 1);
  });

  it('keyset pagination has strict, scope-bound cursors and stable owner/workspace filtering', async () => {
    await service.createWorkspace(owner, { source: { kind: 'blank' }, name: 'Second' });
    await service.createWorkspace(owner, { source: { kind: 'blank' }, name: 'Third' });
    const first = await (await request('/workspaces?limit=1')).json();
    const second = await (await request(`/workspaces?limit=1&cursor=${first.nextCursor}`)).json();
    assert.notEqual(first.items[0].id, second.items[0].id);
    assert.equal((await request(`/runs?cursor=${first.nextCursor}`)).status, 400);
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=1&limit=2', 'cursor=bad', 'ownerId=other']) {
      assert.equal((await request(`/workspaces?${query}`)).status, 400);
    }
    for (const createdAt of ['0000-01-01T00:00:00.000Z', '2026-02-31T00:00:00.000Z']) {
      const forged = Buffer.from(JSON.stringify({ kind: 'workspaces', workspaceId: null, createdAt, id: workspaceId })).toString('base64url');
      assert.equal((await request(`/workspaces?cursor=${forged}`)).status, 400);
    }
    for (let i = 0; i < 3; i++) await admit();
    const runs = await (await request(`/runs?workspaceId=${workspaceId}&limit=2`)).json();
    assert.equal(runs.items.length, 2); assert.ok(runs.nextCursor);
    const last = await (await request(`/runs?workspaceId=${workspaceId}&limit=2&cursor=${runs.nextCursor}`)).json();
    assert.equal(last.items.length, 1); assert.equal(last.nextCursor, null);
    assert.equal(new Set([...runs.items, ...last.items].map((item: AgentRun) => item.id)).size, 3);
  });
});
