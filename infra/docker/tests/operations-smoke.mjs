// Fault injection is restricted to the disposable Compose project.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, evaluateAlerts } from '../monitor.mjs';

assert.equal(process.env.GIGA_DOCKER_SMOKE, '1');
assert.match(process.env.COMPOSE_PROJECT_NAME ?? '', /^giga-smoke-[a-z0-9-]+$/);
const compose = ['compose', '--env-file', '.env'];
const temporary = await mkdtemp(join(tmpdir(), 'giga-operations-smoke-'));
const run = (command, args) => spawnSync(command, args, { timeout: 160000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
function docker(args) {
  const result = run('docker', args);
  assert.equal(result.status, 0, 'Docker operation failed: ' + args.slice(0, 4).join(' '));
  return result.stdout;
}
function probe(path) {
  const code = `fetch('http://127.0.0.1:3001/${path}',{signal:AbortSignal.timeout(3000)})
    .then(async response => console.log(JSON.stringify({code:response.status, body:await response.json()})))
    .catch(() => process.exitCode=1)`;
  return JSON.parse(docker([...compose, 'exec', '-T', 'api', 'node', '-e', code]));
}
const live = () => fetch('http://localhost:8080/health', { signal: AbortSignal.timeout(5000) });
const backup = name => run('sh', ['infra/docker/backup.sh', '--local', join(temporary, name)]);
const checks = [];
try {
  assert.deepEqual(probe('ready'), { code: 200, body: { status: 'ready' } });
  const ops = probe('ops');
  assert.equal(ops.code, 200);
  assert.ok(ops.body.schemaVersion >= 17 && ops.body.databaseBytes > 0);
  assert.equal(ops.body.agentCloud, 'disabled');
  for (const path of ['ops', 'ready']) {
    const response = await fetch('http://localhost:8080/api/v1/' + path, {
      headers: { Authorization: 'Bearer invalid-monitor-fixture' }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 404);
  }
  const inaccessible = run('docker', [...compose, 'exec', '-T', 'nginx', 'wget', '-q', '-T', '2', '-O', '/dev/null', 'http://api:3001/ready']);
  assert.equal(inaccessible.status, 1, 'Management listener must be inaccessible from Nginx');
  checks.push('Readiness, current schema, disabled Cloud and private management listener');

  const response = await live();
  assert.equal(response.status, 200);
  const requestId = response.headers.get('x-request-id');
  assert.match(requestId ?? '', /^[a-f0-9-]{36}$/);
  await response.text();
  for (const [service, event] of [['api', 'http_request'], ['nginx', 'http_edge']]) {
    const logs = docker([...compose, 'logs', '--since', '1m', '--no-color', '--no-log-prefix', service]);
    const matches = logs.split('\n').some(line => {
      try {
        const entry = JSON.parse(line);
        return entry?.event === event && entry.requestId === requestId;
      } catch { return false; }
    });
    assert.ok(matches, 'Request ID must correlate across ' + service + ' logs');
  }
  checks.push('Correlated request ID across API and Nginx');

  docker([...compose, 'stop', 'postgres']);
  try {
    assert.deepEqual(probe('ready'), { code: 503, body: { status: 'not_ready' } });
    assert.equal((await live()).status, 200);
    assert.notEqual(backup('failed.dump').status, 0);
    assert.equal((await readFile(join(temporary, 'failed.dump.status'), 'utf8')).trim(), 'failed');
    checks.push('PostgreSQL outage leaves liveness up, drops readiness and records failed backup');
  } finally {
    docker([...compose, 'up', '-d', '--wait', '--wait-timeout', '120']);
  }
  docker([...compose, 'restart', 'api']);
  docker([...compose, 'up', '-d', '--wait', '--wait-timeout', '120']);
  assert.deepEqual(probe('ready'), { code: 200, body: { status: 'ready' } });
  assert.equal((await live()).status, 200);
  assert.equal(backup('complete.dump').status, 0, 'Disposable backup must complete');
  checks.push('API restart recovers readiness and PostgreSQL backup');

  const rssBeforeBytes = process.memoryUsage().rss;
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const sample = collect(temporary, '.env');
  const collectorDurationMs = Math.round(performance.now() - started);
  const cpu = process.cpuUsage(cpuBefore);
  const alerts = evaluateAlerts(sample);
  for (const code of ['monitor_unavailable', 'monitor_partial', 'api_unavailable', 'postgres_unavailable', 'nginx_unavailable', 'backup_incomplete', 'backup_stale']) {
    assert.ok(!alerts.includes(code), 'Unexpected collector alert: ' + code);
  }
  assert.equal(sample.ready, true);
  assert.equal(sample.backup?.latest, 'complete');
  checks.push('Collector reads container, PostgreSQL, log and backup signals');
  const commit = run('git', ['rev-parse', 'HEAD']);
  assert.equal(commit.status, 0);
  const report = {
    testedCommit: commit.stdout.trim(), checks, collectorDurationMs,
    collectorProcessCpuMs: Math.round((cpu.user + cpu.system) / 1000),
    smokeProcessRssBeforeBytes: rssBeforeBytes,
    smokeProcessRssAfterBytes: process.memoryUsage().rss,
    sample, alerts,
  };
  await mkdir('artifacts/docker-smoke', { recursive: true });
  await writeFile('artifacts/docker-smoke/ops-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
