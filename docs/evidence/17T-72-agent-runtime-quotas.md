# 17T-72 — Agent execution quotas and workspace concurrency

**Status:** implementation ready for independent review; quota admission is not yet wired to the execution boundary.

**Linear:** [17T-72](https://linear.app/17thedev/issue/17T-72/enforce-agent-execution-quotas-budgets-and-workspace-concurrency)

**Branch:** `feat/17t-72-agent-runtime-quotas`

**Base:** `origin/main` at `6ce98b1b8758f6a429a32316f4ed723220d92646`

**Implementation commit:** `6505a93e7d829f00b1ce72d232fbd73a60740778`

**Draft PR:** [#42](https://github.com/17thedevv/Giga/pull/42), linked to 17T-72 as `contributes`

**Owner / reviewer:** Trà / Thư

## Scope and integration boundary

This change adds a server-controlled quota policy, durable PostgreSQL reservations, measured usage accounting, stable quota errors, and migration 015. It does not enable cloud execution or alter the disabled public `POST /runs` behavior. The API v0.2 document remains a draft candidate.

At preflight, 17T-71's migration 014 and sandbox-session work were still unmerged from `main`. Migration 015 does not depend on migration 014 and its upgrade test applies a later 014 after 015. 17T-71 must supply a verifier that can confirm the exact owner/workspace/run/attempt is quiescent before reconciliation releases an allocated writable slot.

17T-73 must call `reserveExecutionAttempt` before queue dispatch or runtime allocation, call `markAllocationStarted` immediately before allocation, submit idempotent measured usage through `recordUsage`, and use `markOutcomeUnknown` for ambiguous provider results. It must commit measured usage and release resource capacity only after the 17T-71 lifecycle verifier confirms quiescence. Cancellation and retry orchestration remain disabled until this integration is implemented and tested. No end-to-end quota enforcement claim is made for an execution path that does not yet call this service.

The original checkout's six unrelated modified files under `apps/web/` remain untouched; implementation was done in an isolated worktree from `origin/main`.

## Policy dimensions and defaults

All values are trusted server defaults. A service can accept a separate administrative policy only after strict validation; callers cannot provide or override limits. Missing, unsafe, or internally inconsistent policy fails at service construction, before admission.

| Limit | Execute | Ask / Plan |
|---|---:|---:|
| Writable concurrency per owner | 1 | 0 writable capacity |
| Writable concurrency per workspace | 1 | 0 writable capacity |
| Attempts per logical run | 3 | 3 |
| Sandbox runtime | 30 minutes | 0 |
| Wall clock | 30 minutes | 2 minutes |
| Tool calls | 30 | 10 |
| Provider requests | 60 | 20 |
| Combined command output | 2 MiB | 256 KiB |
| Artifacts | 20 MiB | 0 |
| Workspace disk | 100 MiB | 0 |
| Workspace files | 1,000 | 0 |

Rolling 24-hour reservation budgets:

| Scope | Sandbox runtime | Provider requests | Command output | Artifacts |
|---|---:|---:|---:|---:|
| Owner | 60 minutes | 200 | 8 MiB | 80 MiB |
| Workspace | 30 minutes | 100 | 4 MiB | 40 MiB |

No dollar spend is stored or inferred. The current provider surface supplies request counts but no trustworthy per-user monetary cost; request count, runtime, bytes, and spend remain distinct measurements.

## Reservation and reconciliation

The reservation is keyed uniquely by owner, workspace, logical run, and attempt. Admission locks the current run row and verifies its live lease, then locks the owner row and workspace row in that order. Under those PostgreSQL locks it checks active writable reservations and rolling usage, reserves every per-attempt upper bound, and inserts the reservation plus its first audit event in one transaction. This serializes budgets across API processes and prevents duplicate attempts from acquiring a second reservation.

The durable states are:

| State | Meaning |
|---|---|
| `reserved` | Capacity is held; runtime allocation has not started. Safe pre-allocation cancellation can refund it once. |
| `active` | Allocation may consume resources. Usage events are accepted only for the current run lease. |
| `reconciliation_required` | Provider result or cleanup is ambiguous. The reservation and writable slot stay held. |
| `committed` | Actual usage is accounted. After execution, the writable slot remains held until quiescence is verified. |
| `released` | No capacity remains held. Released records cannot be reopened. |

Stable event keys plus request fingerprints make repeat usage, completion, and reconciliation calls idempotent. Reuse of a key with different measurements conflicts. Lease tokens are SHA-256 fingerprinted in the database and never returned from reservation or audit reads. Stale workers must still present the current run attempt and lease before changing usage.

The usage audit stores numeric measurements and sanitized event metadata only. Database triggers reject direct mutation of audit events and reservation identity/policy; parent workspace deletion can cascade with its owned Agent data. Cancellation, client disconnect, and provider timeout alone never prove remote quiescence.

## Schema and API behavior

Migration `015_agent_execution_quotas` adds `agent_execution_reservations` and `agent_execution_usage_events`, owner/workspace/run/attempt foreign keys, uniqueness, state/measurement constraints, budget and active-capacity indexes, and immutable-audit guards. It also allows the three quota error codes in the existing internal Agent error constraints. The migration runner sorts versions and skips applied entries; migration tests verify upgrade from 013, idempotent rerun, and late arrival of independent migration 014.

Quota errors use the existing common error DTO:

| Code | HTTP status | Retry header |
|---|---:|---|
| `RATE_LIMITED` | 429 | `Retry-After: 60` |
| `LIMIT_EXCEEDED` | 422 | None |
| `WORKSPACE_BUSY` | 409 | `Retry-After: 5` |

The API contract document records these as candidate errors for a future execution-enabled admission path. No existing public DTO or run-admission behavior is changed.

## Validation evidence

All commands below ran in the 17T-72 worktree. PostgreSQL tests used a disposable local PostgreSQL 18.4 cluster and a UTF-8 database created from `template0`; no cloud service or provider was enabled.

| Check | Command / environment | Result |
|---|---|---|
| API typecheck | `npm run typecheck --prefix apps/api` | Exit 0 |
| API build | `npm run build --prefix apps/api` | Exit 0 |
| Full API suite | `NODE_ENV=test`, `TEST_DATABASE_URL` unset; `npm test --prefix apps/api` | Exit 0; 559 tests, 531 passed, 28 skipped, 0 failed (51.2 s). Skips are tests explicitly requiring PostgreSQL features; the two quota concurrency cases were rerun on PostgreSQL below. |
| Quota and migration integration | `NODE_ENV=test`, `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/giga_quota_final_test`; `npx --prefix apps/api tsx --test --test-concurrency=1 apps/api/tests/agent/agent-quotas.test.ts apps/api/tests/agent/agent-migration.test.ts` | Exit 0; 19 tests passed, 0 skipped, 0 failed. Includes both cross-worker races, populated upgrade from 013, idempotency, late 014 application, direct audit mutation rejection, and workspace cascade deletion. |
| Diff whitespace | `git diff --check` | Exit 0 |

Web typecheck was not run because no frontend source or shared DTO package changed. Full API tests ran in memory mode for speed and broad coverage; they are not described as PostgreSQL tests. Real PostgreSQL coverage is separately recorded above.

## Remaining risks and review handoff

- The reservation interface is not wired to the current Agent execution path. 17T-73 must integrate and test admission, metering, cancellation, and cleanup before execution is enabled.
- Safe release after allocation depends on the 17T-71 sandbox-session lifecycle and its quiescence verifier.
- Dollar spend is not accounted because trustworthy user-scoped provider cost data is unavailable. Resource ceilings remain the enforcement policy.
- Runtime and cloud execution remain disabled; no live provider allocation or cloud provisioning was performed.
- GitHub Actions on the implementation commit: `Validate Git Workflow` run 144 passed; `Backend CI` run 80 passed its typecheck, build, and unit/integration suite against real PostgreSQL.
- The GitHub reviewer request for Linear's assigned reviewer was rejected because that user is not a repository collaborator. The connected Linear diff creator was also the assigned reviewer, so no self-review request is left active; an independent review request remains outstanding.
