# Verification Evidence — Linear 17T-71: Persist sandbox session registry and crash-safe cleanup reconciliation

**Date:** 2026-10-19<br>
**Linear Task:** [17T-71](https://linear.app/17thedev/issue/17T-71/persist-sandbox-session-registry-and-crash-safe-cleanup-reconciliation)<br>
**Branch:** `feat/17t-71-agent-sandbox-sessions`<br>
**PR Title:** `feat(agent): persist sandbox session registry and cleanup reconciler`<br>
**Owner:** Trà (Agent / Backend)<br>
**Peer Reviewer:** Tráng A Thư (Frontend / UX)<br>
**Independent Reviewer:** ChatGPT<br>
**Status:** READY FOR REVIEW (0 Billable Cloud Operations, 0 Real Cloud Sandboxes, Capabilities Disabled by Default)

---

## 1. Executive Summary & Purpose

Linear task **17T-71** establishes a durable PostgreSQL-backed session registry (`agent_sandbox_sessions`) and a crash-safe cleanup reconciler (`SandboxCleanupReconciler`).

Prior to 17T-71, sandbox session state was tracked primarily in-memory within `IsolatedCloudSandboxAdapter.sessions: Map<string, CloudSessionState>`. If an API host or worker process crashed, restarted, or lost connectivity, session handles were lost in memory, risking:
1. **Orphaned cloud sandboxes** incurring recurring provider bills.
2. **Duplicate allocations** when multiple workers or attempts raced on the same run.
3. **Stale worker revival** when late RPC callbacks arrived after timeouts or lease expiries.
4. **Untracked provider resource handles** if a crash occurred between remote allocation and local commit.

**17T-71 Guarantees:**
- **Zero Orphaned Sandboxes:** Every allocation intent is persisted to PostgreSQL before remote provider invocation. An idempotent, crash-safe reconciler scans for expired, abandoned, failed, or orphaned sessions and issues provider destructions.
- **Strict Attempt & Worker Fencing:** Exactly one active or allocating session per run across all workers (`uq_agent_sandbox_single_active`). Late callbacks from expired worker leases or superseded attempts cannot activate sessions and are automatically queued for cleanup.
- **Durable Tombstones & Immutability:** Destroyed sessions cannot be revived or deleted. SQL check constraints and triggers enforce terminal immutability.
- **Safe Multi-Process Concurrency:** Cleanup reconciliation uses PostgreSQL row locks and `FOR UPDATE SKIP LOCKED`, preventing race conditions across horizontal replicas.
- **Zero Real Cloud Sandboxes / Zero Cost:** Maintains the human approval gate from 17T-70. No real E2B API keys or sandboxes were provisioned; capability discovery remains `{ available: false, reason: 'runtime_unavailable' }`.

---

## 2. Durable Architecture & Data Model

### PostgreSQL Migration `014_agent_sandbox_sessions.sql`

```sql
CREATE TABLE IF NOT EXISTS agent_sandbox_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL,
    run_id UUID NOT NULL,
    attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number > 0),
    mode VARCHAR(10) NOT NULL CHECK (mode IN ('ask', 'plan', 'execute')),
    provider_type VARCHAR(32) NOT NULL,
    provider_session_id VARCHAR(128),
    lifecycle_state VARCHAR(32) NOT NULL CHECK (lifecycle_state IN (
        'allocating', 'active', 'stopping', 'destroying', 'destroyed', 'cleanup_pending', 'failed'
    )),
    allocation_state VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (allocation_state IN (
        'pending', 'allocated', 'failed', 'timed_out', 'aborted'
    )),
    cleanup_state VARCHAR(32) NOT NULL DEFAULT 'none' CHECK (cleanup_state IN (
        'none', 'pending', 'retry_scheduled', 'in_progress', 'completed', 'failed'
    )),
    worker_id VARCHAR(128) NOT NULL,
    lease_token VARCHAR(128) NOT NULL,
    allocation_intent_id UUID NOT NULL DEFAULT gen_random_uuid(),
    cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0),
    next_cleanup_retry_at TIMESTAMPTZ,
    allocation_expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    destroyed_at TIMESTAMPTZ,
    diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
    verified_checks JSONB,
    UNIQUE (owner_id, id),
    UNIQUE (run_id, attempt_number),
    FOREIGN KEY (owner_id, workspace_id, run_id) REFERENCES agent_runs(owner_id, workspace_id, id) ON DELETE CASCADE,
    CHECK (updated_at >= created_at),
    CHECK ((lifecycle_state = 'destroyed') = (destroyed_at IS NOT NULL)),
    CHECK (destroyed_at IS NULL OR destroyed_at >= created_at)
);

-- Partial unique index guarantees at most ONE active/allocating/stopping session per run
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_sandbox_single_active ON agent_sandbox_sessions (run_id)
    WHERE lifecycle_state IN ('allocating', 'active', 'stopping');
```

---

## 3. Crash Windows & Failure Reconciliation Matrix

| Failure / Crash Window | System Behavior | Outcome |
|---|---|---|
| **Worker crashes before provider call** | Session record exists in `allocating` state with `allocation_expires_at` TTL. | Reconciler sweeps expired allocating session, marks `failed` with `crashSuspected: true`. |
| **Worker crashes after provider call, before DB commit** | Worker catches or startup reconciler claims session. Provider ID is recorded in diagnostics or during late callback. | Provider session is safely destroyed via `destroySandbox`; session marked `destroyed`. |
| **Worker crashes during stopping / destroying** | Session is in `stopping` or `destroying` state while run is completed / cancelled. | Reconciler sweeps stopping session using `FOR UPDATE SKIP LOCKED`, calls provider destroy, writes tombstone. |
| **Late callback arrives after worker lease expired** | `commitSandboxSessionAllocated` checks run lease. If expired or stolen, session is immediately marked `cleanup_pending` and committed; caller gets `ConflictError`. | No stale session becomes active; orphan provider session is queued for background destruction. |
| **Provider returns 404 / NOT FOUND during cleanup** | Reconciler detects 404 / NOT FOUND. | Treated as idempotent success; session transitions to `destroyed`. |
| **Provider outage during cleanup** | Provider returns 5xx / timeout. | Reconciler increments `cleanup_attempts` and sets `next_cleanup_retry_at` with exponential backoff (up to `maxCleanupAttempts`). Retains durable record. |
| **Attempt to modify destroyed session** | Direct SQL UPDATE attempting to reset `lifecycle_state` or `destroyed_at`. | Rejected by PostgreSQL trigger and check constraints (`cannot modify destroyed sandbox session`). |

---

## 4. Verification Evidence & Test Results

### 1. Dedicated Sandbox Session Tests (`tests/agent/agent-sandbox-sessions.test.ts`)
- **Suite:** 16 tests across 6 scenario groups
- **Outcome:** **16 passed, 0 failed**

```
▶ GigaAgent Durable Sandbox Sessions & Crash-Safe Cleanup (17T-71)
  ▶ 1. Allocation Races & Invariants
    ✔ concurrent allocation intents: exactly one survivor, second gets duplicate or conflict (34.8ms)
    ✔ allocation rejects terminal runs (completed, failed, cancelled) (26.9ms)
    ✔ cross-attempt allocation succeeds after previous attempt destroyed or failed (26.7ms)
  ✔ 1. Allocation Races & Invariants (89.2ms)
  ▶ 2. Crash Windows & Orphan Prevention
    ✔ worker crashes before provider call: allocating TTL expires -> reconciler sweeps and marks timed out (36.7ms)
    ✔ worker crashes after provider allocation before DB commit: session tracked and reconciler destroys it (26.3ms)
    ✔ worker crashes while stopping/destroying: reconciler sweeps and completes destruction (38.6ms)
  ✔ 2. Crash Windows & Orphan Prevention (102.3ms)
  ▶ 3. Late Callbacks & Worker Lease Fencing
    ✔ late callback: commit after lease expired fails and automatically marks session cleanup_pending (27.1ms)
    ✔ late callback: another worker claimed the run -> first worker fenced out on commit (29.1ms)
  ✔ 3. Late Callbacks & Worker Lease Fencing (56.6ms)
  ▶ 4. Durable Reconciler & Idempotent Cleanup
    ✔ reconciler treats 404 / NOT FOUND as idempotent destruction success (33.9ms)
    ✔ reconciler handles transient provider errors with exponential backoff and attempt counter (55.0ms)
    ✔ reconciler bounded batching processes only up to batchSize items (74.4ms)
  ✔ 4. Durable Reconciler & Idempotent Cleanup (163.7ms)
  ▶ 5. Tenant Boundary & Immutability Security
    ✔ cross-owner query via getSandboxSession rejects with NotFoundError (20.9ms)
    ✔ cross-workspace allocation attempt rejected with NotFoundError or ConflictError (15.7ms)
    ✔ destroyed session cannot be revived (immutable tombstone) (20.1ms)
    ✔ diagnostics and error reasons redact sensitive tokens and credentials (20.4ms)
  ✔ 5. Tenant Boundary & Immutability Security (77.7ms)
  ▶ 6. Adapter Integration & Execution Flow
    ✔ IsolatedCloudSandboxAdapter with repository persists allocating intent and commits active session on prepare (27.8ms)
  ✔ 6. Adapter Integration & Execution Flow (28.4ms)
✔ GigaAgent Durable Sandbox Sessions & Crash-Safe Cleanup (17T-71) (676.6ms)
```

### 2. Migration Tests (`tests/agent/agent-migration.test.ts` & `tests/db-migrations.test.ts`)
- **Migration 014 Verification:** Upgrades populated 013 database, preserves all 18 tables, reruns idempotently, enforces unique constraints and immutability triggers.
- **Outcome:** **Pass (100%)**

### 3. Full API & Web Verification
- `apps/api`: **504 tests passed, 0 failures, 25 skipped (live cloud tests awaiting human GO)**
- `apps/api`: `npm run typecheck` — **Clean (0 errors)**
- `apps/api`: `npm run build` — **Clean (0 errors)**
- `apps/web`: **176 tests passed, 0 failures**
- `apps/web`: `npm run typecheck` — **Clean (0 errors)**
- `git diff --check` — **Clean (0 whitespace errors)**

---

## 5. Security & Safety Checklist

- [x] **No billable cloud spend:** 0 real E2B sandboxes created.
- [x] **Feature gate closed:** `cloudRuntime.available: false` and `runExecution.available: false` unchanged.
- [x] **Redaction of sensitive credentials:** `AgentRepository` and `SandboxCleanupReconciler` redact API tokens, Bearer headers, and secrets in diagnostics and error logs.
- [x] **Tenant isolation:** Strict composite foreign key `(owner_id, workspace_id, run_id)` and tenant authorization checks on all queries.
- [x] **PostgreSQL immutability:** Destroyed sessions cannot be revived or deleted.

---

## 6. Changed Files Summary

| File | Change Type | Purpose |
|---|---|---|
| `apps/api/src/db/migrations/014_agent_sandbox_sessions.sql` | Added | Schema migration for durable session registry |
| `apps/api/src/db/migrate.ts` | Modified | Registered migration 014 |
| `apps/api/src/modules/agent/types.ts` | Modified | Added durable session types and lifecycle states |
| `apps/api/src/modules/agent/repository.ts` | Modified | Added 12 durable methods for allocation, fencing, and cleanup |
| `apps/api/src/modules/agent/cleanup-reconciler.ts` | Added | Crash-safe reconciler with backoff and batching |
| `apps/api/src/modules/agent/execution-runtime.ts` | Modified | Extended `PrepareRuntimeRequest` with worker fencing info |
| `apps/api/src/modules/agent/orchestrator.ts` | Modified | Forwarded workerId, leaseToken, and attempt to runtime.prepare |
| `apps/api/src/modules/agent/sandbox-adapter.ts` | Modified | Connected adapter to PostgreSQL registry with in-memory fallback |
| `apps/api/tests/agent/agent-migration.test.ts` | Modified | Added migration 014 verification test |
| `apps/api/tests/agent/agent-sandbox-sessions.test.ts` | Added | 16 comprehensive durable session & reconciler tests |
| `apps/api/tests/db-migrations.test.ts` | Modified | Updated migration count assertion to 14 |
| `apps/api/tests/test-db-helper.ts` | Modified | Added `agent_sandbox_sessions` to test cleanup |
| `docs/evidence/17T-71-sandbox-session-registry.md` | Added | Complete verification evidence and technical analysis |
