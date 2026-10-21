-- Migration 014: Durable PostgreSQL Sandbox Session Registry & Crash-Safe Cleanup Reconciliation
-- Establishes durable session ownership, attempt fencing, lifecycle states, and cleanup scheduling.

CREATE TABLE IF NOT EXISTS agent_sandbox_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL,
    run_id UUID NOT NULL,
    attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number > 0),
    mode VARCHAR(10) NOT NULL CHECK (mode IN ('ask', 'plan', 'execute')),
    provider_type VARCHAR(32) NOT NULL,
    provider_session_id VARCHAR(128),
    lifecycle_state VARCHAR(32) NOT NULL CHECK (lifecycle_state IN (
        'allocating', 'active', 'stopping', 'destroying', 'destroyed', 'cleanup_pending', 'failed'
    )),
    allocation_state VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (allocation_state IN (
        'pending', 'allocated', 'failed', 'timed_out', 'aborted'
    )),
    cleanup_state VARCHAR(32) NOT NULL DEFAULT 'none' CHECK (cleanup_state IN (
        'none', 'pending', 'retry_scheduled', 'in_progress', 'completed', 'failed'
    )),
    worker_id VARCHAR(128) NOT NULL,
    lease_token VARCHAR(128) NOT NULL,
    allocation_intent_id UUID NOT NULL DEFAULT gen_random_uuid(),
    cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0),
    next_cleanup_retry_at TIMESTAMPTZ,
    cleanup_lease_token VARCHAR(128),
    cleanup_lease_expires_at TIMESTAMPTZ,
    cleanup_worker_id VARCHAR(128),
    allocation_expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    destroyed_at TIMESTAMPTZ,
    diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
    verified_checks JSONB,
    UNIQUE (owner_id, id),
    UNIQUE (run_id, attempt_number),
    FOREIGN KEY (owner_id, workspace_id, run_id) REFERENCES agent_runs(owner_id, workspace_id, id) ON DELETE CASCADE,
    CHECK (updated_at >= created_at),
    CHECK ((lifecycle_state = 'destroyed') = (destroyed_at IS NOT NULL)),
    CHECK (destroyed_at IS NULL OR destroyed_at >= created_at)
);

-- Fast lookup indexes
CREATE INDEX IF NOT EXISTS idx_agent_sandbox_sessions_run ON agent_sandbox_sessions (owner_id, workspace_id, run_id);
CREATE INDEX IF NOT EXISTS idx_agent_sandbox_sessions_cleanup ON agent_sandbox_sessions (lifecycle_state, cleanup_state, next_cleanup_retry_at);
CREATE INDEX IF NOT EXISTS idx_agent_sandbox_provider_id ON agent_sandbox_sessions (provider_session_id) WHERE provider_session_id IS NOT NULL;

-- Strict Invariant: Exactly one non-terminal session (where a provider sandbox may still exist) per run
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_sandbox_single_active ON agent_sandbox_sessions (run_id)
    WHERE lifecycle_state IN ('allocating', 'active', 'stopping', 'destroying', 'cleanup_pending');

-- Immutability and State Transition Guard Triggers
CREATE OR REPLACE FUNCTION guard_agent_sandbox_session_update() RETURNS TRIGGER AS $$
BEGIN
    -- Terminal non-revival: once destroyed, lifecycle_state cannot be changed
    IF OLD.lifecycle_state = 'destroyed' AND NEW.lifecycle_state <> 'destroyed' THEN
        RAISE EXCEPTION 'Destroyed sandbox session is terminal and immutable';
    END IF;

    -- If already destroyed, preserve original destroyed_at timestamp
    IF OLD.lifecycle_state = 'destroyed' THEN
        NEW.destroyed_at = OLD.destroyed_at;
    END IF;

    -- Identity columns cannot be altered
    IF ROW(NEW.id, NEW.owner_id, NEW.workspace_id, NEW.run_id, NEW.attempt_number, NEW.allocation_intent_id, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.owner_id, OLD.workspace_id, OLD.run_id, OLD.attempt_number, OLD.allocation_intent_id, OLD.created_at) THEN
        RAISE EXCEPTION 'Sandbox session identity is immutable';
    END IF;

    -- Automatic timestamp update
    NEW.updated_at = GREATEST(NOW(), OLD.updated_at);

    -- Ensure destroyed_at is populated when transitioning to destroyed
    IF NEW.lifecycle_state = 'destroyed' AND NEW.destroyed_at IS NULL THEN
        NEW.destroyed_at = NOW();
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_sandbox_session_update ON agent_sandbox_sessions;
CREATE TRIGGER trg_agent_sandbox_session_update BEFORE UPDATE ON agent_sandbox_sessions
    FOR EACH ROW EXECUTE FUNCTION guard_agent_sandbox_session_update();

-- Guard against direct deletes to preserve durable tombstones and audit trail
CREATE OR REPLACE FUNCTION guard_agent_sandbox_session_delete() RETURNS TRIGGER AS $$
BEGIN
    IF pg_trigger_depth() <= 1 THEN
        RAISE EXCEPTION 'Sandbox sessions cannot be deleted directly (tombstone preservation required)';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_sandbox_session_delete ON agent_sandbox_sessions;
CREATE TRIGGER trg_agent_sandbox_session_delete BEFORE DELETE ON agent_sandbox_sessions
    FOR EACH ROW EXECUTE FUNCTION guard_agent_sandbox_session_delete();
