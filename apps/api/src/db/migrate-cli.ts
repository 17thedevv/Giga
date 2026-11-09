import { createDatabasePool, closeDatabasePool } from './client.js';
import { runMigrations } from './migrate.js';
import { loadConfig } from '../app/config.js';
import { logSystemEvent } from '../app/observability.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const migrationUrl = config.migrationDatabaseUrl ?? config.databaseUrl;
  if (!migrationUrl) {
    logSystemEvent('migration_failed', 'error');
    process.exit(1);
  }

  const pool = createDatabasePool({ connectionString: migrationUrl });

  try {
    const applied = await runMigrations(pool);
    if (applied.length === 0) {
      console.log('[giga-db] Database is already up to date. No pending migrations.');
    } else {
      console.log(`[giga-db] Successfully applied ${applied.length} migration(s).`);
    }
  } catch {
    logSystemEvent('migration_failed', 'error');
    process.exitCode = 1;
  } finally {
    await closeDatabasePool(pool);
  }
}

main().catch(() => {
  logSystemEvent('migration_failed', 'error');
  process.exitCode = 1;
});
