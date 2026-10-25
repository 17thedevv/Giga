-- Migration 015: durable, owner-scoped Agent execution quota reservations.
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
    IF OLD.state = 'reserved' AND NEW.state NOT IN ('reserved', 'active', 'released', 'reconciliation_required', 'committed') THEN
        RAISE EXCEPTION 'Invalid Agent quota reservation transition';
    END IF;
    IF OLD.state = 'active' AND NEW.state NOT IN ('active', 'reconciliation_required', 'committed') THEN
        RAISE EXCEPTION 'Invalid Agent quota reservation transition';
    END IF;
    IF OLD.state = 'reconciliation_required' AND NEW.state NOT IN ('reconciliation_required', 'committed', 'released') THEN
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
