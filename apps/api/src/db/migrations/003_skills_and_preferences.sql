-- Migration 003: Giga Skills and User Preferences Persistence (P0)
-- References: Linear 17T-28, docs/architecture/GIGA_SKILLS_DATA_MODEL_V0.1.md

-- 1. User Preferences: exactly one current record per user with optimistic concurrency control
CREATE TABLE IF NOT EXISTS user_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    preferred_language VARCHAR(50),
    response_length VARCHAR(20) CHECK (response_length IN ('concise', 'balanced', 'detailed')),
    response_style VARCHAR(20) CHECK (response_style IN ('professional', 'casual', 'technical')),
    custom_instructions VARCHAR(2000) NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Skill Definitions: built-in and private text skills
CREATE TABLE IF NOT EXISTS skill_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
    slug VARCHAR(64) NOT NULL,
    title VARCHAR(100) NOT NULL,
    description VARCHAR(500) NOT NULL,
    visibility VARCHAR(20) NOT NULL CHECK (visibility IN ('built_in', 'private')),
    supported_products TEXT[] NOT NULL DEFAULT ARRAY['chat', 'agent'],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_skill_visibility_owner CHECK (
        (visibility = 'built_in' AND owner_id IS NULL) OR
        (visibility = 'private' AND owner_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_skill_definitions_owner_id ON skill_definitions (owner_id);
CREATE INDEX IF NOT EXISTS idx_skill_definitions_slug ON skill_definitions (slug);
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_definitions_owner_slug ON skill_definitions (owner_id, slug) WHERE owner_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_definitions_builtin_slug ON skill_definitions (slug) WHERE visibility = 'built_in';

-- 3. Skill Versions: immutable versioned instructions with content hash
CREATE TABLE IF NOT EXISTS skill_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id UUID NOT NULL REFERENCES skill_definitions(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL CHECK (version_number >= 1),
    content_hash VARCHAR(64) NOT NULL,
    instructions TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_skill_versions_skill_version UNIQUE (skill_id, version_number),
    CONSTRAINT uq_skill_versions_skill_id_id UNIQUE (skill_id, id)
);

CREATE INDEX IF NOT EXISTS idx_skill_versions_skill_id ON skill_versions (skill_id);

-- 4. Skill Installations: user installation and enablement with composite foreign key to guarantee version integrity
CREATE TABLE IF NOT EXISTS skill_installations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill_id UUID NOT NULL REFERENCES skill_definitions(id) ON DELETE CASCADE,
    selected_version_id UUID NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_skill_installations_user_skill UNIQUE (user_id, skill_id),
    CONSTRAINT fk_installation_skill_version FOREIGN KEY (skill_id, selected_version_id)
        REFERENCES skill_versions (skill_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_skill_installations_user_id ON skill_installations (user_id);
CREATE INDEX IF NOT EXISTS idx_skill_installations_skill_id ON skill_installations (skill_id);

-- 5. Workspace Skill Defaults: agent workspace default activations
CREATE TABLE IF NOT EXISTS workspace_skill_defaults (
    workspace_id UUID NOT NULL,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill_id UUID NOT NULL REFERENCES skill_definitions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 1,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, owner_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_skill_defaults_workspace_owner ON workspace_skill_defaults (workspace_id, owner_id);
