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
  const v11Only = MIGRATIONS.filter((migration) => migration.version <= 11);
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
    assert.deepEqual(await runMigrations(pool, v11Only), ['011_agent_control_plane']);
    for (let i = 0; i < tables.length; i++) assert.deepEqual((await pool.query(`SELECT * FROM ${tables[i]} ORDER BY 1`)).rows, snapshots[i]!.rows);
    assert.deepEqual(await runMigrations(pool, v11Only), []);
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

it('012 upgrades populated current 011 preserving all existing agent and product tables and reruns idempotently', async () => {
  const base11 = MIGRATIONS.filter((migration) => migration.version <= 11);
  const v12Only = MIGRATIONS.filter((migration) => migration.version <= 12);
  const initial = await createTestDatabase(base11);
  let pool = initial.pool;
  const schema = `agent_upgrade_012_${randomUUID().replaceAll('-', '')}`;
  if (!initial.isMemory) {
    await initial.pool.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 2, statement_timeout: 5000 });
    await runMigrations(pool, base11);
  }
  try {
    const owner = randomUUID();
    await pool.query("INSERT INTO users (id,email,display_name,password_hash) VALUES ($1,'agent-upgrade-012@example.com','Upgrade12','unused')", [owner]);
    const repository = new AgentRepository(pool);
    const service = new AgentService(repository);
    const workspace = await service.createWorkspace(owner, { source: { kind: 'blank' } });
    const runAdmission = await service.createRun(owner, { workspaceId: workspace.id, task: 'Pre-existing 011 run' }, randomUUID());
    assert.equal(runAdmission.run.status, 'failed');

    const tables = [
      'users', 'sessions', 'conversations', 'messages', 'chat_generations', 'chat_operation_keys',
      'chat_turn_selections', 'user_preferences', 'skill_definitions', 'skill_versions', 'skill_installations',
      'user_provider_credentials', 'chat_credential_preferences',
      'agent_workspaces', 'agent_runs', 'agent_run_events',
    ];
    const snapshots = await Promise.all(tables.map((table) => pool.query(`SELECT * FROM ${table} ORDER BY 1`)));

    // Apply forward-only migration 012
    assert.deepEqual(await runMigrations(pool, v12Only), ['012_agent_orchestrator']);

    // Check all rows preserved
    for (let i = 0; i < tables.length; i++) {
      const currentRows = (await pool.query(`SELECT * FROM ${tables[i]} ORDER BY 1`)).rows;
      assert.equal(currentRows.length, snapshots[i]!.rows.length);
    }

    // Idempotent second run
    assert.deepEqual(await runMigrations(pool, v12Only), []);

    // File content matches registry
    const sql = await readFile(new URL('../../src/db/migrations/012_agent_orchestrator.sql', import.meta.url), 'utf8');
    assert.equal(
      MIGRATIONS.find((migration) => migration.version === 12)!.sql.trim().replace(/\r\n/g, '\n'),
      sql.trim().replace(/\r\n/g, '\n')
    );

    // Verify 012 additions work: queue run, claim, step persistence
    const queued = await repository.enqueueRun(
      owner,
      { workspaceId: workspace.id, task: 'Test 012 run', mode: 'execute', runtime: 'cloud', modelId: 'giga-agent-default' },
      randomUUID(),
      'a'.repeat(64)
    );
    assert.equal(queued.run.status, 'queued');

    const claimed = await repository.claimRun(owner, queued.run.id, 'worker-mig-test');
    assert.ok(claimed);
    assert.equal(claimed.run.status, 'running');

    const stepResult = await repository.recordStepStarted(owner, queued.run.id, claimed.leaseToken, {
      toolName: 'list_files',
      toolCallId: 'call-mig-1',
      risk: 'read',
      arguments: {},
    });
    assert.equal(stepResult.step.stepNumber, 1);
    assert.equal(stepResult.step.status, 'running');

    const steps = await repository.listSteps(owner, queued.run.id);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.toolName, 'list_files');
  } finally {
    if (!initial.isMemory) {
      await pool.end();
      await initial.pool.query(`DROP SCHEMA ${schema} CASCADE`);
    }
    await initial.pool.end();
  }
});

