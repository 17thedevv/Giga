-- Migration 004: Add metadata revision to skill_definitions for optimistic concurrency control (CAS)
-- References: Linear 17T-29, PR #16 review findings

ALTER TABLE skill_definitions ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
