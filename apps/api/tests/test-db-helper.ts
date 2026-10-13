import crypto from 'node:crypto';
import type pg from 'pg';
import { newDb } from 'pg-mem';
import { createDatabasePool } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

export interface TestDbInstance {
  readonly pool: pg.Pool;
  readonly cleanup: () => Promise<void>;
  readonly isMemory: boolean;
}

/**
 * Creates an isolated test database.
 * If DATABASE_URL is set, connects to real PostgreSQL;
 * otherwise initializes a memory-isolated PostgreSQL emulator via pg-mem.
 */
export async function createTestDatabase(): Promise<TestDbInstance> {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (databaseUrl) {
    const pool = createDatabasePool({ connectionString: databaseUrl });
    await runMigrations(pool);

    const cleanup = async (): Promise<void> => {
      // Clear data between test runs while preserving schemas
      await pool.query('TRUNCATE users, sessions CASCADE;');
    };

    return { pool, cleanup, isMemory: false };
  }

  // Fallback to in-memory PostgreSQL for fast local test execution
  const db = newDb({ noAstCoverageCheck: true });

  // Register PostgreSQL native cryptographic functions
  db.public.registerFunction({
    name: 'gen_random_uuid',
    implementation: () => crypto.randomUUID(),
  });

  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool() as unknown as pg.Pool;

  await runMigrations(pool);

  const cleanup = async (): Promise<void> => {
    await pool.query('DELETE FROM sessions;');
    await pool.query('DELETE FROM users;');
  };

  return { pool, cleanup, isMemory: true };
}
