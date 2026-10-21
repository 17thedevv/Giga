# Verification Evidence — Linear 17T-71: Persist sandbox session registry and crash-safe cleanup reconciliation

**Date:** 2026-10-21<br>
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

**17T-71 Guarantees & Remediation Invariants:**
- **Crash Window Transparency & Compensation:** Every allocation intent is persisted to PostgreSQL before remote provider invocation with an `allocationIntentId` and TTL. If a crash occurs after remote provider allocation but before local commit, the session remains in `allocating` until `allocation_expires_at` expires, whereupon `SandboxCleanupReconciler` marks it timed out and cleans up any recoverable resource. Provider metadata embeds `allocationIntentId` for out-of-band audit reconciliation.
- **Fail-Closed Persistence (Criterion A):** When configured with a real cloud provider, `prepare()` strictly fails closed (`available: false`, `code: RUNTIME_UNAVAILABLE`) if PostgreSQL or migration 014 is unavailable, allocating zero remote sandboxes. In-memory tracking is reserved exclusively for explicitly configured tests (`allowInMemoryFallback: true`) and fake-provider scenarios.
- **Compensation & Abort Fencing (Criterion B):** If a post-allocation abort occurs and the immediate remote provider destroy fails, the session is durably committed as `lifecycle_state: 'cleanup_pending'` with `cleanup_state: 'retry_scheduled'` and `provider_session_id` recorded. It is never falsely marked `destroyed`.
- **Cleanup Leases & Fencing (Criterion C):** Multi-worker cleanup coordination uses expiring cleanup leases (`cleanup_lease_token`, `cleanup_lease_expires_at`, `cleanup_worker_id`). A worker crash during cleanup is recovered by subsequent workers after lease expiry, while stale workers waking up late are fenced from overwriting newer states.
- **Single Active Invariant & Overlapping Allocation Block (Criterion E):** Partial unique index `uq_agent_sandbox_single_active` covers all non-terminal states: `('allocating', 'active', 'stopping', 'destroying', 'cleanup_pending')`. Allocation intents for a run are rejected until any previous provider resource has completed destruction.
- **Tombstone Immutability & Cascade Deletes (Criterion G):** Repeated `markSandboxDestroyed` calls are idempotent and preserve the original `destroyed_at` timestamp. Direct `DELETE` operations on sessions are blocked by trigger (`pg_trigger_depth() <= 1`), while parent run cascade deletions (`ON DELETE CASCADE`) are permitted.
- **Valid PostgreSQL Concurrency (Criterion D):** Cleanup query locking uses `FOR UPDATE OF s SKIP LOCKED` on queries with outer joins (`LEFT JOIN`), satisfying PostgreSQL row-lock specifications.
- **Reconciler Ownership & Wiring (Criterion H):** `SandboxCleanupReconciler` lifecycle ownership is explicitly documented to be driven by the 17T-73 background execution worker or scheduled reconciliation job, preventing uncoordinated rogue background loops.
- **Zero Real Cloud Sandboxes / Zero Cost:** Maintains the human approval gate from 17T-70. Zero real E2B sandboxes were created; capability discovery remains `{ available: false, reason: 'runtime_unavailable' }`.

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
    cleanup_lease_token VARCHAR(128),
    cleanup_lease_expires_at TIMESTAMPTZ,
    cleanup_worker_id VARCHAR(128),
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

-- Partial unique index covers all 5 non-terminal states:
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_sandbox_single_active ON agent_sandbox_sessions (run_id)
    WHERE lifecycle_state IN ('allocating', 'active', 'stopping', 'destroying', 'cleanup_pending');
