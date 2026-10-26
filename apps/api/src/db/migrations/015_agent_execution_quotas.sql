-- Migration 015: durable, owner-scoped Agent execution quota reservations.
-- Version 014 is reserved for the independent sandbox-session lifecycle change.

-- The application login is not an owner of quota tables. Migrations run with a
-- separate privileged MIGRATION_DATABASE_URL; its login becomes a member of the
-- NOLOGIN owner role. Grant giga_api_runtime to the API login and reserve
-- giga_agent_quota_finalizer for the post-fence finalization connection.
DO $$
DECLARE
    migration_login NAME := current_user;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'giga_agent_quota_owner') THEN
        EXECUTE 'CREATE ROLE giga_agent_quota_owner NOLOGIN NOINHERIT';
    ELSIF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'giga_agent_quota_owner') THEN
        RAISE EXCEPTION 'giga_agent_quota_owner must be a NOLOGIN role';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'giga_api_runtime') THEN
        EXECUTE 'CREATE ROLE giga_api_runtime NOLOGIN NOINHERIT';
    ELSIF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'giga_api_runtime') THEN
        RAISE EXCEPTION 'giga_api_runtime must be a NOLOGIN role';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'giga_agent_quota_finalizer') THEN
        EXECUTE 'CREATE ROLE giga_agent_quota_finalizer NOLOGIN NOINHERIT';
    ELSIF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'giga_agent_quota_finalizer') THEN
        RAISE EXCEPTION 'giga_agent_quota_finalizer must be a NOLOGIN role';
    END IF;
    EXECUTE format('GRANT giga_agent_quota_owner TO %I', migration_login);
END;
$$;

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
    reconciliation_event_key VARCHAR(128),

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
    CHECK (state NOT IN ('active', 'reconciliation_required') OR started_at IS NOT NULL),
    CHECK (started_at IS NULL OR started_at >= created_at),
    CHECK (NOT resource_active OR state = 'reserved' OR started_at IS NOT NULL),
    CHECK (reconciliation_event_key IS NULL OR (
        char_length(reconciliation_event_key) BETWEEN 1 AND 128 AND state = 'committed' AND
        resource_active = FALSE AND finished_at IS NOT NULL
    )),
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

CREATE OR REPLACE FUNCTION guard_agent_execution_usage_event_insert() RETURNS TRIGGER AS $$
DECLARE
    reservation_row agent_execution_reservations%ROWTYPE;
BEGIN
    SELECT * INTO reservation_row
    FROM agent_execution_reservations
    WHERE id = NEW.reservation_id
    FOR UPDATE;
    IF reservation_row.reconciliation_event_key IS NOT NULL THEN
        RAISE EXCEPTION 'Finalized Agent quota reservation cannot accept usage events';
    END IF;
    IF NEW.event_kind = 'reconciled' THEN
        IF current_user <> 'giga_agent_quota_owner' THEN
            RAISE EXCEPTION 'Reconciliation audit events require the controlled finalization operation';
        END IF;
        IF reservation_row.state <> 'committed' OR NOT reservation_row.resource_active OR
           reservation_row.finished_at IS NULL THEN
            RAISE EXCEPTION 'Reconciliation audit event does not match a held committed reservation';
        END IF;
        IF ROW(
            NEW.sandbox_runtime_ms, NEW.wall_clock_ms, NEW.tool_calls, NEW.provider_requests,
            NEW.command_output_bytes, NEW.artifact_bytes, NEW.workspace_disk_bytes, NEW.workspace_file_count
        ) IS DISTINCT FROM ROW(
            reservation_row.actual_sandbox_runtime_ms, reservation_row.actual_wall_clock_ms,
            reservation_row.actual_tool_calls, reservation_row.actual_provider_requests,
            reservation_row.actual_command_output_bytes, reservation_row.actual_artifact_bytes,
            reservation_row.actual_workspace_disk_bytes, reservation_row.actual_workspace_file_count
        ) OR ROW(
            reservation_row.actual_sandbox_runtime_ms, reservation_row.actual_wall_clock_ms,
            reservation_row.actual_tool_calls, reservation_row.actual_provider_requests,
            reservation_row.actual_command_output_bytes, reservation_row.actual_artifact_bytes,
            reservation_row.actual_workspace_disk_bytes, reservation_row.actual_workspace_file_count
        ) IS DISTINCT FROM ROW(
            reservation_row.accounted_sandbox_runtime_ms, reservation_row.accounted_wall_clock_ms,
            reservation_row.accounted_tool_calls, reservation_row.accounted_provider_requests,
            reservation_row.accounted_command_output_bytes, reservation_row.accounted_artifact_bytes,
            reservation_row.accounted_workspace_disk_bytes, reservation_row.accounted_workspace_file_count
        ) THEN
            RAISE EXCEPTION 'Reconciliation audit measurements do not match reservation accounting';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_execution_usage_event_insert
    BEFORE INSERT ON agent_execution_usage_events
    FOR EACH ROW EXECUTE FUNCTION guard_agent_execution_usage_event_insert();

