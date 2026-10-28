import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, DataType } from 'pg-mem';
import type pg from 'pg';
import { MIGRATIONS, runMigrations, getAppliedMigrationVersions } from '../src/db/migrate.js';
import { redactDatabaseUrl, pingDatabase } from '../src/db/client.js';

describe('Database Migrations and Utilities', () => {
  it('runs migrations deterministically and idempotently', async () => {
    const db = newDb({ noAstCoverageCheck: true });
    db.public.registerFunction({ name: 'octet_length', args: [DataType.text], returns: DataType.integer,
      implementation: (text: string) => Buffer.byteLength(text) });
    db.public.registerFunction({ name: 'char_length', args: [DataType.text], returns: DataType.integer,
      implementation: (text: string) => Array.from(text).length });
    db.public.interceptQueries((sql) => {
      const original = sql;
      sql = sql.replace("status VARCHAR(20) NOT NULL CHECK", "status VARCHAR(20) NOT NULL CONSTRAINT chat_generations_status_check CHECK")
        .replace("finish_reason VARCHAR(20) CHECK", "finish_reason VARCHAR(20) CONSTRAINT chat_generations_finish_reason_check CHECK")
        .replace("operation VARCHAR(10) NOT NULL CHECK", "operation VARCHAR(10) NOT NULL CONSTRAINT chat_operation_keys_operation_check CHECK");
      // Return rewritten 005 so 006 can replace the actual PostgreSQL constraint names.
      if (sql.includes('prevent_skill_versions_update') || sql.includes('CREATE TRIGGER')) {
        const stripped = sql
          .replace(/CREATE OR REPLACE FUNCTION[\s\S]*?LANGUAGE plpgsql;/gi, '')
          .replace(/DROP TRIGGER[\s\S]*?;/gi, '')
          .replace(/CREATE TRIGGER[\s\S]*?;/gi, '');
        return db.public.many(stripped);
      }
      if (sql !== original) return db.public.many(sql);
      return null;
    });
    db.public.registerFunction({
      name: 'gen_random_uuid',
      implementation: () => crypto.randomUUID(),
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool() as unknown as pg.Pool;

    try {
      // pg-mem cannot model migration 015's PostgreSQL role/privilege contract;
      // its full forward/idempotency coverage runs in the isolated PostgreSQL suite.
      const memoryMigrations = MIGRATIONS.filter((migration) => migration.version < 15);
      const firstRun = await runMigrations(pool, memoryMigrations);
      assert.strictEqual(firstRun.length, 14);
      assert.strictEqual(firstRun[0], '001_initial_users_and_sessions');
      assert.strictEqual(firstRun[1], '002_conversations_and_messages');
      assert.strictEqual(firstRun[2], '003_skills_and_preferences');
      assert.strictEqual(firstRun[3], '004_skill_definitions_revision');
      assert.strictEqual(firstRun[4], '005_chat_generations');
      assert.strictEqual(firstRun[5], '006_chat_generation_cancel');
      assert.strictEqual(firstRun[6], '007_chat_turn_variants');
      assert.strictEqual(firstRun[7], '008_chat_resolved_model');
      assert.strictEqual(firstRun[8], '009_chat_byok_credentials');
      assert.strictEqual(firstRun[9], '010_chat_reasoning_effort');
      assert.strictEqual(firstRun[10], '011_agent_control_plane');
      assert.strictEqual(firstRun[11], '012_agent_orchestrator');
      assert.strictEqual(firstRun[12], '013_agent_messages');
      assert.strictEqual(firstRun[13], '014_agent_sandbox_sessions');

      const versions = await getAppliedMigrationVersions(pool);
      assert.ok(versions.has(1));
      assert.ok(versions.has(2));
      assert.ok(versions.has(3));
      assert.ok(versions.has(4));
      assert.ok(versions.has(5));
      assert.ok(versions.has(6));
      assert.ok(versions.has(7));
      assert.ok(versions.has(8));
      assert.ok(versions.has(9));
      assert.ok(versions.has(10));
      assert.ok(versions.has(11));
      assert.ok(versions.has(12));
      assert.ok(versions.has(13));
      assert.ok(versions.has(14));
      assert.equal(versions.has(15), false);

      // Second run: idempotent, applies 0 migrations
      const secondRun = await runMigrations(pool, memoryMigrations);
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
