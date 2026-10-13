import crypto from 'node:crypto';
import type pg from 'pg';
import { newDb, DataType } from 'pg-mem';
import { createDatabasePool, redactDatabaseUrl } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

export interface TestDbInstance {
  readonly pool: pg.Pool;
  readonly cleanup: () => Promise<void>;
  readonly isMemory: boolean;
}

export interface TestDbSafetyCheckResult {
  readonly safe: boolean;
  readonly reason?: string;
}

const FORBIDDEN_KEYWORDS = ['prod', 'production', 'live', 'staging', 'stage', 'main'];

/**
 * Validates that a database URL points to an isolated, dedicated test database.
 * Safeguards:
 * 1. NODE_ENV must be explicitly set to 'test'.
 * 2. Database name must contain 'test'.
 * 3. Neither database name nor host may contain production-like keywords (prod, live, main, etc.).
 */
export function validateTestDatabaseSafety(
  rawUrl: string,
  env: { NODE_ENV?: string } = process.env
): TestDbSafetyCheckResult {
  if (env.NODE_ENV !== 'test') {
    return {
      safe: false,
      reason: `Test database operations require NODE_ENV === 'test' (currently '${env.NODE_ENV ?? '<unset>'}')`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'Invalid database URL format' };
  }

  const dbName = parsed.pathname.replace(/^\//, '').toLowerCase();
  if (!dbName) {
    return { safe: false, reason: 'Database name is missing from connection URL' };
  }

  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (dbName.includes(keyword)) {
      return {
        safe: false,
        reason: `Target database name '${dbName}' contains forbidden keyword '${keyword}'`,
      };
    }
  }

  if (!dbName.includes('test')) {
    return {
      safe: false,
      reason: `Target database name '${dbName}' must explicitly contain 'test'`,
    };
  }

  const host = parsed.hostname.toLowerCase();
  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (host.includes(keyword)) {
      return {
        safe: false,
        reason: `Target database host '${host}' contains forbidden keyword '${keyword}'`,
      };
    }
  }

  return { safe: true };
}

/**
 * Creates an isolated test database for integration testing.
 *
 * Safety rules:
 * - Uses ONLY the dedicated TEST_DATABASE_URL environment variable.
 * - Ordinary DATABASE_URL alone NEVER authorizes test cleanup or test execution.
 * - If TEST_DATABASE_URL is provided, fails fast if safeguards fail or connection cannot be established (NO silent fallback to pg-mem).
 * - If TEST_DATABASE_URL is not set, explicitly uses memory-isolated pg-mem for unit tests.
 */
export async function createTestDatabase(): Promise<TestDbInstance> {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

  // Guard: ordinary DATABASE_URL must NEVER implicitly authorize real DB cleanup in tests
  if (testDatabaseUrl) {
    const safetyCheck = validateTestDatabaseSafety(testDatabaseUrl, process.env);
    if (!safetyCheck.safe) {
      throw new Error(`[test-db-safety] Refusing to use database: ${safetyCheck.reason}`);
    }

    let pool: pg.Pool;
    try {
      pool = createDatabasePool({
        connectionString: testDatabaseUrl,
        connectionTimeoutMillis: 3000,
      });

      // Verify connected database identity directly from the active connection
      const identityRes = await pool.query<{ current_database: string }>('SELECT current_database();');
      const actualDb = identityRes.rows[0]?.current_database?.toLowerCase() ?? '';

      for (const keyword of FORBIDDEN_KEYWORDS) {
        if (actualDb.includes(keyword)) {
          await pool.end();
          throw new Error(`Active database '${actualDb}' contains forbidden keyword '${keyword}'`);
        }
      }

      if (!actualDb.includes('test')) {
        await pool.end();
        throw new Error(`Active database '${actualDb}' does not contain 'test'`);
      }

      await runMigrations(pool);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Redact credentials in error message
      const sanitized = message.replace(testDatabaseUrl, redactDatabaseUrl(testDatabaseUrl));
      throw new Error(`Real PostgreSQL test database initialization failed: ${sanitized}`);
    }

    const cleanup = async (): Promise<void> => {
      // Re-verify safety before executing destructive TRUNCATE
      const check = validateTestDatabaseSafety(testDatabaseUrl, process.env);
      if (!check.safe) {
        throw new Error(`[test-db-safety] Refusing cleanup: ${check.reason}`);
      }
      await pool.query('TRUNCATE users, sessions, user_preferences, skill_installations, skill_versions, skill_definitions, workspace_skill_defaults CASCADE;');
    };

    return { pool, cleanup, isMemory: false };
  }

  // Explicit in-memory fallback when no TEST_DATABASE_URL is provided
  const db = newDb({ noAstCoverageCheck: true });

  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    impure: true,
    implementation: () => crypto.randomUUID(),
  });

  db.public.registerFunction({
    name: 'length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (str: string) => (str ? str.length : 0),
  });

  db.public.registerFunction({
    name: 'char_length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (str: string) => (str ? str.length : 0),
  });

  db.public.registerFunction({
    name: 'octet_length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (str: string) => (str ? Buffer.byteLength(String(str), 'utf8') : 0),
  });

  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool() as unknown as pg.Pool;

  await runMigrations(pool);

  const cleanup = async (): Promise<void> => {
    await pool.query('DELETE FROM workspace_skill_defaults;');
    await pool.query('DELETE FROM skill_installations;');
    await pool.query('DELETE FROM skill_versions;');
    await pool.query('DELETE FROM skill_definitions;');
    await pool.query('DELETE FROM user_preferences;');
    await pool.query('DELETE FROM sessions;');
    await pool.query('DELETE FROM users;');
  };

  return { pool, cleanup, isMemory: true };
}