CREATE OR REPLACE FUNCTION guard_agent_execution_reservation_update() RETURNS TRIGGER AS $$
DECLARE
    has_reconciliation_event BOOLEAN;
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
    IF OLD.started_at IS NULL AND NEW.started_at IS NOT NULL THEN
        IF OLD.state <> 'reserved' OR NEW.state <> 'active' THEN
            RAISE EXCEPTION 'Agent execution start timestamp may only be set when allocation starts';
        END IF;
        NEW.started_at = clock_timestamp();
    ELSIF OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
        RAISE EXCEPTION 'Agent execution start timestamp is immutable';
    END IF;
    IF NEW.actual_wall_clock_ms < OLD.actual_wall_clock_ms THEN
        RAISE EXCEPTION 'Agent actual wall-clock usage cannot decrease';
    END IF;
    IF OLD.reconciliation_event_key IS NOT NULL AND ROW(
        NEW.reconciliation_event_key, NEW.state, NEW.resource_active, NEW.finished_at,
        NEW.actual_sandbox_runtime_ms, NEW.actual_wall_clock_ms, NEW.actual_tool_calls,
        NEW.actual_provider_requests, NEW.actual_command_output_bytes, NEW.actual_artifact_bytes,
        NEW.actual_workspace_disk_bytes, NEW.actual_workspace_file_count,
        NEW.accounted_sandbox_runtime_ms, NEW.accounted_wall_clock_ms, NEW.accounted_tool_calls,
        NEW.accounted_provider_requests, NEW.accounted_command_output_bytes, NEW.accounted_artifact_bytes,
        NEW.accounted_workspace_disk_bytes, NEW.accounted_workspace_file_count
    ) IS DISTINCT FROM ROW(
        OLD.reconciliation_event_key, OLD.state, OLD.resource_active, OLD.finished_at,
        OLD.actual_sandbox_runtime_ms, OLD.actual_wall_clock_ms, OLD.actual_tool_calls,
        OLD.actual_provider_requests, OLD.actual_command_output_bytes, OLD.actual_artifact_bytes,
        OLD.actual_workspace_disk_bytes, OLD.actual_workspace_file_count,
        OLD.accounted_sandbox_runtime_ms, OLD.accounted_wall_clock_ms, OLD.accounted_tool_calls,
        OLD.accounted_provider_requests, OLD.accounted_command_output_bytes, OLD.accounted_artifact_bytes,
        OLD.accounted_workspace_disk_bytes, OLD.accounted_workspace_file_count
    ) THEN
        RAISE EXCEPTION 'Finalized Agent quota accounting is immutable';
    END IF;
    IF OLD.resource_active = TRUE AND NEW.resource_active = FALSE AND
       NEW.state = 'committed' AND NEW.reconciliation_event_key IS NULL THEN
        RAISE EXCEPTION 'Committed Agent quota capacity release requires reconciliation finalization';
    END IF;
    IF OLD.reconciliation_event_key IS NULL AND NEW.reconciliation_event_key IS NOT NULL THEN
        IF current_user <> 'giga_agent_quota_owner' THEN
            RAISE EXCEPTION 'Agent quota reconciliation finalization requires the controlled database operation';
        END IF;
        IF NEW.state <> 'committed' OR NEW.resource_active OR NEW.finished_at IS NULL THEN
            RAISE EXCEPTION 'Agent quota reconciliation finalization has an invalid state';
        END IF;
        SELECT EXISTS (
            SELECT 1 FROM agent_execution_usage_events
            WHERE reservation_id = NEW.id AND event_key = NEW.reconciliation_event_key
              AND event_kind = 'reconciled'
              AND sandbox_runtime_ms = NEW.actual_sandbox_runtime_ms
              AND wall_clock_ms = NEW.actual_wall_clock_ms
              AND tool_calls = NEW.actual_tool_calls
              AND provider_requests = NEW.actual_provider_requests
              AND command_output_bytes = NEW.actual_command_output_bytes
              AND artifact_bytes = NEW.actual_artifact_bytes
              AND workspace_disk_bytes = NEW.actual_workspace_disk_bytes
              AND workspace_file_count = NEW.actual_workspace_file_count
              AND ROW(
                  NEW.actual_sandbox_runtime_ms, NEW.actual_wall_clock_ms, NEW.actual_tool_calls,
                  NEW.actual_provider_requests, NEW.actual_command_output_bytes, NEW.actual_artifact_bytes,
                  NEW.actual_workspace_disk_bytes, NEW.actual_workspace_file_count
              ) IS NOT DISTINCT FROM ROW(
                  NEW.accounted_sandbox_runtime_ms, NEW.accounted_wall_clock_ms, NEW.accounted_tool_calls,
                  NEW.accounted_provider_requests, NEW.accounted_command_output_bytes, NEW.accounted_artifact_bytes,
                  NEW.accounted_workspace_disk_bytes, NEW.accounted_workspace_file_count
              )
        ) INTO has_reconciliation_event;
        IF NOT has_reconciliation_event THEN
            RAISE EXCEPTION 'Agent quota reconciliation finalization requires a matching audit event and accounting';
        END IF;
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

