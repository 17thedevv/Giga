ALTER TABLE chat_generations ADD COLUMN action VARCHAR(12) NOT NULL DEFAULT 'new_prompt'
    CHECK (action IN ('new_prompt', 'retry', 'regenerate'));
ALTER TABLE chat_operation_keys DROP CONSTRAINT chat_operation_keys_operation_check;
ALTER TABLE chat_operation_keys ALTER COLUMN operation TYPE VARCHAR(12);
ALTER TABLE chat_operation_keys ADD CONSTRAINT chat_operation_keys_operation_check
    CHECK (operation IN ('prompt', 'cancel', 'retry', 'regenerate'));

-- Composite keys prove the selected attempt's scope and completed status, including
-- against direct writes. A selected row cannot later lose its completed status.
ALTER TABLE conversations ADD CONSTRAINT uq_conversation_owner UNIQUE (id, user_id);
ALTER TABLE messages ADD CONSTRAINT uq_message_turn_scope UNIQUE (id, conversation_id, role);
ALTER TABLE chat_generations ADD CONSTRAINT uq_generation_selection_scope
    UNIQUE (id, owner_id, conversation_id, user_message_id, status);
CREATE TABLE chat_turn_selections (
    user_message_id UUID PRIMARY KEY,
    owner_id UUID NOT NULL,
    conversation_id UUID NOT NULL,
    user_role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (user_role = 'user'),
    selected_generation_id UUID NOT NULL,
    selected_status VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (selected_status = 'completed'),
    FOREIGN KEY (conversation_id, owner_id) REFERENCES conversations(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (user_message_id, conversation_id, user_role)
        REFERENCES messages(id, conversation_id, role) ON DELETE CASCADE,
    FOREIGN KEY (selected_generation_id, owner_id, conversation_id, user_message_id, selected_status)
        REFERENCES chat_generations(id, owner_id, conversation_id, user_message_id, status) ON DELETE CASCADE
);
INSERT INTO chat_turn_selections (owner_id, conversation_id, user_message_id, selected_generation_id)
    SELECT owner_id, conversation_id, user_message_id, id FROM chat_generations
    WHERE status = 'completed';

CREATE INDEX idx_chat_turn_attempts ON chat_generations (conversation_id, user_message_id, created_at, id);
