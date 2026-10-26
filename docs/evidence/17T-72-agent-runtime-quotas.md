# 17T-72 — Agent execution quotas and workspace concurrency

**Status:** quota accounting follow-up implemented; independent review and runtime integration remain outstanding. The production 17T-71 lifecycle fence is still a blocker, so runtime execution stays disabled.

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

## Review follow-up — 2026-10-26

Validated implementation commit: `37001c45ce6d671763643366b6d48b565f96a1c6` on `feat/17t-72-agent-runtime-quotas`.

### Finding 1: reconciliation fencing

`reconcileAfterQuiescent()` no longer accepts a point-in-time boolean. Its lifecycle adapter must implement `fenceAttemptAndVerify()` with an exact-attempt durable fence and must wait for allocation/runtime operations to settle. The quota transaction then locks the `agent_runs` row before the reservation and refuses release while the same attempt still has a live run lease. `active` reservations are no longer reconcilable. Failure to establish the lifecycle fence or a still-live lease leaves `resource_active = true`.

The PostgreSQL regression test pauses the lifecycle fence, races the quota allocation-start gate, and verifies that reconciliation rejects and another writable run remains blocked. This checks the quota/run-lease boundary; it is not an end-to-end sandbox-provider race test.

**The production lifecycle fence is not implemented on this branch, so Finding 1 is not fully closed.** Inspection of the separate `feat/17t-71-agent-sandbox-sessions` checkout at `c98eb1d4d1f673aea8a92729592c71e2aff6ad73` found a durable session registry and an allocation-intent transaction that locks `agent_runs`. It did not provide a durable proof that an external allocation request has settled. In particular, `SandboxCleanupReconciler` marks an `allocating` session `failed` when its provider ID is absent; that state does not rule out a late provider response. The 17T-72 branch also has no concrete `QuotaQuiescenceVerifier` implementation or 17T-71 migration 014.

Required dependency before this can be treated as solved: 17T-71 must provide a durable exact-attempt fence serialized with allocation-intent creation, track an allocation RPC until it definitively settles (an expired intent or missing provider ID is ambiguous), and expose cleanup completion only after that operation is settled and any resulting sandbox is destroyed. 17T-73 must use the same fence for provider/tool operations and drain already-started work. Until those pieces are integrated, a missing or unavailable verifier must fail closed; runtime execution stays disabled. The existing 17T-71 checkout's six unrelated modified web files were left untouched.

### Finding 2: zero-usage reconciliation

Post-allocation reconciliation now preserves `committed` for both nonzero and zero final usage and only releases the writable slot by setting `resource_active = false`. Migration 015 requires writable `active` and `reconciliation_required` rows to retain their slot, disallows `reconciliation_required -> released`, and prevents any inactive reservation from becoming active again. Pre-allocation refunds remain `released` and terminal.

Real PostgreSQL regressions cover a committed zero-usage attempt, an ambiguous zero-usage attempt, repeated reconciliation, accurate zero accounting, late usage rejection, direct invalid transitions, and slot availability. Migration 015 upgrade-from-013, registry/file parity, idempotent rerun, and later independent migration 014 ordering tests also pass.

### Follow-up validation

| Check | Command / environment | Result |
|---|---|---|
| API typecheck | `npm run typecheck --prefix apps/api` | Exit 0 |
| API production build | `npm run build --prefix apps/api` | Exit 0 |
| Full API suite | `NODE_ENV=test`, `TEST_DATABASE_URL` unset; `npm test --prefix apps/api` | Exit 0; 562 tests, 531 passed, 31 PostgreSQL-specific skips, 0 failed |
| Isolated PostgreSQL quota and migration suite | `NODE_ENV=test`, disposable PostgreSQL 18.4 `giga_quota_review_test`; `npx --prefix apps/api tsx --test --test-concurrency=1 apps/api/tests/agent/agent-quotas.test.ts apps/api/tests/agent/agent-migration.test.ts` | Exit 0; 22 passed, 0 skipped, 0 failed |
| Git Workflow validator tests | `node --test .agents/scripts/validate-git-workflow.test.mjs` | Exit 0; 6 passed, 0 skipped, 0 failed |
| Whitespace check | `git diff --check` | Exit 0 |
| GitHub Actions on implementation commit `37001c45ce6d671763643366b6d48b565f96a1c6` | Backend CI run 82; Validate Git Workflow run 147 | Both completed successfully |

