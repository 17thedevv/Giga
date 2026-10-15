import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createTestDatabase } from '../test-db-helper.js';
import { MIGRATIONS, runMigrations } from '../../src/db/migrate.js';

it('009 upgrades populated 008 without changing legacy data and is idempotent', { timeout: 15000 }, async () => {
  const base = MIGRATIONS.filter((migration) => migration.version <= 8);
  const initial = await createTestDatabase(base);
  let pool = initial.pool;
  const schema = `byok_upgrade_${randomUUID().replaceAll('-', '')}`;
  if (!initial.isMemory) {
    await initial.pool.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 2 });
    await runMigrations(pool, base);
  }
  try {
    const owner = randomUUID(); const conv = randomUUID(); const user = randomUUID(); const generation = randomUUID();
    await pool.query("INSERT INTO users (id,email,display_name,password_hash) VALUES ($1,'byok-upgrade@example.com','Upgrade','unused')", [owner]);
    await pool.query("INSERT INTO conversations (id,user_id,title) VALUES ($1,$2,'Upgrade')", [conv, owner]);
    await pool.query("INSERT INTO messages (id,conversation_id,role,content) VALUES ($1,$2,'user','Prompt')", [user, conv]);
    await pool.query(`INSERT INTO chat_generations (id,owner_id,conversation_id,user_message_id,model_alias,status,partial_content,idempotency_key,request_fingerprint)
      VALUES ($1,$2,$3,$4,'giga-chat-default','failed','Partial answer',$5,$6)`, [generation, owner, conv, user, randomUUID(), 'f'.repeat(64)]);
    await pool.query("INSERT INTO user_preferences (user_id,custom_instructions,response_length,response_style) VALUES ($1,'Do not read credentials','balanced','professional')", [owner]);
    const tables = ['users','sessions','conversations','messages','chat_generations','chat_operation_keys','chat_turn_selections','user_preferences','skill_definitions','skill_versions','skill_installations'];
    const snapshots = await Promise.all(tables.map((table) => pool.query(`SELECT * FROM ${table} ORDER BY 1`)));
    assert.deepEqual(await runMigrations(pool), ['009_chat_byok_credentials']);
    for (let i = 0; i < tables.length; i++) assert.deepEqual((await pool.query(`SELECT * FROM ${tables[i]} ORDER BY 1`)).rows, snapshots[i]!.rows);
    assert.equal((await pool.query('SELECT * FROM user_provider_credentials')).rows.length, 0);
    assert.equal((await pool.query('SELECT * FROM chat_credential_preferences')).rows.length, 0);
    const sql = await readFile(new URL('../../src/db/migrations/009_chat_byok_credentials.sql', import.meta.url), 'utf8');
    assert.equal(MIGRATIONS.find((m) => m.version === 9)!.sql.trim(), sql.replace(/\r\n/g, '\n').trim());
    assert.deepEqual(await runMigrations(pool), []);
  } finally {
    if (!initial.isMemory) { await pool.end(); await initial.pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    await initial.pool.end();
  }
});
