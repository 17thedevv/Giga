import { pathToFileURL } from 'node:url';

/** Infrastructure-only guard; checks environment before migration pool connection. */
export function configureMigrationEnvironment(env = process.env) {
  if (env.NODE_ENV !== 'production') throw new Error('Migration service requires NODE_ENV=production');
  if (env.DB_HOST !== 'postgres' || env.DB_NAME !== 'giga') throw new Error('This stack must target its dedicated Compose database');
  if (env.DB_PASSWORD_API || env.DB_PASSWORD_LIFECYCLE || env.DB_PASSWORD_QUOTA ||
      env.DATABASE_URL || env.AGENT_LIFECYCLE_FINALIZER_DATABASE_URL) {
    throw new Error('API, lifecycle, and quota credentials are forbidden in the migration container');
  }
  const password = env.DB_PASSWORD_MIGRATION;
  if (!/^[a-f0-9]{32,128}$/.test(password ?? '')) {
    throw new Error('Migration database password must be a random hex value (32-128 characters)');
  }
  env.MIGRATION_DATABASE_URL = `postgresql://giga_migration:${password}@postgres:5432/giga`;
  env.MIGRATION_MODE = 'auto';
  return env;
}

export async function runMigrationJob() {
  configureMigrationEnvironment();
  const { createDatabasePool, closeDatabasePool } = await import('../../apps/api/dist/db/client.js');
  const { runMigrations } = await import('../../apps/api/dist/db/migrate.js');
  const migrationPool = createDatabasePool({ connectionString: process.env.MIGRATION_DATABASE_URL });

  try {
    const applied = await runMigrations(migrationPool);
    if (applied.length > 0) {
      console.log(`[giga-migrate] Database migrations applied: ${applied.join(', ')}`);
    } else {
      console.log('[giga-migrate] Database schema is up to date; zero pending migrations.');
    }

    // Post-migration security hardening:
    // 1. schema_migrations must be read-only for runtime (AgentRepository checks migration 013 at runtime).
    await migrationPool.query('REVOKE ALL ON TABLE public.schema_migrations FROM giga_api_runtime');
    await migrationPool.query('GRANT SELECT ON TABLE public.schema_migrations TO giga_api_runtime');

    // 2. Restrict future-table default privileges (P2): replace fail-open default grants with least privilege.
    await migrationPool.query('ALTER DEFAULT PRIVILEGES FOR ROLE giga_migration IN SCHEMA public REVOKE ALL ON TABLES FROM giga_api_runtime');

    // 3. Ensure explicit CRUD access on existing application tables for giga_api_runtime.
    await migrationPool.query(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ' +
      'public.users, public.sessions, public.conversations, public.messages, ' +
      'public.skills, public.user_skill_preferences, public.skill_definitions, ' +
      'public.chat_generations, public.user_byok_credentials, public.agent_workspaces, ' +
      'public.agent_runs, public.agent_messages, public.agent_tool_calls, public.agent_artifacts ' +
      'TO giga_api_runtime'
    );

    console.log('[giga-migrate] Database migrations and least-privilege security hardening complete.');
  } finally {
    await closeDatabasePool(migrationPool);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrationJob().catch(() => {
    // Redacted output: do not dump connection credentials, URLs, or trace.
    console.error('[giga-migrate] Migration job failed: check database connection, credentials, and schema scripts.');
    process.exit(1);
  });
}
