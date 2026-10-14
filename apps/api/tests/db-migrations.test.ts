import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb } from 'pg-mem';
import type pg from 'pg';
import { runMigrations, getAppliedMigrationVersions } from '../src/db/migrate.js';
import { redactDatabaseUrl, pingDatabase } from '../src/db/client.js';

describe('Database Migrations and Utilities', () => {
  it('runs migrations deterministically and idempotently', async () => {
    const db = newDb({ noAstCoverageCheck: true });
    db.public.interceptQueries((sql) => {
      if (sql.includes('prevent_skill_versions_update') || sql.includes('CREATE TRIGGER')) {
        const stripped = sql
          .replace(/CREATE OR REPLACE FUNCTION[\s\S]*?LANGUAGE plpgsql;/gi, '')
          .replace(/DROP TRIGGER[\s\S]*?;/gi, '')
          .replace(/CREATE TRIGGER[\s\S]*?;/gi, '');
        return db.public.many(stripped);
      }
      return null;
    });
    db.public.registerFunction({
      name: 'gen_random_uuid',
      implementation: () => crypto.randomUUID(),
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool() as unknown as pg.Pool;

    try {
      // First run: applies all pending migrations
      const firstRun = await runMigrations(pool);
      assert.strictEqual(firstRun.length, 3);
      assert.strictEqual(firstRun[0], '001_initial_users_and_sessions');
      assert.strictEqual(firstRun[1], '002_conversations_and_messages');
      assert.strictEqual(firstRun[2], '003_skills_and_preferences');

      const versions = await getAppliedMigrationVersions(pool);
      assert.ok(versions.has(1));
      assert.ok(versions.has(2));
      assert.ok(versions.has(3));

      // Second run: idempotent, applies 0 migrations
      const secondRun = await runMigrations(pool);
      assert.strictEqual(secondRun.length, 0);

      // Verify ping probe works
      const alive = await pingDatabase(pool);
      assert.strictEqual(alive, true);
    } finally {
      await pool.end();
    }
  });

  it('redactDatabaseUrl masks passwords in connection strings', () => {
    const raw = 'postgres://giga_user:super_secret_pw@db.neon.tech:5432/giga_prod?sslmode=require';
    const redacted = redactDatabaseUrl(raw);

    assert.ok(!redacted.includes('super_secret_pw'));
    assert.match(redacted, /postgres:\/\/giga_user:\*\*\*@db\.neon\.tech:5432\/giga_prod/);

    assert.strictEqual(redactDatabaseUrl(undefined), '<not-set>');
    assert.strictEqual(redactDatabaseUrl('not a url'), '<invalid-url>');
  });
});
