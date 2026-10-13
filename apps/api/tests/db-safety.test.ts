import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateTestDatabaseSafety, createTestDatabase } from './test-db-helper.js';

describe('Test Database Safety Safeguards', () => {
  it('refuses test database operations when NODE_ENV is not test', () => {
    const validUrl = 'postgres://user:pass@localhost:5432/giga_test';

    const checkDev = validateTestDatabaseSafety(validUrl, { NODE_ENV: 'development' });
    assert.strictEqual(checkDev.safe, false);
    assert.match(checkDev.reason ?? '', /NODE_ENV === 'test'/);

    const checkUnset = validateTestDatabaseSafety(validUrl, { NODE_ENV: undefined });
    assert.strictEqual(checkUnset.safe, false);
  });

  it('rejects production-like database names', () => {
    const forbiddenNames = [
      'postgres://user:pass@localhost:5432/giga_prod',
      'postgres://user:pass@localhost:5432/giga_production',
      'postgres://user:pass@localhost:5432/giga_live_db',
      'postgres://user:pass@localhost:5432/giga_staging',
      'postgres://user:pass@localhost:5432/main_db',
    ];

    for (const url of forbiddenNames) {
      const check = validateTestDatabaseSafety(url, { NODE_ENV: 'test' });
      assert.strictEqual(check.safe, false);
      assert.match(check.reason ?? '', /forbidden keyword/);
    }
  });

  it('rejects database names that do not contain test', () => {
    const nonTestUrl = 'postgres://user:pass@localhost:5432/giga_app_database';
    const check = validateTestDatabaseSafety(nonTestUrl, { NODE_ENV: 'test' });
    assert.strictEqual(check.safe, false);
    assert.match(check.reason ?? '', /must explicitly contain 'test'/);
  });

  it('rejects production-like hostnames', () => {
    const prodHostUrl = 'postgres://user:pass@production-db.internal:5432/giga_test_db';
    const check = validateTestDatabaseSafety(prodHostUrl, { NODE_ENV: 'test' });
    assert.strictEqual(check.safe, false);
    assert.match(check.reason ?? '', /forbidden keyword/);
  });

  it('authorizes valid isolated test database target', () => {
    const safeUrl = 'postgres://test_user:test_pass@localhost:5432/giga_test_suite';
    const check = validateTestDatabaseSafety(safeUrl, { NODE_ENV: 'test' });
    assert.strictEqual(check.safe, true);
    assert.strictEqual(check.reason, undefined);
  });

  it('ordinary DATABASE_URL alone never authorizes test cleanup', async () => {
    // Save original env
    const origDbUrl = process.env.DATABASE_URL;
    const origTestDbUrl = process.env.TEST_DATABASE_URL;

    try {
      // Simulate environment where ordinary DATABASE_URL is set to production-like or arbitrary DB
      process.env.DATABASE_URL = 'postgres://app_user:secret@localhost:5432/giga_app_production';
      delete process.env.TEST_DATABASE_URL;

      // createTestDatabase MUST NOT use DATABASE_URL; it must use in-memory pg-mem
      const testDb = await createTestDatabase();
      assert.strictEqual(testDb.isMemory, true);

      await testDb.cleanup();
      await testDb.pool.end();
    } finally {
      process.env.DATABASE_URL = origDbUrl;
      process.env.TEST_DATABASE_URL = origTestDbUrl;
    }
  });

  it('fails fast without silent fallback when TEST_DATABASE_URL points to unreachable database', async () => {
    const origTestDbUrl = process.env.TEST_DATABASE_URL;
    const origNodeEnv = process.env.NODE_ENV;

    try {
      process.env.NODE_ENV = 'test';
      // Use an unreachable port
      process.env.TEST_DATABASE_URL = 'postgres://test_user:secret_pw@127.0.0.1:59999/giga_test';

      await assert.rejects(
        async () => {
          await createTestDatabase();
        },
        (err: Error) => {
          // Must fail clearly (NO silent fallback)
          assert.match(err.message, /Real PostgreSQL test database initialization failed/);
          // Security requirement: database credentials must NEVER appear in test errors
          assert.ok(!err.message.includes('secret_pw'), 'Error message must not leak credentials');
          return true;
        }
      );
    } finally {
      process.env.TEST_DATABASE_URL = origTestDbUrl;
      process.env.NODE_ENV = origNodeEnv;
    }
  });
});
