import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createTestDatabase } from '../test-db-helper.js';
import { MIGRATIONS, runMigrations } from '../../src/db/migrate.js';
import { CredentialEncryption } from '../../src/modules/credentials/encryption.js';
import { ChatCredentialsService } from '../../src/modules/credentials/service.js';
import { AgentRepository } from '../../src/modules/agent/repository.js';
import { AgentService } from '../../src/modules/agent/service.js';

it('011 upgrades populated current 010 preserving all existing product tables and reruns idempotently', async () => {
  const base = MIGRATIONS.filter((migration) => migration.version <= 10);
  const initial = await createTestDatabase(base);
  let pool = initial.pool;
  const schema = `agent_upgrade_${randomUUID().replaceAll('-', '')}`;
  if (!initial.isMemory) {
    await initial.pool.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 2, statement_timeout: 5000 });
    await runMigrations(pool, base);
  }
  try {
    const owner = randomUUID(); const conversation = randomUUID(); const message = randomUUID();
    await pool.query("INSERT INTO users (id,email,display_name,password_hash) VALUES ($1,'agent-upgrade@example.com','Upgrade','unused')", [owner]);
    await pool.query('INSERT INTO sessions (user_id,token_hash,expires_at) VALUES ($1,$2,$3)', [owner, 'f'.repeat(64), new Date(Date.now() + 60000)]);
    await pool.query("INSERT INTO conversations (id,user_id,title) VALUES ($1,$2,'Existing Chat')", [conversation, owner]);
    await pool.query("INSERT INTO messages (id,conversation_id,role,content) VALUES ($1,$2,'user','Existing prompt')", [message, conversation]);
    await pool.query(`INSERT INTO chat_generations (owner_id,conversation_id,user_message_id,model_alias,status,idempotency_key,request_fingerprint,reasoning_effort)
      VALUES ($1,$2,$3,'giga-chat-default','failed',$4,$5,'high')`, [owner, conversation, message, randomUUID(), 'f'.repeat(64)]);
    await pool.query("INSERT INTO user_preferences (user_id,custom_instructions,response_length,response_style) VALUES ($1,'Existing preference','balanced','professional')", [owner]);
    const credentials = new ChatCredentialsService(pool, new CredentialEncryption(randomBytes(32).toString('base64')));
    const credential = await credentials.save(owner, 'gemini', 'test-agent-upgrade-credential');
    await credentials.setPreference(owner, 'byok', credential.id);
    const tables = ['users', 'sessions', 'conversations', 'messages', 'chat_generations', 'chat_operation_keys',
      'chat_turn_selections', 'user_preferences', 'skill_definitions', 'skill_versions', 'skill_installations',
      'user_provider_credentials', 'chat_credential_preferences'];
    const snapshots = await Promise.all(tables.map((table) => pool.query(`SELECT * FROM ${table} ORDER BY 1`)));
    assert.deepEqual(await runMigrations(pool), ['011_agent_control_plane']);
    for (let i = 0; i < tables.length; i++) assert.deepEqual((await pool.query(`SELECT * FROM ${tables[i]} ORDER BY 1`)).rows, snapshots[i]!.rows);
    assert.deepEqual(await runMigrations(pool), []);
    const sql = await readFile(new URL('../../src/db/migrations/011_agent_control_plane.sql', import.meta.url), 'utf8');
    assert.equal(MIGRATIONS.find((migration) => migration.version === 11)!.sql.trim().replace(/\r\n/g, '\n'), sql.trim().replace(/\r\n/g, '\n'));
    const repository = new AgentRepository(pool); const service = new AgentService(repository);
    const workspace = await service.createWorkspace(owner, { source: { kind: 'blank' } });
    const created = await service.createRun(owner, { workspaceId: workspace.id, task: 'New Agent task' }, randomUUID());
    assert.equal(created.run.error?.code, 'RUNTIME_UNAVAILABLE');
    assert.equal((await repository.events(owner, created.run.id, 0)).items.length, 2);
  } finally {
    if (!initial.isMemory) { await pool.end(); await initial.pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    await initial.pool.end();
  }
});
