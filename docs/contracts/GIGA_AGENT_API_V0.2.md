# GigaAgent — Workspace-first REST/SSE API v0.2

> **DRAFT / NOT FROZEN.** Reconciled for [17T-68](https://linear.app/17thedev/issue/17T-68)
> against merged control plane, orchestrator, messages and sandbox adapter code.
> Owner: Trà (Backend/Agent); reviewer: Thư (Frontend/UX); independent security review pending.
> [ADR-001](../decisions/ADR-001-api-compatibility.md) governs compatibility. Joint sign-off,
> deployed browser checks and fixtures are required before freeze. Interfaces and mocks
> are not evidence that a public feature is operational.

## 1. Authority and implementation boundary

Public wiring: `createApp → createAgentRoutes → AgentService → AgentRepository.admitRun`.
It admits and persists runs but does not dispatch an execution worker. Every newly admitted
Ask/Plan/Execute run commits `failed` with `RUNTIME_UNAVAILABLE`. HTTP 201 means a durable
run was created, not that a task can execute. No Cloud runner is enabled.

Shared public types and runtime response validators:
[`agent.d.ts`](../../packages/contracts/agent.d.ts), [`agent.js`](../../packages/contracts/agent.js).
Backend `types.ts` re-exports public DTOs; worker leases, steps and sandbox sessions remain
internal. Web `agent-contract.ts` re-exports the same definitions. No DB migration.

### Implementation candidate — 17T-44

Workspace create/list/get, Run admission/list/get and durable event replay are implemented.
Blank Workspace means durable metadata, not a created directory or saved snapshot.
See [ADR-008](../decisions/ADR-008-agent-control-plane-foundation.md) and
[control-plane evidence](../evidence/17T-44-agent-control-plane.md).

### Merged foundations — 17T-45 / 17T-46 / 17T-47

- 17T-45: durable orchestration, steps/events, worker leases/fencing and deterministic fake
  runtime. Internal foundations only; public admission does not enqueue execution.
- 17T-46: persisted initial user message, message lists and idempotent follow-up to
  nonterminal runs. Normal public admission is terminal, so usable follow-up is disabled
  in discovery. Internal orchestration can persist bounded/redacted assistant/tool summaries.
- 17T-47: isolated sandbox adapter and simulated provider tests. No production provider
  dispatch, approved Cloud activation, public files or artifacts. Internal stop/cleanup
  methods do not implement the public cancel endpoint.

## 2. Implemented endpoint matrix

Prefix `/api/v1/agent`. All require a session cookie (401 `UNAUTHENTICATED` otherwise).
Ownership comes from the session; clients cannot select owner or permissions. Missing and
cross-owner resources return generic 404 `NOT_FOUND`. POSTs retain exact trusted-Origin/
Referer CSRF protection (403 `FORBIDDEN`). Unknown body/nested source fields are rejected.
Body bound: 100,000 bytes. Malformed JSON, oversized body and validation errors return
400 `VALIDATION_ERROR`, not 413. Unexpected failures use 500 `INTERNAL_ERROR` without secrets.

| Method / route | Request | Success DTO | Owner / cursor / idempotency | Status |
|---|---|---|---|---|
| GET `/capabilities` | No query parameters | 200 `AgentCapabilities` | Session only; no resource data; no-store | Implemented |
| POST `/workspaces` | `CreateAgentWorkspace` | 201 `{ workspace: AgentWorkspace }` | Session owner; no retry deduplication | Implemented |
| GET `/workspaces` | `limit?`, `cursor?` | 200 `Page<AgentWorkspace>` | Owner list; workspace cursor | Implemented |
| GET `/workspaces/:id` | UUID | 200 `{ workspace }` | Owned workspace or 404 | Implemented |
| POST `/runs` | `CreateAgentRun`, `Idempotency-Key` | 201 `{ run: AgentRun }`; 200 duplicate | Owned workspace; owner/key; mismatch 409 `CONFLICT` | Implemented admission; execution Disabled |
| GET `/runs` | `limit?`, `cursor?`, `workspaceId?` | 200 `Page<AgentRun>` | Owner list; owned workspace filter; run cursor | Implemented |
| GET `/runs/:id` | UUID | 200 `{ run }` | Owned run; PostgreSQL authoritative | Implemented |
| GET `/runs/:id/events` | `Last-Event-ID?`; no query | 200 `text/event-stream` | Owned run before cursor validation; per-run sequence | Implemented |
| GET `/runs/:id/messages` | `limit?`, `cursor?` | 200 `Page<AgentMessage>` | Owned run; ascending sequence cursor | Implemented |
| POST `/runs/:id/messages` | `CreateAgentMessage`, `Idempotency-Key` | 201 `{ message }`; 200 duplicate | Owned nonterminal run; owner/run/key; mismatch or terminal 409 | Implemented endpoint; usable follow-up Disabled |

All implemented routes can return 401; resource routes can return 404; validated inputs,
UUIDs and cursors can return 400; POSTs can return 403. Only keyed admissions use 409.
No implemented Agent route currently returns 202, 302, 429, 502 or runtime-unavailable HTTP
503. `RUNTIME_UNAVAILABLE` is a persisted run error inside successful admission, not an
HTTP error or an eighth run status.

## 3. Capability discovery

`GET /api/v1/agent/capabilities` returns this complete authenticated response with
`Cache-Control: private, no-store`. It reflects actual application wiring, not interface
existence, fake adapters, Chat config, environment credentials or client flags. No runtime
activation config is connected to public admission. Future discovery and real dispatch
must change together under runtime/security/cost gates.

```json
{
  "schemaVersion": 1,
  "capabilities": {
    "workspaceManagement": { "available": true },
    "runAdmission": { "available": true },
    "runHistory": { "available": true },
    "runExecution": { "available": false, "reason": "runtime_unavailable" },
    "ask": { "available": false, "reason": "runtime_unavailable" },
    "plan": { "available": false, "reason": "runtime_unavailable" },
    "execute": { "available": false, "reason": "runtime_unavailable" },
    "durableMessages": { "available": true },
    "followUp": { "available": false, "reason": "runtime_unavailable" },
    "eventReplay": { "available": true },
    "cancellation": { "available": false, "reason": "not_implemented" },
    "sandboxFiles": { "available": false, "reason": "not_implemented" },
    "artifacts": { "available": false, "reason": "not_implemented" },
    "artifactDownload": { "available": false, "reason": "not_implemented" },
    "externalApproval": { "available": false, "reason": "not_implemented" },
    "cloudRuntime": { "available": false, "reason": "runtime_unavailable" }
  }
}
```

`workspaceManagement`: create/list/get blank metadata only, not patch/delete/import.
`durableMessages`: read persisted conversations, including initial task. `followUp`: an
instruction can reach an active execution loop. `runAdmission` never enables execution
controls. Artifact listing/access and download have separate flags. No provider names,
credentials, worker/lease IDs, internal quotas or host paths appear in this response.

Server `agentCapabilitiesSchema.parse` requires complete, coherent known metadata and
projects public fields. Shared client `readAgentCapabilities(unknown)` follows these rules:

- Missing/invalid envelope or unknown schema version: every feature disabled.
- Missing known entry, invalid boolean, conflicting metadata or unknown reason: that entry
  becomes `{ available: false, reason: 'unknown' }`.
- Unknown capability names/additive fields ignored, never interpreted as permissions.
- Execution requires Cloud runtime and run admission; modes require execution; follow-up
  also requires durable messages; download requires artifacts. Inconsistent affirmative
  metadata fails closed; server schema rejects it.
- UI checks `isAgentCapabilityAvailable(response, name)` for explicit affirmative support.
  Auth/network errors still need error handling. A 401 never grants a capability.

Discovery is not an authorization token. All server resource/mutation checks remain active.

## 4. Public DTO compatibility

Shared response schemas validate required fields and project known public fields while
accepting additive fields. HTTP responses remain explicit repository projections, never
whole database rows or `ClaimedRun` objects.

| DTO | Actual public fields |
|---|---|
| `AgentWorkspace` | `id`, `name`, `sourceKind: 'blank'`, `revision`, `createdAt`, `updatedAt` |
| `AgentRun` | `id`, `workspaceId`, `task`, `mode`, `runtime: 'cloud'`, `modelId`, `status`, `createdAt`, `updatedAt`; optional `phase`, `finishedAt`, `error`, `result` |
| `AgentMessage` | `id`, `workspaceId`, `runId`, `sequence`, `role: 'user' \| 'assistant' \| 'tool_summary'`, `content`, `createdAt` |
| Run `result` | `summary`, `artifactIds: string[]`, `verifiedChecks: { name, outcome: 'passed' \| 'failed' \| 'not_run', summary? }[]` |
| Run `error` | `{ code: string, message: string }` |
| `Page<T>` | `{ items: T[], nextCursor: string \| null }` |

IDs: UUIDs; timestamps: UTC ISO with milliseconds. Seven statuses unchanged: `queued`,
`running`, `awaiting_approval`, `applying`, `completed`, `failed`, `cancelled`. Optional
phases: `waiting_runtime`, `planning`, `executing`, `observing`, `verifying`. Queued REST
rows currently expose `waiting_runtime`; orchestrator phases may appear in events without
being in REST projections. Enum support does not imply an operational public action.
Internal fake completions have empty `artifactIds`; artifact storage is not implemented.

Normal admission exposes only run error `RUNTIME_UNAVAILABLE`. Existing internal worker
paths can persist `STEP_LIMIT_EXCEEDED`, `TOOL_ERROR`, `EXECUTION_FAILED`,
`VERIFICATION_FAILED`, `CANCELLED`, `UNKNOWN_TOOL`, `INVALID_ARGUMENTS`, `POLICY_VIOLATION`,
`INTERNAL_ERROR`, `ABORTED`, `PERMANENT_ERROR`, `TIMEOUT`, `SECURITY_VIOLATION` and
`RUNTIME_UNAVAILABLE` (the decision-provider allowlist in `types.ts`). Error `code` remains
a string: clients must tolerate unknown additive codes and display safe `message`, not
reinterpret an unfamiliar code as success or a new public status. This task does not
wire those workers into public admission or alter existing internal error semantics.

Request types:

- `CreateAgentWorkspace`: `{ source: { kind: 'blank' }, name? }`; default `New Workspace`;
  supplied name trims to 1–255 UTF-8 bytes.
- `CreateAgentRun`: `{ workspaceId, task, mode?, runtime?, modelId? }`; defaults `ask`,
  `cloud`, sole alias `giga-agent-default`. Supplied values are strictly allowlisted.
- `CreateAgentMessage`: `{ content }`. Task/content trim to 1–16,384 UTF-8 bytes, reject NUL.
- No repository/baseRef, owner ID, native provider options, tool grants or client capabilities.

| Before | After 17T-68 | Impact / evidence |
|---|---|---|
| Backend local Workspace/Run/Message types | Same fields shared and re-exported | No response change; real API fixtures |
| No discovery | Authenticated capability metadata | Additive route; 401/fail-closed tests |
| Admission accepts modes, fails unavailable | Unchanged; discovery distinguishes execution | 201/200/409/replay regressions |
| Legacy web repository/baseRef/prUrl demo | Preserved; separate shared workspace boundary and discovery method | Legacy demo incompatible with real admission; needs Thư migration review |
| Proposal routes beside shipped routes | Explicit implemented/disabled/proposed matrix | No implied cancel/files/approval handler |
| Auth/Chat/Memory | Unchanged | Full API regressions |

Canonical fixtures: [`fixtures/agent.json`](../../packages/contracts/fixtures/agent.json),
checked against real responses and web consumers. Mock discovery uses the same disabled
runtime response. Historical `apps/web/mocks/agent` lifecycle/PR fixtures remain demos,
not current API fixtures. Full workspace UI migration is outside this task. No frontend
compatibility sign-off is claimed.

## 5. Idempotency and pagination

- Keys: 1–128 ASCII chars; first alphanumeric, rest alphanumeric or `._:-`. Missing/invalid
  required key is 400. Workspace creation has no idempotency semantics.
- Run key namespace: authenticated owner. SHA-256 fingerprints normalized workspace/task/
  mode/runtime/model. Defaults, UUID case and whitespace normalize before comparison.
  First admission 201, exact retry 200 with current persisted run, changed tuple 409.
  Run, initial message (migration 013), queued/failure events commit atomically. Replay
  creates no new messages/events/execution.
- Message namespace: authenticated owner + run. Fingerprint uses normalized user role/content.
  First 201, exact retry 200, changed content 409. Exact replay is checked before terminal
  conflict; new follow-up to terminal run is 409. Messages cannot escalate mode/tools,
  approve effects or modify worker leases.
- Workspace/run lists: default 20, max 100; `createdAt DESC, id DESC`. Base64url cursors bind
  collection kind and optional workspace filter, preserving PostgreSQL microseconds.
  UUID/time/calendar/query validation happens before SQL.
- Message list: **default 50**, max 100; `sequence ASC`, exclusive cursor bound to a run.
  This corrects the old document's default 20; implementation remains unchanged.
- One value per supported query parameter. Unknown/repeated params, noncanonical limits
  and malformed/mismatched cursors return 400. Cursors never authorize access; owner
  predicates still apply. Keyset pages are not transaction snapshots.

## 6. SSE replay and reconciliation

1. Authorize run before interpreting `Last-Event-ID`. Per-run cursor, never global.
   Missing/empty = 0. Canonical decimal integers 0–2,147,483,647; malformed/future IDs
   return 400 before headers. Query `after` is not implemented.
2. Replay strictly greater sequences ascending, at most 100 per DB read; drain committed
   pages before terminal close. Terminal cursor returns empty 200 SSE. Admission commits
   ID 1 `run.status` (`queued`, `waiting_runtime`) and ID 2 `run.failed`
   (`RUNTIME_UNAVAILABLE`) with failed row atomically. Historical queued replay cannot
   override a terminal run fetched from PostgreSQL.
3. Poll active durable state every 500 ms; nonpersisted `heartbeat` with `{}` and no ID
   every 15 seconds idle; close after 60 seconds observation. Disconnect, timeout,
   backpressure and DB failure close observation only, never execution or saved run state.
4. Client retains last processed ID separately per run, deduplicates replay and ignores
   unknown additive names/fields while advancing its cursor. Transport safely parses
   unknown names; Agent reducer/reconnect integration remains frontend work. Heartbeat
   is not completion or a new business event.
5. After disconnect/error/timeout, GET Run (PostgreSQL terminal state authoritative),
   reload messages as needed, reconnect with that run's last processed ID. Closed SSE
   never implies success. Refresh reconstructs via REST/replay, not browser-only state.
   No retention/truncation/replay-expired behavior is implemented yet.

Persisted admission/internal-orchestrator events:

| Event | Public data |
|---|---|
| `run.status` | `{ runId, status, phase? }` |
| `plan.updated` | `{ runId, version, steps: string[] }` summaries |
| `tool.started` | `{ runId, toolCallId, name, stepNumber }` |
| `tool.completed` | `{ runId, toolCallId, outcome: 'success', durationMs, summary? }` |
| `tool.failed` | `{ runId, toolCallId, code, summary }` |
| `run.completed` | `{ runId, artifactIds, verifiedChecks, summary? }` |
| `run.failed` | `{ runId, code, message }` |

Internal cancellation uses `run.status` with `cancelled`, not a new `run.cancelled` event.
No public cancel route. Results/events persist before observation. No raw tool bodies,
chain-of-thought, provider credentials or worker/lease metadata in public DTOs.
`approval.required`, `approval.decided`, `artifact.ready`, `run.phase` are future proposals.

## 7. Proposed endpoints — NOT IMPLEMENTED

These have no handlers: generic route 404, subject to existing auth/CSRF middleware.
Requests/responses/errors below are candidates only. Implementations must add session,
owner, validation, idempotency and lifecycle checks before claiming support.

| Method / route | Proposed request/result | Status |
|---|---|---|
| PATCH `/workspaces/:id` | name + expectedRevision → workspace; stale 409 | Proposed |
| DELETE `/workspaces/:id` | Authorized lifecycle/retention cleanup → 204 | Proposed |
| GET `/workspaces/:id/files` | Safe path → saved snapshot file tree | Proposed |
| GET `/workspaces/:id/files/content` | Bounded text → content/encoding/revision | Proposed |
| POST `/workspaces/:id/uploads` | Checked upload/import → upload metadata; protocol TBD | Proposed |
| POST `/runs/:id/cancel` | Idempotent bounded stop → truthful run/partial state | Proposed |
| GET `/runs/:id/steps` | Owner-scoped paginated safe step/verification DTO | Proposed |
| GET `/runs/:id/artifacts` | Owner-scoped durable artifact list/cursor | Proposed |
| GET `/artifacts/:id/download` | Short-lived authorized URL or streamed download | Proposed |
| GET `/approvals/:id` | Bounded external-effect approval DTO | Proposed |
| POST `/approvals/:id/decision` | decision + effectHash + idempotency → approval/run | Proposed |

External approvals must bind actor, run, exact action hash, target, expiry and current policy.
Normal isolated sandbox writes do not require a GitHub PR. Real runner activation remains
gated by [ADR-003](../decisions/ADR-003-agentic-workspace-and-isolated-runtime.md), locked
INV-07, security and cost approval. No host execution fallback. Legacy `/runs/:id/proposal`
and `/runs/:id/decision` are historical GitHub mock proposals, not shipped compatibility
adapters. No deployment, E2B provisioning or external effects are authorized by this contract.

## 8. Acceptance

See [17T-68 evidence](../evidence/17T-68-agent-api-capabilities.md) for exact commands,
results, HEAD SHA, CI links and review risks.

- [ ] Trà approves admission, DTOs, tenant filters, public events and capability mapping.
- [ ] Thư independently approves schema, disabled-mode UX, new workspace imports, mock
  separation, 201/200/409, message default 50 and per-run replay/dedup/reconciliation.
- [ ] Independent security review confirms no internal leak/grant escalation/Cloud execution.
- [ ] Deployed browser Auth/CSRF/SSE compatibility passes before explicit API freeze.

**No joint approval or API freeze is claimed.**
