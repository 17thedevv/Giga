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
        REFERENCES agent_sandbox_attempt_fences(owner_id, workspace_id, run_id, attempt_number, generation) ON DELETE CASCADE,
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
        -- 1. Identity columns are strictly immutable
        IF ROW(NEW.id, NEW.session_id, NEW.owner_id, NEW.workspace_id, NEW.run_id, NEW.attempt_number,
               NEW.generation, NEW.operation_kind, NEW.created_at)
           IS DISTINCT FROM ROW(OLD.id, OLD.session_id, OLD.owner_id, OLD.workspace_id, OLD.run_id,
               OLD.attempt_number, OLD.generation, OLD.operation_kind, OLD.created_at) THEN
            RAISE EXCEPTION 'Sandbox lifecycle operation identity is immutable';
        END IF;

        -- 2. Settled operations are terminal and immutable
        IF OLD.state = 'settled' THEN
            IF ROW(NEW.state, NEW.outcome, NEW.provider_resource_id, NEW.settled_at)
               IS DISTINCT FROM ROW(OLD.state, OLD.outcome, OLD.provider_resource_id, OLD.settled_at) THEN
                RAISE EXCEPTION 'Settled sandbox lifecycle operations are immutable';
            END IF;
            RETURN NEW;
        END IF;

        -- 3. Explicit Operation-State Transition Matrix
        IF OLD.operation_kind = 'allocation' THEN
            IF OLD.state = 'not_started' THEN
                IF NEW.state = 'in_progress' THEN
                    PERFORM 1 FROM agent_runs
                     WHERE owner_id = NEW.owner_id AND workspace_id = NEW.workspace_id AND id = NEW.run_id
                     FOR UPDATE;
                    SELECT * INTO fence_row FROM agent_sandbox_attempt_fences
                     WHERE owner_id = NEW.owner_id AND workspace_id = NEW.workspace_id AND run_id = NEW.run_id
                       AND attempt_number = NEW.attempt_number AND generation = NEW.generation FOR UPDATE;
                    IF NOT FOUND OR fence_row.fenced_at IS NOT NULL THEN
                        RAISE EXCEPTION 'Cannot start lifecycle work for a fenced sandbox attempt';
                    END IF;
                    IF NEW.outcome IS NOT NULL OR NEW.provider_resource_id IS NOT NULL OR NEW.settled_at IS NOT NULL THEN
                        RAISE EXCEPTION 'In-progress allocation must not specify outcome or settled_at';
                    END IF;
                ELSIF NEW.state = 'settled' THEN
                    IF NEW.outcome = 'no_resource' THEN
                        -- Legitimate transition: never-started allocation settled as no_resource ONLY if durably fenced
                        SELECT * INTO fence_row FROM agent_sandbox_attempt_fences
                         WHERE owner_id = NEW.owner_id AND workspace_id = NEW.workspace_id AND run_id = NEW.run_id
                           AND attempt_number = NEW.attempt_number AND generation = NEW.generation;
                        IF NOT FOUND OR fence_row.fenced_at IS NULL THEN
                            RAISE EXCEPTION 'Cannot settle never-started allocation as no_resource before attempt is durably fenced';
                        END IF;
                        IF NEW.provider_resource_id IS NOT NULL THEN
                            RAISE EXCEPTION 'Allocation with no_resource outcome cannot specify provider resource id';
                        END IF;
                        IF NEW.settled_at IS NULL THEN
                            NEW.settled_at = NOW();
                        END IF;
                    ELSIF NEW.outcome = 'resource' THEN
                        IF NEW.provider_resource_id IS NULL THEN
                            RAISE EXCEPTION 'Settled allocation with resource outcome requires provider resource id';
                        END IF;
                        IF NEW.settled_at IS NULL THEN
                            NEW.settled_at = NOW();
                        END IF;
                    ELSE
                        RAISE EXCEPTION 'Settled allocation requires valid outcome';
                    END IF;
                ELSE
                    RAISE EXCEPTION 'Invalid allocation state transition from not_started to %', NEW.state;
                END IF;

            ELSIF OLD.state = 'in_progress' THEN
                IF NEW.state = 'ambiguous' THEN
                    IF NEW.outcome IS NOT NULL THEN
                        RAISE EXCEPTION 'Ambiguous allocation must not specify outcome';
                    END IF;
                ELSIF NEW.state = 'settled' THEN
                    IF NEW.outcome = 'resource' THEN
                        IF NEW.provider_resource_id IS NULL THEN
                            RAISE EXCEPTION 'Settled allocation with resource outcome requires provider resource id';
                        END IF;
                        IF NEW.settled_at IS NULL THEN
                            NEW.settled_at = NOW();
                        END IF;
                    ELSIF NEW.outcome = 'no_resource' THEN
                        RAISE EXCEPTION 'In-progress allocation cannot be settled as no_resource';
                    ELSE
                        RAISE EXCEPTION 'Settled allocation requires valid outcome';
                    END IF;
                ELSE
                    RAISE EXCEPTION 'Invalid allocation state transition from in_progress to %', NEW.state;
                END IF;

            ELSIF OLD.state = 'ambiguous' THEN
                IF NEW.state = 'settled' THEN
                    IF NEW.outcome = 'resource' THEN
                        IF NEW.provider_resource_id IS NULL THEN
                            RAISE EXCEPTION 'Settled allocation with resource outcome requires provider resource id';
                        END IF;
                        IF NEW.settled_at IS NULL THEN
                            NEW.settled_at = NOW();
                        END IF;
                    ELSIF NEW.outcome = 'no_resource' THEN
                        RAISE EXCEPTION 'Ambiguous allocation cannot be settled as no_resource';
                    ELSE
                        RAISE EXCEPTION 'Settled allocation requires valid outcome';
                    END IF;
                ELSE
                    RAISE EXCEPTION 'Invalid allocation state transition from ambiguous to %', NEW.state;
                END IF;
            END IF;

        ELSIF OLD.operation_kind IN ('tool', 'snapshot') THEN
            IF OLD.state = 'in_progress' THEN
                IF NEW.state = 'ambiguous' THEN
                    -- Ambiguous runtime operation allowed
                ELSIF NEW.state = 'settled' THEN
                    IF NEW.settled_at IS NULL THEN
                        NEW.settled_at = NOW();
                    END IF;
                ELSE
                    RAISE EXCEPTION 'Invalid runtime operation transition from in_progress to %', NEW.state;
                END IF;
            ELSIF OLD.state = 'ambiguous' THEN
                IF NEW.state = 'settled' THEN
                    IF NEW.settled_at IS NULL THEN
                        NEW.settled_at = NOW();
                    END IF;
                ELSE
                    RAISE EXCEPTION 'Invalid runtime operation transition from ambiguous to %', NEW.state;
                END IF;
            ELSE
                RAISE EXCEPTION 'Invalid runtime operation state %', OLD.state;
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

