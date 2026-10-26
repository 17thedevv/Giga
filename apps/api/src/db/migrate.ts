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
  { version: 11, name: '011_agent_control_plane', sql: `
CREATE TABLE agent_workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL CHECK (char_length(name) > 0 AND octet_length(name) <= 255),
    source_kind VARCHAR(10) NOT NULL DEFAULT 'blank' CHECK (source_kind = 'blank'),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (owner_id, id),
    CHECK (updated_at >= created_at)
);
CREATE INDEX idx_agent_workspace_history ON agent_workspaces (owner_id, created_at DESC, id DESC);

CREATE TABLE agent_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL,
    task TEXT NOT NULL CHECK (char_length(task) > 0 AND octet_length(task) <= 16384),
    mode VARCHAR(10) NOT NULL CHECK (mode IN ('ask', 'plan', 'execute')),
    runtime VARCHAR(10) NOT NULL CHECK (runtime = 'cloud'),
    model_alias VARCHAR(128) NOT NULL CHECK (char_length(model_alias) > 0),
    status VARCHAR(20) NOT NULL CHECK (status IN ('queued', 'running', 'awaiting_approval', 'applying', 'completed', 'failed', 'cancelled')),
    last_event_id INTEGER NOT NULL DEFAULT 0 CHECK (last_event_id >= 0),
    idempotency_key VARCHAR(128) NOT NULL,
    request_fingerprint VARCHAR(64) NOT NULL CHECK (char_length(request_fingerprint) = 64),
    error_code VARCHAR(40) CHECK (error_code IS NULL OR error_code = 'RUNTIME_UNAVAILABLE'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    UNIQUE (owner_id, id),
    UNIQUE (owner_id, idempotency_key),
    FOREIGN KEY (owner_id, workspace_id) REFERENCES agent_workspaces(owner_id, id) ON DELETE CASCADE,
    CHECK ((status IN ('completed', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
    CHECK ((status = 'failed') = (error_code IS NOT NULL)),
    CHECK (updated_at >= created_at AND (finished_at IS NULL OR finished_at >= created_at))
);
CREATE INDEX idx_agent_run_history ON agent_runs (owner_id, created_at DESC, id DESC);
CREATE INDEX idx_agent_workspace_runs ON agent_runs (owner_id, workspace_id, created_at DESC, id DESC);

CREATE TABLE agent_run_events (
    owner_id UUID NOT NULL,
    run_id UUID NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    event_type VARCHAR(32) NOT NULL CHECK (event_type IN ('run.status', 'run.failed')),
    status VARCHAR(20) NOT NULL CHECK (status IN ('queued', 'running', 'awaiting_approval', 'applying', 'completed', 'failed', 'cancelled')),
    error_code VARCHAR(40) CHECK (error_code IS NULL OR error_code = 'RUNTIME_UNAVAILABLE'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (run_id, sequence),
    FOREIGN KEY (owner_id, run_id) REFERENCES agent_runs(owner_id, id) ON DELETE CASCADE,
    CHECK ((event_type = 'run.failed') = (status = 'failed')),
    CHECK ((status = 'failed') = (error_code IS NOT NULL))
);
CREATE INDEX idx_agent_event_replay ON agent_run_events (owner_id, run_id, sequence);

CREATE OR REPLACE FUNCTION guard_agent_run_update() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IN ('completed', 'failed', 'cancelled') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Agent terminal run is immutable';
    END IF;
    IF ROW(NEW.id, NEW.owner_id, NEW.workspace_id, NEW.task, NEW.mode, NEW.runtime, NEW.model_alias,
        NEW.idempotency_key, NEW.request_fingerprint, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.owner_id, OLD.workspace_id, OLD.task, OLD.mode, OLD.runtime, OLD.model_alias,
        OLD.idempotency_key, OLD.request_fingerprint, OLD.created_at) THEN
        RAISE EXCEPTION 'Agent admission identity is immutable';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
        (OLD.status = 'queued' AND NEW.status IN ('running', 'failed', 'cancelled')) OR
        (OLD.status = 'running' AND NEW.status IN ('awaiting_approval', 'completed', 'failed', 'cancelled')) OR
        (OLD.status = 'awaiting_approval' AND NEW.status IN ('running', 'applying', 'failed', 'cancelled')) OR
        (OLD.status = 'applying' AND NEW.status IN ('running', 'completed', 'failed'))
    ) THEN RAISE EXCEPTION 'Invalid Agent status transition'; END IF;
    IF NEW.last_event_id < OLD.last_event_id OR NEW.last_event_id > OLD.last_event_id + 1 THEN
        RAISE EXCEPTION 'Invalid Agent event sequence';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_agent_run_update BEFORE UPDATE ON agent_runs
    FOR EACH ROW EXECUTE FUNCTION guard_agent_run_update();

CREATE OR REPLACE FUNCTION guard_agent_event_insert() RETURNS TRIGGER AS $$
DECLARE current_run agent_runs%ROWTYPE;
previous_sequence INTEGER;
BEGIN
    SELECT * INTO current_run FROM agent_runs WHERE id = NEW.run_id AND owner_id = NEW.owner_id FOR UPDATE;
    SELECT COALESCE(MAX(sequence), 0) INTO previous_sequence FROM agent_run_events WHERE run_id = NEW.run_id AND owner_id = NEW.owner_id;
    IF current_run.id IS NULL OR NEW.sequence <> previous_sequence + 1 OR NEW.sequence <> current_run.last_event_id
        OR NEW.status <> current_run.status OR NEW.error_code IS DISTINCT FROM current_run.error_code THEN
        RAISE EXCEPTION 'Agent event must match allocated sequence and current state';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_agent_event_insert BEFORE INSERT ON agent_run_events
    FOR EACH ROW EXECUTE FUNCTION guard_agent_event_insert();
CREATE OR REPLACE FUNCTION guard_agent_event_update() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Agent run events are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_agent_event_update BEFORE UPDATE ON agent_run_events
    FOR EACH ROW EXECUTE FUNCTION guard_agent_event_update();
` },
  { version: 12, name: '012_agent_orchestrator', sql: `ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_error_code_check;
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_constraint_7;
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_constraint_8;
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_constraint_9;
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS chk_agent_runs_error_code;
ALTER TABLE agent_runs ADD CONSTRAINT chk_agent_runs_error_code
    CHECK (error_code IS NULL OR error_code IN (
        'RUNTIME_UNAVAILABLE', 'STEP_LIMIT_EXCEEDED', 'TOOL_ERROR',
        'EXECUTION_FAILED', 'VERIFICATION_FAILED', 'CANCELLED',
        'UNKNOWN_TOOL', 'INVALID_ARGUMENTS', 'POLICY_VIOLATION',
        'INTERNAL_ERROR', 'ABORTED', 'PERMANENT_ERROR'
    ));

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS worker_id VARCHAR(128);
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS lease_token VARCHAR(128);
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS verified_checks JSONB;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS result_summary TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_runs_queue ON agent_runs (status, lease_expires_at);

ALTER TABLE agent_run_events DROP CONSTRAINT IF EXISTS agent_run_events_event_type_check;
ALTER TABLE agent_run_events DROP CONSTRAINT IF EXISTS agent_run_events_error_code_check;
ALTER TABLE agent_run_events DROP CONSTRAINT IF EXISTS agent_run_events_check;
ALTER TABLE agent_run_events DROP CONSTRAINT IF EXISTS agent_run_events_check1;
ALTER TABLE agent_run_events DROP CONSTRAINT IF EXISTS agent_run_events_constraint_2;
ALTER TABLE agent_run_events DROP CONSTRAINT IF EXISTS agent_run_events_constraint_4;
ALTER TABLE agent_run_events DROP CONSTRAINT IF EXISTS agent_run_events_constraint_5;
ALTER TABLE agent_run_events DROP CONSTRAINT IF EXISTS agent_run_events_constraint_6;
ALTER TABLE agent_run_events DROP CONSTRAINT IF EXISTS chk_agent_run_events_event_type;
ALTER TABLE agent_run_events DROP CONSTRAINT IF EXISTS chk_agent_run_events_error_code;
ALTER TABLE agent_run_events DROP CONSTRAINT IF EXISTS chk_agent_run_events_failed;
ALTER TABLE agent_run_events DROP CONSTRAINT IF EXISTS chk_agent_run_events_error_consistency;

ALTER TABLE agent_run_events ADD COLUMN IF NOT EXISTS payload JSONB;

ALTER TABLE agent_run_events ADD CONSTRAINT chk_agent_run_events_event_type
    CHECK (event_type IN ('run.status', 'plan.updated', 'tool.started', 'tool.completed', 'tool.failed', 'run.completed', 'run.failed'));
ALTER TABLE agent_run_events ADD CONSTRAINT chk_agent_run_events_error_code
    CHECK (error_code IS NULL OR error_code IN (
        'RUNTIME_UNAVAILABLE', 'STEP_LIMIT_EXCEEDED', 'TOOL_ERROR',
        'EXECUTION_FAILED', 'VERIFICATION_FAILED', 'CANCELLED',
        'UNKNOWN_TOOL', 'INVALID_ARGUMENTS', 'POLICY_VIOLATION',
        'INTERNAL_ERROR', 'ABORTED', 'PERMANENT_ERROR'
    ));
ALTER TABLE agent_run_events ADD CONSTRAINT chk_agent_run_events_failed
    CHECK ((event_type = 'run.failed') = (status = 'failed'));
ALTER TABLE agent_run_events ADD CONSTRAINT chk_agent_run_events_error_consistency
    CHECK ((status = 'failed') = (error_code IS NOT NULL));

CREATE TABLE IF NOT EXISTS agent_run_steps (
    id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    owner_id UUID NOT NULL,
    run_id UUID NOT NULL,
    step_number INTEGER NOT NULL CHECK (step_number > 0),
    status VARCHAR(20) NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    tool_name VARCHAR(64) NOT NULL,
    tool_call_id VARCHAR(64) NOT NULL,
    tool_risk VARCHAR(20) NOT NULL CHECK (tool_risk IN ('read', 'sandbox_write', 'sandbox_execute')),
    arguments_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    result_json JSONB,
    error_code VARCHAR(40),
    error_message TEXT,
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (run_id, step_number),
    UNIQUE (run_id, tool_call_id),
    FOREIGN KEY (owner_id, run_id) REFERENCES agent_runs(owner_id, id) ON DELETE CASCADE,
    CHECK (completed_at IS NULL OR completed_at >= created_at),
    CHECK ((status IN ('completed', 'failed')) = (completed_at IS NOT NULL)),
    CHECK ((status = 'failed') = (error_code IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_agent_run_steps_replay ON agent_run_steps (owner_id, run_id, step_number);

CREATE OR REPLACE FUNCTION guard_agent_event_insert() RETURNS TRIGGER AS $$
DECLARE
    current_run agent_runs%ROWTYPE;
    previous_sequence INTEGER;
BEGIN
    SELECT * INTO current_run FROM agent_runs WHERE id = NEW.run_id AND owner_id = NEW.owner_id FOR UPDATE;
    IF current_run.id IS NULL THEN
        RAISE EXCEPTION 'Agent run does not exist or owner mismatch';
    END IF;
    SELECT COALESCE(MAX(sequence), 0) INTO previous_sequence FROM agent_run_events WHERE run_id = NEW.run_id AND owner_id = NEW.owner_id;
    IF NEW.sequence <> previous_sequence + 1 OR NEW.sequence <> current_run.last_event_id THEN
        RAISE EXCEPTION 'Agent event must match allocated sequence and current state';
    END IF;
    IF NEW.status <> current_run.status THEN
        RAISE EXCEPTION 'Agent event status must match current run status';
    END IF;
    IF NEW.event_type = 'run.failed' AND (current_run.status <> 'failed' OR NEW.error_code IS DISTINCT FROM current_run.error_code) THEN
        RAISE EXCEPTION 'run.failed event must match failed run error_code';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_agent_step_insert() RETURNS TRIGGER AS $$
DECLARE
    current_run agent_runs%ROWTYPE;
    previous_step INTEGER;
BEGIN
    SELECT * INTO current_run FROM agent_runs WHERE id = NEW.run_id AND owner_id = NEW.owner_id FOR UPDATE;
    IF current_run.id IS NULL THEN
        RAISE EXCEPTION 'Agent run does not exist';
    END IF;
    IF current_run.status <> 'running' THEN
        RAISE EXCEPTION 'Cannot add steps to run with status %', current_run.status;
    END IF;
    SELECT COALESCE(MAX(step_number), 0) INTO previous_step FROM agent_run_steps WHERE run_id = NEW.run_id;
    IF NEW.step_number <> previous_step + 1 THEN
        RAISE EXCEPTION 'Agent step number must be monotonic: expected %, got %', previous_step + 1, NEW.step_number;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_agent_step_insert ON agent_run_steps;
CREATE TRIGGER trg_agent_step_insert BEFORE INSERT ON agent_run_steps
    FOR EACH ROW EXECUTE FUNCTION guard_agent_step_insert();

CREATE OR REPLACE FUNCTION guard_agent_step_update() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IN ('completed', 'failed') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Agent committed step is immutable';
    END IF;
    IF OLD.status = 'running' AND NEW.status IN ('completed', 'failed') THEN
        IF ROW(NEW.id, NEW.owner_id, NEW.run_id, NEW.step_number, NEW.tool_name, NEW.tool_call_id, NEW.tool_risk, NEW.arguments_json, NEW.created_at)
           IS DISTINCT FROM ROW(OLD.id, OLD.owner_id, OLD.run_id, OLD.step_number, OLD.tool_name, OLD.tool_call_id, OLD.tool_risk, OLD.arguments_json, OLD.created_at) THEN
            RAISE EXCEPTION 'Agent step identity and arguments are immutable';
        END IF;
    ELSE
        RAISE EXCEPTION 'Invalid step transition';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_agent_step_update ON agent_run_steps;
CREATE TRIGGER trg_agent_step_update BEFORE UPDATE ON agent_run_steps
    FOR EACH ROW EXECUTE FUNCTION guard_agent_step_update();

CREATE OR REPLACE FUNCTION guard_agent_step_delete() RETURNS TRIGGER AS $$
BEGIN
    IF pg_trigger_depth() <= 1 THEN
        RAISE EXCEPTION 'Agent steps cannot be deleted directly';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_agent_step_delete ON agent_run_steps;
CREATE TRIGGER trg_agent_step_delete BEFORE DELETE ON agent_run_steps
    FOR EACH ROW EXECUTE FUNCTION guard_agent_step_delete();
` },
  {
    version: 13,
    name: '013_agent_messages',
    sql: `
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS uq_agent_runs_owner_workspace_id;
ALTER TABLE agent_runs ADD CONSTRAINT uq_agent_runs_owner_workspace_id UNIQUE (owner_id, workspace_id, id);

CREATE TABLE IF NOT EXISTS agent_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL,
    run_id UUID NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'tool_summary')),
    content TEXT NOT NULL CHECK (char_length(content) > 0 AND octet_length(content) <= 16384),
    idempotency_key VARCHAR(128),
    request_fingerprint VARCHAR(64) CHECK (request_fingerprint IS NULL OR char_length(request_fingerprint) = 64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id, sequence),
    CONSTRAINT uq_agent_messages_idempotency UNIQUE (owner_id, run_id, idempotency_key),
    FOREIGN KEY (owner_id, workspace_id, run_id) REFERENCES agent_runs(owner_id, workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_thread ON agent_messages (owner_id, run_id, sequence ASC);
CREATE INDEX IF NOT EXISTS idx_agent_messages_workspace ON agent_messages (owner_id, workspace_id, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_idempotency ON agent_messages (owner_id, run_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Backfill initial instruction from agent_runs.task for existing runs
INSERT INTO agent_messages (id, owner_id, workspace_id, run_id, sequence, role, content, created_at)
SELECT gen_random_uuid(), owner_id, workspace_id, id, 1, 'user', task, created_at
FROM agent_runs
ON CONFLICT (run_id, sequence) DO NOTHING;

-- Backfill completed assistant summary for existing completed runs
INSERT INTO agent_messages (id, owner_id, workspace_id, run_id, sequence, role, content, created_at)
SELECT gen_random_uuid(), owner_id, workspace_id, id, 2, 'assistant', result_summary, COALESCE(finished_at, updated_at)
FROM agent_runs
WHERE status = 'completed' AND result_summary IS NOT NULL AND char_length(result_summary) > 0
ON CONFLICT (run_id, sequence) DO NOTHING;

CREATE OR REPLACE FUNCTION guard_agent_message_insert() RETURNS TRIGGER AS $$
DECLARE
    current_run agent_runs%ROWTYPE;
    previous_seq INTEGER;
BEGIN
    SELECT * INTO current_run FROM agent_runs WHERE id = NEW.run_id AND owner_id = NEW.owner_id FOR UPDATE;
    IF current_run.id IS NULL THEN
        RAISE EXCEPTION 'Agent run does not exist or owner mismatch';
    END IF;
    IF current_run.workspace_id <> NEW.workspace_id THEN
        RAISE EXCEPTION 'Message workspace does not match run workspace';
    END IF;
    SELECT COALESCE(MAX(sequence), 0) INTO previous_seq FROM agent_messages WHERE run_id = NEW.run_id;
    IF NEW.sequence <> previous_seq + 1 THEN
        RAISE EXCEPTION 'Agent message sequence must be monotonic: expected %, got %', previous_seq + 1, NEW.sequence;
    END IF;
    IF NEW.sequence = 1 THEN
        IF NEW.role <> 'user' THEN
            RAISE EXCEPTION 'Sequence 1 message must have user role';
        END IF;
        IF NEW.content <> current_run.task THEN
            RAISE EXCEPTION 'Sequence 1 message content must match initial run task';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_agent_message_insert ON agent_messages;
CREATE TRIGGER trg_agent_message_insert BEFORE INSERT ON agent_messages
    FOR EACH ROW EXECUTE FUNCTION guard_agent_message_insert();

CREATE OR REPLACE FUNCTION guard_agent_message_update() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Agent messages are immutable';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_agent_message_update ON agent_messages;
CREATE TRIGGER trg_agent_message_update BEFORE UPDATE ON agent_messages
    FOR EACH ROW EXECUTE FUNCTION guard_agent_message_update();

CREATE OR REPLACE FUNCTION guard_agent_message_delete() RETURNS TRIGGER AS $$
BEGIN
    IF pg_trigger_depth() <= 1 THEN
        RAISE EXCEPTION 'Agent messages cannot be deleted directly';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_agent_message_delete ON agent_messages;
CREATE TRIGGER trg_agent_message_delete BEFORE DELETE ON agent_messages
    FOR EACH ROW EXECUTE FUNCTION guard_agent_message_delete();
` },
  {
    version: 15,
    name: '015_agent_execution_quotas',
    sql: `-- Migration 015: durable, owner-scoped Agent execution quota reservations.
-- Version 014 is reserved for the independent sandbox-session lifecycle change.

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS chk_agent_runs_error_code;
ALTER TABLE agent_runs ADD CONSTRAINT chk_agent_runs_error_code CHECK (
    error_code IS NULL OR error_code IN (
        'RUNTIME_UNAVAILABLE', 'STEP_LIMIT_EXCEEDED', 'TOOL_ERROR',
        'EXECUTION_FAILED', 'VERIFICATION_FAILED', 'CANCELLED',
        'UNKNOWN_TOOL', 'INVALID_ARGUMENTS', 'POLICY_VIOLATION',
        'INTERNAL_ERROR', 'ABORTED', 'PERMANENT_ERROR', 'TIMEOUT', 'SECURITY_VIOLATION',
        'RATE_LIMITED', 'LIMIT_EXCEEDED', 'WORKSPACE_BUSY'
    )
);

ALTER TABLE agent_run_events DROP CONSTRAINT IF EXISTS chk_agent_run_events_error_code;
ALTER TABLE agent_run_events ADD CONSTRAINT chk_agent_run_events_error_code CHECK (
    error_code IS NULL OR error_code IN (
        'RUNTIME_UNAVAILABLE', 'STEP_LIMIT_EXCEEDED', 'TOOL_ERROR',
        'EXECUTION_FAILED', 'VERIFICATION_FAILED', 'CANCELLED',
        'UNKNOWN_TOOL', 'INVALID_ARGUMENTS', 'POLICY_VIOLATION',
        'INTERNAL_ERROR', 'ABORTED', 'PERMANENT_ERROR', 'TIMEOUT', 'SECURITY_VIOLATION',
        'RATE_LIMITED', 'LIMIT_EXCEEDED', 'WORKSPACE_BUSY'
    )
);

CREATE TABLE agent_execution_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL,
    workspace_id UUID NOT NULL,
    run_id UUID NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    mode VARCHAR(10) NOT NULL CHECK (mode IN ('ask', 'plan', 'execute')),
    state VARCHAR(32) NOT NULL CHECK (state IN (
        'reserved', 'active', 'reconciliation_required', 'committed', 'released'
    )),
    resource_active BOOLEAN NOT NULL DEFAULT FALSE,
    writable BOOLEAN NOT NULL,
    policy_version INTEGER NOT NULL CHECK (policy_version > 0),
    lease_token_hash CHAR(64) NOT NULL CHECK (char_length(lease_token_hash) = 64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,

    max_sandbox_runtime_ms BIGINT NOT NULL CHECK (max_sandbox_runtime_ms >= 0),
    max_wall_clock_ms BIGINT NOT NULL CHECK (max_wall_clock_ms > 0),
    max_tool_calls BIGINT NOT NULL CHECK (max_tool_calls >= 0),
    max_provider_requests BIGINT NOT NULL CHECK (max_provider_requests >= 0),
    max_command_output_bytes BIGINT NOT NULL CHECK (max_command_output_bytes >= 0),
    max_artifact_bytes BIGINT NOT NULL CHECK (max_artifact_bytes >= 0),
    max_workspace_disk_bytes BIGINT NOT NULL CHECK (max_workspace_disk_bytes >= 0),
    max_workspace_file_count BIGINT NOT NULL CHECK (max_workspace_file_count >= 0),

    accounted_sandbox_runtime_ms BIGINT NOT NULL CHECK (accounted_sandbox_runtime_ms >= 0),
    accounted_wall_clock_ms BIGINT NOT NULL CHECK (accounted_wall_clock_ms >= 0),
    accounted_tool_calls BIGINT NOT NULL CHECK (accounted_tool_calls >= 0),
    accounted_provider_requests BIGINT NOT NULL CHECK (accounted_provider_requests >= 0),
    accounted_command_output_bytes BIGINT NOT NULL CHECK (accounted_command_output_bytes >= 0),
    accounted_artifact_bytes BIGINT NOT NULL CHECK (accounted_artifact_bytes >= 0),
    accounted_workspace_disk_bytes BIGINT NOT NULL CHECK (accounted_workspace_disk_bytes >= 0),
    accounted_workspace_file_count BIGINT NOT NULL CHECK (accounted_workspace_file_count >= 0),

    actual_sandbox_runtime_ms BIGINT NOT NULL DEFAULT 0 CHECK (actual_sandbox_runtime_ms >= 0),
    actual_wall_clock_ms BIGINT NOT NULL DEFAULT 0 CHECK (actual_wall_clock_ms >= 0),
    actual_tool_calls BIGINT NOT NULL DEFAULT 0 CHECK (actual_tool_calls >= 0),
    actual_provider_requests BIGINT NOT NULL DEFAULT 0 CHECK (actual_provider_requests >= 0),
    actual_command_output_bytes BIGINT NOT NULL DEFAULT 0 CHECK (actual_command_output_bytes >= 0),
    actual_artifact_bytes BIGINT NOT NULL DEFAULT 0 CHECK (actual_artifact_bytes >= 0),
    actual_workspace_disk_bytes BIGINT NOT NULL DEFAULT 0 CHECK (actual_workspace_disk_bytes >= 0),
    actual_workspace_file_count BIGINT NOT NULL DEFAULT 0 CHECK (actual_workspace_file_count >= 0),

    UNIQUE (owner_id, workspace_id, run_id, attempt_number),
    UNIQUE (id, owner_id, workspace_id, run_id, attempt_number),
    FOREIGN KEY (owner_id, workspace_id, run_id)
        REFERENCES agent_runs(owner_id, workspace_id, id) ON DELETE CASCADE,
    CHECK ((mode = 'execute') = writable),
    CHECK (NOT resource_active OR writable),
    CHECK (NOT writable OR state NOT IN ('active', 'reconciliation_required') OR resource_active),
    CHECK ((state IN ('reserved', 'active', 'reconciliation_required')) = (finished_at IS NULL)),
    CHECK (state <> 'released' OR (resource_active = FALSE AND
        accounted_sandbox_runtime_ms = 0 AND accounted_wall_clock_ms = 0 AND accounted_tool_calls = 0 AND
        accounted_provider_requests = 0 AND accounted_command_output_bytes = 0 AND accounted_artifact_bytes = 0 AND
        accounted_workspace_disk_bytes = 0 AND accounted_workspace_file_count = 0)),
    CHECK (updated_at >= created_at AND (finished_at IS NULL OR finished_at >= created_at))
);

CREATE INDEX idx_agent_quota_owner_active
    ON agent_execution_reservations (owner_id, created_at)
    WHERE resource_active = TRUE AND writable = TRUE;
CREATE INDEX idx_agent_quota_workspace_active
    ON agent_execution_reservations (owner_id, workspace_id, created_at)
    WHERE resource_active = TRUE AND writable = TRUE;
CREATE INDEX idx_agent_quota_owner_window
    ON agent_execution_reservations (owner_id, created_at)
    WHERE state <> 'released';
CREATE INDEX idx_agent_quota_workspace_window
    ON agent_execution_reservations (owner_id, workspace_id, created_at)
    WHERE state <> 'released';

CREATE TABLE agent_execution_usage_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id UUID NOT NULL,
    owner_id UUID NOT NULL,
    workspace_id UUID NOT NULL,
    run_id UUID NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    event_key VARCHAR(128) NOT NULL CHECK (char_length(event_key) BETWEEN 1 AND 128),
    event_kind VARCHAR(32) NOT NULL CHECK (event_kind IN (
        'reservation', 'allocation_started', 'provider_request', 'tool_call', 'measurement',
        'outcome_unknown', 'released_before_allocation', 'attempt_committed', 'reconciled'
    )),
    request_fingerprint CHAR(64) NOT NULL CHECK (char_length(request_fingerprint) = 64),
    sandbox_runtime_ms BIGINT NOT NULL DEFAULT 0 CHECK (sandbox_runtime_ms >= 0),
    wall_clock_ms BIGINT NOT NULL DEFAULT 0 CHECK (wall_clock_ms >= 0),
    tool_calls BIGINT NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
    provider_requests BIGINT NOT NULL DEFAULT 0 CHECK (provider_requests >= 0),
    command_output_bytes BIGINT NOT NULL DEFAULT 0 CHECK (command_output_bytes >= 0),
    artifact_bytes BIGINT NOT NULL DEFAULT 0 CHECK (artifact_bytes >= 0),
    workspace_disk_bytes BIGINT NOT NULL DEFAULT 0 CHECK (workspace_disk_bytes >= 0),
    workspace_file_count BIGINT NOT NULL DEFAULT 0 CHECK (workspace_file_count >= 0),
    limit_exceeded BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (reservation_id, event_key),
    FOREIGN KEY (reservation_id, owner_id, workspace_id, run_id, attempt_number)
        REFERENCES agent_execution_reservations(id, owner_id, workspace_id, run_id, attempt_number)
        ON DELETE CASCADE
);

CREATE INDEX idx_agent_quota_events_owner
    ON agent_execution_usage_events (owner_id, workspace_id, run_id, attempt_number, created_at);

CREATE OR REPLACE FUNCTION guard_agent_execution_reservation_update() RETURNS TRIGGER AS $$
BEGIN
    IF ROW(NEW.id, NEW.owner_id, NEW.workspace_id, NEW.run_id, NEW.attempt_number, NEW.mode,
        NEW.writable, NEW.policy_version, NEW.lease_token_hash, NEW.created_at,
        NEW.max_sandbox_runtime_ms, NEW.max_wall_clock_ms, NEW.max_tool_calls,
        NEW.max_provider_requests, NEW.max_command_output_bytes, NEW.max_artifact_bytes,
        NEW.max_workspace_disk_bytes, NEW.max_workspace_file_count)
       IS DISTINCT FROM ROW(OLD.id, OLD.owner_id, OLD.workspace_id, OLD.run_id, OLD.attempt_number, OLD.mode,
        OLD.writable, OLD.policy_version, OLD.lease_token_hash, OLD.created_at,
        OLD.max_sandbox_runtime_ms, OLD.max_wall_clock_ms, OLD.max_tool_calls,
        OLD.max_provider_requests, OLD.max_command_output_bytes, OLD.max_artifact_bytes,
        OLD.max_workspace_disk_bytes, OLD.max_workspace_file_count) THEN
        RAISE EXCEPTION 'Agent quota reservation identity and policy are immutable';
    END IF;
    IF OLD.state = 'released' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Released Agent quota reservation is immutable';
    END IF;
    IF OLD.state = 'committed' AND NEW.state NOT IN ('committed') THEN
        RAISE EXCEPTION 'Committed Agent quota reservation cannot be reopened';
    END IF;
    IF OLD.resource_active = FALSE AND NEW.resource_active = TRUE THEN
        RAISE EXCEPTION 'Released Agent quota capacity cannot be reactivated';
    END IF;
    IF OLD.state = 'reserved' AND NEW.state NOT IN ('reserved', 'active', 'released', 'reconciliation_required', 'committed') THEN
        RAISE EXCEPTION 'Invalid Agent quota reservation transition';
    END IF;
    IF OLD.state = 'active' AND NEW.state NOT IN ('active', 'reconciliation_required', 'committed') THEN
        RAISE EXCEPTION 'Invalid Agent quota reservation transition';
    END IF;
    IF OLD.state = 'reconciliation_required' AND NEW.state NOT IN ('reconciliation_required', 'committed') THEN
        RAISE EXCEPTION 'Invalid Agent quota reservation transition';
    END IF;
    NEW.updated_at = GREATEST(NOW(), OLD.updated_at);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_execution_reservation_update
    BEFORE UPDATE ON agent_execution_reservations
    FOR EACH ROW EXECUTE FUNCTION guard_agent_execution_reservation_update();

CREATE OR REPLACE FUNCTION guard_agent_execution_reservation_delete() RETURNS TRIGGER AS $$
BEGIN
    IF pg_trigger_depth() <= 1 THEN
        RAISE EXCEPTION 'Agent quota reservations cannot be deleted directly';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_execution_reservation_delete
    BEFORE DELETE ON agent_execution_reservations
    FOR EACH ROW EXECUTE FUNCTION guard_agent_execution_reservation_delete();

CREATE OR REPLACE FUNCTION guard_agent_execution_usage_event_update() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' OR pg_trigger_depth() <= 1 THEN
        RAISE EXCEPTION 'Agent quota usage events are immutable';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_execution_usage_event_update
    BEFORE UPDATE OR DELETE ON agent_execution_usage_events
    FOR EACH ROW EXECUTE FUNCTION guard_agent_execution_usage_event_update();
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
