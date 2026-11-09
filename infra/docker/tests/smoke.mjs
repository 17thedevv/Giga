// Runs only against a disposable Compose project. Never point this at a shared stack.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { browserSmoke } from './browser.mjs';

const project = process.env.COMPOSE_PROJECT_NAME ?? '';
assert.equal(process.env.GIGA_DOCKER_SMOKE, '1', 'Set GIGA_DOCKER_SMOKE=1 to authorize disposable local tests');
assert.match(project, /^giga-smoke-[a-z0-9-]+$/, 'Use an isolated giga-smoke-* Compose project');
const base = 'http://localhost:8080';
const compose = ['compose', '--env-file', '.env', '-p', project, '-f', 'compose.yaml', '-f', 'infra/docker/compose.local.yaml'];
const fixture = [...compose, '-f', 'infra/docker/tests/compose.fixture.yaml'];
const checks = [];
const reportDir = 'artifacts/docker-smoke';
const temporary = await mkdtemp(join(tmpdir(), 'giga-docker-smoke-'));
const envText = await readFile('.env', 'utf8');
const privateValues = envText.split(/\r?\n/)
  .filter(line => /^[A-Z_]*(?:PASSWORD|KEY|TOKEN|SECRET)[A-Z_]*=/.test(line))
  .map(line => line.slice(line.indexOf('=') + 1).replace(/^["']|["']$/g, '')).filter(value => value.length >= 8);
let fixtureActive = false;
let activeCheck = '';
function redact(text) {
  let safe = String(text).replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-database-url]');
  for (const value of privateValues) safe = safe.split(value).join('[redacted]');
  return safe.slice(-2500);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw new Error('Local command could not complete: ' + command);
  return result;
}
function docker(args, options = {}) {
  const result = run('docker', args, options);
  if (result.status !== 0) throw new Error('Docker command failed: ' + args.slice(0, 2).join(' ') + '\n' + redact(result.stderr));
  return result.stdout.trim();
}
async function check(name, operation) {
  activeCheck = name;
  const started = Date.now();
  const detail = await operation();
  checks.push({ name, outcome: 'PASS', durationMs: Date.now() - started, ...(detail ? { detail } : {}) });
  console.log('PASS ' + name);
}
async function request(path, { method = 'GET', cookie, body, origin = base, headers = {} } = {}) {
  return fetch(base + path, {
    method, signal: AbortSignal.timeout(30000),
    headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function requestWithHost(path, host) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(path, base), { headers: { Host: host } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.setTimeout(10000, () => req.destroy(new Error('Host validation request timed out')));
    req.on('error', reject);
    req.end();
  });
}
async function json(path, options, expected) {
  const response = await request(path, options);
  assert.equal(response.status, expected, 'Expected HTTP status for ' + path);
  return response.json();
}
async function health() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try { if ((await request('/health')).status === 200) return; } catch {}
    await delay(500);
  }
  throw new Error('Health did not recover');
}
function sql(query, login = 'giga_admin', passwordKey = 'DB_PASSWORD_ADMIN', database = 'giga') {
  assert.match(database, /^giga(?:_(?:restore_test|auto_fresh|auto_upgrade)_[a-f0-9]{32})?$/);
  assert.ok(['giga_admin', 'giga_migration', 'giga_runtime', 'giga_lifecycle', 'giga_quota'].includes(login));
  assert.ok(['DB_PASSWORD_ADMIN', 'DB_PASSWORD_MIGRATION', 'DB_PASSWORD_API', 'DB_PASSWORD_LIFECYCLE', 'DB_PASSWORD_QUOTA'].includes(passwordKey));
  return docker([...compose, 'exec', '-T', 'postgres', 'sh', '-c',
    'PGPASSWORD="$' + passwordKey + '" psql -h 127.0.0.1 -U ' + login + ' -d ' + database + ' -X -A -t -v ON_ERROR_STOP=1'], { input: query });
}
const email = 'docker-' + randomUUID() + '@example.invalid';
const password = 'Docker!' + randomBytes(24).toString('hex');
let cookie;
let userId;
let conversationId;
try {
  await check('health and API routing', async () => {
    await health();
    const result = await json('/health', {}, 200);
    assert.equal(result.status, 'ok'); assert.equal(result.service, 'giga-api');
    const missing = await request('/api/v1/definitely-missing');
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type'), /application\/json/);
    assert.equal((await missing.json()).error.code, 'NOT_FOUND');
    await assert.rejects(() => requestWithHost('/health', 'attacker.invalid'),
      'Nginx closes requests with a Host outside the generated allowlist');
  });
  await check('frontend assets and deep links', async () => {
    const index = await request('/');
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    const html = await index.text();
    const asset = html.match(/src="([^"]+\/assets\/[^"]+)"/)?.[1] ?? html.match(/src="(\/assets\/[^"]+)"/)?.[1];
    assert.ok(asset, 'Built index references hashed JavaScript');
    assert.equal((await request(asset)).status, 200);
    for (const route of ['/login', '/chat/' + randomUUID(), '/agent/runs/' + randomUUID(), '/settings']) {
      const response = await request(route);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), html);
    }
  });
  await check('real registration, login, authenticated routes and CSRF', async () => {
    assert.equal((await request('/api/v1/auth/me')).status, 401);
    const registered = await json('/api/v1/auth/register', { method: 'POST', body: { email, password, displayName: 'Docker smoke' } }, 201);
    userId = registered.user.id;
    const login = await request('/api/v1/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /SameSite=Lax/i);
    assert.doesNotMatch(setCookie, /;\s*Secure/i, 'HTTP override is explicitly local-only');
    cookie = setCookie.match(/giga_session=[a-f0-9]+/)[0];
    assert.equal((await json('/api/v1/auth/me', { cookie }, 200)).user.id, userId);
    const auth = await request('/api/v1/auth/me', { cookie });
    assert.match(auth.headers.get('cache-control'), /no-store/);
    assert.match(auth.headers.get('x-content-type-options'), /nosniff/i);
    assert.equal((await request('/api/v1/conversations', { method: 'POST', cookie, origin: 'https://attacker.invalid', body: {} })).status, 403);
    assert.equal((await request('/api/v1/conversations', { method: 'POST', cookie, origin: '', body: {} })).status, 403);
    const created = await json('/api/v1/conversations', { method: 'POST', cookie, body: { title: 'Persistent Docker fixture' } }, 201);
    conversationId = created.conversation.id;
    assert.equal((await request('/api/v1/conversations/' + conversationId, { cookie })).status, 200);
  });
  await check('Chat disabled and Agent cloud execution truthful', async () => {
    const disabled = await json('/api/v1/conversations/' + conversationId + '/messages:stream', {
      method: 'POST', cookie, body: { content: 'Must not call a provider' }, headers: { 'Idempotency-Key': randomUUID() },
    }, 503);
    assert.equal(disabled.error.code, 'SERVICE_UNAVAILABLE');
    const capabilities = await json('/api/v1/agent/capabilities', { cookie }, 200);
    for (const key of ['cloudRuntime', 'runExecution', 'ask', 'plan', 'execute']) {
      assert.equal(capabilities.capabilities[key].available, false);
      assert.equal(capabilities.capabilities[key].reason, 'runtime_unavailable');
    }
    const { workspace } = await json('/api/v1/agent/workspaces', { method: 'POST', cookie, body: { source: { kind: 'blank' } } }, 201);
    const { run: agentRun } = await json('/api/v1/agent/runs', {
      method: 'POST', cookie, headers: { 'Idempotency-Key': randomUUID() },
      body: { workspaceId: workspace.id, task: 'Execution must stay disabled', mode: 'execute' },
    }, 201);
    assert.equal(agentRun.status, 'failed'); assert.equal(agentRun.error.code, 'RUNTIME_UNAVAILABLE');
    assert.equal(Object.hasOwn(agentRun, 'result'), false);
  });
  await check('real PostgreSQL role logins and denied privileged writes', async () => {
    for (const [login, key] of [
      ['giga_admin', 'DB_PASSWORD_ADMIN'], ['giga_migration', 'DB_PASSWORD_MIGRATION'],
      ['giga_runtime', 'DB_PASSWORD_API'], ['giga_lifecycle', 'DB_PASSWORD_LIFECYCLE'], ['giga_quota', 'DB_PASSWORD_QUOTA'],
    ]) assert.equal(sql('SELECT current_user;', login, key), login);
    const roleChecks = await readFile('infra/docker/postgres/roles-check.sql', 'utf8');
    sql(roleChecks);
    assert.equal(sql("SELECT count(*) FROM users WHERE id='" + userId + "';"), '1');
  });
  await check('PostgreSQL has no published port and uses internal networking', async () => {
    const id = docker([...compose, 'ps', '-q', 'postgres']);
    const [container] = JSON.parse(docker(['inspect', id]));
    assert.ok(!container.NetworkSettings.Ports?.['5432/tcp']?.length);
    assert.deepEqual(container.HostConfig.PortBindings ?? {}, {});
    for (const name of Object.keys(container.NetworkSettings.Networks)) {
      assert.equal(JSON.parse(docker(['network', 'inspect', name]))[0].Internal, true);
    }
  });
  await check('migration service succeeds, exits, and API starts with unprivileged credentials only', async () => {
    const migrateId = docker([...compose, 'ps', '-a', '-q', 'migrate']);
    assert.ok(migrateId, 'Migrate container exists');
    const [migrateContainer] = JSON.parse(docker(['inspect', migrateId]));
    assert.equal(migrateContainer.State.Status, 'exited', 'Migrate container must be exited');
    assert.equal(migrateContainer.State.ExitCode, 0, 'Migrate container must exit successfully (0)');

    const migrateEnv = (migrateContainer.Config.Env ?? []).map(e => e.split('=')[0]);
    assert.ok(migrateEnv.includes('DB_PASSWORD_MIGRATION'), 'Migrate container has migration password');
    assert.ok(!migrateEnv.includes('DB_PASSWORD_API'), 'Migrate container must not have API password');
    assert.ok(!migrateEnv.includes('DB_PASSWORD_LIFECYCLE'), 'Migrate container must not have lifecycle password');
    assert.ok(!migrateEnv.includes('DB_PASSWORD_QUOTA'), 'Migrate container must not have quota password');

    const apiId = docker([...compose, 'ps', '-q', 'api']);
    assert.ok(apiId, 'API container exists');
    const [apiContainer] = JSON.parse(docker(['inspect', apiId]));
    assert.equal(apiContainer.State.Status, 'running', 'API container is running');
    const apiEnv = (apiContainer.Config.Env ?? []).map(e => e.split('=')[0]);
    assert.ok(apiEnv.includes('DB_PASSWORD_API'), 'API container has runtime DB credential');
    assert.ok(!apiEnv.includes('DB_PASSWORD_MIGRATION'), 'API container must not have migration password');
    assert.ok(!apiEnv.includes('DB_PASSWORD_LIFECYCLE'), 'API container must not have lifecycle password');
    assert.ok(!apiEnv.includes('DB_PASSWORD_QUOTA'), 'API container must not have quota password');
    assert.ok(!apiEnv.includes('MIGRATION_DATABASE_URL'), 'API container must not have migration database URL');
    assert.ok(!apiEnv.includes('AGENT_LIFECYCLE_FINALIZER_DATABASE_URL'), 'API container must not have lifecycle finalizer database URL');

    docker([...compose, 'restart', 'api']);
    await health();
    const result = await json('/health', {}, 200);
    assert.equal(result.status, 'ok');
  });
  await check('data and sessions persist after stack stop/start', async () => {
    docker([...compose, 'stop']);
    docker([...compose, 'up', '-d', '--wait', '--wait-timeout', '120']);
    await health();
    assert.equal((await json('/api/v1/auth/me', { cookie }, 200)).user.id, userId);
    const detail = await json('/api/v1/conversations/' + conversationId, { cookie }, 200);
    assert.equal(detail.conversation.id, conversationId);
  });
  await check('backup and restore preserve fixture data and grants in new disposable database', async () => {
    const backup = join(temporary, 'fixture.dump');
    const saved = run('sh', ['infra/docker/backup.sh', '--local', backup]);
    if (saved.status !== 0) throw new Error('Backup script failed:\n' + redact(saved.stderr));
    const restored = run('sh', ['infra/docker/restore-disposable.sh', '--local', backup]);
    if (restored.status !== 0) throw new Error('Disposable restore script failed:\n' + redact(restored.stderr));
    const database = restored.stdout.trim().split(/\r?\n/).at(-1);
    assert.match(database, /^giga_restore_test_[a-f0-9]{32}$/);
    assert.equal(sql("SELECT count(*) FROM users WHERE id='" + userId + "';", 'giga_admin', 'DB_PASSWORD_ADMIN', database), '1');
    assert.equal(sql("SELECT count(*) FROM conversations WHERE id='" + conversationId + "';", 'giga_admin', 'DB_PASSWORD_ADMIN', database), '1');
    assert.equal(sql("SELECT title FROM conversations WHERE id='" + conversationId + "';", 'giga_admin', 'DB_PASSWORD_ADMIN', database), 'Persistent Docker fixture');
    assert.equal(sql("SELECT email FROM users WHERE id='" + userId + "';", 'giga_admin', 'DB_PASSWORD_ADMIN', database), email);
    assert.equal(sql("SELECT count(*) FROM sessions WHERE user_id='" + userId + "';", 'giga_admin', 'DB_PASSWORD_ADMIN', database),
      sql("SELECT count(*) FROM sessions WHERE user_id='" + userId + "';"));
    sql(await readFile('infra/docker/postgres/roles-check.sql', 'utf8'), 'giga_admin', 'DB_PASSWORD_ADMIN', database);
  });
  await check('missing secrets, invalid origin and provider configuration fail closed', async () => {
    for (const override of [
      'DB_PASSWORD_API=',
      'DB_PASSWORD_API=' + '0'.repeat(64),
      'DB_PASSWORD_MIGRATION=' + randomBytes(32).toString('hex'),
      'DB_PASSWORD_LIFECYCLE=' + randomBytes(32).toString('hex'),
      'ALLOWED_ORIGINS=*',
      'CHAT_ENABLED=true'
    ]) {
      const result = run('docker', [...compose, 'run', '--rm', '--no-deps', '-e', override, 'api']);
      assert.notEqual(result.status, 0, 'Invalid API configuration is rejected: ' + override.split('=')[0]);
      assert.ok(!result.error, 'Negative probe must finish rather than time out');
    }
    for (const override of [
      'DB_PASSWORD_MIGRATION=',
      'DB_PASSWORD_API=' + randomBytes(32).toString('hex')
    ]) {
      const result = run('docker', [...compose, 'run', '--rm', '--no-deps', '-e', override, 'migrate']);
      assert.notEqual(result.status, 0, 'Invalid migration configuration is rejected: ' + override.split('=')[0]);
      assert.ok(!result.error, 'Negative probe must finish rather than time out');
    }
    await health();
  });
  await check('API startup fails closed if required schema migrations are missing', async () => {
    try {
      sql('ALTER TABLE public.schema_migrations RENAME TO schema_migrations_hidden;');
      const rejected = run('docker', [...compose, 'run', '--rm', '--no-deps', 'api']);
      assert.notEqual(rejected.status, 0, 'API startup fails closed when schema_migrations is missing');
      assert.ok(!rejected.error, 'Schema check must fail without timeout');
    } finally {
      sql('ALTER TABLE public.schema_migrations_hidden RENAME TO schema_migrations;');
    }
    await health();
  });
  await check('production startup rejects runtime with finalizer membership', async () => {
    try {
      sql('GRANT giga_agent_lifecycle_finalizer TO giga_runtime;');
      const rejected = run('docker', [...compose, 'run', '--rm', '--no-deps', 'api']);
      assert.notEqual(rejected.status, 0, 'Production role validation rejects a privileged runtime login');
      assert.ok(!rejected.error, 'Role validation must fail without a timeout');
    } finally {
      sql('REVOKE giga_agent_lifecycle_finalizer FROM giga_runtime;');
    }
    sql(await readFile('infra/docker/postgres/roles-check.sql', 'utf8'));
    await health();
  });
  await check('production auto startup applies ACL migration on fresh databases and upgrades from 016', async () => {
    const databases = ['fresh', 'upgrade'].map(kind => 'giga_auto_' + kind + '_' + randomUUID().replaceAll('-', ''));
    for (const database of databases) {
      sql(`CREATE DATABASE ${database} OWNER giga_migration TEMPLATE template0;`);
      sql('REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE, CREATE ON SCHEMA public TO giga_agent_lifecycle_owner;',
        'giga_admin', 'DB_PASSWORD_ADMIN', database);
    }
    const output = docker([
      ...compose, 'run', '--rm', '--no-deps', '-e', 'DB_PASSWORD_API',
      '-v', './infra/docker/tests/migration-smoke.mjs:/app/infra/docker/tests/migration-smoke.mjs:ro',
      'migrate', 'node', 'infra/docker/tests/migration-smoke.mjs', ...databases,
    ], { env: { ...process.env, DB_PASSWORD_API: parseEnv(envText).DB_PASSWORD_API } });
    assert.match(output, /PASS auto fresh, 016 upgrade, and per-privilege startup guards/);
    return { paths: ['fresh database', 'upgrade from 016 with legacy ACLs and existing data'], deniedGrants: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] };
  });
  await check('real browser login, protected deep link, reload and logout', async () => {
    return browserSmoke({ base, email, password, conversationId });
  });
  await check('incremental SSE through Nginx with deterministic injected adapter', async () => {
    fixtureActive = true;
    docker([...fixture, 'up', '-d', '--wait', '--wait-timeout', '120', '--force-recreate', 'api', 'nginx']);
    await health();
    const response = await request('/api/v1/conversations/' + conversationId + '/messages:stream', {
      method: 'POST', cookie, body: { content: 'Deterministic fixture; no real provider' },
      headers: { 'Idempotency-Key': randomUUID() },
    });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const received = []; let buffer = ''; const decoder = new TextDecoder();
    const start = Date.now();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const event = frame.match(/^event: (.+)$/m)?.[1];
        const data = frame.match(/^data: (.+)$/m)?.[1];
        if (event && data) received.push({ event, data: JSON.parse(data), atMs: Date.now() - start });
      }
    }
    assert.deepEqual(received.map(item => item.event), ['message.started', 'message.delta', 'message.delta', 'message.delta', 'message.completed']);
    const deltas = received.filter(item => item.event === 'message.delta');
    assert.equal(deltas.map(item => item.data.text).join(''), 'Deterministic Docker fixture.');
    for (let index = 1; index < deltas.length; index++) assert.ok(deltas[index].atMs - deltas[index - 1].atMs >= 250, 'SSE delta frames arrive separately');
    assert.ok(received.at(-1).atMs - received[0].atMs >= 1200, 'Started frame arrives before delayed completion');
    const capabilities = await json('/api/v1/agent/capabilities', { cookie }, 200);
    assert.equal(capabilities.capabilities.cloudRuntime.available, false, 'Chat fixture cannot enable Agent cloud execution');
    const detail = await json('/api/v1/conversations/' + conversationId, { cookie }, 200);
    assert.ok(detail.messages.some(message => message.role === 'assistant' && message.content === 'Deterministic Docker fixture.'));
    return { provider: 'deterministic fixture; zero live provider calls', frames: received.map(({ event, atMs }) => ({ event, atMs })) };
  });
  await check('application rollback removes fixture and retains persisted state', async () => {
    docker([...compose, 'up', '-d', '--wait', '--wait-timeout', '120', '--force-recreate', 'api', 'nginx']);
    fixtureActive = false; await health();
    assert.equal((await request('/api/v1/conversations/' + conversationId, { cookie })).status, 200);
    assert.equal((await request('/api/v1/conversations/' + conversationId + '/messages:stream', {
      method: 'POST', cookie, body: { content: 'Chat must again be disabled' }, headers: { 'Idempotency-Key': randomUUID() },
    })).status, 503);
  });
  await check('logout revokes existing real API session', async () => {
    assert.equal((await request('/api/v1/auth/logout', { method: 'POST', cookie })).status, 204);
    assert.equal((await request('/api/v1/auth/me', { cookie })).status, 401);
  });
} catch (error) {
  checks.push({ name: activeCheck, outcome: 'FAIL', detail: redact(error instanceof assert.AssertionError ? error.message.split('\n')[0] : error.message ?? 'Smoke check failed') });
  console.error('FAIL ' + activeCheck);
  process.exitCode = 1;
} finally {
  if (fixtureActive) {
    const rollback = run('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '120', '--force-recreate', 'api', 'nginx']);
    if (rollback.status !== 0) process.exitCode = 1;
  }
  await mkdir(reportDir, { recursive: true });
  const sha = run('git', ['rev-parse', 'HEAD']).stdout.trim();
  const containers = run('docker', [...compose, 'ps', '-q']).stdout.trim().split(/\s+/).filter(Boolean);
  const metrics = containers.length ? run('docker', ['stats', '--no-stream', '--format', '{{.Name}} CPU={{.CPUPerc}} memory={{.MemUsage}} pids={{.PIDs}}', ...containers]).stdout.trim() : '';
  const images = run('docker', [...compose, 'images', '--format', 'json']).stdout.trim();
  const runtimeVersions = {
    docker: run('docker', ['version', '--format', '{{.Server.Version}}']).stdout.trim(),
    compose: run('docker', ['compose', 'version', '--short']).stdout.trim(),
    node: run('docker', [...compose, 'exec', '-T', 'api', 'node', '--version']).stdout.trim(),
    chrome: run(process.env.CHROME_BIN ?? 'google-chrome', ['--version']).stdout.trim(),
  };
  let databaseSizeBytes = null;
  try {
    runtimeVersions.postgres = sql('SHOW server_version;');
    databaseSizeBytes = Number(sql('SELECT pg_database_size(current_database());'));
  } catch {}
  const report = { testedCommit: sha, timestamp: new Date().toISOString(), environment: 'isolated local Docker Compose, NODE_ENV=production, explicit HTTP override', liveProviderCalls: 0, runtimeVersions, checks, resourceSnapshot: metrics, databaseSizeBytes, imageInventory: images };
  await writeFile(join(reportDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(reportDir, 'summary.md'), '# Docker Compose smoke evidence\n\nTested commit: ' + sha + '\n\nReal provider calls: 0. SSE uses an explicitly injected deterministic adapter.\n\n' + checks.map(item => '- ' + item.outcome + ': ' + item.name).join('\n') + '\n\nResource snapshot:\n\n' + metrics + '\n\nDatabase size in bytes: ' + databaseSizeBytes + '\n\nRuntime versions: ' + JSON.stringify(runtimeVersions) + '\n');
  await rm(temporary, { recursive: true, force: true });
}