-- Replace guard_agent_sandbox_session_update to enforce lifecycle integrity on sandbox destruction
CREATE OR REPLACE FUNCTION guard_agent_sandbox_session_update() RETURNS TRIGGER AS $$
BEGIN
    -- 1. Identity columns are strictly immutable
    IF ROW(NEW.id, NEW.owner_id, NEW.workspace_id, NEW.run_id, NEW.attempt_number,
           NEW.allocation_intent_id, NEW.attempt_generation, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.owner_id, OLD.workspace_id, OLD.run_id, OLD.attempt_number,
           OLD.allocation_intent_id, OLD.attempt_generation, OLD.created_at) THEN
        RAISE EXCEPTION 'Sandbox session identity is immutable';
    END IF;

    -- 2. Terminal destroyed state: non-revival and immutability
    IF OLD.lifecycle_state = 'destroyed' THEN
        IF NEW.lifecycle_state <> 'destroyed' THEN
            RAISE EXCEPTION 'Destroyed sandbox session is terminal and immutable';
        END IF;
        IF NEW.destroyed_at IS DISTINCT FROM OLD.destroyed_at THEN
            RAISE EXCEPTION 'Destroyed sandbox session destroyed_at timestamp cannot be modified';
        END IF;
        IF NEW.provider_session_id IS DISTINCT FROM OLD.provider_session_id THEN
            RAISE EXCEPTION 'Destroyed sandbox session provider_session_id cannot be modified';
        END IF;
    END IF;

    -- 3. Transition into 'destroying' requires active cleanup lease
    IF NEW.lifecycle_state = 'destroying' AND OLD.lifecycle_state <> 'destroying' THEN
        IF NEW.cleanup_state <> 'in_progress' OR NEW.cleanup_lease_expires_at IS NULL OR NEW.cleanup_lease_expires_at <= NOW() THEN
            RAISE EXCEPTION 'Transition to destroying requires active cleanup lease';
        END IF;
    END IF;

    -- 4. Transition into 'destroyed' requires verified invariants
    IF NEW.lifecycle_state = 'destroyed' AND OLD.lifecycle_state <> 'destroyed' THEN
        -- 4a. Old state must be 'destroying'
        IF OLD.lifecycle_state NOT IN ('destroying', 'stopping') THEN
            RAISE EXCEPTION 'Direct transition to destroyed is forbidden from state %', OLD.lifecycle_state;
        END IF;

        -- 4b. Active cleanup lease must not be expired if in_progress
        IF OLD.cleanup_state = 'in_progress' AND OLD.cleanup_lease_expires_at IS NOT NULL AND OLD.cleanup_lease_expires_at <= NOW() THEN
            RAISE EXCEPTION 'Cannot destroy sandbox session with expired cleanup lease';
        END IF;

        -- 4c. Provider session ID required and cannot mismatch
        IF NEW.provider_session_id IS NULL THEN
            RAISE EXCEPTION 'Cannot destroy sandbox session without provider_session_id';
        END IF;
        IF OLD.provider_session_id IS NOT NULL AND NEW.provider_session_id <> OLD.provider_session_id THEN
            RAISE EXCEPTION 'Provider session ID mismatch during destruction';
        END IF;

        -- 4d. Matching settled allocation operation with outcome = 'resource'
        PERFORM 1 FROM agent_sandbox_lifecycle_operations
         WHERE session_id = NEW.id
           AND owner_id = NEW.owner_id
           AND workspace_id = NEW.workspace_id
           AND run_id = NEW.run_id
           AND attempt_number = NEW.attempt_number
           AND generation = NEW.attempt_generation
           AND operation_kind = 'allocation'
           AND state = 'settled'
           AND outcome = 'resource'
           AND provider_resource_id = NEW.provider_session_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Sandbox destruction requires a verified settled allocation operation with matching provider resource ID';
        END IF;

        -- 4e. Completed cleanup conditions
        IF NEW.cleanup_state <> 'completed' OR NEW.cleanup_lease_token IS NOT NULL OR NEW.cleanup_lease_expires_at IS NOT NULL THEN
            RAISE EXCEPTION 'Destroyed session must have completed cleanup and cleared cleanup lease';
        END IF;

        -- 4f. Populate destroyed_at
        IF NEW.destroyed_at IS NULL THEN
            NEW.destroyed_at = NOW();
        END IF;
    END IF;

    -- Automatic timestamp update
    NEW.updated_at = GREATEST(NOW(), OLD.updated_at);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_sandbox_session_update ON agent_sandbox_sessions;