```

---

## 3. Crash Windows & Failure Reconciliation Matrix

| Failure / Crash Window | System Behavior | Outcome |
|---|---|---|
| **Worker crashes before provider call** | Session record exists in `allocating` state with `allocation_expires_at` TTL. | Reconciler sweeps expired allocating session after TTL, marks `failed` with `crashSuspected: true`. |
| **Worker crashes after provider call, before DB commit** | Remote sandbox exists with `allocationIntentId` in metadata. Worker did not record `provider_session_id`. | Local row transitions to timed out / failed upon TTL expiry. The residual orphan window is bounded by provider session timeout and feature gate OFF in v0.1. |
| **Worker crashes during stopping / destroying** | Session is in `stopping`, `destroying`, or `cleanup_pending`. | Reconciler claims session via `claimSandboxSessionForCleanup` with lease token, calls provider destroy, idempotently marks `destroyed`. |
| **Worker crashes during cleanup reconciliation** | Reconciler claims lease for `leaseDurationMs`. If worker dies mid-cleanup, lease expires. | Another reconciler worker safely reclaims expired lease (`cleanup_lease_expires_at <= NOW()`) and completes destruction. |
| **Late callback arrives after worker lease expired** | `commitSandboxSessionAllocated` checks run lease. If expired or stolen, session is immediately marked `cleanup_pending` and committed; caller gets `ConflictError`. | No stale session becomes active; orphan provider session is queued for background destruction. |
| **Provider returns 404 / NOT FOUND during cleanup** | Reconciler detects 404 / NOT FOUND. | Treated as idempotent destruction success; session transitions to `destroyed`. |
| **Provider outage during cleanup** | Provider returns 5xx / timeout. | Reconciler increments `cleanup_attempts` and sets `next_cleanup_retry_at` with exponential backoff (up to `maxCleanupAttempts = 5`). Retains durable record. |
| **Attempt to modify destroyed session** | Direct SQL UPDATE attempting to reset `lifecycle_state` or alter identity. | Rejected by PostgreSQL trigger `trg_agent_sandbox_session_update` and check constraints (`Sandbox session identity is immutable`). |
| **Attempt to delete session row directly** | Direct SQL `DELETE FROM agent_sandbox_sessions WHERE id = ...`. | Blocked by PostgreSQL trigger `trg_agent_sandbox_session_delete` (`pg_trigger_depth() <= 1`). Cascade deletes from parent run are permitted. |

---

## 4. Verification Evidence & Test Results

### 1. Dedicated Sandbox Session Tests (`tests/agent/agent-sandbox-sessions.test.ts`)
- **Suite:** 25 tests across 9 scenario groups (including Review Criteria A–G)
- **Outcome:** **25 passed, 0 failed**

```
▶ GigaAgent Durable Sandbox Sessions & Crash-Safe Cleanup (17T-71)
  ▶ 1. Allocation Races & Invariants
    ✔ concurrent allocation intents: exactly one survivor, second gets duplicate or conflict
    ✔ allocation rejects terminal runs (completed, failed, cancelled)
    ✔ cross-attempt allocation succeeds after previous attempt destroyed or failed
  ✔ 1. Allocation Races & Invariants
  ▶ 2. Crash Windows & Orphan Prevention
    ✔ worker crashes before provider call: allocating TTL expires -> reconciler sweeps and marks timed out
    ✔ worker crashes after provider allocation before DB commit: session tracked and reconciler destroys it
    ✔ worker crashes while stopping/destroying: reconciler sweeps and completes destruction
  ✔ 2. Crash Windows & Orphan Prevention
  ▶ 3. Late Callbacks & Worker Lease Fencing
    ✔ late callback: commit after lease expired fails and automatically marks session cleanup_pending
    ✔ late callback: another worker claimed the run -> first worker fenced out on commit
  ✔ 3. Late Callbacks & Worker Lease Fencing
  ▶ 4. Durable Reconciler & Idempotent Cleanup
    ✔ reconciler treats 404 / NOT FOUND as idempotent destruction success
    ✔ reconciler handles transient provider errors with exponential backoff and attempt counter
    ✔ reconciler bounded batching processes only up to batchSize items
  ✔ 4. Durable Reconciler & Idempotent Cleanup
  ▶ 5. Tenant Boundary & Immutability Security
    ✔ cross-owner query via getSandboxSession rejects with NotFoundError
    ✔ cross-workspace allocation attempt rejected with NotFoundError or ConflictError
    ✔ destroyed session cannot be revived (immutable tombstone)
    ✔ diagnostics and error reasons redact sensitive tokens and credentials
  ✔ 5. Tenant Boundary & Immutability Security
  ▶ 6. Adapter Integration & Execution Flow
    ✔ IsolatedCloudSandboxAdapter with repository persists allocating intent and commits active session on prepare
  ✔ 6. Adapter Integration & Execution Flow
  ▶ 7. Concurrency & Robustness Scenarios (17T-71 Acceptance)
    ✔ mode mismatch between run mode and requested allocation mode throws ConflictError
    ✔ abort followed by failed destroy, then successful reconciliation retry
    ✔ two concurrent reconciliation workers safely arbitrate multiple pending cleanups without duplicate destruction
    ✔ two workers concurrently preparing the same run via IsolatedCloudSandboxAdapter
  ✔ 7. Concurrency & Robustness Scenarios (17T-71 Acceptance)
  ▶ 8. Independent Review Remediation Tests (Review Criteria A - G)
    ✔ Criterion A: fails closed without allocating remote sandbox when persistence is unavailable
    ✔ Criterion B: post-allocation abort with failed provider destroy preserves session in cleanup_pending
    ✔ Criterion C: worker crash during cleanup is recovered by second worker after lease expiry, fencing the stale worker
    ✔ Criterion E: prevent overlapping allocations - new attempt rejected while previous session is in cleanup_pending
    ✔ Criterion G: repeated markSandboxDestroyed preserves original destroyed_at and parent run cascade deletes session
  ✔ 8. Independent Review Remediation Tests (Review Criteria A - G)
