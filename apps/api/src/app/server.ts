import { serve, type ServerType } from '@hono/node-server';
import type pg from 'pg';
import { createApp } from './create-app.js';
import { loadConfig, type AppConfig } from './config.js';
import { closeDatabasePool, createDatabasePool } from '../db/client.js';
import { logSystemEvent } from './observability.js';
import { RUNTIME_ACL_MIGRATION_VERSION, runMigrations } from '../db/migrate.js';
import { findMissingRuntimeTablePrivilege } from '../db/runtime-privileges.js';
import { createChatEngine } from '../modules/llm/chat-bootstrap.js';
import type { ProviderTransport } from '../modules/llm/providers/gemini/gemini-provider.js';
import type { LLMEngine } from '../modules/llm/engine.js';
import { createWebUi } from './web-ui.js';

export interface StartServerOptions {
  readonly port?: number;
  readonly pool?: pg.Pool;
  readonly lifecycleFinalizationPool?: pg.Pool;
  readonly config?: AppConfig;
  readonly skipMigrations?: boolean;
  readonly llmEngine?: LLMEngine;
  readonly providerTransport?: ProviderTransport;
}

export async function startServer(options: StartServerOptions = {}): Promise<{
  server: ServerType;
  pool?: pg.Pool;
  lifecycleFinalizationPool?: pg.Pool;
  port: number;
}> {
  const config = options.config ?? loadConfig();
  const port = options.port ?? config.port;
  if ((config.chatEnabled === true || (config.nodeEnv === 'production' && config.chatEnabled !== false)) && !config.chat) {
    throw new Error('Enabled Chat requires server provider configuration');
  }
  if (config.chatEnabled === false && config.chat) throw new Error('Conflicting Chat enable configuration');
  // Fail configuration before opening DB connections or listening on a socket.
  const configuredEngine = createChatEngine(config.chat, options.providerTransport);
  const llmEngine = options.llmEngine ?? configuredEngine;
  // Validate the optional web bundle before connecting or applying migrations.
  const webUi = config.serveWeb ? createWebUi() : undefined;

  let pool = options.pool;
  let lifecycleFinalizationPool = options.lifecycleFinalizationPool;
  let ownsLifecycleFinalizationPool = false;

  if (!pool && config.databaseUrl) {
    if (!options.skipMigrations && config.migrationMode !== 'external') {
      const migrationUrl = config.migrationDatabaseUrl ?? config.databaseUrl;
      const migrationPool = createDatabasePool({ connectionString: migrationUrl });
      try {
        await runMigrations(migrationPool);
      } catch (err) {
        logSystemEvent('migration_failed', 'error');
        throw err;
      } finally {
        await closeDatabasePool(migrationPool);
      }
    }

    pool = createDatabasePool({ connectionString: config.databaseUrl });
  }

  if (!lifecycleFinalizationPool && pool && config.agentLifecycleFinalizerDatabaseUrl) {
    lifecycleFinalizationPool = createDatabasePool({ connectionString: config.agentLifecycleFinalizerDatabaseUrl });
    ownsLifecycleFinalizationPool = true;
  }
  if (pool && config.nodeEnv === 'production') {
    if (!lifecycleFinalizationPool && config.agentLifecycleFinalizerDatabaseUrl) {
      throw new Error('A dedicated provider-authoritative lifecycle finalization connection is required in production.');
    }
    try {
      // 1. Fail-closed check: public.schema_migrations table must exist
      const schemaTableCheck = await pool.query<{ exists: boolean }>(
        "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists"
      );
      if (!schemaTableCheck.rows[0]?.exists) {
        throw new Error('Database startup validation failed: public.schema_migrations table does not exist.');
      }

      // 2. Both migration entry points must apply the runtime ACL migration before serving.
      const versionCheck = await pool.query<{ version: number }>(
        'SELECT version FROM public.schema_migrations WHERE version = $1',
        [RUNTIME_ACL_MIGRATION_VERSION],
      );
      if (!versionCheck.rows.length) {
        throw new Error(`Database startup validation failed: required migration version ${RUNTIME_ACL_MIGRATION_VERSION} is not applied.`);
      }

      // 3. Fail-closed check: runtime privileges on schema_migrations and public schema
      const privsCheck = await pool.query<{
        can_read_migrations: boolean;
        can_write_migrations: boolean;
        can_create_schema: boolean;
      }>(
        "SELECT has_table_privilege(current_user, 'public.schema_migrations', 'SELECT') AS can_read_migrations, " +
        "has_table_privilege(current_user, 'public.schema_migrations', 'INSERT,UPDATE,DELETE,TRUNCATE') AS can_write_migrations, " +
        "has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_schema"
      );
      const privs = privsCheck.rows[0];
      if (!privs?.can_read_migrations) {
        throw new Error('Database startup validation failed: runtime role cannot read public.schema_migrations.');
      }
      if (privs.can_write_migrations) {
        throw new Error('Database startup validation failed: runtime role must not have write permissions on public.schema_migrations.');
      }
      if (privs.can_create_schema) {
        throw new Error('Database startup validation failed: runtime role must not have CREATE privilege on schema public.');
      }

      // 4. Fail-closed check: runtime privileges on application tables
      const missingPrivilege = await findMissingRuntimeTablePrivilege(pool);
      if (missingPrivilege) {
        throw new Error(`Database startup validation failed: runtime role lacks ${missingPrivilege.privilege} on public.${missingPrivilege.table_name}.`);
      }

      // 5. Fail-closed check: sequence privileges (runtime must never possess UPDATE on public sequences)
      const seqCheck = await pool.query<{ has_excessive_seq_privs: boolean }>(
        "SELECT EXISTS (" +
        "  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "  WHERE n.nspname = 'public' AND c.relkind = 'S' " +
        "    AND has_sequence_privilege(current_user, c.oid, 'UPDATE')" +
        ") AS has_excessive_seq_privs"
      );
      if (seqCheck.rows[0]?.has_excessive_seq_privs) {
        throw new Error('Database startup validation failed: runtime role must not possess UPDATE privilege on public sequences.');
      }

      // 6. Runtime role membership validation
      const roles = await pool.query<{
        is_superuser: boolean;
        is_api_runtime: boolean;
        is_quota_owner: boolean;
        is_quota_finalizer: boolean;
        is_lifecycle_owner: boolean;
        is_lifecycle_finalizer: boolean;
      }>(
        'SELECT role.rolsuper AS is_superuser, ' +
        "pg_has_role(current_user, 'giga_api_runtime', 'MEMBER') AS is_api_runtime, " +
        "pg_has_role(current_user, 'giga_agent_quota_owner', 'MEMBER') AS is_quota_owner, " +
        "pg_has_role(current_user, 'giga_agent_quota_finalizer', 'MEMBER') AS is_quota_finalizer, " +
        "pg_has_role(current_user, 'giga_agent_lifecycle_owner', 'MEMBER') AS is_lifecycle_owner, " +
        "pg_has_role(current_user, 'giga_agent_lifecycle_finalizer', 'MEMBER') AS is_lifecycle_finalizer " +
        'FROM pg_roles AS role WHERE role.rolname = current_user'
      );
      const runtimeRole = roles.rows[0];
      if (!runtimeRole || runtimeRole.is_superuser || !runtimeRole.is_api_runtime ||
          runtimeRole.is_quota_owner || runtimeRole.is_quota_finalizer ||
          runtimeRole.is_lifecycle_owner || runtimeRole.is_lifecycle_finalizer) {
        throw new Error('DATABASE_URL must use a non-superuser giga_api_runtime login without quota or lifecycle owner/finalizer membership.');
      }

      if (lifecycleFinalizationPool) {
        const lifecycleRoles = await lifecycleFinalizationPool.query<{
          is_superuser: boolean;
          is_lifecycle_finalizer: boolean;
          is_lifecycle_owner: boolean;
          is_api_runtime: boolean;
          is_quota_owner: boolean;
          is_quota_finalizer: boolean;
        }>(
          'SELECT role.rolsuper AS is_superuser, ' +
          "pg_has_role(current_user, 'giga_agent_lifecycle_finalizer', 'MEMBER') AS is_lifecycle_finalizer, " +
          "pg_has_role(current_user, 'giga_agent_lifecycle_owner', 'MEMBER') AS is_lifecycle_owner, " +
          "pg_has_role(current_user, 'giga_api_runtime', 'MEMBER') AS is_api_runtime, " +
          "pg_has_role(current_user, 'giga_agent_quota_owner', 'MEMBER') AS is_quota_owner, " +
          "pg_has_role(current_user, 'giga_agent_quota_finalizer', 'MEMBER') AS is_quota_finalizer " +
          'FROM pg_roles AS role WHERE role.rolname = current_user'
        );
        const lifecycleRole = lifecycleRoles.rows[0];
        if (!lifecycleRole || lifecycleRole.is_superuser || !lifecycleRole.is_lifecycle_finalizer ||
            lifecycleRole.is_lifecycle_owner || lifecycleRole.is_api_runtime ||
            lifecycleRole.is_quota_owner || lifecycleRole.is_quota_finalizer) {
          throw new Error('AGENT_LIFECYCLE_FINALIZER_DATABASE_URL must use a non-superuser login granted only the dedicated lifecycle finalizer role.');
        }
      }
    } catch (err) {
      if (ownsLifecycleFinalizationPool && lifecycleFinalizationPool) await closeDatabasePool(lifecycleFinalizationPool);
      if (!options.pool && pool) await closeDatabasePool(pool);
      throw err;
    }
  }

  // Keep the provider-authoritative pool out of the public API route container.
  // Trusted provider callbacks and cleanup workers must receive it explicitly.
  const app = createApp({
    pool,
    config,
    llmEngine,
    providerTransport: options.providerTransport,
  });
  if (webUi) app.route('/', webUi);

  const server = serve(
    {
      fetch: app.fetch,
      port,
    },
    () => logSystemEvent('server_listening', 'info')
  );

  return { server, pool, lifecycleFinalizationPool, port };
}
