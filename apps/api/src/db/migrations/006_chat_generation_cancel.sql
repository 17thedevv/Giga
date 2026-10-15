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
