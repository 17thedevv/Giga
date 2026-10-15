ALTER TABLE chat_generations ADD COLUMN resolved_provider_id VARCHAR(128);
ALTER TABLE chat_generations ADD COLUMN resolved_model_id VARCHAR(128);
ALTER TABLE chat_generations ADD CONSTRAINT chk_chat_resolved_model_pair CHECK (
    (resolved_provider_id IS NULL AND resolved_model_id IS NULL) OR
    (resolved_provider_id IS NOT NULL AND resolved_model_id IS NOT NULL
        AND octet_length(resolved_provider_id) > 0 AND octet_length(resolved_model_id) > 0)
);
-- Historical identity cannot be reconstructed truthfully: leave existing rows null.
CREATE OR REPLACE FUNCTION prevent_chat_resolved_model_rewrite()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.resolved_provider_id IS DISTINCT FROM NEW.resolved_provider_id
        OR OLD.resolved_model_id IS DISTINCT FROM NEW.resolved_model_id THEN
        IF OLD.resolved_provider_id IS NOT NULL OR OLD.status <> 'streaming'
            OR NEW.status <> 'streaming' OR NEW.resolved_provider_id IS NULL
            OR NEW.resolved_model_id IS NULL THEN
            RAISE EXCEPTION 'Resolved chat model identity is write-once at streaming start';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_chat_resolved_model_rewrite BEFORE UPDATE ON chat_generations
    FOR EACH ROW EXECUTE FUNCTION prevent_chat_resolved_model_rewrite();