it('015 upgrades populated current 013 independently of 014 and reruns idempotently', async (t) => {
  const base13 = MIGRATIONS.filter((migration) => migration.version <= 13);
  const quotaMigrations = MIGRATIONS.filter((migration) => migration.version === 14 || migration.version === 15);
  const initial = await createTestDatabase(base13);
  if (initial.isMemory) {
    await initial.pool.end();
    return t.skip('Migration 015 role and privilege invariants require real PostgreSQL');
  }
  let pool = initial.pool;
  const schema = `agent_upgrade_015_${randomUUID().replaceAll('-', '')}`;
  if (!initial.isMemory) {
    await initial.pool.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 2, statement_timeout: 5000 });
    await runMigrations(pool, base13);
  }
  try {
    const owner = randomUUID();
    await pool.query("INSERT INTO users (id,email,display_name,password_hash) VALUES ($1,'agent-upgrade-015@example.com','Upgrade15','unused')", [owner]);
    const repository = new AgentRepository(pool);
    const service = new AgentService(repository);
    const workspace = await service.createWorkspace(owner, { source: { kind: 'blank' } });
    const before = await service.createRun(owner, { workspaceId: workspace.id, task: 'Existing run before quotas' }, randomUUID());
    assert.equal(before.run.status, 'failed');

    assert.deepEqual(await runMigrations(pool, [...base13, ...quotaMigrations]), [
      '014_agent_sandbox_sessions', '015_agent_execution_quotas',
    ]);
    assert.equal((await pool.query('SELECT id FROM agent_runs WHERE id = $1', [before.run.id])).rows.length, 1);
    assert.equal((await pool.query('SELECT id FROM agent_workspaces WHERE id = $1', [workspace.id])).rows.length, 1);
    assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS count FROM agent_execution_reservations')).rows[0]!.count), 0);
    assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS count FROM agent_execution_usage_events')).rows[0]!.count), 0);
    const privilegeBoundary = await pool.query<{
      reservation_owner: string;
      event_owner: string;
      runtime_can_select: boolean;
      runtime_can_insert_event: boolean;
      runtime_can_insert_owner_id: boolean;
      runtime_can_update_finalization: boolean;
      finalizer_owner: string;
      finalizer_is_security_definer: boolean;
      runtime_can_execute_finalizer: boolean;
      finalizer_role_can_execute: boolean;
      finalizer_role_can_insert_event: boolean;
      finalizer_role_can_update_marker: boolean;
    }>(
      'SELECT ' +
      "(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'agent_execution_reservations'::regclass) AS reservation_owner, " +
      "(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'agent_execution_usage_events'::regclass) AS event_owner, " +
      "has_table_privilege('giga_api_runtime', 'agent_execution_reservations', 'SELECT') AS runtime_can_select, " +
      "has_table_privilege('giga_api_runtime', 'agent_execution_usage_events', 'INSERT') AS runtime_can_insert_event, " +
      "has_column_privilege('giga_api_runtime', 'agent_execution_reservations', 'owner_id', 'INSERT') AS runtime_can_insert_owner_id, " +
      "has_column_privilege('giga_api_runtime', 'agent_execution_reservations', 'reconciliation_event_key', 'UPDATE') AS runtime_can_update_finalization, " +
      "(SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = to_regprocedure('finalize_agent_execution_reconciliation(uuid,character varying,character,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,boolean)')) AS finalizer_owner, " +
      "(SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('finalize_agent_execution_reconciliation(uuid,character varying,character,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,boolean)')) AS finalizer_is_security_definer, " +
      "has_function_privilege('giga_api_runtime', to_regprocedure('finalize_agent_execution_reconciliation(uuid,character varying,character,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,boolean)'), 'EXECUTE') AS runtime_can_execute_finalizer, " +
      "has_function_privilege('giga_agent_quota_finalizer', to_regprocedure('finalize_agent_execution_reconciliation(uuid,character varying,character,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,boolean)'), 'EXECUTE') AS finalizer_role_can_execute, " +
      "has_table_privilege('giga_agent_quota_finalizer', 'agent_execution_usage_events', 'INSERT') AS finalizer_role_can_insert_event, " +
      "has_column_privilege('giga_agent_quota_finalizer', 'agent_execution_reservations', 'reconciliation_event_key', 'UPDATE') AS finalizer_role_can_update_marker"
    );
    assert.equal(privilegeBoundary.rows[0]?.reservation_owner, 'giga_agent_quota_owner');
    assert.equal(privilegeBoundary.rows[0]?.event_owner, 'giga_agent_quota_owner');
    assert.equal(privilegeBoundary.rows[0]?.runtime_can_select, true);
    assert.equal(privilegeBoundary.rows[0]?.runtime_can_insert_event, false);
    assert.equal(privilegeBoundary.rows[0]?.runtime_can_insert_owner_id, true);
    assert.equal(privilegeBoundary.rows[0]?.runtime_can_update_finalization, false);
    assert.equal(privilegeBoundary.rows[0]?.finalizer_owner, 'giga_agent_quota_owner');
    assert.equal(privilegeBoundary.rows[0]?.finalizer_is_security_definer, true);
    assert.equal(privilegeBoundary.rows[0]?.runtime_can_execute_finalizer, false);
    assert.equal(privilegeBoundary.rows[0]?.finalizer_role_can_execute, true);
    assert.equal(privilegeBoundary.rows[0]?.finalizer_role_can_insert_event, false);
    assert.equal(privilegeBoundary.rows[0]?.finalizer_role_can_update_marker, false);
    assert.deepEqual(await runMigrations(pool, [...base13, ...quotaMigrations]), []);

    for (const migration of quotaMigrations) {
      const sql = await readFile(new URL(`../../src/db/migrations/${migration.name}.sql`, import.meta.url), 'utf8');
      assert.equal(migration.sql.trim().replace(/\r\n/g, '\n'), sql.trim().replace(/\r\n/g, '\n'));
    }
  } finally {
    if (!initial.isMemory) {
      await pool.end();
      await initial.pool.query(`DROP SCHEMA ${schema} CASCADE`);
    }
    await initial.pool.end();
  }
});

