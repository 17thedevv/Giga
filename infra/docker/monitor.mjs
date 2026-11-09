import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const services = ['api', 'nginx', 'postgres', 'migrate'];
const defaults = {
  cpuPercent: 85, memoryPercent: 85, diskPercent: 85,
  errors: 5, authFailures: 10, streamFailures: 5, backupHours: 26,
  waiting: 3, anomalies: 1,
};
const snapshotCounters = [
  'databaseBytes', 'schemaVersion', 'stuckChat', 'agentAdmissions',
  'agentCompleted', 'agentCancelled', 'agentWorkerFailures', 'agentStuckQueue',
  'agentExpiredLeases', 'agentCleanupFailures', 'agentProviderFailures',
  'agentAmbiguousAllocations', 'agentQuotaReconciliation', 'agentQuotaLimits',
];

function thresholds(env) {
  return Object.fromEntries(Object.entries(defaults).map(([key, value]) => {
    const name = 'GIGA_OPS_' + key.replace(/[A-Z]/g, ch => '_' + ch).toUpperCase();
    const selected = env[name] === undefined ? value : Number(env[name]);
    if (!Number.isFinite(selected) || selected <= 0) throw new Error('Invalid ' + name);
    return [key, selected];
  }));
}

export function readBackup(directory, now = Date.now()) {
  const markers = readdirSync(directory).filter(name => name.endsWith('.status'));
  if (markers.length > 1000) throw new Error('Too many backup status files');
  let latest = { state: 'missing', time: -Infinity };
  let completed = -Infinity;
  for (const name of markers) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 16) continue;
    let state = readFileSync(path, 'utf8').trim();
    if (state === 'complete') {
      try {
        const archive = lstatSync(path.slice(0, -'.status'.length));
        if (!archive.isFile() || archive.size === 0) state = 'failed';
      } catch { state = 'failed'; }
    }
    if (state === 'complete') completed = Math.max(completed, stat.mtimeMs);
    if (stat.mtimeMs >= latest.time) {
      latest = { state: state === 'complete' || state === 'pending' ? state : 'failed', time: stat.mtimeMs };
    }
  }
  return { latest: latest.state, ageHours: Number.isFinite(completed) ? Math.max(0, (now - completed) / 3600000) : null };
}

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  return result.status === 0 ? result.stdout : null;
}

function jsonLines(text) {
  if (text === null) return null;
  return text.split(/\r?\n/).flatMap(line => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' ? value : [];
    } catch { return []; }
  });
}

export function logCounts(text) {
  const lines = jsonLines(text);
  if (!lines) return null;
  return {
    edgeErrors: lines.filter(x => x.event === 'http_edge' && /^5\d\d$/.test(String(x.status))).length,
    authFailures: lines.filter(x => x.event === 'http_request' && x.route === '/api/v1/auth/login' && x.status === 401).length,
    streamFailures: lines.filter(x => x.event === 'chat_stream_end'
      && ['failed', 'provider_error', 'timeout', 'disconnected'].includes(x.outcome)).length,
    capped: lines.length >= 4000,
  };
}

function usagePercent(text) {
  const match = text?.trim().split(/\r?\n/).at(-1)?.match(/\s(\d{1,3})%\s/);
  return match ? Number(match[1]) : null;
}