CREATE TRIGGER trg_agent_sandbox_session_update
    BEFORE UPDATE ON agent_sandbox_sessions
    FOR EACH ROW EXECUTE FUNCTION guard_agent_sandbox_session_update();

-- Reassess privileges: Revoke blanket permissions and apply least-privilege column grants for giga_api_runtime
REVOKE ALL PRIVILEGES ON agent_sandbox_sessions FROM giga_api_runtime;
GRANT SELECT, INSERT ON agent_sandbox_sessions TO giga_api_runtime;
GRANT UPDATE (
    provider_session_id, lifecycle_state, allocation_state, cleanup_state,
    worker_id, lease_token, cleanup_attempts, next_cleanup_retry_at,
    cleanup_lease_token, cleanup_lease_expires_at, cleanup_worker_id,
    allocation_expires_at, updated_at, destroyed_at, diagnostics, verified_checks
) ON agent_sandbox_sessions TO giga_api_runtime;
REVOKE DELETE, TRUNCATE ON agent_sandbox_sessions FROM giga_api_runtime;

REVOKE ALL PRIVILEGES ON agent_sandbox_lifecycle_operations FROM giga_api_runtime;
GRANT SELECT, INSERT ON agent_sandbox_lifecycle_operations TO giga_api_runtime;
GRANT UPDATE (state, outcome, provider_resource_id, operation_name, settled_at) ON agent_sandbox_lifecycle_operations TO giga_api_runtime;
REVOKE DELETE, TRUNCATE ON agent_sandbox_lifecycle_operations FROM giga_api_runtime;

REVOKE ALL PRIVILEGES ON agent_sandbox_attempt_fences FROM giga_api_runtime;
GRANT SELECT, INSERT ON agent_sandbox_attempt_fences TO giga_api_runtime;
GRANT UPDATE (fenced_at, fence_reason) ON agent_sandbox_attempt_fences TO giga_api_runtime;
REVOKE DELETE, TRUNCATE ON agent_sandbox_attempt_fences FROM giga_api_runtime;
