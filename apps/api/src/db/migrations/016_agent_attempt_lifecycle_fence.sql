-- Migration 016: durable exact-attempt fence and provider/runtime operation ledger.
-- A missing in-memory sandbox is never treated as proof that allocation stopped.

CREATE TABLE agent_sandbox_attempt_fences (
    owner_id UUID NOT NULL,
    workspace_id UUID NOT NULL,
    run_id UUID NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    generation UUID NOT NULL,
    fenced_at TIMESTAMPTZ,
    fence_reason VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, workspace_id, run_id, attempt_number),
    UNIQUE (owner_id, workspace_id, run_id, attempt_number, generation),
    FOREIGN KEY (owner_id, workspace_id, run_id)
        REFERENCES agent_runs(owner_id, workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE agent_sandbox_sessions ADD COLUMN attempt_generation UUID;

INSERT INTO agent_sandbox_attempt_fences (
    owner_id, workspace_id, run_id, attempt_number, generation, fenced_at, fence_reason
)
SELECT owner_id, workspace_id, run_id, attempt_number, allocation_intent_id,
       CASE WHEN lifecycle_state = 'destroyed' THEN destroyed_at ELSE NULL END,
       CASE WHEN lifecycle_state = 'destroyed' THEN 'migration_016_terminal_session' ELSE NULL END
FROM agent_sandbox_sessions
ON CONFLICT (owner_id, workspace_id, run_id, attempt_number) DO NOTHING;

UPDATE agent_sandbox_sessions SET attempt_generation = allocation_intent_id;

ALTER TABLE agent_sandbox_sessions ALTER COLUMN attempt_generation SET NOT NULL;
ALTER TABLE agent_sandbox_sessions
    ADD CONSTRAINT fk_agent_sandbox_attempt_generation
    FOREIGN KEY (owner_id, workspace_id, run_id, attempt_number, attempt_generation)
    REFERENCES agent_sandbox_attempt_fences(owner_id, workspace_id, run_id, attempt_number, generation);

CREATE TABLE agent_sandbox_lifecycle_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES agent_sandbox_sessions(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL,
    workspace_id UUID NOT NULL,
    run_id UUID NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    generation UUID NOT NULL,
    operation_kind VARCHAR(16) NOT NULL CHECK (operation_kind IN ('allocation', 'tool', 'snapshot')),
    state VARCHAR(16) NOT NULL CHECK (state IN ('not_started', 'in_progress', 'ambiguous', 'settled')),
    outcome VARCHAR(16) CHECK (outcome IS NULL OR outcome IN ('resource', 'no_resource')),
    provider_resource_id VARCHAR(128),
    operation_name VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at TIMESTAMPTZ,
    FOREIGN KEY (owner_id, workspace_id, run_id, attempt_number, generation)
        REFERENCES agent_sandbox_attempt_fences(owner_id, workspace_id, run_id, attempt_number, generation),
    CHECK ((state = 'settled') = (settled_at IS NOT NULL)),
    CHECK (outcome IS NULL OR outcome <> 'resource' OR provider_resource_id IS NOT NULL)
);

CREATE UNIQUE INDEX uq_agent_sandbox_allocation_operation
    ON agent_sandbox_lifecycle_operations (session_id) WHERE operation_kind = 'allocation';
CREATE INDEX idx_agent_sandbox_unsettled_operations
    ON agent_sandbox_lifecycle_operations (owner_id, workspace_id, run_id, attempt_number, state)
    WHERE state <> 'settled';

-- Existing rows without provider ids have unknown outcomes. Preserve them as ambiguous;
-- TTL expiry cannot turn them into proof that the provider did not allocate a resource.
INSERT INTO agent_sandbox_lifecycle_operations (
    id, session_id, owner_id, workspace_id, run_id, attempt_number, generation,
    operation_kind, state, outcome, provider_resource_id, operation_name, settled_at
)
SELECT s.allocation_intent_id, s.id, s.owner_id, s.workspace_id, s.run_id,
       s.attempt_number, s.attempt_generation, 'allocation',
       CASE WHEN s.provider_session_id IS NULL THEN 'ambiguous' ELSE 'settled' END,
       CASE WHEN s.provider_session_id IS NULL THEN NULL ELSE 'resource' END,
       s.provider_session_id, 'migration_014_allocation',
       CASE WHEN s.provider_session_id IS NULL THEN NULL ELSE COALESCE(s.destroyed_at, s.updated_at) END
FROM agent_sandbox_sessions s;

CREATE OR REPLACE FUNCTION guard_agent_sandbox_attempt_fence_update() RETURNS TRIGGER AS $$
BEGIN
    IF ROW(NEW.owner_id, NEW.workspace_id, NEW.run_id, NEW.attempt_number, NEW.generation, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.owner_id, OLD.workspace_id, OLD.run_id, OLD.attempt_number, OLD.generation, OLD.created_at) THEN
        RAISE EXCEPTION 'Sandbox attempt fence identity is immutable';
    END IF;
    IF OLD.fenced_at IS NOT NULL AND NEW.fenced_at IS DISTINCT FROM OLD.fenced_at THEN
        RAISE EXCEPTION 'Sandbox attempt fence is terminal and cannot be cleared';
    END IF;
    IF OLD.fence_reason IS NOT NULL AND NEW.fence_reason IS DISTINCT FROM OLD.fence_reason THEN
        RAISE EXCEPTION 'Sandbox attempt fence reason is immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_sandbox_attempt_fence_update
    BEFORE UPDATE ON agent_sandbox_attempt_fences
    FOR EACH ROW EXECUTE FUNCTION guard_agent_sandbox_attempt_fence_update();

CREATE OR REPLACE FUNCTION guard_agent_sandbox_attempt_fence_delete() RETURNS TRIGGER AS $$
BEGIN
    IF pg_trigger_depth() <= 1 THEN
        RAISE EXCEPTION 'Sandbox attempt fences cannot be deleted directly';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_sandbox_attempt_fence_delete
    BEFORE DELETE ON agent_sandbox_attempt_fences
    FOR EACH ROW EXECUTE FUNCTION guard_agent_sandbox_attempt_fence_delete();

CREATE OR REPLACE FUNCTION guard_agent_sandbox_session_generation() RETURNS TRIGGER AS $$
DECLARE
    fence_row agent_sandbox_attempt_fences%ROWTYPE;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Consistent lock order for allocation admission and fencing: run, then attempt fence.
        PERFORM 1 FROM agent_runs
         WHERE owner_id = NEW.owner_id AND workspace_id = NEW.workspace_id AND id = NEW.run_id
         FOR UPDATE;
        SELECT * INTO fence_row FROM agent_sandbox_attempt_fences
         WHERE owner_id = NEW.owner_id AND workspace_id = NEW.workspace_id AND run_id = NEW.run_id
           AND attempt_number = NEW.attempt_number FOR UPDATE;
        IF NOT FOUND OR fence_row.generation <> NEW.attempt_generation OR fence_row.fenced_at IS NOT NULL THEN
            RAISE EXCEPTION 'Sandbox attempt is fenced or generation is invalid';
        END IF;
    ELSE
        IF NEW.attempt_generation IS DISTINCT FROM OLD.attempt_generation THEN
            RAISE EXCEPTION 'Sandbox attempt generation is immutable';
        END IF;
        IF NEW.lifecycle_state = 'active' THEN
            SELECT * INTO fence_row FROM agent_sandbox_attempt_fences
             WHERE owner_id = NEW.owner_id AND workspace_id = NEW.workspace_id AND run_id = NEW.run_id
               AND attempt_number = NEW.attempt_number AND generation = NEW.attempt_generation;
            IF NOT FOUND OR fence_row.fenced_at IS NOT NULL THEN
                RAISE EXCEPTION 'Fenced sandbox attempt cannot become active';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_sandbox_session_generation
    BEFORE INSERT OR UPDATE ON agent_sandbox_sessions
    FOR EACH ROW EXECUTE FUNCTION guard_agent_sandbox_session_generation();

CREATE OR REPLACE FUNCTION guard_agent_sandbox_operation() RETURNS TRIGGER AS $$
DECLARE
    fence_row agent_sandbox_attempt_fences%ROWTYPE;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Match the same lock order as attempt fencing, even for direct SQL inserts.
        PERFORM 1 FROM agent_runs
         WHERE owner_id = NEW.owner_id AND workspace_id = NEW.workspace_id AND id = NEW.run_id
         FOR UPDATE;
        SELECT * INTO fence_row FROM agent_sandbox_attempt_fences
         WHERE owner_id = NEW.owner_id AND workspace_id = NEW.workspace_id AND run_id = NEW.run_id
           AND attempt_number = NEW.attempt_number AND generation = NEW.generation FOR UPDATE;
        IF NOT FOUND OR fence_row.fenced_at IS NOT NULL THEN
            RAISE EXCEPTION 'Cannot start lifecycle work for a fenced sandbox attempt';
        END IF;
    ELSE
        IF ROW(NEW.id, NEW.session_id, NEW.owner_id, NEW.workspace_id, NEW.run_id, NEW.attempt_number,
               NEW.generation, NEW.operation_kind, NEW.created_at)
           IS DISTINCT FROM ROW(OLD.id, OLD.session_id, OLD.owner_id, OLD.workspace_id, OLD.run_id,
               OLD.attempt_number, OLD.generation, OLD.operation_kind, OLD.created_at) THEN
            RAISE EXCEPTION 'Sandbox lifecycle operation identity is immutable';
        END IF;
        IF OLD.state = 'settled' AND ROW(NEW.state, NEW.outcome, NEW.provider_resource_id, NEW.settled_at)
           IS DISTINCT FROM ROW(OLD.state, OLD.outcome, OLD.provider_resource_id, OLD.settled_at) THEN
            RAISE EXCEPTION 'Settled sandbox lifecycle operations are immutable';
        END IF;
        IF OLD.state = 'not_started' AND NEW.state = 'in_progress' THEN
            PERFORM 1 FROM agent_runs
             WHERE owner_id = NEW.owner_id AND workspace_id = NEW.workspace_id AND id = NEW.run_id
             FOR UPDATE;
            SELECT * INTO fence_row FROM agent_sandbox_attempt_fences
             WHERE owner_id = NEW.owner_id AND workspace_id = NEW.workspace_id AND run_id = NEW.run_id
               AND attempt_number = NEW.attempt_number AND generation = NEW.generation FOR UPDATE;
            IF NOT FOUND OR fence_row.fenced_at IS NOT NULL THEN
                RAISE EXCEPTION 'Cannot start lifecycle work for a fenced sandbox attempt';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_sandbox_operation
    BEFORE INSERT OR UPDATE ON agent_sandbox_lifecycle_operations
    FOR EACH ROW EXECUTE FUNCTION guard_agent_sandbox_operation();

CREATE OR REPLACE FUNCTION guard_agent_sandbox_operation_delete() RETURNS TRIGGER AS $$
BEGIN
    IF pg_trigger_depth() <= 1 THEN
        RAISE EXCEPTION 'Sandbox lifecycle operations cannot be deleted directly';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_sandbox_operation_delete
    BEFORE DELETE ON agent_sandbox_lifecycle_operations
    FOR EACH ROW EXECUTE FUNCTION guard_agent_sandbox_operation_delete();

-- Migration 015 established this runtime group and its default privileges. State the
-- required grants explicitly so the migration is robust when defaults differ.
GRANT SELECT, INSERT, UPDATE ON agent_sandbox_attempt_fences TO giga_api_runtime;
GRANT SELECT, INSERT, UPDATE ON agent_sandbox_lifecycle_operations TO giga_api_runtime;
REVOKE DELETE ON agent_sandbox_attempt_fences FROM giga_api_runtime;
REVOKE DELETE ON agent_sandbox_lifecycle_operations FROM giga_api_runtime;