it('013 upgrades populated current 012 preserving all existing agent and product tables and reruns idempotently', async () => {
  const base12 = MIGRATIONS.filter((migration) => migration.version <= 12);
  const v13Only = MIGRATIONS.filter((migration) => migration.version <= 13);
  const initial = await createTestDatabase(base12);
  let pool = initial.pool;
  const schema = `agent_upgrade_013_${randomUUID().replaceAll('-', '')}`;
  if (!initial.isMemory) {
    await initial.pool.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 2, statement_timeout: 5000 });
    await runMigrations(pool, base12);
  }
  try {
    const owner = randomUUID();
    await pool.query("INSERT INTO users (id,email,display_name,password_hash) VALUES ($1,'agent-upgrade-013@example.com','Upgrade13','unused')", [owner]);
    const repository = new AgentRepository(pool);
    const service = new AgentService(repository);
    const workspace = await service.createWorkspace(owner, { source: { kind: 'blank' } });

    // Pre-existing 011 run (admitted / failed)
    const runAdmission = await service.createRun(owner, { workspaceId: workspace.id, task: 'Pre-existing 011/012 admitted task' }, randomUUID());
    assert.equal(runAdmission.run.status, 'failed');

    // Pre-existing 012 queued + claimed + completed run
    const runCompletedKey = randomUUID();
    const queued = await repository.enqueueRun(
      owner,
      { workspaceId: workspace.id, task: 'Pre-existing completed run task', mode: 'execute', runtime: 'cloud', modelId: 'giga-agent-default' },
      runCompletedKey,
      'c'.repeat(64)
    );
    const claimed = await repository.claimRun(owner, queued.run.id, 'worker-mig-013-test');
    assert.ok(claimed);
    await repository.finalizeRun(owner, queued.run.id, claimed.leaseToken, {
      status: 'completed',
      summary: 'Pre-existing run completed summary',
      verifiedChecks: [{ name: 'npm test', outcome: 'passed' }],
    });

    const tables = [
      'users', 'sessions', 'conversations', 'messages', 'chat_generations', 'chat_operation_keys',
      'chat_turn_selections', 'user_preferences', 'skill_definitions', 'skill_versions', 'skill_installations',
      'user_provider_credentials', 'chat_credential_preferences',
      'agent_workspaces', 'agent_runs', 'agent_run_events', 'agent_run_steps',
    ];
    const snapshots = await Promise.all(tables.map((table) => pool.query(`SELECT * FROM ${table} ORDER BY 1`)));

    // Apply forward-only migration 013
    assert.deepEqual(await runMigrations(pool, v13Only), ['013_agent_messages']);

    // Check all 17 pre-existing tables preserved
    for (let i = 0; i < tables.length; i++) {
      const currentRows = (await pool.query(`SELECT * FROM ${tables[i]} ORDER BY 1`)).rows;
      assert.equal(currentRows.length, snapshots[i]!.rows.length);
    }

    // Idempotent second run
    assert.deepEqual(await runMigrations(pool, v13Only), []);

    // File content matches registry
    const sql = await readFile(new URL('../../src/db/migrations/013_agent_messages.sql', import.meta.url), 'utf8');
    assert.equal(
      MIGRATIONS.find((migration) => migration.version === 13)!.sql.trim().replace(/\r\n/g, '\n'),
      sql.trim().replace(/\r\n/g, '\n')
    );

    // Verify backfilled messages in agent_messages:
    // 1. Initial instruction appears as sequence 1 for runAdmission
    const admissionMessages = await repository.listMessages(owner, runAdmission.run.id, { limit: 10 });
    assert.equal(admissionMessages.items.length, 1);
    assert.equal(admissionMessages.items[0]!.sequence, 1);
    assert.equal(admissionMessages.items[0]!.role, 'user');
    assert.equal(admissionMessages.items[0]!.content, 'Pre-existing 011/012 admitted task');

    // 2. Completed run has sequence 1 user message and sequence 2 assistant summary message
    const completedMessages = await repository.listMessages(owner, queued.run.id, { limit: 10 });
    assert.equal(completedMessages.items.length, 2);
    assert.equal(completedMessages.items[0]!.sequence, 1);
    assert.equal(completedMessages.items[0]!.role, 'user');
    assert.equal(completedMessages.items[0]!.content, 'Pre-existing completed run task');
    assert.equal(completedMessages.items[1]!.sequence, 2);
    assert.equal(completedMessages.items[1]!.role, 'assistant');
    assert.equal(completedMessages.items[1]!.content, 'Pre-existing run completed summary');

    // 3. New active run allows follow-up message insertion
    const activeKey = randomUUID();
    const activeRun = await repository.enqueueRun(
      owner,
      { workspaceId: workspace.id, task: 'Active run for follow-up testing', mode: 'ask', runtime: 'cloud', modelId: 'giga-agent-default' },
      activeKey,
      'd'.repeat(64)
    );
    const followUp = await repository.appendUserMessage(
      owner,
      activeRun.run.id,
      'This is a follow-up user instruction',
      'followup-key-mig-1',
      'e'.repeat(64)
    );
    assert.equal(followUp.message.sequence, 2);
    assert.equal(followUp.message.role, 'user');
    assert.equal(followUp.message.content, 'This is a follow-up user instruction');

    const allActiveMessages = await repository.listMessages(owner, activeRun.run.id, { limit: 10 });
    assert.equal(allActiveMessages.items.length, 2);
    assert.equal(allActiveMessages.items[0]!.sequence, 1);
    assert.equal(allActiveMessages.items[1]!.sequence, 2);
  } finally {
    if (!initial.isMemory) {
      await pool.end();
      await initial.pool.query(`DROP SCHEMA ${schema} CASCADE`);
    }
    await initial.pool.end();
  }
});

