CREATE TABLE user_provider_credentials (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id VARCHAR(20) NOT NULL CHECK (provider_id = 'gemini'),
    ciphertext TEXT NOT NULL,
    nonce VARCHAR(24) NOT NULL,
    auth_tag VARCHAR(24) NOT NULL,
    key_version INTEGER NOT NULL CHECK (key_version >= 1),
    display_hint VARCHAR(8) NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'valid', 'invalid')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_validated_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    UNIQUE (owner_id, provider_id),
    UNIQUE (owner_id, id)
);

-- A null selection in BYOK mode is intentional: deletion never enables platform billing.
-- Composite FK prevents selecting another owner's key, even through direct SQL.
CREATE TABLE chat_credential_preferences (
    owner_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mode VARCHAR(10) NOT NULL CHECK (mode IN ('platform', 'byok')),
    credential_id UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (mode = 'byok' OR credential_id IS NULL),
    FOREIGN KEY (owner_id, credential_id) REFERENCES user_provider_credentials(owner_id, id)
);
