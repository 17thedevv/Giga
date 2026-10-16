ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_error_code_check;
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
