import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createTestDatabase, type TestDbInstance } from '../test-db-helper.js';
import { createApp } from '../../src/app/create-app.js';
import { UserRepository } from '../../src/db/repositories/user-repository.js';
import { SessionRepository } from '../../src/db/repositories/session-repository.js';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../../src/modules/auth/session.js';
import { AgentRepository } from '../../src/modules/agent/repository.js';
import { AGENT_MODEL_ALIAS } from '../../src/modules/agent/types.js';
import { getAgentCapabilities } from '../../src/modules/agent/capabilities.js';
import { AGENT_CAPABILITY_NAMES, agentCapabilitiesSchema, readAgentCapabilities, isAgentCapabilityAvailable,
  agentWorkspaceSchema, agentRunSchema, agentMessageSchema } from '../../../../packages/contracts/agent.js';

const fixture = JSON.parse(readFileSync(new URL('../../../../packages/contracts/fixtures/agent.json', import.meta.url), 'utf8'));
const origin = 'http://localhost:3000';
const forbidden = /^(?:owner_?id|worker_?id|lease_?token|lease_?expires_?at|attempt_?count|idempotency_?key|request_?fingerprint|provider|api_?key|credentials?|system_?prompt|reasoning|arguments|result_json)$/i;
function noInternals(value: unknown): void {
  if (Array.isArray(value)) value.forEach(noInternals);
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      assert.equal(forbidden.test(key), false, `Internal key: ${key}`);
      noInternals(entry);
    }
  }
}

