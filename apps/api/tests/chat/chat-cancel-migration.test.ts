import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createTestDatabase } from '../test-db-helper.js';
import { MIGRATIONS, runMigrations } from '../../src/db/migrate.js';

it('006 upgrades an existing populated 005 schema, preserves all rows and is idempotent', { timeout: 15000 }, async () => {
  const base = MIGRATIONS.filter((m) => m.version <= 5);
  const initial = await createTestDatabase(base);
  let pool = initial.pool;
  const schema = `cancel_upgrade_${randomUUID().replaceAll('-', '')}`;
  if (!initial.isMemory) {
    // createTestDatabase has already verified TEST_DATABASE_URL and active DB identity.
    await initial.pool.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 2, statement_timeout: 3000 });
    await runMigrations(pool, base);
  }
  try {
    const owner = randomUUID();
    await pool.query("INSERT INTO users (id,email,display_name,password_hash) VALUES ($1,'upgrade@example.com','Upgrade','unused')", [owner]);
    for (const status of ['pending', 'completed', 'failed', 'interrupted']) {
      const conv = randomUUID(); const user = randomUUID(); const assistant = randomUUID();
      await pool.query("INSERT INTO conversations (id,user_id,title) VALUES ($1,$2,'Upgrade')", [conv, owner]);
      await pool.query("INSERT INTO messages (id,conversation_id,role,content) VALUES ($1,$2,'user','Hello')", [user, conv]);
      if (status === 'completed') await pool.query("INSERT INTO messages (id,conversation_id,role,content) VALUES ($1,$2,'assistant','Stored answer')", [assistant, conv]);
      await pool.query(`INSERT INTO chat_generations (owner_id,conversation_id,user_message_id,assistant_message_id,model_alias,
        status,partial_content,idempotency_key,request_fingerprint,finished_at)
        VALUES ($1,$2,$3,$4,'giga-chat-default',$5,$6,$7,$8,$9)`,
      [owner, conv, user, status === 'completed' ? assistant : null, status, status === 'completed' ? 'Stored answer' : 'partial', randomUUID(), 'f'.repeat(64), status === 'pending' ? null : new Date()]);
    }
    const before = await pool.query('SELECT id,status,partial_content,assistant_message_id,finished_at FROM chat_generations ORDER BY id');
    if (!initial.isMemory) {
      const names = await pool.query("SELECT conname FROM pg_constraint WHERE conrelid = 'chat_generations'::regclass");
      assert.ok(names.rows.some((r) => r.conname === 'chat_generations_status_check'));
      assert.ok(names.rows.some((r) => r.conname === 'chat_generations_finish_reason_check'));
    }
    const through006 = MIGRATIONS.filter((m) => m.version <= 6);
    assert.deepEqual(await runMigrations(pool, through006), ['006_chat_generation_cancel']);
    assert.deepEqual((await pool.query('SELECT id,status,partial_content,assistant_message_id,finished_at FROM chat_generations ORDER BY id')).rows, before.rows);
    assert.equal((await pool.query('SELECT * FROM chat_operation_keys')).rows.length, 4);
    const sql = await readFile(new URL('../../src/db/migrations/006_chat_generation_cancel.sql', import.meta.url), 'utf8');
    assert.equal(MIGRATIONS.find((m) => m.version === 6)!.sql.trim(), sql.replace(/\r\n/g, '\n').trim());
    await pool.query(sql);
    assert.deepEqual(await runMigrations(pool, through006), []);
    const pending = (await pool.query("SELECT id FROM chat_generations WHERE status = 'pending'")).rows[0]!.id;
    await pool.query("UPDATE chat_generations SET status = 'stopped', cancel_requested_at = NOW(), finished_at = NOW(), finish_reason = 'cancelled' WHERE id = $1", [pending]);
    assert.equal((await pool.query('SELECT status FROM chat_generations WHERE id = $1', [pending])).rows[0].status, 'stopped');
  } finally {
    if (!initial.isMemory) {
      await pool.end();
      await initial.pool.query(`DROP SCHEMA ${schema} CASCADE`);
    }
    await initial.pool.end();
  }
});