-- This SECURITY DEFINER operation is the only application path that can create
-- a reconciled event and release committed writable capacity. It stages the
-- final accounting, inserts its matching audit event, and releases the slot in
-- one transaction. The API role cannot write the marker or reconciled events.
DO $finalizer$
DECLARE
    quota_schema TEXT := current_schema();
BEGIN
    EXECUTE format($function$
        CREATE OR REPLACE FUNCTION %I.finalize_agent_execution_reconciliation(
            p_reservation_id UUID,
            p_event_key VARCHAR,
            p_request_fingerprint CHAR(64),
            p_sandbox_runtime_ms BIGINT,
            p_wall_clock_ms BIGINT,
            p_tool_calls BIGINT,
            p_provider_requests BIGINT,
            p_command_output_bytes BIGINT,
            p_artifact_bytes BIGINT,
            p_workspace_disk_bytes BIGINT,
            p_workspace_file_count BIGINT,
            p_limit_exceeded BOOLEAN
        ) RETURNS VOID
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, %I
        AS $body$
        DECLARE
            reservation_row agent_execution_reservations%%ROWTYPE;
            existing_event agent_execution_usage_events%%ROWTYPE;
        BEGIN
            IF p_event_key IS NULL OR char_length(p_event_key) NOT BETWEEN 1 AND 128 OR
               p_request_fingerprint IS NULL OR p_request_fingerprint::TEXT !~ '^[0-9a-f]{64}$' THEN
                RAISE EXCEPTION 'Invalid Agent quota reconciliation identity';
            END IF;
            SELECT * INTO reservation_row
            FROM agent_execution_reservations
            WHERE id = p_reservation_id
            FOR UPDATE;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Agent quota reservation does not exist';
            END IF;

            IF reservation_row.reconciliation_event_key IS NOT NULL THEN
                SELECT * INTO existing_event
                FROM agent_execution_usage_events
                WHERE reservation_id = p_reservation_id
                  AND event_key = reservation_row.reconciliation_event_key;
                IF reservation_row.reconciliation_event_key = p_event_key AND
                   existing_event.event_kind = 'reconciled' AND
                   existing_event.request_fingerprint = p_request_fingerprint AND
                   ROW(
                       existing_event.sandbox_runtime_ms, existing_event.wall_clock_ms,
                       existing_event.tool_calls, existing_event.provider_requests,
                       existing_event.command_output_bytes, existing_event.artifact_bytes,
                       existing_event.workspace_disk_bytes, existing_event.workspace_file_count,
                       existing_event.limit_exceeded
                   ) IS NOT DISTINCT FROM ROW(
                       p_sandbox_runtime_ms, p_wall_clock_ms, p_tool_calls, p_provider_requests,
                       p_command_output_bytes, p_artifact_bytes, p_workspace_disk_bytes,
                       p_workspace_file_count, p_limit_exceeded
                   ) AND ROW(
                       reservation_row.actual_sandbox_runtime_ms, reservation_row.actual_wall_clock_ms,
                       reservation_row.actual_tool_calls, reservation_row.actual_provider_requests,
                       reservation_row.actual_command_output_bytes, reservation_row.actual_artifact_bytes,
                       reservation_row.actual_workspace_disk_bytes, reservation_row.actual_workspace_file_count
                   ) IS NOT DISTINCT FROM ROW(
                       p_sandbox_runtime_ms, p_wall_clock_ms, p_tool_calls, p_provider_requests,
                       p_command_output_bytes, p_artifact_bytes, p_workspace_disk_bytes, p_workspace_file_count
                   ) AND ROW(
                       reservation_row.accounted_sandbox_runtime_ms, reservation_row.accounted_wall_clock_ms,
                       reservation_row.accounted_tool_calls, reservation_row.accounted_provider_requests,
                       reservation_row.accounted_command_output_bytes, reservation_row.accounted_artifact_bytes,
                       reservation_row.accounted_workspace_disk_bytes, reservation_row.accounted_workspace_file_count
                   ) IS NOT DISTINCT FROM ROW(
                       p_sandbox_runtime_ms, p_wall_clock_ms, p_tool_calls, p_provider_requests,
                       p_command_output_bytes, p_artifact_bytes, p_workspace_disk_bytes, p_workspace_file_count
                   ) THEN
                    RETURN;
                END IF;
                RAISE EXCEPTION 'Agent quota reconciliation is already finalized with another request';
            END IF;

            IF reservation_row.state NOT IN ('reconciliation_required', 'committed') OR
               NOT reservation_row.resource_active THEN
                RAISE EXCEPTION 'Agent quota reservation is not held for reconciliation';
            END IF;

            UPDATE agent_execution_reservations SET
                state = 'committed',
                finished_at = COALESCE(finished_at, clock_timestamp()),
                actual_sandbox_runtime_ms = p_sandbox_runtime_ms,
                actual_wall_clock_ms = p_wall_clock_ms,
                actual_tool_calls = p_tool_calls,
                actual_provider_requests = p_provider_requests,
                actual_command_output_bytes = p_command_output_bytes,
                actual_artifact_bytes = p_artifact_bytes,
                actual_workspace_disk_bytes = p_workspace_disk_bytes,
                actual_workspace_file_count = p_workspace_file_count,
                accounted_sandbox_runtime_ms = p_sandbox_runtime_ms,
                accounted_wall_clock_ms = p_wall_clock_ms,
                accounted_tool_calls = p_tool_calls,
                accounted_provider_requests = p_provider_requests,
                accounted_command_output_bytes = p_command_output_bytes,
                accounted_artifact_bytes = p_artifact_bytes,
                accounted_workspace_disk_bytes = p_workspace_disk_bytes,
                accounted_workspace_file_count = p_workspace_file_count
            WHERE id = p_reservation_id;

            INSERT INTO agent_execution_usage_events (
                reservation_id, owner_id, workspace_id, run_id, attempt_number,
                event_key, event_kind, request_fingerprint,
                sandbox_runtime_ms, wall_clock_ms, tool_calls, provider_requests,
                command_output_bytes, artifact_bytes, workspace_disk_bytes, workspace_file_count,
                limit_exceeded
            ) VALUES (
                reservation_row.id, reservation_row.owner_id, reservation_row.workspace_id,
                reservation_row.run_id, reservation_row.attempt_number,
                p_event_key, 'reconciled', p_request_fingerprint,
                p_sandbox_runtime_ms, p_wall_clock_ms, p_tool_calls, p_provider_requests,
                p_command_output_bytes, p_artifact_bytes, p_workspace_disk_bytes, p_workspace_file_count,
                p_limit_exceeded
            );

            UPDATE agent_execution_reservations SET
                resource_active = FALSE,
                reconciliation_event_key = p_event_key
            WHERE id = p_reservation_id;
        END;
        $body$
    $function$, quota_schema, quota_schema);