describe('Agent shared public contract', () => {
  it('validates canonical fixtures and the complete disabled-cloud capability response', () => {
    assert.deepEqual(agentWorkspaceSchema.parse(fixture.workspace), fixture.workspace);
    assert.deepEqual(agentRunSchema.parse(fixture.run), fixture.run);
    assert.deepEqual(agentMessageSchema.parse(fixture.message), fixture.message);
    assert.deepEqual(agentCapabilitiesSchema.parse(fixture.capabilities), getAgentCapabilities());
    assert.deepEqual(Object.keys(fixture.capabilities.capabilities), AGENT_CAPABILITY_NAMES);
    noInternals(fixture);
  });

  it('fails closed for missing envelopes, unknown schema versions and missing capabilities', () => {
    for (const input of [undefined, null, [], {}, { schemaVersion: 2, capabilities: fixture.capabilities.capabilities },
      { schemaVersion: 1, capabilities: {} }]) {
      const parsed = readAgentCapabilities(input);
      for (const name of AGENT_CAPABILITY_NAMES) assert.equal(isAgentCapabilityAvailable(parsed, name), false);
      assert.throws(() => agentCapabilitiesSchema.parse(input));
    }
    const partial = structuredClone(fixture.capabilities);
    delete partial.capabilities.eventReplay;
    assert.equal(readAgentCapabilities(partial).capabilities.eventReplay.available, false);
    assert.equal(readAgentCapabilities(partial).capabilities.workspaceManagement.available, true);
    assert.throws(() => agentCapabilitiesSchema.parse(partial));
    assert.equal(isAgentCapabilityAvailable(fixture.capabilities, 'future' as never), false);
  });

  it('rejects malformed and contradictory metadata without enabling execution from client hints', () => {
    for (const entry of [true, 'available', {}, null, { available: 'true' }, { available: 1 },
      { available: true, reason: 'future_reason' }, { available: false }, { available: false, reason: 'future_reason' }]) {
      const input = structuredClone(fixture.capabilities);
      input.capabilities.eventReplay = entry;
      assert.equal(readAgentCapabilities(input).capabilities.eventReplay.available, false);
      assert.throws(() => agentCapabilitiesSchema.parse(input));
    }
    const input = structuredClone(fixture.capabilities);
    for (const name of ['ask', 'plan', 'execute', 'runExecution', 'followUp', 'artifactDownload']) {
      input.capabilities[name] = { available: true };
    }
    const safe = readAgentCapabilities(input);
    for (const name of ['ask', 'plan', 'execute', 'runExecution', 'followUp', 'artifactDownload'] as const) {
      assert.equal(safe.capabilities[name].available, false);
    }
    assert.throws(() => agentCapabilitiesSchema.parse(input));
  });

  it('accepts additive response fields, projects only public fields and ignores future capability names', () => {
    const extended = structuredClone(fixture.capabilities);
    extended.future = { any: true };
    extended.capabilities.futureTool = { available: true };
    extended.capabilities.eventReplay.description = 'Additive';
    assert.deepEqual(agentCapabilitiesSchema.parse(extended), fixture.capabilities);
    assert.deepEqual(readAgentCapabilities(extended), fixture.capabilities);
    for (const [schema, dto] of [[agentWorkspaceSchema, fixture.workspace], [agentRunSchema, fixture.run],
      [agentMessageSchema, fixture.message]] as const) {
      assert.deepEqual(schema.parse({ ...dto, future: 'additive', leaseToken: 'private-fixture' }), dto);
    }
  });

  it('accepts a complete coherent future enablement without making flags into server authority', () => {
    const input = { schemaVersion: 1, capabilities: Object.fromEntries(
      AGENT_CAPABILITY_NAMES.map((name) => [name, { available: true }])
    ) };
    assert.deepEqual(agentCapabilitiesSchema.parse(input), input);
    for (const name of AGENT_CAPABILITY_NAMES) assert.equal(isAgentCapabilityAvailable(input, name), true);
    // The real server mapping still derives from shipped admission, never this client document.
    assert.equal(getAgentCapabilities().capabilities.execute.available, false);
  });

  it('preserves seven statuses and rejects malformed required public DTO fields', () => {
    for (const status of ['queued', 'running', 'awaiting_approval', 'applying', 'completed', 'failed', 'cancelled']) {
      assert.equal(agentRunSchema.parse({ ...fixture.run, status }).status, status);
    }
    for (const change of [{ status: 'stopping' }, { mode: 'root' }, { runtime: 'local' }, { workspaceId: undefined },
      { createdAt: '2026-02-31T00:00:00.000Z' }, { result: { summary: 'Unverified' } }]) {
      assert.throws(() => agentRunSchema.parse({ ...fixture.run, ...change }));
    }
    assert.throws(() => agentMessageSchema.parse({ ...fixture.message, sequence: 0 }));
    assert.throws(() => agentWorkspaceSchema.parse({ ...fixture.workspace, sourceKind: 'import' }));
  });
});

