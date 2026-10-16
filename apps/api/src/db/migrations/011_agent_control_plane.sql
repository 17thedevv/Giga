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
