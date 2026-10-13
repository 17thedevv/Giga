import { createDatabasePool, redactDatabaseUrl, closeDatabasePool } from './client.js';
import { runMigrations } from './migrate.js';
import { loadConfig } from '../app/config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`[giga-db] Connecting to database: ${redactDatabaseUrl(config.databaseUrl)}`);

  if (!config.databaseUrl) {
    console.error('[giga-db] Error: DATABASE_URL environment variable is not configured.');
    process.exit(1);
  }

  const pool = createDatabasePool({ connectionString: config.databaseUrl });

  try {
    const applied = await runMigrations(pool);
    if (applied.length === 0) {
      console.log('[giga-db] Database is already up to date. No pending migrations.');
    } else {
      console.log(`[giga-db] Successfully applied ${applied.length} migration(s).`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[giga-db] Migration execution failed: ${message}`);
    process.exit(1);
  } finally {
    await closeDatabasePool(pool);
  }
}

main().catch((err) => {
  console.error('[giga-db] Fatal migration error:', err);
  process.exit(1);
});
