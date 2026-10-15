import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createTestDatabase } from '../test-db-helper.js';
import { MIGRATIONS, runMigrations } from '../../src/db/migrate.js';

it('008 upgrades populated 007 preserving output/selection/keys and leaves legacy identities null', { timeout: 15000 }, async () => {
  const base = MIGRATIONS.filter((m) => m.version <= 7);
  const initial = await createTestDatabase(base);
  let pool = initial.pool;
  const schema = `provider_upgrade_${randomUUID().replaceAll('-', '')}`;
  if (!initial.isMemory) {
    await initial.pool.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 2, statement_timeout: 3000 });
    await runMigrations(pool, base);
  }
  try {
    const owner = randomUUID(); const conv = randomUUID(); const user = randomUUID(); const assistant = randomUUID(); const generation = randomUUID(); const key = randomUUID();
    await pool.query("INSERT INTO users (id,email,display_name,password_hash) VALUES ($1,'provider-upgrade@example.com','Upgrade','unused')", [owner]);
    await pool.query("INSERT INTO conversations (id,user_id,title) VALUES ($1,$2,'Upgrade')", [conv, owner]);
    await pool.query("INSERT INTO messages (id,conversation_id,role,content) VALUES ($1,$2,'user','Prompt')", [user, conv]);
    await pool.query("INSERT INTO messages (id,conversation_id,role,content) VALUES ($1,$2,'assistant','Durable answer')", [assistant, conv]);
    await pool.query(`INSERT INTO chat_generations (id,owner_id,conversation_id,user_message_id,assistant_message_id,model_alias,status,partial_content,idempotency_key,request_fingerprint,finished_at)
      VALUES ($1,$2,$3,$4,$5,'giga-chat-default','completed','Durable answer',$6,$7,NOW())`, [generation, owner, conv, user, assistant, key, 'f'.repeat(64)]);
    await pool.query('INSERT INTO chat_turn_selections (owner_id,conversation_id,user_message_id,selected_generation_id) VALUES ($1,$2,$3,$4)', [owner, conv, user, generation]);
    await pool.query("INSERT INTO chat_operation_keys (owner_id,idempotency_key,generation_id,operation) VALUES ($1,$2,$3,'prompt')", [owner, key, generation]);
    const tables = ['messages', 'chat_turn_selections', 'chat_operation_keys'];
    const snapshots = await Promise.all(tables.map((table) => pool.query(`SELECT * FROM ${table} ORDER BY 1,2`)));
    const before = await pool.query('SELECT id,status,partial_content,assistant_message_id,finished_at,action FROM chat_generations');
    assert.deepEqual(await runMigrations(pool), ['008_chat_resolved_model']);
    assert.deepEqual((await pool.query('SELECT id,status,partial_content,assistant_message_id,finished_at,action FROM chat_generations')).rows, before.rows);
    for (let i = 0; i < tables.length; i++) assert.deepEqual((await pool.query(`SELECT * FROM ${tables[i]} ORDER BY 1,2`)).rows, snapshots[i]!.rows);
    assert.deepEqual((await pool.query('SELECT resolved_provider_id,resolved_model_id FROM chat_generations')).rows, [{ resolved_provider_id: null, resolved_model_id: null }]);
    const sql = await readFile(new URL('../../src/db/migrations/008_chat_resolved_model.sql', import.meta.url), 'utf8');
    assert.equal(MIGRATIONS.find((m) => m.version === 8)!.sql.trim(), sql.replace(/\r\n/g, '\n').trim());
    assert.deepEqual(await runMigrations(pool), []);
    await assert.rejects(pool.query(`INSERT INTO chat_generations (owner_id,conversation_id,user_message_id,model_alias,status,idempotency_key,request_fingerprint,resolved_provider_id)
      VALUES ($1,$2,$3,'giga-chat-default','failed',$4,$5,'gemini')`, [owner, conv, user, randomUUID(), 'e'.repeat(64)]));
  } finally {
    if (!initial.isMemory) { await pool.end(); await initial.pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    await initial.pool.end();
  }
});
