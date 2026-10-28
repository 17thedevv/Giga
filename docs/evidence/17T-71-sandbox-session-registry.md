# Verification Evidence — Linear 17T-71

**Date:** 2026-10-28
**Linear:** [17T-71](https://linear.app/17thedev/issue/17T-71/persist-sandbox-session-registry-and-crash-safe-cleanup-reconciliation)
**Branch:** `feat/17t-71-agent-sandbox-sessions`
**Merged dependency:** PR #42, merge commit `207d78327fd58962dd9acdb4f2cf3048234df0d9`
**Baseline 17T-71 commit:** `c98eb1d4d1f673aea8a92729592c71e2aff6ad73`
**Lifecycle commits:** `b59b44f` (`fix(agent): fence sandbox allocation lifecycle per attempt`), `eb0d3e02b1a3913911a9c126abc31f96b263eada` (preserve active cleanup lease)
**Review Fix (Database Lifecycle Integrity):** Resolved Finding 1 (explicit operation-state transition matrix) and Finding 2 (prevent fabricated sandbox destruction & enforce least-privilege column grants).
**Draft PR:** [#44](https://github.com/17thedevv/Giga/pull/44)
**Decision:** NO-GO for 17T-73 runtime integration until independent review and provider settlement limits below are closed.

This document supersedes earlier 17T-71 evidence. In particular, allocation TTL, a missing in-process sandbox handle, or a lost provider response is not proof of quiescence. No pull request was merged; no live E2B call, cloud resource, deployment, or runtime enablement was used for this work.

## Lifecycle invariants implemented

- **Durable Attempt Fence & Operation Ledger (Migration 016):** Adds a durable attempt fence keyed by owner, workspace, run, attempt and generation, plus an immutable lifecycle-operation ledger for allocation, tool and snapshot work.
- **Finding 1 — Explicit Operation-State Transition Matrix (`agent_sandbox_lifecycle_operations`):**
  - Settled operations are terminal and immutable; outcome, provider resource identity, and settled timestamp cannot be altered.
  - An `in_progress` or `ambiguous` allocation can NEVER transition directly to `settled/no_resource` via direct SQL. A provider response timeout, process crash, empty E2B listing or missing provider ID is never converted into absence based on elapsed time.
  - A `not_started` allocation can settle as `settled/no_resource` ONLY when the exact attempt is durably fenced (`fenced_at IS NOT NULL`).
  - Late provider callbacks arriving after fencing transition `in_progress` or `ambiguous` allocations to `settled/resource` with verified `provider_resource_id` against the original generation.
  - Runtime tool and snapshot operations enforce valid transitions (`in_progress -> ambiguous | settled`, `ambiguous -> settled`).
  - Blank table privileges on `agent_sandbox_lifecycle_operations` are revoked from `giga_api_runtime`. Least-privilege column grants allow UPDATE ONLY on `(state, outcome, provider_resource_id, operation_name, settled_at)`. Identity columns are immutable and ungranted.
- **Finding 2 — Prevent Fabricated Sandbox Destruction (`agent_sandbox_sessions`):**
  - Direct transitions to `destroyed` from `active`, `cleanup_pending`, `allocating`, or `failed` are strictly forbidden and rejected with a PL/pgSQL exception.
  - A transition into `destroying` requires an active cleanup lease (`cleanup_state = 'in_progress'` and `cleanup_lease_expires_at > NOW()`).
  - A transition into `destroyed` requires:
    1. Pre-state must be `destroying`.
    2. Active cleanup lease must not be expired if in progress.
    3. Exact matching settled allocation operation in `agent_sandbox_lifecycle_operations` with `state = 'settled'`, `outcome = 'resource'`, and `provider_resource_id = NEW.provider_session_id`.
    4. Completed cleanup conditions: `cleanup_state = 'completed'`, with `cleanup_lease_token` and `cleanup_lease_expires_at` cleared to NULL.
  - Tombstones are permanent and immutable: reviving a destroyed session (`lifecycle_state <> 'destroyed'`) is strictly forbidden.
  - Blank table privileges on `agent_sandbox_sessions` are revoked from `giga_api_runtime`. UPDATE is restricted to lifecycle and cleanup columns only; identity columns are immutable and ungranted. DELETE and TRUNCATE are revoked.
- **Lease Fencing & Takeover:**
  - An expired worker lease fences its prior attempt before takeover. Takeover is refused while allocation is ambiguous/in progress or a provider resource remains undestroyed.
  - Attempt fencing preserves a live `destroying` / `in_progress` cleanup lease, preventing overlapping workers from double-destroying.
- **E2B Metadata Tracking:** Creation metadata carries the allocation operation ID and attempt generation. Recovery finds running/paused sandboxes through SDK metadata listing and destroys by durable provider ID after restart.

## Remaining provider and integration dependencies

The E2B SDK listing returns running/paused sandboxes. If an allocation is not visible, the adapter returns `pending`; absence is not treated as proof that the create RPC has definitively settled with no resource. E2B does not currently provide this implementation with a definitive, operation-scoped `not_allocated` settlement result. A provider request that remains invisible or ambiguous therefore keeps its attempt and quota capacity held until definitive provider evidence is available. A live provider contract test is not included and would require the separate approval gate.

17T-73 must wire the lifecycle verifier into controlled quota finalization and demonstrate provider allocation, late response, sandbox destruction, in-flight operation drain, and quota release as one end-to-end race. A fake verifier or database-only race is not evidence for that production path. Independent review is also required before this protocol is treated as ready for runtime integration.

## Regression and migration evidence

All PostgreSQL checks below ran against an isolated local PostgreSQL 18.4 test database (`giga_test`, port 5434) with `NODE_ENV=test` and `TEST_DATABASE_URL` set. In-memory fallback was verified in `pg-mem` with trigger and role stripping.

| Check | Command | Result |
|---|---|---|
| Database Lifecycle Integrity Suite (Real PostgreSQL, role `giga_api_runtime`) | `npx --prefix apps/api tsx --test apps/api/tests/agent/agent-sandbox-lifecycle-integrity.test.ts` | **11 passed, 0 failed, 0 skipped**. Covers all 11 required review scenarios: rejection of `in_progress` and `ambiguous` to `no_resource`, immutability of settled operations, rejection of direct transitions to `destroyed` from live/cleanup-pending, non-revival of destroyed sessions, valid fenced `no_resource` settlement, late allocation recorded on original generation, cleanup concurrency arbitration, quota capacity retention while ambiguous, controlled quota release after verified quiescence, and effective role privilege verification after 014→015→016 migration sequence. |
| Sandbox lifecycle suite on PostgreSQL | `npx --prefix apps/api tsx --test apps/api/tests/agent/agent-sandbox-sessions.test.ts` | **28 passed, 0 failed, 0 skipped**. Includes deterministic queued PostgreSQL fence/allocation race, forced overlapping cleanup workers with no duplicate provider destroy, expired-lease takeover blocked by ambiguous allocation, late callback persistence/cleanup, tombstones, quota retention while ambiguous, and controlled release after verified cleanup. |
| Sandbox lifecycle suite in pg-mem | `npx --prefix apps/api tsx --test apps/api/tests/agent/agent-sandbox-sessions.test.ts` (without `TEST_DATABASE_URL`) | **24 passed, 0 failed, 4 skipped** (PostgreSQL row-lock tests cleanly skipped in memory). |
| E2B adapter suite (injected SDK, no network) | `npx --prefix apps/api tsx --test apps/api/tests/agent/agent-e2b-provider.test.ts` | **50 passed, 0 failed, 0 skipped**. Includes metadata-based ID recovery, command escaping/quoting, in-flight cancellation, and confirms an empty running/paused listing remains `pending`. |
| Migration and database utility suites on PostgreSQL | `npx --prefix apps/api tsx --test apps/api/tests/agent/agent-migration.test.ts` | **5 passed, 0 failed, 0 skipped**. Verifies actual 014→015→016 application, populated pre-016 allocation backfill to `ambiguous`, source/registry parity, role privileges and idempotent reruns. |
| Quota suite on PostgreSQL | `npx --prefix apps/api tsx --test apps/api/tests/agent/agent-quotas.test.ts` | **21 passed, 0 failed, 0 skipped**. Confirms ambiguous allocation holds quota, verified cleanup permits controlled release, and migrations through 016 upgrade populated schemas and rerun idempotently. |
| API typecheck | `npm run typecheck --prefix apps/api` | Passed, exit 0. |
| API production build | `npm run build --prefix apps/api` | Passed, exit 0. |
| Full API test suite | `npm test --prefix apps/api` | **543 passed, 0 failed, 31 skipped**; duration 47.1s. |
| Agent Skills validator | `node .agents/scripts/validate-skills.mjs` | Passed, all 8 skills valid. |
| Git Workflow validator | `node --test .agents/scripts/validate-git-workflow.test.mjs` | 6 passed, 0 failed, 0 skipped. |
| Whitespace & diff check | `git diff --check` | Passed, 0 whitespace errors. |

## Changed-file intent

The implementation updates:
- `apps/api/src/db/migrations/016_agent_attempt_lifecycle_fence.sql`: Enforces explicit operation-state transition matrix in `guard_agent_sandbox_operation()`, replaces `guard_agent_sandbox_session_update()` to prevent fabricated sandbox destruction, adds `ON DELETE CASCADE` to foreign key on `agent_sandbox_attempt_fences`, and applies least-privilege column grants for role `giga_api_runtime`.
- `apps/api/src/db/migrate.ts`: Updates embedded migration 16 definition to match SQL byte-for-byte.
- `apps/api/src/modules/agent/repository.ts`: Transitions sessions through `destroying` with an active cleanup lease before committing `destroyed` in `markSandboxDestroyed()`, and enforces that only never-started operations can be confirmed absent in `confirmSandboxAllocationAbsent()`.
- `apps/api/tests/test-db-helper.ts`: Updates regex to strip multiline role grants in pg-mem.
- `apps/api/tests/agent/agent-sandbox-sessions.test.ts`: Marks PostgreSQL row-lock concurrency test as skipped in pg-mem when `TEST_DATABASE_URL` is absent.
- `apps/api/tests/agent/agent-sandbox-lifecycle-integrity.test.ts`: Implements real PostgreSQL regression suite under effective role `giga_api_runtime` covering all 11 required scenarios.
- `docs/evidence/17T-71-sandbox-session-registry.md`: Updates verification evidence and audit trail.

All unstaged working-tree changes in `apps/web/` remain completely untouched. No cloud runtime was enabled. Draft PR #44 remains in Draft; independent review remains a required separate gate.
