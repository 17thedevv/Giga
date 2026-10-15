import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createTestDatabase } from '../test-db-helper.js';
import { MIGRATIONS, runMigrations } from '../../src/db/migrate.js';

it('007 upgrades populated 006 without changing users, sessions, prompts, outputs or operation keys', { timeout: 15000 }, async () => {
  const base = MIGRATIONS.filter((m) => m.version <= 6);
  const initial = await createTestDatabase(base);
  let pool = initial.pool;
  const schema = `variants_upgrade_${randomUUID().replaceAll('-', '')}`;
  if (!initial.isMemory) {
    await initial.pool.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 2, statement_timeout: 3000 });
    await runMigrations(pool, base);
  }
  try {
    const owner = randomUUID();
    await pool.query("INSERT INTO users (id,email,display_name,password_hash) VALUES ($1,'variants@example.com','Upgrade','unused')", [owner]);
    await pool.query("INSERT INTO sessions (user_id,token_hash,expires_at) VALUES ($1,$2,$3)", [owner, 'f'.repeat(64), new Date(Date.now() + 60000)]);
    const completed: { id: string; user: string; conversation: string }[] = [];
    for (const status of ['pending', 'streaming', 'completed', 'failed', 'interrupted', 'stopped']) {
      const conv = randomUUID(); const user = randomUUID(); const assistant = randomUUID(); const id = randomUUID();
      await pool.query("INSERT INTO conversations (id,user_id,title) VALUES ($1,$2,'Upgrade')", [conv, owner]);
      await pool.query("INSERT INTO messages (id,conversation_id,role,content) VALUES ($1,$2,'user','Prompt')", [user, conv]);
      if (status === 'completed') {
        await pool.query("INSERT INTO messages (id,conversation_id,role,content) VALUES ($1,$2,'assistant','Durable answer')", [assistant, conv]);
        completed.push({ id, user, conversation: conv });
      }
      const key = randomUUID();
      await pool.query(`INSERT INTO chat_generations (id,owner_id,conversation_id,user_message_id,assistant_message_id,model_alias,
        status,partial_content,idempotency_key,request_fingerprint,finished_at,cancel_requested_at,finish_reason)
        VALUES ($1,$2,$3,$4,$5,'giga-chat-default',$6,$7,$8,$9,$10,$11,$12)`,
      [id, owner, conv, user, status === 'completed' ? assistant : null, status, status === 'completed' ? 'Durable answer' : 'partial', key, 'f'.repeat(64),
        ['pending', 'streaming'].includes(status) ? null : new Date(), status === 'stopped' ? new Date() : null, status === 'stopped' ? 'cancelled' : null]);
      await pool.query("INSERT INTO chat_operation_keys (owner_id,idempotency_key,generation_id,operation) VALUES ($1,$2,$3,'prompt')", [owner, key, id]);
    }
    const tables = ['users', 'sessions', 'conversations', 'messages', 'chat_operation_keys'];
    const snapshots = await Promise.all(tables.map((table) => pool.query(`SELECT * FROM ${table} ORDER BY 1,2`)));
    const before = await pool.query('SELECT id,status,partial_content,assistant_message_id,finished_at,cancel_requested_at FROM chat_generations ORDER BY id');
    const through007 = MIGRATIONS.filter((m) => m.version <= 7);
    assert.deepEqual(await runMigrations(pool, through007), ['007_chat_turn_variants']);
    assert.deepEqual((await pool.query('SELECT id,status,partial_content,assistant_message_id,finished_at,cancel_requested_at FROM chat_generations ORDER BY id')).rows, before.rows);
    for (let i = 0; i < tables.length; i++) assert.deepEqual((await pool.query(`SELECT * FROM ${tables[i]} ORDER BY 1,2`)).rows, snapshots[i]!.rows);
    assert.equal((await pool.query('SELECT * FROM chat_turn_selections')).rows.length, completed.length);
    for (const row of completed) {
      assert.equal((await pool.query('SELECT selected_generation_id FROM chat_turn_selections WHERE user_message_id = $1', [row.user])).rows[0].selected_generation_id, row.id);
    }
    const sql = await readFile(new URL('../../src/db/migrations/007_chat_turn_variants.sql', import.meta.url), 'utf8');
    assert.equal(MIGRATIONS.find((m) => m.version === 7)!.sql.trim(), sql.replace(/\r\n/g, '\n').trim());
    assert.deepEqual(await runMigrations(pool, through007), []);
  } finally {
    if (!initial.isMemory) {
      await pool.end();
      await initial.pool.query(`DROP SCHEMA ${schema} CASCADE`);
    }
    await initial.pool.end();
  }
});
