import { pathToFileURL } from 'node:url';
import { once } from 'node:events';

/** Infrastructure-only guard; the application's production role checks still run. */
export function configureEnvironment(env = process.env) {
  if (env.NODE_ENV !== 'production' || env.SERVE_WEB !== 'true') throw new Error('Docker requires NODE_ENV=production and SERVE_WEB=true');
  if (env.AGENT_CLOUD_EXECUTION_ENABLED !== 'false') throw new Error('Agent cloud execution must remain disabled');
  if (Object.keys(env).some(key => /^(E2B_|AGENT_.*(?:KEY|TOKEN|ENABLED))/.test(key) && key !== 'AGENT_CLOUD_EXECUTION_ENABLED' && env[key])) {
    throw new Error('Agent cloud credentials and enable switches are forbidden in this stack');
  }
  const local = env.GIGA_LOCAL_HTTP === 'true';
  if (!['true', 'false'].includes(env.GIGA_LOCAL_HTTP)) throw new Error('GIGA_LOCAL_HTTP must be explicit');
  if (env.COOKIE_SECURE !== (local ? 'false' : 'true') || env.COOKIE_SAME_SITE !== 'lax') throw new Error('Invalid cookie profile');
  let origin;
  try { origin = new URL(env.ALLOWED_ORIGINS); } catch { throw new Error('Configure one exact allowed origin'); }
  if (origin.origin !== env.ALLOWED_ORIGINS || origin.username || origin.password ||
      (local ? !['http://localhost:8080', 'http://127.0.0.1:8080'].includes(origin.origin) : origin.protocol !== 'https:' || origin.port)) {
    throw new Error('Invalid origin for the selected HTTP/TLS profile');
  }
  if (env.DB_HOST !== 'postgres' || env.DB_NAME !== 'giga') throw new Error('This stack must target its dedicated Compose database');
  if (env.DB_PASSWORD_MIGRATION || env.DB_PASSWORD_LIFECYCLE || env.DB_PASSWORD_QUOTA ||
      env.MIGRATION_DATABASE_URL || env.AGENT_LIFECYCLE_FINALIZER_DATABASE_URL) {
    throw new Error('Privileged database credentials (migration, lifecycle, quota) are forbidden in the API container');
  }
  const apiPassword = env.DB_PASSWORD_API;
  if (!/^[a-f0-9]{32,128}$/.test(apiPassword ?? '')) {
    throw new Error('Database password must be a random hex value (32-128 characters)');
  }
  env.DATABASE_URL = `postgresql://giga_runtime:${apiPassword}@postgres:5432/giga`;
  env.MIGRATION_MODE = 'external';
  if (!['true', 'false'].includes(env.CHAT_ENABLED)) throw new Error('CHAT_ENABLED must be explicit');
  for (const key of ['GEMINI_API_KEY', 'CHAT_MODEL_ID', 'CREDENTIAL_ENCRYPTION_KEY']) if (env[key] === '') delete env[key];
  return env;
}

export async function start(options = {}) {
  configureEnvironment();
  const { loadConfig } = await import('../../apps/api/dist/app/config.js');
  const { startServer } = await import('../../apps/api/dist/app/server.js');
  const { startOperationsListener } = await import('../../apps/api/dist/app/operations.js');
  const { logSystemEvent } = await import('../../apps/api/dist/app/observability.js');
  const config = loadConfig(); // Reject provider/config errors before connecting.
  const running = await startServer({ ...options, config });
  const operations = startOperationsListener(running.pool, Boolean(config.chat));
  if (!operations.listening) await once(operations, 'listening');
  operations.on('error', () => {
    logSystemEvent('operations_listener_failed', 'error');
    process.exit(1);
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 25000);
    deadline.unref();
    const close = server => new Promise(resolve => server.close(resolve));
    void Promise.allSettled([close(running.server), close(operations)]).then(async () => {
      await Promise.allSettled([running.pool?.end(), running.lifecycleFinalizationPool?.end()]);
      process.exit(0);
    });
    running.server.closeIdleConnections?.();
    operations.closeIdleConnections?.();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return running;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch(() => {
    // Do not dump connection errors, URLs, request data or environment values.
    console.error('[giga-docker] Startup failed: check configuration, DB credentials, migrations and role grants.');
    process.exit(1);
  });
}