it('014 upgrades populated current 013 preserving all existing agent and product tables and reruns idempotently', async () => {
  const base13 = MIGRATIONS.filter((migration) => migration.version <= 13);
  const v14Only = MIGRATIONS.filter((migration) => migration.version <= 14);
  const initial = await createTestDatabase(base13);
  let pool = initial.pool;
  const schema = `agent_upgrade_014_${randomUUID().replaceAll('-', '')}`;
  if (!initial.isMemory) {
    await initial.pool.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 2, statement_timeout: 5000 });
    await runMigrations(pool, base13);
  }
  try {
    const owner = randomUUID();
    await pool.query("INSERT INTO users (id,email,display_name,password_hash) VALUES ($1,'agent-upgrade-014@example.com','Upgrade14','unused')", [owner]);
    const repository = new AgentRepository(pool);
    const service = new AgentService(repository);
    const workspace = await service.createWorkspace(owner, { source: { kind: 'blank' } });

    // Pre-existing 013 run with messages
    const runKey = randomUUID();
    const queued = await repository.enqueueRun(
      owner,
      { workspaceId: workspace.id, task: 'Pre-existing 013 run for 014 migration', mode: 'execute', runtime: 'cloud', modelId: 'giga-agent-default' },
      runKey,
      'f'.repeat(64)
    );
    const claimed = await repository.claimRun(owner, queued.run.id, 'worker-mig-014-test');
    assert.ok(claimed);

    const tables = [
      'users', 'sessions', 'conversations', 'messages', 'chat_generations', 'chat_operation_keys',
      'chat_turn_selections', 'user_preferences', 'skill_definitions', 'skill_versions', 'skill_installations',
      'user_provider_credentials', 'chat_credential_preferences',
      'agent_workspaces', 'agent_runs', 'agent_run_events', 'agent_run_steps', 'agent_messages',
    ];
    const snapshots = await Promise.all(tables.map((table) => pool.query(`SELECT * FROM ${table} ORDER BY 1`)));

    // Apply forward-only migration 014
    assert.deepEqual(await runMigrations(pool, v14Only), ['014_agent_sandbox_sessions']);

    // Check all 18 pre-existing tables preserved
    for (let i = 0; i < tables.length; i++) {
      const currentRows = (await pool.query(`SELECT * FROM ${tables[i]} ORDER BY 1`)).rows;
      assert.equal(currentRows.length, snapshots[i]!.rows.length);
    }

    // Idempotent second run
    assert.deepEqual(await runMigrations(pool, v14Only), []);

    // File content matches registry
    const sql = await readFile(new URL('../../src/db/migrations/014_agent_sandbox_sessions.sql', import.meta.url), 'utf8');
    assert.equal(
      MIGRATIONS.find((migration) => migration.version === 14)!.sql.trim().replace(/\r\n/g, '\n'),
      sql.trim().replace(/\r\n/g, '\n')
    );

    // Verify 014 additions: create allocation intent, commit allocated, verify constraints
    const { session: allocation } = await repository.createSandboxAllocationIntent({
      ownerId: owner,
      workspaceId: workspace.id,
      runId: queued.run.id,
      attemptNumber: 1,
      mode: 'execute',
      providerType: 'e2b',
      leaseToken: claimed.leaseToken,
      workerId: 'worker-mig-014-test',
    });
    assert.equal(allocation.allocationState, 'pending');
    assert.equal(allocation.lifecycleState, 'allocating');

    const activeSession = await repository.commitSandboxSessionAllocated({
      sessionId: allocation.id,
      ownerId: owner,
      runId: queued.run.id,
      leaseToken: claimed.leaseToken,
      providerSessionId: 'sbx-test-mig-014',
    });
    assert.ok(activeSession);
    assert.equal(activeSession.lifecycleState, 'active');
    assert.equal(activeSession.providerSessionId, 'sbx-test-mig-014');

    // Partial unique constraint prevents second active session for same run
    await assert.rejects(
      async () => {
        await pool.query(
          `INSERT INTO agent_sandbox_sessions (
             owner_id, workspace_id, run_id, attempt_number, mode, provider_type,
             lifecycle_state, allocation_state, cleanup_state, worker_id, lease_token,
             allocation_intent_id, allocation_expires_at
           ) VALUES ($1, $2, $3, 2, 'execute', 'e2b', 'allocating', 'pending', 'none', 'w2', 'tok2', gen_random_uuid(), NOW() + interval '1 minute')`,
          [owner, workspace.id, queued.run.id]
        );
      },
      (err: any) => err.code === '23505'
    );

    // Mark destroyed
    const destroyed = await repository.markSandboxDestroyed(activeSession.id, 'sbx-test-mig-014');
    assert.ok(destroyed);
    assert.equal(destroyed.lifecycleState, 'destroyed');

    // Immutability trigger and check constraint prevents reviving destroyed session
    await assert.rejects(
      async () => {
        await pool.query(
          "UPDATE agent_sandbox_sessions SET lifecycle_state = 'active' WHERE id = $1",
          [destroyed.id]
        );
      },
      /cannot modify destroyed sandbox session|terminal and immutable|check constraint/i
    );
  } finally {
    if (!initial.isMemory) {
      await pool.end();
      await initial.pool.query(`DROP SCHEMA ${schema} CASCADE`);
    }
    await initial.pool.end();
  }
});
