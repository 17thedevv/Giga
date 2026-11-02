// Self-signed, loopback-only HTTPS rehearsal. The certificate is trusted only
// by these requests; this never disables TLS verification globally.
import assert from 'node:assert/strict';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

assert.equal(process.env.GIGA_DOCKER_SMOKE, '1', 'HTTPS rehearsal requires explicit disposable smoke authorization');
assert.match(process.env.COMPOSE_PROJECT_NAME ?? '', /^giga-smoke-[a-z0-9-]+$/, 'HTTPS rehearsal requires an isolated smoke project');
const project = process.env.COMPOSE_PROJECT_NAME + '-https';
const compose = ['compose', '--env-file', '.env.https', '-p', project, '-f', 'compose.yaml'];
const certificate = await readFile('artifacts/private-tls/fullchain.pem');
const privateValues = (await readFile('.env.https', 'utf8')).split(/\r?\n/)
  .filter(line => /(?:PASSWORD|KEY|TOKEN|SECRET)=/.test(line))
  .map(line => line.slice(line.indexOf('=') + 1)).filter(value => value.length >= 8);
const origin = 'https://localhost';
const checks = [];
let activeCheck = '';

function local(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000 });
  return result.status === 0 ? result.stdout.trim() : 'unavailable';
}
function redact(value) {
  let text = String(value).replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-database-url]');
  for (const secret of privateValues) text = text.split(secret).join('[redacted]');
  return text.slice(-1500);
}
function request(path, { method = 'GET', cookie, body, requestOrigin = origin, plainHttp = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const send = plainHttp ? httpRequest : httpsRequest;
    const req = send({
      hostname: 'localhost', family: 4, port: plainHttp ? 80 : 443, path, method,
      ...(plainHttp ? {} : { ca: certificate, rejectUnauthorized: true }),
      headers: {
        ...(method === 'GET' ? {} : { Origin: requestOrigin }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
      },
    }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) { response.destroy(); reject(new Error('HTTPS smoke response exceeded limit')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode, headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'), tlsVersion: response.socket?.getProtocol?.(),
      }));
      response.on('error', () => reject(new Error('HTTPS response failed')));
    });
    req.setTimeout(10000, () => req.destroy(new Error('HTTPS request timed out')));
    req.on('error', () => reject(new Error('HTTPS connection or verified certificate check failed')));
    if (data !== undefined) req.write(data);
    req.end();
  });
}
async function check(name, operation) {
  activeCheck = name;
  const started = Date.now();
  const detail = await operation();
  checks.push({ name, outcome: 'PASS', durationMs: Date.now() - started, ...(detail ? { detail } : {}) });
  console.log('PASS HTTPS ' + name);
}
function securityHeaders(response) {
  assert.match(response.headers['strict-transport-security'], /max-age=31536000/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.match(response.headers['cache-control'], /no-store/);
}
const email = 'https-' + randomUUID() + '@example.invalid';
const password = 'Https!' + randomBytes(24).toString('hex');
let cookie;
let userId;
try {
  await check('HTTP redirects permanently to HTTPS', async () => {
    const response = await request('/health?rehearsal=1', { plainHttp: true });
    assert.equal(response.status, 308);
    assert.equal(response.headers.location, 'https://localhost/health?rehearsal=1');
  });
  await check('verified TLS health, security headers and frontend deep links', async () => {
    const health = await request('/health');
    assert.equal(health.status, 200); assert.equal(JSON.parse(health.text).status, 'ok');
    securityHeaders(health);
    for (const path of ['/', '/login', '/chat/' + randomUUID(), '/agent/runs/' + randomUUID()]) {
      const response = await request(path);
      assert.equal(response.status, 200); assert.match(response.headers['content-type'], /text\/html/);
      assert.match(response.text, /\/assets\//); securityHeaders(response);
    }
    const missing = await request('/api/v1/definitely-missing');
    assert.equal(missing.status, 404); assert.equal(JSON.parse(missing.text).error.code, 'NOT_FOUND');
    return { certificateValidation: 'explicit test CA, hostname localhost, no TLS bypass', tlsVersion: health.tlsVersion };
  });
  await check('real HTTPS registration, Secure HttpOnly SameSite cookie and authenticated request', async () => {
    const created = await request('/api/v1/auth/register', { method: 'POST', body: { email, password, displayName: 'HTTPS smoke' } });
    assert.equal(created.status, 201);
    userId = JSON.parse(created.text).user.id;
    const login = await request('/api/v1/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(login.status, 200); securityHeaders(login);
    const setCookie = login.headers['set-cookie']?.find(value => value.startsWith('giga_session='));
    assert.ok(setCookie, 'Login sets a session cookie');
    assert.match(setCookie, /;\s*Secure/i); assert.match(setCookie, /;\s*HttpOnly/i); assert.match(setCookie, /SameSite=Lax/i);
    cookie = setCookie.match(/giga_session=[a-f0-9]+/)[0];
    const me = await request('/api/v1/auth/me', { cookie });
    assert.equal(me.status, 200); assert.equal(JSON.parse(me.text).user.id, userId); securityHeaders(me);
  });
  await check('HTTPS CSRF rejects foreign origin and Agent cloud stays disabled', async () => {
    const rejected = await request('/api/v1/conversations', {
      method: 'POST', cookie, requestOrigin: 'https://attacker.invalid', body: {},
    });
    assert.equal(rejected.status, 403);
    const capabilities = await request('/api/v1/agent/capabilities', { cookie });
    assert.equal(capabilities.status, 200);
    const body = JSON.parse(capabilities.text);
    assert.equal(body.capabilities.cloudRuntime.available, false);
    assert.equal(body.capabilities.runExecution.available, false);
  });
  await check('HTTPS logout revokes authenticated session', async () => {
    const logout = await request('/api/v1/auth/logout', { method: 'POST', cookie });
    assert.equal(logout.status, 204); securityHeaders(logout);
    assert.ok(logout.headers['set-cookie']?.some(value => /Max-Age=0/i.test(value)));
    assert.equal((await request('/api/v1/auth/me', { cookie })).status, 401);
  });
} catch (error) {
  checks.push({ name: activeCheck, outcome: 'FAIL', detail: redact(error.message?.split('\n')[0] ?? 'HTTPS rehearsal failed') });
  console.error('FAIL HTTPS ' + activeCheck);
  process.exitCode = 1;
} finally {
  const reportDir = 'artifacts/docker-smoke';
  await mkdir(reportDir, { recursive: true });
  const testedCommit = local('git', ['rev-parse', 'HEAD']);
  const containers = local('docker', [...compose, 'ps', '-q']).split(/\s+/).filter(id => /^[a-f0-9]{12,64}$/.test(id));
  const resourceSnapshot = containers.length ? local('docker', ['stats', '--no-stream', '--format', '{{.Name}} CPU={{.CPUPerc}} memory={{.MemUsage}} pids={{.PIDs}}', ...containers]) : 'unavailable';
  const report = { testedCommit, timestamp: new Date().toISOString(), environment: 'separate disposable Compose HTTPS profile on loopback ports 80/443', certificate: 'ephemeral self-signed localhost certificate explicitly trusted by test requests only', liveProviderCalls: 0, checks, resourceSnapshot };
  await writeFile(join(reportDir, 'report-https.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(reportDir, 'summary-https.md'), '# Local HTTPS rehearsal\n\nTested commit: ' + testedCommit + '\n\nEphemeral self-signed localhost certificate; request-specific CA trust; real production cookie profile. Zero live provider calls.\n\n' + checks.map(item => '- ' + item.outcome + ': ' + item.name).join('\n') + '\n\nResource snapshot:\n\n' + resourceSnapshot + '\n');
}
