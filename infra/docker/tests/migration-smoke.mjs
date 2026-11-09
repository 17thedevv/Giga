// Mounted only by the disposable Compose smoke. Uses the built production API.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { loadConfig } from '../../../apps/api/dist/app/config.js';
import { startServer } from '../../../apps/api/dist/app/server.js';
import { createDatabasePool } from '../../../apps/api/dist/db/client.js';
import { MIGRATIONS, RUNTIME_ACL_MIGRATION_VERSION, runMigrations } from '../../../apps/api/dist/db/migrate.js';

const [fresh, upgrade] = process.argv.slice(2);
assert.match(fresh ?? '', /^giga_auto_fresh_[a-f0-9]{32}$/);
assert.match(upgrade ?? '', /^giga_auto_upgrade_[a-f0-9]{32}$/);
for (const name of ['DB_PASSWORD_MIGRATION', 'DB_PASSWORD_API']) {
  assert.ok(/^[a-f0-9]{32,128}$/.test(process.env[name] ?? ''), 'Missing disposable test credential');
}

async function boot(config) {
  const { server, pool } = await startServer({ config, port: 0 });
  try {
    if (!server.listening) await once(server, 'listening');
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/health', {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ok');
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await pool.end();
  }
}

for (const database of [fresh, upgrade]) {
  const config = loadConfig({
    NODE_ENV: 'production',
    CHAT_ENABLED: 'false',
    AGENT_CLOUD_EXECUTION_ENABLED: 'false',
    ALLOWED_ORIGINS: 'https://localhost',
    DATABASE_URL: `postgresql://giga_runtime:${process.env.DB_PASSWORD_API}@postgres/${database}`,
    MIGRATION_DATABASE_URL: `postgresql://giga_migration:${process.env.DB_PASSWORD_MIGRATION}@postgres/${database}`,
  });
  assert.equal(config.migrationMode, 'auto');
  const migrationPool = createDatabasePool({ connectionString: config.migrationDatabaseUrl });
  const userId = randomUUID();
  try {
    if (database === upgrade) {
      await runMigrations(migrationPool, MIGRATIONS.filter(migration => migration.version <= 16));
      await migrationPool.query(
        "INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, 'legacy@example.invalid', 'Legacy fixture', 'unused')",
        [userId],
      );
      await migrationPool.query('CREATE SEQUENCE public.legacy_acl_seq');
      const legacy = await migrationPool.query(`
        SELECT max(version) AS version,
          has_table_privilege('giga_runtime', 'public.schema_migrations', 'INSERT') AS history_write,
          has_sequence_privilege('giga_runtime', 'public.legacy_acl_seq', 'UPDATE') AS sequence_update
        FROM schema_migrations
      `);
      assert.deepEqual(legacy.rows[0], { version: 16, history_write: true, sequence_update: true });
    }

    await boot(config);
    const versions = await migrationPool.query('SELECT max(version) AS version FROM schema_migrations');
    assert.equal(versions.rows[0].version, RUNTIME_ACL_MIGRATION_VERSION);
    assert.deepEqual(await runMigrations(migrationPool), []);
    if (database === upgrade) {
      const preserved = await migrationPool.query('SELECT id FROM users WHERE id = $1', [userId]);
      assert.equal(preserved.rows[0]?.id, userId);
      const repaired = await migrationPool.query(`
        SELECT has_sequence_privilege('giga_runtime', 'public.legacy_acl_seq', 'UPDATE') AS can_reset,
          has_sequence_privilege('giga_runtime', 'public.legacy_acl_seq', 'USAGE') AS can_advance,
          has_sequence_privilege('giga_runtime', 'public.legacy_acl_seq', 'SELECT') AS can_read
      `);
      assert.deepEqual(repaired.rows[0], { can_reset: false, can_advance: true, can_read: true });
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        await migrationPool.query(`REVOKE ${privilege} ON public.sessions FROM giga_api_runtime`);
        try {
          await assert.rejects(() => boot(config), new RegExp(`lacks ${privilege} on public\\.sessions`));
        } finally {
          await migrationPool.query(`GRANT ${privilege} ON public.sessions TO giga_api_runtime`);
        }
      }
      await boot(config);
    }
  } finally {
    await migrationPool.end();
  }
}
console.log('PASS auto fresh, 016 upgrade, and per-privilege startup guards');
