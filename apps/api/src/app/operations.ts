import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { clearTimeout, setTimeout } from 'node:timers';
import type pg from 'pg';
import { RUNTIME_ACL_MIGRATION_VERSION } from '../db/migrate.js';
import { findMissingRuntimeTablePrivilege } from '../db/runtime-privileges.js';

// Check the required ACL migration explicitly while allowing later migrations.
const compatibility = `SELECT COALESCE(bool_or(version = $1), false) AS compatible,
  has_database_privilege(current_user, current_database(), 'CONNECT') AS "canConnect",
  max(version)::int AS version FROM public.schema_migrations`;

interface Compatibility {
  compatible: boolean;
  canConnect: boolean;
  version: number | null;
}

const counts = `
  SELECT pg_database_size(current_database())::text AS "databaseBytes",
    (SELECT count(*)::int FROM public.chat_generations WHERE status IN ('pending', 'streaming')
      AND COALESCE(started_at, created_at) < now() - interval '5 minutes') AS "stuckChat",
    (SELECT count(*)::int FROM public.agent_runs WHERE created_at >= now() - interval '24 hours') AS "agentAdmissions",
    (SELECT count(*)::int FROM public.agent_runs WHERE finished_at >= now() - interval '24 hours'
      AND status = 'completed') AS "agentCompleted",
    (SELECT count(*)::int FROM public.agent_runs WHERE finished_at >= now() - interval '24 hours'
      AND status = 'cancelled') AS "agentCancelled",
    (SELECT count(*)::int FROM public.agent_runs WHERE finished_at >= now() - interval '24 hours'
      AND status = 'failed' AND attempt_count > 0) AS "agentWorkerFailures",
    (SELECT count(*)::int FROM public.agent_runs WHERE status = 'queued'
      AND created_at < now() - interval '15 minutes') AS "agentStuckQueue",
    (SELECT count(*)::int FROM public.agent_runs WHERE status IN ('running', 'applying')
      AND (lease_expires_at <= now() OR (lease_expires_at IS NULL AND updated_at < now() - interval '15 minutes'))) AS "agentExpiredLeases",
    (SELECT count(*)::int FROM public.agent_sandbox_sessions WHERE cleanup_state = 'failed'
      OR (cleanup_state = 'in_progress' AND cleanup_lease_expires_at <= now())) AS "agentCleanupFailures",
    (SELECT count(*)::int FROM public.agent_sandbox_sessions WHERE allocation_state IN ('failed', 'timed_out')
      AND updated_at >= now() - interval '24 hours') AS "agentProviderFailures",
    (SELECT count(*)::int FROM public.agent_sandbox_lifecycle_operations
      WHERE operation_kind = 'allocation' AND state = 'ambiguous') AS "agentAmbiguousAllocations",
    (SELECT count(*)::int FROM public.agent_execution_reservations
      WHERE state = 'reconciliation_required') AS "agentQuotaReconciliation",
    (SELECT count(*)::int FROM public.agent_execution_usage_events WHERE limit_exceeded
      AND created_at >= now() - interval '24 hours') AS "agentQuotaLimits"`;

// A deadline bounds the HTTP response. Keep a single flight until the actual
// query settles, so a stalled DB cannot build a queue of monitoring queries.
function singleFlight<T>(read: () => Promise<T>, deadlineMs: number): () => Promise<T | undefined> {
  let pending: Promise<T | undefined> | undefined;
  return () => {
    if (pending) return pending;
    let cancelDeadline: () => void;
    const deadline = new Promise<undefined>(resolve => {
      const timer = setTimeout(resolve, deadlineMs);
      cancelDeadline = () => clearTimeout(timer);
    });
    const result = read().catch(() => undefined).finally(() => {
      cancelDeadline();
      pending = undefined;
    });
    pending = Promise.race([deadline, result]);
    return pending;
  };
}

async function readOnly<T>(pool: pg.Pool, query: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '750ms'");
    const value = await query(client);
    await client.query('COMMIT');
    committed = true;
    return value;
  } finally {
    // Destroy the client if a probe fails, including when the connection died
    // during a transaction. Never return an open transaction to the API pool.
    client.release(!committed);
  }
}

export function startOperationsListener(pool: pg.Pool, chatConfigured: boolean) {
  return serve({
    fetch: createOperationsApp(pool, chatConfigured).fetch,
    hostname: '127.0.0.1',
    port: 3001,
  });
}

export function createOperationsApp(pool: pg.Pool, chatConfigured: boolean, deadlineMs = 1500): Hono {
  const app = new Hono();
  const compatibilityCheck = async (client: pg.PoolClient) =>
    (await client.query<Compatibility>(compatibility, [RUNTIME_ACL_MIGRATION_VERSION])).rows[0];
  const ready = singleFlight(() => readOnly(pool, async client => {
    const schema = await compatibilityCheck(client);
    // A pooled connection can survive REVOKE CONNECT. Check the live ACLs
    // without touching application rows or issuing test writes.
    return schema?.compatible && schema.canConnect && !(await findMissingRuntimeTablePrivilege(client));
  }), deadlineMs);
  const snapshot = singleFlight(() => readOnly(pool, async client => {
    const schema = await compatibilityCheck(client);
    if (!schema?.compatible) return undefined;
    const result = (await client.query(counts)).rows[0];
    return {
      ...result,
      databaseBytes: Number(result.databaseBytes),
      schemaVersion: schema.version,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      chatConfigured,
      agentCloud: 'disabled',
    };
  }), deadlineMs);
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/ready', async c => await ready()
    ? c.json({ status: 'ready' }, 200)
    : c.json({ status: 'not_ready' }, 503));
  app.get('/ops', async c => {
    const sample = await snapshot();
    return sample ? c.json({ status: 'ok', ...sample }, 200) : c.json({ status: 'unavailable' }, 503);
  });
  return app;
}