The first full-suite run was parallel to typecheck/build and hit one unrelated chat persistence ordering assertion when messages shared a millisecond timestamp. Rerunning the full suite by itself completed with 531 passed, 31 expected PostgreSQL-specific skips, and 0 failed.

The GitHub Actions above ran on the implementation commit; the evidence-only follow-up commit is checked separately on the PR. No production database, cloud service, sandbox provider, or runtime was enabled; no merge or deployment was performed.

## Review follow-up — 2026-10-26 (wall-clock and reconciliation finalization)

Implementation commit: `1b3b7368a4ec1a7790859ab234712ac894f347db` on `feat/17t-72-agent-runtime-quotas`.

### Finding 1: wall-clock accounting

PostgreSQL records `started_at` with `clock_timestamp()` at the `reserved -> active` allocation-start transition. The database trigger overwrites any supplied start value with its own clock and makes the timestamp immutable afterward; actual wall-clock usage cannot decrease. A reservation has no execution `deadlineAt` while it is queued. Once started, the deadline is `started_at + max_wall_clock_ms`, so queue time does not consume the execution limit.

Callers can no longer supply wall-clock usage. `recordUsage()`, `commitAttempt()` and `reconcileAfterQuiescent()` derive elapsed milliseconds in PostgreSQL from `clock_timestamp() - started_at`, round up to whole milliseconds, and never reduce previously persisted actual usage. `recordUsage()` preserves the existing `LIMIT_EXCEEDED` failure behavior when an in-flight measurement is already over its cap. Terminal commit and reconciliation persist the final DB-measured wall time and accounting even when it exceeds the limit; the terminal usage event records `limit_exceeded = true`, and the returned reservation exposes `limitExceeded = true`.

Real PostgreSQL regressions cover a started attempt with no usage events that exceeds its wall-clock cap before commit, queue delay before allocation start, and final wall-clock accounting through reconciliation and repeated calls.

### Finding 2: reconciliation finalization

The first successful reconciliation atomically inserts its `reconciled` audit event, commits final actual/accounted usage, releases `resource_active`, and records `reconciliation_event_key`. An exact duplicate key and request returns the finalized snapshot without adding an event or changing totals. A different key or changed measurement is rejected.

Migration 015 enforces the finalization boundary: the marker is only accepted with its matching reconciliation audit event; finalized actual/accounted usage, state, finish time, marker and slot state cannot be rewritten; new usage events cannot be inserted afterward; and committed capacity cannot be released without finalization or reactivated afterward. Tests exercise exact duplicate reconciliation, different-key and changed-measurement rejection, direct SQL accounting mutation, post-finalization event insertion, attempted early slot release and reactivation.

### Validation

| Check | Command / environment | Result |
|---|---|---|
| API typecheck | `npm run typecheck --prefix apps/api` | Exit 0 |
| API production build | `npm run build --prefix apps/api` | Exit 0 |
| Full API suite | `NODE_ENV=test`, `TEST_DATABASE_URL` unset; `npm test --prefix apps/api` | Exit 0; 565 tests, 531 passed, 34 PostgreSQL-specific skips, 0 failed |
| Isolated PostgreSQL quota and migration suite | PostgreSQL 18.4, disposable `giga_17t72_followup2_test`; `npx --prefix apps/api tsx --test --test-concurrency=1 apps/api/tests/agent/agent-quotas.test.ts apps/api/tests/agent/agent-migration.test.ts` | Exit 0; 25 passed, 0 skipped, 0 failed. Includes populated upgrade from 013, idempotent rerun, later independent 014 application, wall-clock regressions and finalization guards. |
| Git Workflow validator | `node --test .agents/scripts/validate-git-workflow.test.mjs` | Exit 0; 6 passed, 0 skipped, 0 failed |
| Whitespace check | `git diff --check` | Exit 0 |
| GitHub Actions on implementation commit `1b3b7368a4ec1a7790859ab234712ac894f347db` | [Backend CI run 84](https://github.com/17thedevv/Giga/actions/runs/40281947311); [Validate Git Workflow run 150](https://github.com/17thedevv/Giga/actions/runs/40281947253) | Both completed successfully on this exact SHA. |

The in-memory adapter cannot model PostgreSQL `timestamptz` subtraction. It retains prior wall-clock counters for broad unit runs; elapsed-time correctness and state-transition triggers are verified in the isolated PostgreSQL suite. The 17T-71 production lifecycle fence and 17T-73 runtime integration remain unresolved. There is still no end-to-end provider-allocation/cleanup/quota-release race proof. Keep the PR Draft and runtime disabled; do not mark this work merge-ready.
