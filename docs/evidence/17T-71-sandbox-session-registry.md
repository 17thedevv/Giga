# Verification Evidence — Linear 17T-71

**Date:** 2026-10-26
**Linear:** [17T-71](https://linear.app/17thedev/issue/17T-71/persist-sandbox-session-registry-and-crash-safe-cleanup-reconciliation)
**Branch:** `feat/17t-71-agent-sandbox-sessions`
**Merged dependency:** PR #42, merge commit `207d78327fd58962dd9acdb4f2cf3048234df0d9`
**Baseline 17T-71 commit:** `c98eb1d4d1f673aea8a92729592c71e2aff6ad73`
**Lifecycle implementation commit:** `b59b44f` (`fix(agent): fence sandbox allocation lifecycle per attempt`)
**Decision:** NO-GO for 17T-73 runtime integration until independent review and provider settlement limits below are closed.

This document supersedes earlier 17T-71 evidence. In particular, allocation TTL, a missing in-process sandbox handle, or a lost provider response is not proof of quiescence. No live E2B call, cloud resource, deployment, merge, or runtime enablement was used for this work.

## Lifecycle invariants implemented

- Migration 016 adds a durable attempt fence keyed by owner, workspace, run, attempt and generation, plus an immutable lifecycle-operation ledger for allocation, tool and snapshot work.
- Allocation-intent creation, allocation-operation start, runtime-operation start, explicit attempt fencing, and expired-lease takeover serialize on the durable run row and exact attempt fence. A request queued behind a committed fence cannot insert an intent or start work.
- An expired worker lease fences its prior attempt before takeover. The replacement claim is refused while allocation is ambiguous/in progress, a provider resource remains undestroyed, or runtime/tool work is unresolved. A late successful allocation callback records its provider ID on the original generation as cleanup pending; takeover remains blocked until cleanup is confirmed.
- Allocation TTL is only a cleanup scheduling hint. A `not_started` operation can be settled resource-free; an in-progress or ambiguous operation cannot be converted to no-resource by elapsed time.
- Cleanup persists provider identity before marking destruction complete, validates the settled allocation identity, and respects the cleanup lease. A terminal run is not rewritten merely to persist its attempt fence.
- E2B creation metadata carries the allocation operation ID and attempt generation. Recovery can find running/paused sandboxes through the SDK metadata listing and destroy by durable provider ID after a process restart. Multiple matching IDs are ambiguous.

## Remaining provider and integration dependencies

The E2B SDK listing returns running/paused sandboxes. If an allocation is not visible, the adapter returns `pending`; absence is not treated as proof that the create RPC has definitively settled with no resource. E2B does not currently provide this implementation with a definitive, operation-scoped `not_allocated` settlement result. A provider request that remains invisible or ambiguous therefore keeps its attempt and quota capacity held until definitive provider evidence is available. A live provider contract test is not included and would require the separate approval gate.

17T-73 must wire the lifecycle verifier into controlled quota finalization and demonstrate provider allocation, late response, sandbox destruction, in-flight operation drain, and quota release as one end-to-end race. A fake verifier or database-only race is not evidence for that production path. Independent review is also required before this protocol is treated as ready for runtime integration.

## Regression and migration evidence

All PostgreSQL checks below ran against an isolated local PostgreSQL 18.4 test database (`giga_17t71_baseline_test`, listener port 55432) with `NODE_ENV=test` and `TEST_DATABASE_URL` set. Migrations 014, 015 and 016 ran in the test schema; no production database was used.

| Check | Command | Result |
|---|---|---|
| Sandbox lifecycle suite on PostgreSQL | `npx --prefix apps/api tsx --test --test-concurrency=1 apps/api/tests/agent/agent-sandbox-sessions.test.ts` | 28 passed, 0 failed, 0 skipped. Includes deterministic queued PostgreSQL fence/allocation race, expired-lease takeover blocked by ambiguous allocation, late callback persistence/cleanup, concurrent cleanup, terminal-run fencing, tombstones, quota-capacity retention under ambiguous provider state, and controlled release after verified cleanup. |
| E2B adapter suite (injected SDK, no network) | `npx --prefix apps/api tsx --test --test-concurrency=1 apps/api/tests/agent/agent-e2b-provider.test.ts` | 50 passed, 0 failed, 0 skipped. Includes metadata-based ID recovery and confirms an empty running/paused listing remains `pending`. |
| Migration and database utility suites on PostgreSQL | `npx --prefix apps/api tsx --test --test-concurrency=1 apps/api/tests/agent/agent-migration.test.ts apps/api/tests/db-migrations.test.ts` | 7 passed, 0 failed, 0 skipped. Verifies actual 014→015→016 application, populated pre-016 allocation backfill to `ambiguous`, source/registry parity, role privileges and idempotent reruns. |
| Combined quota, migration and sandbox suites on PostgreSQL | `npx --prefix apps/api tsx --test --test-concurrency=1 apps/api/tests/agent/agent-quotas.test.ts apps/api/tests/agent/agent-migration.test.ts apps/api/tests/agent/agent-sandbox-sessions.test.ts` | 54 passed, 0 failed, 0 skipped. Confirms the exact-attempt fence/allocation lock race, ambiguous allocation holds quota, verified cleanup permits controlled release, and migrations through 016 upgrade populated schemas and rerun idempotently. |
| API typecheck | `npm run typecheck --prefix apps/api` | Passed, exit 0. |
| Full API suite on isolated PostgreSQL | PostgreSQL 18.4, `NODE_ENV=test`, dedicated `TEST_DATABASE_URL`; `npm test --prefix apps/api` | 595 passed, 0 failed, 0 skipped; duration 142.5 seconds. |
| API production build | `npm run build --prefix apps/api` | Passed, exit 0, rerun on this tree. |
| Git Workflow validator | `node --test .agents/scripts/validate-git-workflow.test.mjs` | 6 passed, 0 failed, 0 skipped. |
| Whitespace check | `git diff --check` and `git diff --cached --check` | Passed, exit 0 on staged merge and unstaged implementation/evidence changes. |
| GitHub Actions on final SHA | Pending push. |

The broader sandbox test file was run against real PostgreSQL; these concurrency results do not depend on pg-mem's locking emulation. Migration 015 continues to enforce the distinct quota-owner, API-runtime and quota-finalizer privilege boundary. The new migration is forward-only and does not edit migrations 014 or 015.

## Changed-file intent

The implementation adds migration 016 and updates the embedded migration registry, repository fencing and takeover logic, E2B provider metadata lookup, cleanup reconciliation, lifecycle verifier, lifecycle types, PostgreSQL migration/lifecycle tests, pg-mem test support, and this evidence record. PR #42's merged quota, migration 015, runtime-role and evidence changes are included as the requested upstream merge dependency.

No cloud runtime was enabled. PR #42 remains merged upstream. No existing 17T-71 PR was found; open a new Draft PR after pushing the final commit. Do not interpret this local evidence as hosted CI success or independent approval.