END;
$finalizer$;

-- Establish the actual privilege boundary. The application group retains the
-- API's pre-existing table access, then receives only the quota columns and
-- operations needed by AgentQuotaService. It cannot insert reconciliation
-- events or update reconciliation_event_key.
DO $quota_privileges$
DECLARE
    quota_schema TEXT := current_schema();
    migration_login NAME := current_user;
BEGIN
    EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO giga_agent_quota_owner', quota_schema);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO giga_api_runtime', quota_schema);
    EXECUTE format('GRANT SELECT ON %I.agent_runs TO giga_agent_quota_owner', quota_schema);
    EXECUTE format('GRANT UPDATE (updated_at) ON %I.agent_runs TO giga_agent_quota_owner', quota_schema);

    EXECUTE format('ALTER TABLE %I.agent_execution_reservations OWNER TO giga_agent_quota_owner', quota_schema);
    EXECUTE format('ALTER TABLE %I.agent_execution_usage_events OWNER TO giga_agent_quota_owner', quota_schema);
    EXECUTE format('ALTER FUNCTION %I.finalize_agent_execution_reconciliation(uuid, character varying, character, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean) OWNER TO giga_agent_quota_owner', quota_schema);

    EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I TO giga_api_runtime', quota_schema);
    EXECUTE format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I TO giga_api_runtime', quota_schema);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT ALL PRIVILEGES ON TABLES TO giga_api_runtime', migration_login, quota_schema);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT ALL PRIVILEGES ON SEQUENCES TO giga_api_runtime', migration_login, quota_schema);

    EXECUTE format('REVOKE ALL PRIVILEGES ON %I.agent_execution_reservations FROM giga_api_runtime', quota_schema);
    EXECUTE format('REVOKE ALL PRIVILEGES ON %I.agent_execution_usage_events FROM giga_api_runtime', quota_schema);
    EXECUTE format('GRANT SELECT ON %I.agent_execution_reservations TO giga_api_runtime', quota_schema);
    EXECUTE format('GRANT SELECT ON %I.agent_execution_usage_events TO giga_api_runtime', quota_schema);
    EXECUTE format('GRANT INSERT (owner_id, workspace_id, run_id, attempt_number, mode, state, resource_active, writable, policy_version, lease_token_hash, max_sandbox_runtime_ms, max_wall_clock_ms, max_tool_calls, max_provider_requests, max_command_output_bytes, max_artifact_bytes, max_workspace_disk_bytes, max_workspace_file_count, accounted_sandbox_runtime_ms, accounted_wall_clock_ms, accounted_tool_calls, accounted_provider_requests, accounted_command_output_bytes, accounted_artifact_bytes, accounted_workspace_disk_bytes, accounted_workspace_file_count) ON %I.agent_execution_reservations TO giga_api_runtime', quota_schema);
    EXECUTE format('GRANT UPDATE (state, resource_active, updated_at, started_at, finished_at, actual_sandbox_runtime_ms, actual_wall_clock_ms, actual_tool_calls, actual_provider_requests, actual_command_output_bytes, actual_artifact_bytes, actual_workspace_disk_bytes, actual_workspace_file_count, accounted_sandbox_runtime_ms, accounted_wall_clock_ms, accounted_tool_calls, accounted_provider_requests, accounted_command_output_bytes, accounted_artifact_bytes, accounted_workspace_disk_bytes, accounted_workspace_file_count) ON %I.agent_execution_reservations TO giga_api_runtime', quota_schema);
    EXECUTE format('GRANT INSERT (reservation_id, owner_id, workspace_id, run_id, attempt_number, event_key, event_kind, request_fingerprint, sandbox_runtime_ms, wall_clock_ms, tool_calls, provider_requests, command_output_bytes, artifact_bytes, workspace_disk_bytes, workspace_file_count, limit_exceeded) ON %I.agent_execution_usage_events TO giga_api_runtime', quota_schema);

    EXECUTE format('REVOKE ALL ON FUNCTION %I.finalize_agent_execution_reconciliation(uuid, character varying, character, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean) FROM PUBLIC', quota_schema);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO giga_agent_quota_finalizer', quota_schema);
    EXECUTE format('GRANT SELECT ON %I.agent_runs, %I.agent_execution_reservations, %I.agent_execution_usage_events TO giga_agent_quota_finalizer', quota_schema, quota_schema, quota_schema);
    EXECUTE format('GRANT UPDATE (updated_at) ON %I.agent_runs TO giga_agent_quota_finalizer', quota_schema);
    EXECUTE format('GRANT UPDATE (updated_at) ON %I.agent_execution_reservations TO giga_agent_quota_finalizer', quota_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.finalize_agent_execution_reconciliation(uuid, character varying, character, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean) TO giga_agent_quota_finalizer', quota_schema);
END;
$quota_privileges$;
