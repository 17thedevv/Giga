# 17T-44 — Agent control-plane foundation verification and handoff

Date: 2026-10-16. Base: `e54ca18` (inspected current `origin/main` before implementation).
Issue: [17T-44](https://linear.app/17thedev/issue/17T-44).
Branch: `feat/17t-44-agent-control-plane`.
Linear assignee: `17thedev`; intended backend owner: Trà; reviewer: Thư.
Independent ChatGPT review requested by the user remains pending. No approval is claimed.

## Delivered scope / changed areas

- `apps/api/src/db/migrations/011_agent_control_plane.sql` and the matching migration
  registry entry create exactly three tables. Existing migrations/tables are unchanged.
- `agent_workspaces`: UUID ID, owner FK, name, blank-only source, revision, timestamps,
  owner/ID unique scope and owner/creation-time history index. No filesystem is created.
- `agent_runs`: UUID ID, owner + workspace composite FK, bounded task, mode, Cloud runtime,
  model alias, seven-status enum, persisted event counter, idempotency key/fingerprint,
  safe unavailable error and timestamps. Owner/key uniqueness prevents duplicate admission.
  CHECKs enforce terminal timestamps and failed/error consistency. History indexes support
  owner and owner/workspace lists. A trigger prevents admission identity and terminal rewrites.
- `agent_run_events`: owner/run composite FK, `(run_id, sequence)` primary key, constrained
  event/status/error fields and timestamp. Insertion locks the owner-matched run and validates
  next sequence/current state; updates are prohibited. Replay index is owner/run/sequence.
- `apps/api/src/modules/agent`: DTO validation, repository, admission service, routes,
  SSE observer, and an execution-runtime port with a no-effects unavailable adapter.
- `create-app.ts` wires the seven authenticated Agent endpoints whenever pool/Auth exist.
  Agent does not require Chat/provider configuration and does not access Chat Memory/credentials.
- Test helpers register the required pg-mem functions, handle exact-time cursor projection
  and clean up only isolated Agent fixture rows. Standalone migration test expects version 11.
- DRAFT Agent contract and ADR-008 define the implemented subset; architecture/security/test
  plans distinguish this foundation from the unimplemented execution plane.

## API / event semantics

Implemented: Workspace POST/list/get; Run POST/list/get; Run events GET. See the
[exact DRAFT DTOs](../contracts/GIGA_AGENT_API_V0.2.md#implementation-candidate--17t-44).

Run admission supports Ask/Plan/Execute, default Ask; runtime Cloud; allowlisted/default
`giga-agent-default`. It never dispatches a runner. A transaction saves queued event 1,
failed event 2 (`RUNTIME_UNAVAILABLE`), and the final failed row. New admission returns 201;
exact normalized key replay returns 200. Changed identity under the same owner/key is 409.

Fingerprint is SHA-256 of normalized workspace/task/mode/runtime/model. Workspace owner is
checked before key lookup. Unique owner/key arbitration covers concurrent requests even
across different owned workspaces. Duplicate requests create neither rows nor events.
Defaults, trimmed text and UUID case normalize consistently before hashing.

SSE emits persisted events in ascending per-run sequence, strictly after Last-Event-ID.
Missing/empty cursor is 0; malformed or future cursor is rejected before streaming after
owner authorization. Reads are bounded to 100 events; subsequent pages drain before a
terminal close. A captured committed high-water mark avoids dropping a concurrent terminal.
Idle heartbeat is ID-less, unpersisted, every 15 s; polling is every 500 ms. Subscriptions
expire after 60 s of active observation. Client cancellation, request abort, timeout,
backpressure and DB read failures never update or redispatch a run. GET/replay reconciles
disconnects. Unknown future event types must be ignored by clients; no frontend is added.

## Security and execution boundary

- Every Workspace, Run and Event repository query includes authenticated owner scope.
  Composite FKs add database protection. Cross-owner and missing IDs return identical
  generic 404s, including event replay and workspace-filtered history.
- Existing session and Origin/CSRF middleware apply. Unknown DTO/nested source/query fields,
  invalid modes/runtime/models, oversized bodies/text, invalid keys/cursors and nulls are rejected.
  Only internal constant table identifiers are interpolated; all request values are SQL parameters.
- Public projection contains no owner/key/fingerprint, raw provider/native config or session credentials.
  Event payloads are constructed from safe lifecycle fields, not arbitrary runtime output.
- TypeScript AST checks forbid host execution, dynamic evaluation, filesystem access and
  Chat/provider/credential imports in Agent source modules. The unavailable runtime port
  is exercised without effects; actual HTTP disconnect/reconnect is exercised on a local server.
- No `child_process` fallback, model-generated command execution, cloud resource provisioning,
  deployment, production write, secret rotation, GitHub integration, upload, artifact,
  approval, browser preview or local runner was added or performed.

## Checks executed

Environment: Windows PowerShell, Node 24.20.0, npm 11.19.0; `NODE_ENV=test`.
PostgreSQL 18.4 used a newly initialized disposable loopback-only cluster on port 56444,
database `giga_agent_test`. Ordinary application `DATABASE_URL` was not used. Existing
test safety checks verify the dedicated URL and active database identity before cleanup.
CI uses Node 22 / PostgreSQL 16; its results belong to the Draft PR checks.

| Command / action | Result |
|---|---|
| `npm run typecheck` in `apps/api` | PASS |
| `npm run build` in `apps/api` | PASS |
| `npx tsx --test --test-concurrency=1 tests/agent/*.test.ts tests/db-migrations.test.ts` with real PostgreSQL | PASS: 23 tests, 0 skipped |
| Full `npm test` with dedicated `TEST_DATABASE_URL` | PASS: 375 tests, 0 failed, 0 skipped |
| Full `npm test` with `TEST_DATABASE_URL` unset | PASS: 352 tests, 0 failed, 23 PostgreSQL-only skips |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | PASS: 6 tests |
| `git diff --check` | PASS |

The first full run exposed an isolated pg-mem migration fixture missing `char_length`;
that registration was added and the focused migration check rerun successfully. An initial
focused test also exposed pg-mem returning a row for `ON CONFLICT DO NOTHING RETURNING`;
explicit scoped replay lookup now preserves idempotency consistently. Neither issue is
hidden behind the final successful results.

PostgreSQL evidence includes:

- Populated migration 010 → 011 preserves Auth, Chat (including reasoning snapshots),
  Skills/preferences and encrypted BYOK tables exactly; SQL file matches registry and rerun is empty.
- Owner-matched FKs, enum/timestamp/error CHECKs, terminal/event mutation triggers, next-sequence
  allocation, duplicate/gap/state-mismatch rejection and history/replay indexes.
- Five simultaneous identical admissions produce exactly one 201 and four 200 responses,
  one run and two events; different-workspace same-key race produces one run and one conflict.
- Microsecond history cursors, atomic rollback on terminal-event failure, 106-event paged replay,
  live observation of a second connection's committed event, unpersisted heartbeat and real socket abort/reconnect.
- AG-01/02, AG-17/18 and AG-34 foundation cases are exercised; no task execution or completion is fabricated.

The 23 pg-mem skips comprise the 18 pre-existing PostgreSQL-specific cases plus five Agent
cases (two admission races, microsecond pagination, relational/CHECK guards and trigger fencing).
pg-mem does not prove those database guarantees; they execute against real PostgreSQL.

Reproduce from `apps/api`: set `NODE_ENV=test`, point `TEST_DATABASE_URL` at a dedicated
database whose name contains `test`, run typecheck/build and `npm test`. Unset that dedicated
URL for the pg-mem run. Do not substitute the application connection or reset a shared DB.

## Checks not executed / remaining blockers

- No real sandbox, live model/tool call, hosted HTTPS browser, deployment or cloud role-swap test.
  Backend socket tests are not deployed browser/cookie/CORS evidence. No runtime isolation is claimed.
- No formatter/linter script exists in the API manifest. No frontend code changed.
- No worker/queue dispatch, leases/fencing, quotas/budgets, saved snapshot, verified artifact
  or cancellation protocol is implemented. ADR-003 adoption, runner selection/isolation,
  egress/resource policy and explicit cloud cost authorization remain prerequisites.
- The broader Agent plan and MVP golden E2E remain unpassed. API v1 is DRAFT.
- Draft PR only; independent review and explicit human merge authorization remain required.

## Handoff

Migration is forward-only and additive; assess migration locking before eventual deployment.
Application rollback retains the new tables/data. PR description records the final SHA,
CI links, schema/DTO/SSE/idempotency guarantees and reviewer questions. No merge, issue Done
transition or colleague approval is claimed by this handoff.
