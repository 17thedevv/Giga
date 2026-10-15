CREATE TABLE IF NOT EXISTS chat_generations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    assistant_message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    model_alias VARCHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'streaming', 'completed', 'failed', 'interrupted')),
    partial_content TEXT NOT NULL DEFAULT '' CHECK (octet_length(partial_content) <= 65536),
    idempotency_key VARCHAR(128) NOT NULL,
    request_fingerprint VARCHAR(64) NOT NULL,
    finish_reason VARCHAR(20) CHECK (finish_reason IS NULL OR finish_reason IN ('stop', 'length', 'other')),
    error_code VARCHAR(40),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    CONSTRAINT uq_chat_owner_key UNIQUE (owner_id, idempotency_key),
    CONSTRAINT chk_chat_completion CHECK (status <> 'completed' OR (assistant_message_id IS NOT NULL AND finished_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_active_conversation
    ON chat_generations (conversation_id) WHERE status IN ('pending', 'streaming');
