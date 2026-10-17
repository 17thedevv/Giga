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
