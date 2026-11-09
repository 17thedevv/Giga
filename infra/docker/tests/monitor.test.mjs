import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collect, evaluateAlerts, logCounts, readBackup } from '../monitor.mjs';

test('freshness uses the latest successful backup and flags a newer failed attempt', t => {
  const directory = mkdtempSync(join(tmpdir(), 'giga-monitor-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const now = Date.now();
  assert.deepEqual(readBackup(directory, now), { latest: 'missing', ageHours: null });
  const marker = (name, state, hoursAgo) => {
    const file = join(directory, name + '.status');
    writeFileSync(file, state + '\n');
    const modified = new Date(now - hoursAgo * 3600000);
    utimesSync(file, modified, modified);
  };
  writeFileSync(join(directory, 'earlier.dump'), 'synthetic nonempty archive');
  marker('earlier.dump', 'complete', 2);
  marker('newer.dump', 'failed', 1);
  const backup = readBackup(directory, now);
  assert.equal(backup.latest, 'failed');
  assert.ok(Math.abs(backup.ageHours - 2) < 0.001);
  marker('missing.dump', 'complete', 0);
  assert.equal(readBackup(directory, now).latest, 'failed');
});

test('monitor unavailability is distinguishable from an observed outage', () => {
  const sample = collect('.', undefined, () => null);
  assert.deepEqual(evaluateAlerts(sample), ['monitor_unavailable']);
});

test('aggregate alerts flag database and backup failure and simulated Agent anomalies', () => {
  const running = { state: 'running', health: 'healthy', cpuPercent: 20, memoryPercent: 40, restarts: 0 };
  const sample = {
    composeAvailable: true, ready: false,
    states: { api: running, nginx: running, postgres: { state: 'exited' }, migrate: { state: 'exited', exitCode: 1 } },
    operations: { agentCleanupFailures: 1, agentQuotaReconciliation: 1, agentAmbiguousAllocations: 1, agentStuckQueue: 1, stuckChat: 1 },
    logs: { edgeErrors: 5, authFailures: 10, streamFailures: 5 },
    pgDiskPercent: null, backupDiskPercent: 90, backup: { latest: 'failed', ageHours: 30 },
  };
  for (const code of [
    'api_unavailable', 'postgres_unavailable', 'migration_failed', 'monitor_partial', 'disk_low',
    'backup_incomplete', 'backup_stale', 'edge_5xx', 'authentication_failures', 'stream_failures',
    'agent_cleanup_failed', 'agent_quota_reconciliation', 'agent_allocation_ambiguous', 'agent_queue_stuck', 'chat_stuck',
  ]) assert.ok(evaluateAlerts(sample).includes(code), code);
});

test('log window counts safe events and discards input fields', () => {
  const lines = [
    { event: 'http_edge', status: '502', authorization: 'private-fixture' },
    { event: 'http_edge', status: '404' },
    { event: 'http_request', route: '/api/v1/auth/login', status: 401 },
    { event: 'chat_stream_end', outcome: 'provider_error' },
    { event: 'chat_stream_end', outcome: 'completed' },
  ].map(record => JSON.stringify(record));
  const result = logCounts(['not JSON', 'null', ...lines].join('\n'));
  assert.deepEqual(result, { edgeErrors: 1, authFailures: 1, streamFailures: 1, capped: false });
  assert.equal(logCounts(Array(4000).fill(lines[0]).join('\n')).capped, true);
});