function probe(compose, route, invoke) {
  const code = "fetch('http://127.0.0.1:3001/" + route + "',{signal:AbortSignal.timeout(2500)})"
    + ".then(async r=>console.log(await r.text())).catch(()=>process.exitCode=1)";
  const response = invoke([...compose, 'exec', '-T', 'api', 'node', '-e', code]);
  return jsonLines(response)?.[0] ?? null;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function collect(backupDir, envFile, invoke = docker) {
  const compose = ['compose', ...(envFile ? ['--env-file', envFile] : [])];
  const ps = jsonLines(invoke([...compose, 'ps', '--all', '--format', 'json']));
  const entries = ps?.filter(row => services.includes(row.Service) && /^[a-f0-9]{12,64}$/.test(row.ID)) ?? [];
  const states = Object.fromEntries(services.map(service => {
    const row = entries.find(x => x.Service === service);
    const state = ['running', 'exited', 'restarting', 'created', 'dead'].includes(row?.State) ? row.State : 'unknown';
    const health = ['healthy', 'unhealthy', 'starting'].includes(row?.Health) ? row.Health : 'unknown';
    return [service, { state, health, exitCode: finite(row?.ExitCode), restarts: null, cpuPercent: null, memoryPercent: null }];
  }));
  const running = entries.filter(row => row.State === 'running');
  if (entries.length) {
    const inspected = jsonLines(invoke(['inspect', '--format', '{"id":"{{.Id}}","restarts":{{.RestartCount}}}', ...entries.map(x => x.ID)]));
    for (const row of entries) {
      states[row.Service].restarts = finite(inspected?.find(x => x.id?.startsWith(row.ID))?.restarts);
    }
  }
  if (running.length) {
    const stats = jsonLines(invoke(['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}', ...running.map(x => x.ID)]));
    for (const row of running) {
      const sample = stats?.find(x => x.ID?.startsWith(row.ID));
      for (const [field, key] of [['cpuPercent', 'CPUPerc'], ['memoryPercent', 'MemPerc']]) {
        const raw = sample?.[key];
        states[row.Service][field] = typeof raw === 'string' && /^\d+(\.\d+)?%$/.test(raw) ? Number(raw.slice(0, -1)) : null;
      }
    }
  }
  const readiness = states.api.state === 'running' ? probe(compose, 'ready', invoke)?.status : 'not_ready';
  const ready = readiness === 'ready' ? true : readiness === 'not_ready' ? false : null;
  const raw = ready ? probe(compose, 'ops', invoke) : null;
  const operations = raw?.status === 'ok' ? {
    ...Object.fromEntries(snapshotCounters.map(key => [key, finite(raw[key])])),
    poolWaiting: finite(raw.pool?.waiting),
    chatConfigured: raw.chatConfigured === true,
    agentCloudDisabled: raw.agentCloud === 'disabled',
  } : null;
  const pgDiskPercent = usagePercent(invoke([...compose, 'exec', '-T', 'postgres', 'df', '-Pk', '/var/lib/postgresql/data']));
  let backup = null, backupDiskPercent = null;
  try {
    backup = readBackup(backupDir);
    const space = statfsSync(backupDir);
    if (space.blocks > 0) backupDiskPercent = (1 - space.bavail / space.blocks) * 100;
  } catch { /* Report unavailable, without a path or raw error. */ }
  return {
    composeAvailable: ps !== null, states, ready, operations,
    pgDiskPercent, backupDiskPercent, backup,
    logs: logCounts(invoke([...compose, 'logs', '--since', '5m', '--tail', '4000', '--no-color', '--no-log-prefix', 'api', 'nginx'])),
  };
}

export function evaluateAlerts(sample, limits = defaults) {
  const alerts = [];
  const add = (condition, code) => { if (condition) alerts.push(code); };
  if (!sample.composeAvailable) return ['monitor_unavailable'];
  add(sample.states.api.state !== 'running' || sample.ready === false, 'api_unavailable');
  add(sample.states.nginx.state !== 'running' || sample.states.nginx.health !== 'healthy', 'nginx_unavailable');
  add(sample.states.postgres.state !== 'running' || sample.states.postgres.health !== 'healthy', 'postgres_unavailable');
  add(sample.states.migrate.state === 'exited' && sample.states.migrate.exitCode !== 0, 'migration_failed');
  add(!sample.logs || !sample.backup || sample.pgDiskPercent === null || sample.backupDiskPercent === null
    || !sample.operations || snapshotCounters.some(key => sample.operations[key] === null)
    || Object.values(sample.states).some(row => row.state === 'running'
      && [row.cpuPercent, row.memoryPercent, row.restarts].includes(null)), 'monitor_partial');
  for (const name of ['api', 'nginx', 'postgres']) {
    const state = sample.states[name];
    add((state.cpuPercent ?? 0) >= limits.cpuPercent || (state.memoryPercent ?? 0) >= limits.memoryPercent, name + '_resource_high');
  }
  add(Math.max(sample.pgDiskPercent ?? 0, sample.backupDiskPercent ?? 0) >= limits.diskPercent, 'disk_low');
  add(sample.backup?.latest === 'failed' || sample.backup?.latest === 'pending', 'backup_incomplete');
  add(sample.backup?.ageHours == null || sample.backup.ageHours >= limits.backupHours, 'backup_stale');
  add((sample.logs?.edgeErrors ?? 0) >= limits.errors, 'edge_5xx');
  add((sample.logs?.authFailures ?? 0) >= limits.authFailures, 'authentication_failures');
  add((sample.logs?.streamFailures ?? 0) >= limits.streamFailures, 'stream_failures');
  add(sample.logs?.capped, 'log_window_capped');
  add((sample.operations?.poolWaiting ?? 0) >= limits.waiting, 'postgres_pool_waiting');
  for (const [key, code] of [
    ['stuckChat', 'chat_stuck'], ['agentStuckQueue', 'agent_queue_stuck'], ['agentExpiredLeases', 'agent_lease_expired'],
    ['agentCleanupFailures', 'agent_cleanup_failed'], ['agentAmbiguousAllocations', 'agent_allocation_ambiguous'],
    ['agentQuotaReconciliation', 'agent_quota_reconciliation'], ['agentQuotaLimits', 'agent_quota_exhausted'],
    ['agentProviderFailures', 'agent_provider_failures'], ['agentWorkerFailures', 'agent_worker_failures'],
  ]) add((sample.operations?.[key] ?? 0) >= limits.anomalies, code);
  return alerts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [backupDir, envFile] = process.argv.slice(2);
    if (!backupDir || process.argv.length > 4) throw new Error('usage');
    const limits = thresholds(process.env);
    const sample = collect(backupDir, envFile);
    const alerts = evaluateAlerts(sample, limits);
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), sample, alerts }));
    process.exitCode = alerts.length ? 2 : 0;
  } catch {
    console.error('Monitoring failed. Usage: node infra/docker/monitor.mjs BACKUP_DIR [ENV_FILE]');
    process.exitCode = 2;
  }
}
