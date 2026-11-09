import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type pg from 'pg';
import { createApp } from '../src/app/create-app.js';
import { createOperationsApp } from '../src/app/operations.js';
import type { AuthService } from '../src/modules/auth/auth-service.js';
import type { ChatRuntime } from '../src/modules/chat/chat-runtime.js';
import type { EventSink } from '../src/modules/chat/types.js';
import { createTestDatabase } from './test-db-helper.js';

test('response and safe request log use the same generated ID even when an error contains secrets', async () => {
  const lines: string[] = [];
  const secret = 'synthetic-password-token-do-not-log';
  const authService = {
    login: async () => { throw new Error('postgres://example:' + secret + '@host/test'); },
  } as unknown as AuthService;
  const app = createApp({ authService, logSink: line => lines.push(line) });
  const response = await app.request('/api/v1/auth/login?token=' + secret, {
    method: 'POST',
    headers: { origin: 'http://localhost:5173', 'content-type': 'application/json',
      'x-request-id': secret, 'x-correlation-id': secret, authorization: 'Bearer ' + secret },
    body: JSON.stringify({ email: 'fixture@example.invalid', password: secret }),
  });
  assert.equal(response.status, 500);
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!);
  assert.equal(record.requestId, response.headers.get('x-request-id'));
  assert.match(record.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(record.route, '/api/v1/auth/login');
  assert.equal(record.errorCategory, 'server_error');
  assert.equal(record.correlationId, undefined);
  assert.ok(!lines[0]!.includes(secret));
  assert.ok(!(await response.text()).includes(secret));
});

test('Chat SSE terminal log correlates with the response without payloads or session values', async () => {
  const lines: string[] = [];
  const authService = { getMe: async () => ({ id: randomUUID() }) } as unknown as AuthService;
  const runtime = {
    admit: async () => ({ duplicate: false, generation: { id: randomUUID() } }),
    run: async (_owner: string, _generation: unknown, sink: EventSink) => {
      await sink({ event: 'message.failed', data: { error: { code: 'UPSTREAM_ERROR', message: 'fixture failure' } } });
    },
  } as unknown as ChatRuntime;
  const conversation = randomUUID();
  const app = createApp({ authService, chatRuntime: runtime, logSink: line => lines.push(line) });
  const response = await app.request('/api/v1/conversations/' + conversation + '/messages:stream', {
    method: 'POST',
    headers: { origin: 'http://localhost:5173', 'content-type': 'application/json', cookie: 'giga_session=fixture-secret' },
    body: '{}',
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /event: message.failed/);
  await setImmediate();
  const records = lines.map(line => JSON.parse(line));
  assert.equal(records.length, 2);
  for (const record of records) assert.equal(record.requestId, response.headers.get('x-request-id'));
  assert.equal(records.find(record => record.event === 'chat_stream_end')?.outcome, 'provider_error');
  for (const line of lines) assert.ok(!line.includes(conversation) && !line.includes('fixture-secret') && !line.includes('fixture failure'));
});

test('unknown monitoring credentials cannot access public ops routes, and high-volume traces stay bounded', async () => {
  let count = 0;
  const ids = new Set<string>();
  const app = createApp({ logSink: line => {
    count += 1;
    assert.ok(Buffer.byteLength(line) < 700);
    ids.add(JSON.parse(line).requestId);
  } });
  for (const path of ['/ops', '/ready']) {
    const response = await app.request(path, { headers: { authorization: 'Bearer invalid-monitor-credential' } });
    assert.equal(response.status, 404);
  }
  const responses = await Promise.all(Array.from({ length: 400 }, (_, i) => app.request('/health?untrusted=' + 'x'.repeat(2000) + i)));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(count, 402);
  assert.equal(ids.size, count);
});

test('readiness fails closed on connection failure and missing migration while liveness stays independent', async () => {
  const failure = {
    connect: async () => { throw new Error('private db connection data'); },
  } as unknown as pg.Pool;
  const operations = createOperationsApp(failure, false);
  const response = await operations.request('/ready');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'not_ready' });
  assert.equal((await operations.request('/ops')).status, 503);
  assert.equal((await createApp({ logSink: () => {} }).request('/health')).status, 200);

  let released = false;
  const incompatible = { connect: async () => ({
    query: async () => ({ rows: [{ compatible: false, version: 16 }] }),
    release: (destroy: boolean) => { released = !destroy; },
  }) } as unknown as pg.Pool;
  assert.equal((await createOperationsApp(incompatible, false).request('/ready')).status, 503);
  assert.ok(released);
});

test('repeated readiness probes share a bounded in-flight database query', async () => {
  let connects = 0;
  let finish!: (value: unknown) => void;
  const result = new Promise(resolve => { finish = resolve; });
  const pool = {
    connect: async () => {
      connects += 1;
      return { query: (query: string) => query.startsWith('SELECT') ? result : Promise.resolve(), release: () => {} };
    },
  } as unknown as pg.Pool;
  const ops = createOperationsApp(pool, false, 15);
  try {
    const responses = await Promise.all(Array.from({ length: 20 }, () => ops.request('/ready')));
    assert.ok(responses.every(response => response.status === 503));
    assert.equal((await ops.request('/ready')).status, 503);
    assert.equal(connects, 1);
  } finally {
    finish({ rows: [{ compatible: true, version: 17 }] });
  }
  await setImmediate();
  assert.equal((await ops.request('/ready')).status, 200);
});

test('real PostgreSQL ops snapshot finds a simulated stuck Agent run while optional Cloud remains disabled', async (t) => {
  const db = await createTestDatabase();
  if (db.isMemory) {
    await db.pool.end();
    return t.skip('Requires real PostgreSQL ACL migration and aggregate queries');
  }
  const user = randomUUID();
  const workspace = randomUUID();
  try {
    const app = createOperationsApp(db.pool, false);
    const ready = await app.request('/ready');
    assert.equal(ready.status, 200);
    const beforeResponse = await app.request('/ops');
    assert.equal(beforeResponse.status, 200);
    const before = await beforeResponse.json();
    await db.pool.query(
      'INSERT INTO users (id,email,display_name,password_hash) VALUES ($1,$2,$3,$4)',
      [user, user + '@example.invalid', 'ops fixture', 'unused'],
    );
    await db.pool.query('INSERT INTO agent_workspaces (id,owner_id,name) VALUES ($1,$2,$3)', [workspace, user, 'ops fixture']);
    await db.pool.query("INSERT INTO agent_runs (owner_id,workspace_id,task,mode,runtime,model_alias,status,idempotency_key,request_fingerprint,created_at,updated_at) VALUES ($1,$2,'private synthetic prompt','execute','cloud','giga-agent-default','queued',$3,$4,now()-interval '20 minutes',now()-interval '20 minutes')",
      [user, workspace, randomUUID(), 'a'.repeat(64)]);
    const response = await app.request('/ops');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.agentStuckQueue, before.agentStuckQueue + 1);
    assert.ok(body.databaseBytes > 0);
    assert.ok(body.schemaVersion >= 17);
    assert.equal(body.agentCloud, 'disabled');
    assert.equal(body.chatConfigured, false);
    assert.ok(!JSON.stringify(body).includes('private synthetic prompt'));
  } finally {
    try { await db.pool.query('DELETE FROM users WHERE id = $1', [user]); }
    finally { await db.pool.end(); }
  }
});
