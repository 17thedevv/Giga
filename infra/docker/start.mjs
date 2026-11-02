import { pathToFileURL } from 'node:url';

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
  const roles = [['API', 'giga_runtime', 'DATABASE_URL'], ['MIGRATION', 'giga_migration', 'MIGRATION_DATABASE_URL'], ['LIFECYCLE', 'giga_lifecycle', 'AGENT_LIFECYCLE_FINALIZER_DATABASE_URL']];
  const passwords = roles.map(([role]) => env[`DB_PASSWORD_${role}`]);
  if (passwords.some(password => !/^[a-f0-9]{32,128}$/.test(password ?? '')) || new Set(passwords).size !== passwords.length) {
    throw new Error('Database passwords must be distinct random hex values (32-128 characters)');
  }
  for (const [role, login, name] of roles) {
    env[name] = `postgresql://${login}:${env[`DB_PASSWORD_${role}`]}@postgres:5432/giga`;
  }
  if (!['true', 'false'].includes(env.CHAT_ENABLED)) throw new Error('CHAT_ENABLED must be explicit');
  for (const key of ['GEMINI_API_KEY', 'CHAT_MODEL_ID', 'CREDENTIAL_ENCRYPTION_KEY']) if (env[key] === '') delete env[key];
  return env;
}

export async function start(options = {}) {
  configureEnvironment();
  const { loadConfig } = await import('../../apps/api/dist/app/config.js');
  const { createDatabasePool, closeDatabasePool } = await import('../../apps/api/dist/db/client.js');
  const { runMigrations } = await import('../../apps/api/dist/db/migrate.js');
  const { startServer } = await import('../../apps/api/dist/app/server.js');
  const config = loadConfig(); // Reject provider/config errors before connecting.
  const migrationPool = createDatabasePool({ connectionString: config.migrationDatabaseUrl });
  try {
    await runMigrations(migrationPool);
    // Migration 015 grants all tables to runtime. Keep migration history privileged.
    await migrationPool.query('REVOKE ALL ON TABLE public.schema_migrations FROM giga_api_runtime');
  } finally {
    await closeDatabasePool(migrationPool);
  }
  const running = await startServer({ ...options, config, skipMigrations: true });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 25000);
    deadline.unref();
    running.server.close(async () => {
      await Promise.allSettled([running.pool?.end(), running.lifecycleFinalizationPool?.end()]);
      process.exit(0);
    });
    running.server.closeIdleConnections?.();
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