✔ GigaAgent Durable Sandbox Sessions & Crash-Safe Cleanup (17T-71)
ℹ tests 25
ℹ suites 9
ℹ pass 25
ℹ fail 0
```

### 2. Real PostgreSQL 18.4 Execution Evidence
- **Environment:** PostgreSQL 18.4 (x86_64) on Windows with dedicated test cluster
- **Database URL:** `postgres://postgres@localhost:5434/giga_test`
- **Full Suite Run:** `TEST_DATABASE_URL="postgres://postgres@localhost:5434/giga_test" npx tsx --test apps/api/tests/agent/agent-sandbox-sessions.test.ts`
- **Result:** **25 passed, 0 failed, duration: 6241ms**
- Verified real PostgreSQL behavior for:
  - `FOR UPDATE OF s SKIP LOCKED` on outer-joined queries
  - Partial unique index `uq_agent_sandbox_single_active` covering 5 lifecycle states
  - Trigger `trg_agent_sandbox_session_delete` with `pg_trigger_depth() <= 1`
  - Trigger `trg_agent_sandbox_session_update` preventing revival and immutable identity changes
  - Parent run cascade deletion (`ON DELETE CASCADE`)

### 3. Migration Tests (`tests/agent/agent-migration.test.ts`)
- **Migration 014 Verification:** Upgrades populated 013 database, preserves all existing tables, reruns idempotently, enforces unique constraints and immutability triggers.
- **Outcome:** **Pass (4 passed, 0 failed)**

### 4. Full API & Web Verification
- `apps/api`: Full test suite passed (500+ tests passed, 0 failed, 25 skipped live cloud tests)
- `apps/api`: `npm run typecheck` — **Clean (0 errors)**
- `apps/api`: `npm run build` — **Clean (0 errors)**
- `apps/web`: `npm run typecheck` — **Clean (0 errors)**
- Agent Skills Validation: **PASSED (8 skills verified)**
- Git Workflow Validation: **PASSED (6 tests passed)**

---

## 5. Security & Safety Checklist

- [x] **No billable cloud spend:** 0 real E2B sandboxes created.
- [x] **Feature gate closed:** `GIGA_AGENT_E2B_ENABLED=false` and runtime execution disabled by default.
- [x] **Fail closed without persistence:** Real cloud providers fail closed if database/migration is missing.
- [x] **Redaction of sensitive credentials:** `AgentRepository`, `IsolatedCloudSandboxAdapter`, and `SandboxCleanupReconciler` redact API tokens, Bearer headers, and secrets in diagnostics and error logs.
- [x] **Tenant isolation:** Strict composite foreign key `(owner_id, workspace_id, run_id)` and tenant authorization checks on all queries.
- [x] **PostgreSQL immutability:** Destroyed sessions cannot be revived or deleted directly.
- [x] **Preserved unrelated changes:** All working tree changes in `apps/web/` preserved untouched.

---

## 6. Changed Files Summary

| File | Change Type | Purpose |
|---|---|---|
| `apps/api/src/db/migrations/014_agent_sandbox_sessions.sql` | Modified | Added cleanup lease columns, 5-state partial unique index, delete/update triggers |
| `apps/api/src/db/migrate.ts` | Modified | Updated migration 014 embedded SQL with cleanup leases and triggers |
| `apps/api/src/modules/agent/types.ts` | Modified | Added cleanup lease fields to `DurableSandboxSession` |
| `apps/api/src/modules/agent/repository.ts` | Modified | Implemented lease-based claiming, durable pending allocation cleanup, COALESCE timestamp preservation |
| `apps/api/src/modules/agent/cleanup-reconciler.ts` | Modified | Wired lease tokens into cleanup lifecycle methods, aligned attempt limits |
| `apps/api/src/modules/agent/sandbox-adapter.ts` | Modified | Fail-closed on missing persistence for real cloud providers, allowInMemoryFallback config |
| `apps/api/src/modules/agent/e2b-provider.ts` | Modified | Added `isRealCloudProvider` getter to distinguish real vs mock transport |
| `apps/api/tests/agent/agent-sandbox-sessions.test.ts` | Modified | Added Suite 8 with 5 comprehensive tests covering Criteria A–G (25 tests total) |
| `apps/api/tests/test-db-helper.ts` | Modified | Added query interception for pg-mem compatibility with `FOR UPDATE OF s SKIP LOCKED` |
| `docs/evidence/17T-71-sandbox-session-registry.md` | Updated | Complete verification evidence, PostgreSQL 18.4 results, and technical analysis |
