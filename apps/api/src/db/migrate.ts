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
    version: 2,
    name: '002_conversations_and_messages',
    sql: `
      CREATE TABLE IF NOT EXISTS conversations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title VARCHAR(255) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations (user_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations (user_id, updated_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages (conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages (conversation_id, created_at ASC, id ASC);
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

      -- 3. Skill Versions: immutable versioned instructions with content hash
      -- Deletion policy: ON DELETE CASCADE from skill_definitions allows complete removal when an owner
      -- deletes a skill definition or account. The trigger below strictly prevents any in-place UPDATE.
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

      CREATE OR REPLACE FUNCTION prevent_skill_versions_update()
      RETURNS TRIGGER AS $$
      BEGIN
          RAISE EXCEPTION 'skill_versions rows are strictly immutable and cannot be updated';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_prevent_skill_versions_update ON skill_versions;

      CREATE TRIGGER trg_prevent_skill_versions_update
      BEFORE UPDATE ON skill_versions
      FOR EACH ROW
      EXECUTE FUNCTION prevent_skill_versions_update();
    `,
  },
  {
    version: 4,
    name: '004_skill_definitions_revision',
    sql: `
      ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
    `,
  },
  {
    version: 5,
    name: '005_chat_generations',
    sql: `
CREATE TABLE IF NOT EXISTS chat_generations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    assistant_message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    model_alias VARCHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'streaming', 'completed', 'failed', 'interrupted')),
    partial_content TEXT NOT NULL DEFAULT '' CHECK (octet_length(partial_content) <= 65536),
    idempotency_key VARCHAR(128) NOT NULL,
    request_fingerprint VARCHAR(64) NOT NULL,
    finish_reason VARCHAR(20) CHECK (finish_reason IS NULL OR finish_reason IN ('stop', 'length', 'other')),
    error_code VARCHAR(40),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    CONSTRAINT uq_chat_owner_key UNIQUE (owner_id, idempotency_key),
    CONSTRAINT chk_chat_completion CHECK (status <> 'completed' OR (assistant_message_id IS NOT NULL AND finished_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_active_conversation
    ON chat_generations (conversation_id) WHERE status IN ('pending', 'streaming');
`,
  },
  {
    version: 6,
    name: '006_chat_generation_cancel',
    sql: `
-- PostgreSQL's generated names from the unchanged migration 005.
ALTER TABLE chat_generations DROP CONSTRAINT IF EXISTS chat_generations_status_check;
ALTER TABLE chat_generations DROP CONSTRAINT IF EXISTS chat_generations_finish_reason_check;
ALTER TABLE chat_generations DROP CONSTRAINT IF EXISTS chk_chat_status;
ALTER TABLE chat_generations DROP CONSTRAINT IF EXISTS chk_chat_finish_reason;
ALTER TABLE chat_generations DROP CONSTRAINT IF EXISTS chk_chat_stopped;
ALTER TABLE chat_generations ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
ALTER TABLE chat_generations ADD CONSTRAINT chk_chat_status
    CHECK (status IN ('pending', 'streaming', 'completed', 'failed', 'interrupted', 'stopped'));
ALTER TABLE chat_generations ADD CONSTRAINT chk_chat_finish_reason
    CHECK (finish_reason IS NULL OR finish_reason IN ('stop', 'length', 'other', 'cancelled'));
ALTER TABLE chat_generations ADD CONSTRAINT chk_chat_stopped
    CHECK (status <> 'stopped' OR (finished_at IS NOT NULL AND cancel_requested_at IS NOT NULL
        AND assistant_message_id IS NULL AND finish_reason IS NOT NULL AND finish_reason = 'cancelled'));

-- Shared key namespace binds every accepted prompt/cancel key to its first operation.
-- Keep identity tombstones after conversation deletion; no prompt/output data is stored here.
CREATE TABLE IF NOT EXISTS chat_operation_keys (
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(128) NOT NULL,
    generation_id UUID NOT NULL,
    operation VARCHAR(10) NOT NULL CHECK (operation IN ('prompt', 'cancel')),
    PRIMARY KEY (owner_id, idempotency_key)
);
INSERT INTO chat_operation_keys (owner_id, idempotency_key, generation_id, operation)
    SELECT owner_id, idempotency_key, id, 'prompt' FROM chat_generations
    ON CONFLICT (owner_id, idempotency_key) DO NOTHING;

CREATE OR REPLACE FUNCTION prevent_chat_terminal_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IN ('completed', 'failed', 'interrupted', 'stopped') AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'Terminal chat generation status cannot change';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_chat_terminal_transition ON chat_generations;
CREATE TRIGGER trg_chat_terminal_transition BEFORE UPDATE ON chat_generations
    FOR EACH ROW EXECUTE FUNCTION prevent_chat_terminal_transition();
`,
  },
  {
    version: 7,
    name: '007_chat_turn_variants',
    sql: `
ALTER TABLE chat_generations ADD COLUMN action VARCHAR(12) NOT NULL DEFAULT 'new_prompt'
    CHECK (action IN ('new_prompt', 'retry', 'regenerate'));
ALTER TABLE chat_operation_keys DROP CONSTRAINT chat_operation_keys_operation_check;
ALTER TABLE chat_operation_keys ALTER COLUMN operation TYPE VARCHAR(12);
ALTER TABLE chat_operation_keys ADD CONSTRAINT chat_operation_keys_operation_check
    CHECK (operation IN ('prompt', 'cancel', 'retry', 'regenerate'));

-- Composite keys prove the selected attempt's scope and completed status, including
-- against direct writes. A selected row cannot later lose its completed status.
ALTER TABLE conversations ADD CONSTRAINT uq_conversation_owner UNIQUE (id, user_id);
ALTER TABLE messages ADD CONSTRAINT uq_message_turn_scope UNIQUE (id, conversation_id, role);
ALTER TABLE chat_generations ADD CONSTRAINT uq_generation_selection_scope
    UNIQUE (id, owner_id, conversation_id, user_message_id, status);
CREATE TABLE chat_turn_selections (
    user_message_id UUID PRIMARY KEY,
    owner_id UUID NOT NULL,
    conversation_id UUID NOT NULL,
    user_role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (user_role = 'user'),
    selected_generation_id UUID NOT NULL,
    selected_status VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (selected_status = 'completed'),
    FOREIGN KEY (conversation_id, owner_id) REFERENCES conversations(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (user_message_id, conversation_id, user_role)
        REFERENCES messages(id, conversation_id, role) ON DELETE CASCADE,
    FOREIGN KEY (selected_generation_id, owner_id, conversation_id, user_message_id, selected_status)
        REFERENCES chat_generations(id, owner_id, conversation_id, user_message_id, status) ON DELETE CASCADE
);
INSERT INTO chat_turn_selections (owner_id, conversation_id, user_message_id, selected_generation_id)
    SELECT owner_id, conversation_id, user_message_id, id FROM chat_generations
    WHERE status = 'completed';

CREATE INDEX idx_chat_turn_attempts ON chat_generations (conversation_id, user_message_id, created_at, id);
`,
  },
  {
    version: 8,
    name: '008_chat_resolved_model',
    sql: `
ALTER TABLE chat_generations ADD COLUMN resolved_provider_id VARCHAR(128);
ALTER TABLE chat_generations ADD COLUMN resolved_model_id VARCHAR(128);
ALTER TABLE chat_generations ADD CONSTRAINT chk_chat_resolved_model_pair CHECK (
    (resolved_provider_id IS NULL AND resolved_model_id IS NULL) OR
    (resolved_provider_id IS NOT NULL AND resolved_model_id IS NOT NULL
        AND octet_length(resolved_provider_id) > 0 AND octet_length(resolved_model_id) > 0)
);
-- Historical identity cannot be reconstructed truthfully: leave existing rows null.
CREATE OR REPLACE FUNCTION prevent_chat_resolved_model_rewrite()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.resolved_provider_id IS DISTINCT FROM NEW.resolved_provider_id
        OR OLD.resolved_model_id IS DISTINCT FROM NEW.resolved_model_id THEN
        IF OLD.resolved_provider_id IS NOT NULL OR OLD.status <> 'streaming'
            OR NEW.status <> 'streaming' OR NEW.resolved_provider_id IS NULL
            OR NEW.resolved_model_id IS NULL THEN
            RAISE EXCEPTION 'Resolved chat model identity is write-once at streaming start';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_chat_resolved_model_rewrite BEFORE UPDATE ON chat_generations
    FOR EACH ROW EXECUTE FUNCTION prevent_chat_resolved_model_rewrite();
`,
  },
  { version: 9, name: '009_chat_byok_credentials', sql: `
CREATE TABLE user_provider_credentials (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id VARCHAR(20) NOT NULL CHECK (provider_id = 'gemini'),
    ciphertext TEXT NOT NULL,
    nonce VARCHAR(24) NOT NULL,
    auth_tag VARCHAR(24) NOT NULL,
    key_version INTEGER NOT NULL CHECK (key_version >= 1),
    display_hint VARCHAR(8) NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'valid', 'invalid')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_validated_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    UNIQUE (owner_id, provider_id),
    UNIQUE (owner_id, id)
);

-- A null selection in BYOK mode is intentional: deletion never enables platform billing.
-- Composite FK prevents selecting another owner's key, even through direct SQL.
CREATE TABLE chat_credential_preferences (
    owner_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mode VARCHAR(10) NOT NULL CHECK (mode IN ('platform', 'byok')),
    credential_id UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (mode = 'byok' OR credential_id IS NULL),
    FOREIGN KEY (owner_id, credential_id) REFERENCES user_provider_credentials(owner_id, id)
);
` },
  {
    version: 10,
    name: '010_chat_reasoning_effort',
    sql: `
ALTER TABLE chat_generations ADD COLUMN reasoning_effort VARCHAR(10);
ALTER TABLE chat_generations ADD CONSTRAINT chk_chat_reasoning_effort CHECK (
    reasoning_effort IS NULL OR reasoning_effort IN ('low', 'medium', 'high')
);
-- Historical generations remain null; requested effort is immutable once admitted.
CREATE OR REPLACE FUNCTION prevent_chat_reasoning_effort_rewrite()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.reasoning_effort IS DISTINCT FROM NEW.reasoning_effort THEN
        RAISE EXCEPTION 'Chat generation reasoning_effort is immutable once admitted';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_chat_reasoning_effort_rewrite BEFORE UPDATE ON chat_generations
    FOR EACH ROW EXECUTE FUNCTION prevent_chat_reasoning_effort_rewrite();
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
 * Accepts an optional migrations array, defaulting to canonical MIGRATIONS.
 */
export async function runMigrations(
  pool: pg.Pool,
  migrations: readonly Migration[] = MIGRATIONS
): Promise<string[]> {
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

    const sortedMigrations = [...migrations].sort((a, b) => a.version - b.version);
    for (const migration of sortedMigrations) {
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
