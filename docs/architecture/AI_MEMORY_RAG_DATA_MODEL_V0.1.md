# GigaChat Data Model and Migration Specification v0.1

> **PROPOSED ONLY** — SQL below is illustrative DDL for later reviewed forward migrations, not executed in the repository. References: [architecture](AI_MEMORY_RAG_V0.1.md), [draft memory API](../contracts/GIGACHAT_MEMORY_API_V0.1.md), [17T-21 History CRUD](https://linear.app/17thedev/issue/17T-21).

## 1. Existing schema and dependency order

On the inspected Giga main revision (2026-10-13), migration 001 exists for **users**, **sessions**, and schema_migrations. Conversation History migration 002 is **owned by 17T-21 and was In Progress during authoring**; do not create duplicate conversations/messages tables in the Memory task.

Proposed migration order:
- 001 already in main: users and sessions.
- 002 reserved for reviewed conversations and messages implementation in 17T-21; verify merged schema before coding Memory.
- **Next available migration version after 002**: introduce memory settings/items/suggestions/jobs/provenance and pgvector, ONLY after confirming real migration registry.
- Never create a second competing migration runner. Current runner contains an inline MIGRATIONS array as well as SQL files: resolve to **one authoritative migration source**, checksum and reviewed forward-only process before adding Memory tables.

No production destructive migration, table wipe or Cloud schema change is authorized by this design document.

## 2. Ownership and scope

Each user owns conversations and memory. All read/update/delete operations use the authenticated principal, not request-supplied userId. For future project-scoped memory, resolve a real authorized project membership before querying; **MVP is global personal memory only**, no placeholder projectId is accepted yet. Repository/code index is a distinct, access-controlled future subsystem.

Suggested relational invariants:
- users.id -> memory_settings.user_id, memory_items.user_id, memory_suggestions.user_id, memory_jobs.user_id, suppression.user_id.
- memories have stable UUID plus revision; no cross-user reassignment.
- memory_sources links only to source messages owned by the same user; validate with owner-qualified join / transaction, possibly composite FK in finalized schema.
- deleting a user cascades content, vectors, suggestions, jobs and suppressions.
- deleting a memory cascades vectors, source links, pending derived jobs (or workers are invalidated transactionally).
- no memory vector available if stored embedding revision != memory revision.

## 3. Proposed tables

| Table | Primary fields | Constraints / semantics |
|---|---|---|
| memory_settings | user_id, enabled, capture_mode, use_in_chat, policy_epoch, updated_at | One row/user, default disabled; update increments policy_epoch |
| memory_items | id, user_id, memory_key, content, category, origin, status, revision, created_at, updated_at | Active vs superseded, provenance-bearing; optimistic concurrency |
| memory_embeddings | memory_id, revision, model_id, vector, created_at | Current revision only for retrieval; model/dimension specific |
| memory_sources | memory_id, message_id, origin_role | Source pointers to stored messages; owner invariants |
| memory_suggestions | id, user_id, source_message_id, candidate_key, proposed_content, category, status, expires_at, policy_epoch | Pending not indexed; accept/reject idempotent |
| memory_jobs | id, user_id, job_kind, target_id, status, attempts, run_after, lease_until, policy_epoch, idempotency_key | Durable extraction/embedding/cleanup tasks |
| memory_suppressions | id, user_id, fingerprint, source_message_id?, created_at | Minimal keyed digest / source exclusion, no deleted plaintext |
| memory_usage (optional) | message_id, memory_id, revision | Optional source disclosure; purge link on forgetting |

Memory content length, retention periods, suggested categories and worker limits are **configurable candidates** requiring review and test evidence.

## 4. Illustrative DDL (non-executable spec)

**Prerequisites:** PostgreSQL containing the extension binaries; confirm provider privileges and extension version. Vector dimensionality **1536 is a placeholder**, not an embedding-provider commitment. PostgreSQL 15+ supports NULLS NOT DISTINCT in indexes; the local PostgreSQL 16 target qualifies.

~~~sql
-- PROPOSAL, NOT AN AUTHORIZED MIGRATION
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  capture_mode text NOT NULL DEFAULT 'suggest'
    CHECK (capture_mode IN ('off','suggest','auto')),
  use_in_chat boolean NOT NULL DEFAULT true,
  policy_epoch bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  memory_key text NOT NULL,
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  category text NOT NULL CHECK
    (category IN ('preference','fact','project_decision','goal')),
  origin text NOT NULL CHECK
    (origin IN ('manual','suggested','automatic')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','superseded')),
  confidence real CHECK (confidence BETWEEN 0 AND 1),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX memory_items_user_status
  ON memory_items(user_id, status, updated_at DESC);
CREATE UNIQUE INDEX memory_items_active_logical_key
  ON memory_items(user_id, memory_key) WHERE status = 'active';

-- dimension = example; select exactly one model/dimension for MVP
CREATE TABLE memory_embeddings (
  memory_id uuid PRIMARY KEY REFERENCES memory_items(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  model_id text NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_message_id uuid, -- FK to 17T-21 messages when merged
  candidate_key text NOT NULL,
  proposed_content text NOT NULL CHECK (length(proposed_content) > 0),
  category text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected','expired')),
  policy_epoch bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX memory_suggestions_user_pending
  ON memory_suggestions(user_id, status, created_at DESC);

CREATE TABLE memory_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_kind text NOT NULL CHECK
    (job_kind IN ('extract','embed','cleanup')),
  target_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  policy_epoch bigint NOT NULL,
  idempotency_key text NOT NULL,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX memory_jobs_claim_idx
  ON memory_jobs(status, run_after, lease_until);

CREATE TABLE memory_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint text NOT NULL, -- keyed HMAC digest, never plaintext
  source_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);
~~~

**Not shown in executable DDL:** memory_sources and optional memory_usage require the actual messages schema from 17T-21. On implementation, define same-user consistency, on-delete behavior and audit privacy explicitly. The DDL sketch deliberately does **not** include a query-ready table for Knowledge RAG (future knowledge_documents / knowledge_chunks).

**Security note:** A foreign key from memory_sources to messages alone does not enforce same-owner access. The DB/service must verify that a given message belongs to memory.user_id; consider database constraints/triggers or an owner-qualified insert transaction. Avoid broad SQL policies claimed secure merely because queries include user_id.

## 5. Retrieval SQL sketch and performance

~~~sql
-- $1 = userId from authenticated session; $2 = query vector of pinned model
SELECT m.id, m.content, m.category, m.origin, m.revision,
       1 - (e.embedding <=> $2::vector) AS similarity
FROM memory_items AS m
JOIN memory_embeddings AS e ON e.memory_id = m.id
JOIN memory_settings AS s ON s.user_id = m.user_id
WHERE m.user_id = $1
  AND m.status = 'active'
  AND s.enabled = true
  AND s.use_in_chat = true
  AND e.revision = m.revision
  AND e.model_id = $3
ORDER BY e.embedding <=> $2::vector
LIMIT $4;
~~~

Embedding dimensions must match. Use an application-level validation for $3 and the vector dimension before calling SQL. Exact nearest-neighbor search suffices initially for limited per-user memory volumes; build HNSW only after benchmarks and after testing filtering behavior with tenant constraints. Indexes on user_id/status support early scope filtering; pgvector HNSW may filter *after* approximate search, so do not assume HNSW always returns the requested k hits for filtered queries.

Potential later lexical path: PostgreSQL tsvector/tsquery, or pg_trgm/exact matching for IDs such as 17T-20, filenames and API method names. Evaluate Vietnamese tokenization separately. Fuse vector and lexical rankings with measured thresholds, rather than untested constants.

## 6. Revisions, conflicts and durable jobs

- Store memory_key as a stable normalized logical concept, not a public identifier. Per-user active key uniqueness avoids duplicate "Giga database choice" memories. Deriving the key is not foolproof; semantic dedup still needed.
- On edit: optimistic update WHERE id=user-scope AND revision=expected; increment revision, invalidate existing embedding immediately, queue new embedding job. Return 409 on revision conflict.
- Worker uses SELECT ... FOR UPDATE SKIP LOCKED to claim jobs with a bounded lease; define crash reclaim, backoff, max attempts and status monitoring. Worker must recheck user enabled/capture mode, policy_epoch, memory revision and source existence during the final write transaction.
- On disable/delete/forget: bump policy_epoch, invalidate/revoke eligible jobs, delete vectors and source references. Suppression should never retain original secret text; HMAC key is a backend-only secret, and user can clear suppression history.
- Handle concurrent accept/reject/retry with unique idempotency keys and row locks. Exactly-once execution is not guaranteed by retries; design **idempotent effects**.
- Persistence of assistant message plus extraction job should be atomic when extraction applies, but the streaming terminal event and durable DB commit order must be decided alongside Chat SSE persistence contract.
- Avoid raw provider prompts or sensitive message data in jobs, errors or logs.

## 7. Migrations, tests and operations

1. Merge/review 17T-21 conversation migration and 17T-23 auth/test DB safety fix first.
2. Confirm pgvector extension availability in selected local Docker image, CI and eventual managed provider. Current vanilla postgres:16-alpine does not prove availability. Do not silently swap production DB provider.
3. Migrate using the one canonical forward-only runner; do not implement the above DDL as a shadow independent tool.
4. Integration test migrations on disposable real PostgreSQL with pgvector; ensure no production-like database is touched. Check reruns and concurrent workers.
5. Include isolation/injection tests, vector dim/model mismatch tests, stale revision tests, opt-out race, deletion and source consistency tests.
6. Record index sizes, query latency, extension version and quotas as evidence. Do not claim these benchmarks were completed in a documentation PR.

**Related:** [Architecture](AI_MEMORY_RAG_V0.1.md), [Pipelines](AI_MEMORY_RAG_PIPELINES_V0.1.md), [Test plan](AI_MEMORY_RAG_TEST_PLAN_V0.1.md).