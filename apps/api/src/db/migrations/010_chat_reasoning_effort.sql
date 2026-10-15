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
