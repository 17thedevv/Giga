import type pg from 'pg';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '001_initial_users_and_sessions',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email VARCHAR(255) NOT NULL,
          display_name VARCHAR(100) NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));

      CREATE TABLE IF NOT EXISTS sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash VARCHAR(64) NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          revoked_at TIMESTAMPTZ
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions (token_hash);
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
    `,
  },
  {
    version: 3,
    name: '003_skills_and_preferences',
    sql: `
      CREATE TABLE IF NOT EXISTS user_preferences (
          user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
          preferred_language VARCHAR(50),
          response_length VARCHAR(20) CHECK (response_length IN ('concise', 'balanced', 'detailed')),
          response_style VARCHAR(20) CHECK (response_style IN ('professional', 'casual', 'technical')),
          custom_instructions VARCHAR(2000) NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS skill_definitions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
          slug VARCHAR(64) NOT NULL,
          title VARCHAR(100) NOT NULL,
          description VARCHAR(500) NOT NULL,
          visibility VARCHAR(20) NOT NULL CHECK (visibility IN ('built_in', 'private')),
          supported_products TEXT[] NOT NULL DEFAULT ARRAY['chat', 'agent'],
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_skill_visibility_owner CHECK (
              (visibility = 'built_in' AND owner_id IS NULL) OR
              (visibility = 'private' AND owner_id IS NOT NULL)
          )
      );

      CREATE INDEX IF NOT EXISTS idx_skill_definitions_owner_id ON skill_definitions (owner_id);
      CREATE INDEX IF NOT EXISTS idx_skill_definitions_slug ON skill_definitions (slug);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_definitions_owner_slug ON skill_definitions (owner_id, slug) WHERE owner_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_definitions_builtin_slug ON skill_definitions (slug) WHERE visibility = 'built_in';

      CREATE TABLE IF NOT EXISTS skill_versions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          skill_id UUID NOT NULL REFERENCES skill_definitions(id) ON DELETE CASCADE,
          version_number INTEGER NOT NULL CHECK (version_number >= 1),
          content_hash VARCHAR(64) NOT NULL,
          instructions TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uq_skill_versions_skill_version UNIQUE (skill_id, version_number),
          CONSTRAINT uq_skill_versions_skill_id_id UNIQUE (skill_id, id)
      );

      CREATE INDEX IF NOT EXISTS idx_skill_versions_skill_id ON skill_versions (skill_id);

      CREATE TABLE IF NOT EXISTS skill_installations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          skill_id UUID NOT NULL REFERENCES skill_definitions(id) ON DELETE CASCADE,
          selected_version_id UUID NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT true,
          installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uq_skill_installations_user_skill UNIQUE (user_id, skill_id),
          CONSTRAINT fk_installation_skill_version FOREIGN KEY (skill_id, selected_version_id)
              REFERENCES skill_versions (skill_id, id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_skill_installations_user_id ON skill_installations (user_id);
      CREATE INDEX IF NOT EXISTS idx_skill_installations_skill_id ON skill_installations (skill_id);

      CREATE TABLE IF NOT EXISTS workspace_skill_defaults (
          workspace_id UUID NOT NULL,
          owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          skill_id UUID NOT NULL REFERENCES skill_definitions(id) ON DELETE CASCADE,
          position INTEGER NOT NULL DEFAULT 1,
          enabled BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (workspace_id, owner_id, skill_id)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_skill_defaults_workspace_owner ON workspace_skill_defaults (workspace_id, owner_id);
    `,
  },
];

/**
 * Creates schema_migrations tracking table if it does not exist.
 * Tolerates concurrent race condition on PostgreSQL composite type creation.
 */
export async function ensureMigrationTable(client: pg.PoolClient | pg.Pool): Promise<void> {
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('already exists') && !message.includes('pg_type_typname_nsp_index')) {
      throw err;
    }
  }
}

/**
 * Retrieves list of already-applied migration versions.
 */
export async function getAppliedMigrationVersions(client: pg.PoolClient | pg.Pool): Promise<Set<number>> {
  await ensureMigrationTable(client);
  const result = await client.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version ASC;');
  return new Set(result.rows.map((r) => r.version));
}

/**
 * Executes pending forward migrations in transaction order.
 * Uses an advisory lock in real PostgreSQL to serialize concurrent migration runs.
 */
export async function runMigrations(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  const appliedNow: string[] = [];

  let lockAcquired = false;
  try {
    try {
      await client.query('SELECT pg_advisory_lock(7162534);');
      lockAcquired = true;
    } catch {
      // In-memory or databases without advisory locks proceed normally
    }

    await ensureMigrationTable(client);
    const appliedVersions = await getAppliedMigrationVersions(client);

    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, NOW());',
          [migration.version, migration.name]
        );
        await client.query('COMMIT');
        appliedNow.push(migration.name);
        console.log(`[giga-db] Applied migration: ${migration.name} (version ${migration.version})`);
      } catch (migrationError) {
        await client.query('ROLLBACK');
        throw new Error(
          `Failed to apply migration ${migration.name}: ${migrationError instanceof Error ? migrationError.message : String(migrationError)}`
        );
      }
    }
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock(7162534);');
      } catch {
        // Ignore unlock error on connection teardown
      }
    }
    client.release();
  }

  return appliedNow;
}