describe('Agent capability and DTO HTTP compatibility', () => {
  let db: TestDbInstance;
  let app: ReturnType<typeof createApp>;
  let owner: string;
  let cookie: string;
  let otherCookie: string;
  before(async () => { db = await createTestDatabase(); });
  after(async () => { await db.cleanup(); await db.pool.end(); });
  beforeEach(async () => {
    await db.cleanup();
    async function session(): Promise<{ id: string; cookie: string }> {
      const user = await new UserRepository(db.pool).createUser({ email: `${randomUUID()}@example.com`, displayName: 'Contract fixture', passwordHash: 'unused' });
      const token = generateSessionToken();
      await new SessionRepository(db.pool).createSession({ userId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60000) });
      return { id: user.id, cookie: `${SESSION_COOKIE_NAME}=${token}` };
    }
    const a = await session(); const b = await session(); owner = a.id; cookie = a.cookie; otherCookie = b.cookie;
    app = createApp({ pool: db.pool, config: { nodeEnv: 'test', allowedOrigins: [origin] } });
  });
  function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    return app.request(`/api/v1/agent${path}`, { method,
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function workspace(): Promise<string> {
    return (await (await request('/workspaces', 'POST', { source: { kind: 'blank' } })).json()).workspace.id;
  }

  it('authenticates discovery, sends no-store, rejects caller capabilities and never changes DB state', async () => {
    assert.equal((await request('/capabilities', 'GET', undefined, { Cookie: '' })).status, 401);
    assert.equal((await request('/capabilities', 'GET', undefined, { Cookie: `${SESSION_COOKIE_NAME}=invalid` })).status, 401);
    const result = await request('/capabilities');
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await result.json(), fixture.capabilities);
    assert.deepEqual(await (await request('/capabilities', 'GET', undefined, { Cookie: otherCookie })).json(), fixture.capabilities);
    for (const query of ['?execute=true', '?ownerId=other', '?cloudRuntime=true', '?limit=1&limit=2']) {
      assert.equal((await request(`/capabilities${query}`)).status, 400);
    }
    assert.equal((await db.pool.query('SELECT id FROM agent_runs')).rows.length, 0);
    assert.equal((await db.pool.query('SELECT id FROM agent_workspaces')).rows.length, 0);
  });

  it('matches real Workspace/Run/Message responses to shared fixtures without changing admission or idempotency', async () => {
    const w = (await (await request('/workspaces', 'POST', { source: { kind: 'blank' } })).json()).workspace;
    assert.deepEqual(agentWorkspaceSchema.parse(w), w);
    assert.deepEqual({ ...w, id: fixture.workspace.id, createdAt: fixture.workspace.createdAt, updatedAt: fixture.workspace.updatedAt }, fixture.workspace);
    for (const mode of ['ask', 'plan', 'execute']) {
      const key = randomUUID(); const body = { workspaceId: w.id, task: fixture.run.task, mode };
      const admitted = await request('/runs', 'POST', body, { 'Idempotency-Key': key });
      assert.equal(admitted.status, 201);
      const { run } = await admitted.json();
      assert.deepEqual(agentRunSchema.parse(run), run);
      assert.deepEqual({ ...run, id: fixture.run.id, workspaceId: fixture.run.workspaceId, mode: fixture.run.mode,
        createdAt: fixture.run.createdAt, updatedAt: fixture.run.updatedAt, finishedAt: fixture.run.finishedAt }, fixture.run);
      const duplicate = await request('/runs', 'POST', body, { 'Idempotency-Key': key });
      assert.equal(duplicate.status, 200); assert.deepEqual((await duplicate.json()).run, run);
      assert.equal((await request('/runs', 'POST', { ...body, task: 'Changed' }, { 'Idempotency-Key': key })).status, 409);
      const messages = await (await request(`/runs/${run.id}/messages`)).json();
      assert.equal(messages.nextCursor, null); assert.equal(messages.items.length, 1);
      const message = messages.items[0];
      assert.deepEqual(agentMessageSchema.parse(message), message);
      assert.deepEqual({ ...message, id: fixture.message.id, workspaceId: fixture.message.workspaceId,
        runId: fixture.message.runId, createdAt: fixture.message.createdAt }, fixture.message);
      assert.equal((await request(`/runs/${run.id}/messages`, 'POST', { content: 'Continue' }, { 'Idempotency-Key': randomUUID() })).status, 409);
      noInternals({ w, run, messages });
    }
  });

  it('keeps cross-owner resources indistinguishable from missing and preserves CSRF/strict input', async () => {
    const id = await workspace();
    const admitted = await request('/runs', 'POST', { workspaceId: id, task: 'Question' }, { 'Idempotency-Key': randomUUID() });
    const { run } = await admitted.json();
    for (const suffix of ['', '/events', '/messages']) {
      const hidden = await request(`/runs/${run.id}${suffix}`, 'GET', undefined, { Cookie: otherCookie });
      const missing = await request(`/runs/${randomUUID()}${suffix}`, 'GET', undefined, { Cookie: otherCookie });
      assert.equal(hidden.status, 404); assert.deepEqual(await hidden.json(), await missing.json());
    }
    assert.equal((await request(`/runs/${run.id}/messages`, 'POST', { content: 'Private' }, { Cookie: otherCookie, 'Idempotency-Key': randomUUID() })).status, 404);
    for (const badOrigin of ['', 'https://attacker.invalid']) {
      assert.equal((await request('/runs', 'POST', { workspaceId: id, task: 'Question' }, { Origin: badOrigin, 'Idempotency-Key': randomUUID() })).status, 403);
    }
    assert.equal((await request('/runs', 'POST', { workspaceId: id, task: 'Question', capabilities: { execute: true } }, { 'Idempotency-Key': randomUUID() })).status, 400);
  });

  it('preserves scoped cursors, validates pagination and reconciles terminal state independently of SSE', async () => {
    const id = await workspace(); await workspace();
    const page = await (await request('/workspaces?limit=1')).json();
    assert.equal(page.items.length, 1); assert.equal(typeof page.nextCursor, 'string');
    const next = await (await request(`/workspaces?limit=1&cursor=${page.nextCursor}`)).json();
    assert.equal(next.items.length, 1); assert.equal(next.nextCursor, null); assert.notEqual(next.items[0].id, page.items[0].id);
    assert.equal((await request(`/runs?cursor=${page.nextCursor}`)).status, 400);
    for (const query of ['limit=0', 'limit=101', 'cursor=bogus', 'limit=1&limit=2', 'after=1']) {
      assert.equal((await request(`/workspaces?${query}`)).status, 400);
    }
    const { run } = await (await request('/runs', 'POST', { workspaceId: id, task: 'Question' }, { 'Idempotency-Key': randomUUID() })).json();
    const replay = await (await request(`/runs/${run.id}/events`, 'GET', undefined, { 'Last-Event-ID': '1' })).text();
    assert.match(replay, /^id: 2\nevent: run.failed/m); assert.doesNotMatch(replay, /id: 1/);
    assert.equal(await (await request(`/runs/${run.id}/events`, 'GET', undefined, { 'Last-Event-ID': '2' })).text(), '');
    assert.equal((await request(`/runs/${run.id}/events`, 'GET', undefined, { 'Last-Event-ID': '3' })).status, 400);
    const restarted = createApp({ pool: db.pool, config: { nodeEnv: 'test' } });
    const saved = await (await restarted.request(`/api/v1/agent/runs/${run.id}`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(saved.run, run); assert.equal(saved.run.status, 'failed'); noInternals(saved);
  });

  it('projects worker-claimed and completed rows without lease metadata in any public DTO or event', async () => {
    const id = await workspace(); const repo = new AgentRepository(db.pool);
    const { run } = await repo.enqueueRun(owner, { workspaceId: id, task: 'Fixture', mode: 'execute', runtime: 'cloud', modelId: AGENT_MODEL_ALIAS }, randomUUID(), 'a'.repeat(64));
    const claimed = await repo.claimRun(owner, run.id, 'private-worker-fixture');
    assert.ok(claimed);
    for (const path of [`/runs/${run.id}`, '/runs', `/runs/${run.id}/messages`]) noInternals(await (await request(path)).json());
    await repo.finalizeRun(owner, run.id, claimed.leaseToken, { status: 'completed', summary: 'Verified fixture', verifiedChecks: [{ name: 'fixture', outcome: 'passed' }] });
    const completed = (await (await request(`/runs/${run.id}`)).json()).run;
    assert.deepEqual(agentRunSchema.parse(completed), completed); noInternals(completed);
    assert.deepEqual(completed.result.artifactIds, []);
    const events = await (await request(`/runs/${run.id}/events`)).text();
    for (const line of events.split('\n').filter((line) => line.startsWith('data: '))) noInternals(JSON.parse(line.slice(6)));
    assert.ok(!events.includes(claimed.leaseToken)); assert.ok(!events.includes('private-worker-fixture'));
  });
});
