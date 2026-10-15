import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createTestDatabase } from '../test-db-helper.js';
import { MIGRATIONS, runMigrations } from '../../src/db/migrate.js';

it('010 upgrades populated 009 preserving existing generations and leaves historical reasoning_effort null', { timeout: 15000 }, async () => {
  const base = MIGRATIONS.filter((m) => m.version <= 9);
  const initial = await createTestDatabase(base);
  let pool = initial.pool;
  const schema = `reasoning_upgrade_${randomUUID().replaceAll('-', '')}`;
  if (!initial.isMemory) {
    await initial.pool.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 2, statement_timeout: 3000 });
    await runMigrations(pool, base);
  }
  try {
    const owner = randomUUID(); const conv = randomUUID(); const user = randomUUID(); const assistant = randomUUID(); const generation = randomUUID(); const key = randomUUID();
    await pool.query("INSERT INTO users (id,email,display_name,password_hash) VALUES ($1,'reasoning-upgrade@example.com','Upgrade','unused')", [owner]);
    await pool.query("INSERT INTO conversations (id,user_id,title) VALUES ($1,$2,'Upgrade')", [conv, owner]);
    await pool.query("INSERT INTO messages (id,conversation_id,role,content) VALUES ($1,$2,'user','Prompt')", [user, conv]);
    await pool.query("INSERT INTO messages (id,conversation_id,role,content) VALUES ($1,$2,'assistant','Durable answer')", [assistant, conv]);
    await pool.query(`INSERT INTO chat_generations (id,owner_id,conversation_id,user_message_id,assistant_message_id,model_alias,status,partial_content,idempotency_key,request_fingerprint,finished_at,resolved_provider_id,resolved_model_id)
      VALUES ($1,$2,$3,$4,$5,'giga-chat-default','completed','Durable answer',$6,$7,NOW(),'gemini','gemini-3.1-flash-lite')`, [generation, owner, conv, user, assistant, key, 'f'.repeat(64)]);
    await pool.query('INSERT INTO chat_turn_selections (owner_id,conversation_id,user_message_id,selected_generation_id) VALUES ($1,$2,$3,$4)', [owner, conv, user, generation]);
    await pool.query("INSERT INTO chat_operation_keys (owner_id,idempotency_key,generation_id,operation) VALUES ($1,$2,$3,'prompt')", [owner, key, generation]);

    const before = await pool.query('SELECT id,status,partial_content,assistant_message_id,finished_at,action,resolved_provider_id,resolved_model_id FROM chat_generations');
    const applied = await runMigrations(pool, MIGRATIONS.filter((m) => m.version <= 10));
    assert.deepEqual(applied, ['010_chat_reasoning_effort']);

    // Existing rows preserved exactly, with reasoning_effort null
    const after = await pool.query('SELECT id,status,partial_content,assistant_message_id,finished_at,action,resolved_provider_id,resolved_model_id,reasoning_effort FROM chat_generations');
    assert.equal(after.rows.length, 1);
    assert.equal(after.rows[0].reasoning_effort, null);
    assert.equal(after.rows[0].id, before.rows[0].id);

    // Verify migration idempotency
    assert.deepEqual(await runMigrations(pool, MIGRATIONS.filter((m) => m.version <= 10)), []);

    // Check migration file matches MIGRATIONS entry
    const sql = await readFile(new URL('../../src/db/migrations/010_chat_reasoning_effort.sql', import.meta.url), 'utf8');
    assert.equal(MIGRATIONS.find((m) => m.version === 10)!.sql.trim(), sql.replace(/\r\n/g, '\n').trim());

    // Check allowed values
    for (const valid of ['low', 'medium', 'high'] as const) {
      const genId = randomUUID();
      await pool.query(`INSERT INTO chat_generations (id,owner_id,conversation_id,user_message_id,model_alias,status,idempotency_key,request_fingerprint,reasoning_effort)
        VALUES ($1,$2,$3,$4,'giga-chat-default','pending',$5,$6,$7)`, [genId, owner, conv, user, randomUUID(), 'a'.repeat(64), valid]);
      const res = await pool.query('SELECT reasoning_effort FROM chat_generations WHERE id = $1', [genId]);
      assert.equal(res.rows[0].reasoning_effort, valid);
    }

    // Check invalid value rejected by CHECK constraint
    await assert.rejects(pool.query(`INSERT INTO chat_generations (id,owner_id,conversation_id,user_message_id,model_alias,status,idempotency_key,request_fingerprint,reasoning_effort)
      VALUES ($1,$2,$3,$4,'giga-chat-default','pending',$5,$6,'extreme')`, [randomUUID(), owner, conv, user, randomUUID(), 'b'.repeat(64)]));
  } finally {
    if (!initial.isMemory) { await pool.end(); await initial.pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    await initial.pool.end();
  }
});

it('prevent_chat_reasoning_effort_rewrite trigger rejects updating reasoning_effort on Real PostgreSQL', async (t) => {
  const initial = await createTestDatabase(MIGRATIONS);
  if (initial.isMemory) return t.skip('PostgreSQL trigger enforcement is not emulated in pg-mem');
  let pool = initial.pool;
  const schema = `reasoning_trigger_${randomUUID().replaceAll('-', '')}`;
  await initial.pool.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 2, statement_timeout: 3000 });
  await runMigrations(pool);
  try {
    const owner = randomUUID(); const conv = randomUUID(); const user = randomUUID(); const genId = randomUUID();
    await pool.query("INSERT INTO users (id,email,display_name,password_hash) VALUES ($1,'trig@example.com','Trig','unused')", [owner]);
    await pool.query("INSERT INTO conversations (id,user_id,title) VALUES ($1,$2,'Trig')", [conv, owner]);
    await pool.query("INSERT INTO messages (id,conversation_id,role,content) VALUES ($1,$2,'user','Prompt')", [user, conv]);
    await pool.query(`INSERT INTO chat_generations (id,owner_id,conversation_id,user_message_id,model_alias,status,idempotency_key,request_fingerprint,reasoning_effort)
      VALUES ($1,$2,$3,$4,'giga-chat-default','pending',$5,$6,'low')`, [genId, owner, conv, user, randomUUID(), 'c'.repeat(64)]);

    // Attempting to mutate reasoning_effort once set must be rejected by the trigger
    await assert.rejects(pool.query('UPDATE chat_generations SET reasoning_effort = $1 WHERE id = $2', ['high', genId]));
  } finally {
    await pool.end();
    await initial.pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await initial.pool.end();
  }
});
