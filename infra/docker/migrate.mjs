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
  } finally {
    await closeDatabasePool(migrationPool);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrationJob().catch((err) => {
    // Redacted output: do not dump connection credentials, URLs, or trace.
    console.error('[giga-migrate] Migration job failed: check database connection, credentials, and schema scripts.');
    if (err && err.message) {
      const safeMessage = String(err.message).replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-database-url]');
      console.error(`[giga-migrate] Error: ${safeMessage}`);
    }
    process.exit(1);
  });
}
