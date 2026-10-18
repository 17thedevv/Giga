# 17T-68 — Agent API reconciliation and typed capability discovery

Status: **DRAFT / NOT FROZEN; independent review pending**.
Tracking: [Linear 17T-68](https://linear.app/17thedev/issue/17T-68).
Intended owner: Trà (Backend/Agent). Peer reviewer: Thư (Frontend/UX).
Security review is independent and not claimed by these self-checks. Linear was verified
as Todo at task start; no Done transition is authorized or performed.

## Checkout and delivery identity

- Initial checkout: clean `feat/17t-47-sandbox-preflight`, HEAD `9798670`.
- Fetched `origin/main`: `e7fe37a` (merged sandbox-preflight PR).
- Fast-forwarded local main, created `feat/17t-68-agent-api-contract` from that base.
- Validation scope: the code changes in this branch; exact implementation SHA and CI URLs
  are recorded below after publication. The PR metadata is authoritative for its current
  HEAD; a documentation commit cannot embed its own hash.
- No colleague changes were discarded, no force push, merge, deployment or Cloud provisioning.

## Endpoint implementation matrix

Prefix `/api/v1/agent`; every implemented route is authenticated. Resource routes use
session owner filters and generic 404s for missing/cross-owner IDs. POSTs use existing
Origin/Referer CSRF checks. Common errors: 400 `VALIDATION_ERROR`, 401 `UNAUTHENTICATED`,
403 `FORBIDDEN` on mutations, 404 `NOT_FOUND`, 409 `CONFLICT` for keyed admissions,
500 `INTERNAL_ERROR` for unexpected failures. Full input/response/error details are in
[the reconciled contract](../contracts/GIGA_AGENT_API_V0.2.md).

| Method / actual path | Request → response | Key / cursor / ownership | Status |
|---|---|---|---|
| GET `/capabilities` | No query → 200 `AgentCapabilities` | Session; no-store; no resource data | Implemented |
| POST `/workspaces` | `{ name?, source: { kind: 'blank' } }` → 201 `{ workspace }` | Session owner; no idempotency | Implemented |
| GET `/workspaces` | limit/cursor → `Page<AgentWorkspace>` | Owner list; createdAt/id descending | Implemented |
| GET `/workspaces/:id` | UUID → `{ workspace }` | Owned workspace or 404 | Implemented |
| POST `/runs` | workspaceId/task/mode?/runtime?/modelId? → `{ run }` | Owner/key; 201 new, 200 replay, 409 changed identity | Implemented admission; execution Disabled |
| GET `/runs` | limit/cursor/workspaceId? → `Page<AgentRun>` | Owner list; owned filter; createdAt/id descending | Implemented |
| GET `/runs/:id` | UUID → `{ run }` | Owned run; PostgreSQL terminal state | Implemented |
| GET `/runs/:id/events` | Last-Event-ID → SSE | Authorize first; exclusive per-run sequence | Implemented |
| GET `/runs/:id/messages` | limit/cursor → `Page<AgentMessage>` | Owned run; sequence ascending, default 50 | Implemented |
| POST `/runs/:id/messages` | `{ content }` → `{ message }` | Owner/run/key; 201/200; conflict/terminal 409 | Implemented endpoint; usable follow-up Disabled |

No handlers exist for the following proposed routes (generic route 404, not a feature promise):

| Method / proposed path | Status |
|---|---|
| PATCH / DELETE `/workspaces/:id` | Proposed |
| GET `/workspaces/:id/files` / `/workspaces/:id/files/content` | Proposed |
| POST `/workspaces/:id/uploads` | Proposed |
| POST `/runs/:id/cancel` | Proposed |
| GET `/runs/:id/steps` | Proposed |
| GET `/runs/:id/artifacts` | Proposed |
| GET `/artifacts/:id/download` | Proposed |
| GET `/approvals/:id` | Proposed |
| POST `/approvals/:id/decision` | Proposed |

17T-45 internal orchestration/fake runtime, 17T-46 message persistence and 17T-47 sandbox
adapter are present. Public admission still calls `admitRun`, not `enqueueRun`; no real
worker/provider dispatch is connected. Adapter stop/snapshot is not public cancel/files.
Normal admission persists a failed run with `RUNTIME_UNAVAILABLE`, plus queued/failure
events atomically, for all modes. No HTTP 503 or successful execution is newly introduced.

## Capability response and fail-closed consumer

Authenticated `GET /api/v1/agent/capabilities` returns `schemaVersion: 1` and a known-name
`capabilities` map. Available entry: `{ available: true }`. Unavailable entry:
`{ available: false, reason: 'runtime_unavailable' | 'not_implemented' | 'unknown' }`.

| Available now | Disabled: runtime unavailable | Unimplemented |
|---|---|---|
| workspaceManagement, runAdmission, runHistory, durableMessages, eventReplay | runExecution, ask, plan, execute, followUp, cloudRuntime | cancellation, sandboxFiles, artifacts, artifactDownload, externalApproval |

The complete JSON example is in the contract and shared fixture. `workspaceManagement`
is metadata create/list/get only. `durableMessages` supports read/reconstruction; follow-up
cannot reach an execution loop through normal terminal admission, so its capability is false.
Cloud provider interfaces, fake/simulated runtimes, Chat configuration or client input cannot
enable capabilities. Mapping changes must accompany reviewed changes to actual public wiring.

`agentCapabilitiesSchema` checks complete/coherent server responses. Shared
`readAgentCapabilities`/`isAgentCapabilityAvailable` disable missing/malformed/unknown
metadata, ignore unknown names/additive fields, and enforce execution/mode/message/artifact
prerequisites. Unknown versions disable all features. 401 remains an authentication error.
Discovery returns `Cache-Control: private, no-store`, rejects queries and exposes no provider,
credential, lease, worker, quota implementation or filesystem metadata.

## Public DTO compatibility and shared fixtures

- Existing `AgentWorkspace`, `AgentRun`, `AgentMessage`, result/check/page types moved into
  shared declarations and are re-exported by the backend. Field names, optionality, seven
  statuses and actual repository projections are unchanged. No persistence or event mutation.
- Shared runtime schemas validate and project known public fields while accepting additive
  response fields. Run errors remain string codes; unknown future codes do not mean success.
- Canonical `packages/contracts/fixtures/agent.json` covers metadata, unavailable run,
  initial message and capability response. API tests compare real responses after normalizing
  generated IDs/timestamps; web tests consume the same fixture and schema.
- New web shared boundary and `getAgentCapabilities()` in real/mock clients allow frontend
  integration without importing server internals. Discovery fixtures match exactly.
- Legacy GitHub demo types, UI and lifecycle mocks are preserved and explicitly labeled as
  incompatible with the actual workspace API. Full UI migration is not part of this task.
- Cross-boundary reason: `packages/contracts` is the canonical DTO/discovery boundary;
  narrow `apps/web` changes prove consumability and real/mock discovery parity; both CI path
  filters include shared contracts so subsequent shared-only changes trigger consumer checks.

| Old behavior | New behavior | Compatibility |
|---|---|---|
| Local backend DTO types | Shared identical declarations | Additive consumption; no existing wire change |
| No capability discovery | Authenticated complete discovery | Additive route |
| Accepted modes always fail unavailable | Same; explicitly advertise execution false | No status/error/admission change |
| Unknown/additive response metadata | Known fields projected; unknown/missing flags false | Forward-compatible and fail-closed |
| Message default documented as 20 | Document actual default 50 | Documentation correction only |
| Existing SSE/key/cursor behavior | Same behavior, now documented precisely | Existing plus new regression coverage |

## SSE and reconciliation

Last-Event-ID is per-run canonical decimal 0–2,147,483,647, missing/empty = 0. Authorize
before checking cursor; malformed/future IDs return 400. Replay is exclusive, ascending,
100 events per DB read, with terminal close/empty replay at terminal ID. Heartbeat has
no persisted ID. DB polling/heartbeat/subscription bounds remain 500 ms / 15 s / 60 s.
Disconnect/read failure never cancels/restarts a run. GET Run from PostgreSQL is
authoritative; clients retain/deduplicate a cursor per run, ignore unknown additive
events and reconcile REST/messages after disconnect. Generic web SSE transport tolerates
unknown names; full Agent UI reducer/reconnect behavior remains frontend integration work.

Workspace/run keyset cursors bind kind and workspace filter, preserving microseconds;
message cursors bind run/sequence. Lists reject invalid/unknown/repeated query params.
Limits stay 1–100; workspace/run default 20, messages 50. Keys remain owner-scoped (messages
also run-scoped). Exact replay cannot create duplicate messages/events/effects.

## Verification — actual local results

Environment: Windows, Node.js 24.20.0; PostgreSQL 18.4, newly initialized disposable cluster
on `127.0.0.1:56468`, dedicated `giga_capabilities_test`. No application/production database
was used. The repository test helper enforced `NODE_ENV=test` and `TEST_DATABASE_URL` safety.
Migration 001–013 applied to this test database; no migration source changed.

Commands below use cwd `apps/api` or `apps/web` as indicated. Local log files were kept
outside the repository. No raw secrets/log credentials are included in evidence.

| Command / scope | Result |
|---|---|
| API: `npx tsx --test --test-concurrency=1 tests/agent/agent-contract.test.ts` with dedicated PostgreSQL | PASS: 10 tests, 2 suites, 0 fail, 0 skipped |
| API: `npm test` with dedicated PostgreSQL | PASS: 477 tests, 66 suites, 0 fail, 0 skipped, 0 cancelled |
| API: `npm run typecheck` | PASS, exit 0 |
| API: `npm run build` | PASS, exit 0 |
| Import built `dist/modules/agent/capabilities.js` and assert Execute unavailable | PASS, exit 0; shared runtime resolves from compiled API |
| Web: `npx vitest run tests/agent-contract.test.ts` | PASS: 5 tests, 0 fail |
| Web: `npm test` | PASS: 111 tests, 10 files, 0 fail |
| Web: `npm run typecheck` | PASS, exit 0 |
| Web: `npm run build` | PASS, exit 0 |
| Root: `node --test .agents/scripts/validate-git-workflow.test.mjs` | PASS: 6 tests, 0 fail, 0 skipped |
| Root: `node .agents/scripts/validate-skills.mjs` | PASS: all 8 skills |
| Root: `git diff --check` | PASS |

Mandatory case mapping:

1. Cloud disabled: schema/HTTP fixture plus all modes still return truthful failed runs.
2. Missing/unknown capability metadata/version/reasons: shared contract and web consumer tests.
3. Additive fields/names: accepted and projected; no accidental feature enablement.
4. 401: missing/invalid session; client preserves auth failure.
5. Cross-owner: generic 404 equality for workspace/run/messages/events, including follow-up.
6. DTO compatibility: shared declarations, real fixture equality and malformed-field cases.
7. Pagination: new workspace cursor regression plus existing Agent/messages cursor suites.
8. Idempotency: 201/200/409 plus existing concurrent PostgreSQL/message cases.
9. SSE: exclusive replay/terminal reconciliation/new app instance plus existing disconnect,
   live-tail, heartbeat and paged replay tests; additive frame transport test on web.
10. No internals: claimed-worker, completed result, list, messages and event public projections;
    existing sandbox/redaction and tenant/lease security regressions run in the full suite.

No security test was skipped. No deployed-browser, real Cloud sandbox or paid-provider tests
were run: this task authorizes none of those environments/actions. They remain freeze/runtime
gates, not evidence supplied by unit tests.

## GitHub publication and CI

Implementation/test HEAD SHA: pending initial commit.
Draft PR and exact GitHub Actions run URLs/results: pending publication; update after checks.

## Changed files and review handoff

- `packages/contracts/agent.d.ts`, `agent.js`, `fixtures/agent.json`, `package.json`, `README.md`:
  private shared DTO/schema/fixtures with no third-party dependency or published package.
- `apps/api/src/modules/agent/{capabilities,routes,types}.ts`: truthful discovery and shared
  public DTO re-exports; `apps/api/tests/agent/agent-contract.test.ts`: runtime/API regressions.
- `apps/web/src/lib/api/{agent-contract,client,mock-adapter}.ts`, `tests/agent-contract.test.ts`,
  `mocks/README.md`: narrow typed consumer/discovery parity and historical fixture boundary.
- `.github/workflows/{api-ci,web-ci}.yml`: shared contract changes trigger both consumers.
- `docs/contracts/GIGA_AGENT_API_V0.2.md` and this evidence: reconciled implementation matrix.

NO-GO: real Cloud/Execute enablement, production writes, host execution, E2B provisioning,
deploy, auto-merge and Linear Done. No new framework, third-party dependency or migration.

Known limitations/review questions for Thư and independent reviewer:

- Confirm distinction between run admission/history and task execution, disabled Ask/Plan/
  Execute/follow-up UX, schema version policy and missing metadata fallback.
- Confirm new shared DTO imports, result/error handling, 201/200/409 semantics, message
  default 50, per-run cursor/dedup and terminal PostgreSQL reconciliation.
- Legacy Agent UI still uses historical GitHub demo shapes; full workspace integration and
  reducer/reconnect acceptance need frontend work/review. No colleague approval is inferred.
- Shared JS runtime and declaration files must remain in parity (fixtures exercise both).
  API source/dist requires the sibling `packages/contracts` tree; compiled import was tested.
  Any deployment packaging must retain that tree; no deployment was changed or verified.
- Capabilities describe current application wiring, not dynamic DB health or a permission
  grant. Runtime activation must update admission and mapping together with tests/review.
- No event retention protocol, public files/artifacts/cancel/approval routes or real runner;
  Cloud/security/cost and deployed browser gates remain open. API stays DRAFT / NOT FROZEN.
