# GigaAgent — Workspace-first REST/SSE API Proposal v0.2

> **STATUS: DRAFT / NOT IMPLEMENTED / NOT FROZEN.** Trà (Backend) + Thư (Frontend) must review exact route, DTO, statuses, SSE payloads and security. This candidate updates the historical GitHub-first agent assumptions in [canonical API v0.1](API_CONTRACT_V0.1.md) while retaining shared Auth/Chat semantics. [ADR-001](../decisions/ADR-001-api-compatibility.md) controls actual freeze/compatibility; [17T-24](https://linear.app/17thedev/issue/17T-24/redesign-gigaagent-as-agentic-workspace-with-sandbox-runtime).

## 1. Conventions / authority

- Prefix /api/v1, UTC ISO timestamps, UUID resource IDs, camelCase response fields.
- Session cookie Auth, CSRF + exact Origin checks for mutating requests, no arbitrary userId as ownership authority, HTTPS on public deployment.
- Collection shape { items: T[], nextCursor: string | null }; one-resource shape { workspace | run | artifact | approval }.
- Errors { error: { code, message, details?, requestId? } }. Use 400 VALIDATION_ERROR, 401 UNAUTHENTICATED, 403 FORBIDDEN, 404 NOT_FOUND (including cross-owner), 409 CONFLICT, 413 PAYLOAD_TOO_LARGE, 429 RATE_LIMITED, 502 UPSTREAM_ERROR or 503 runtime unavailable as reviewed.
- Never return raw provider tokens, sandbox credentials, private system prompts, unredacted tool environment, non-owner paths or direct object-storage keys.
- "run completed" means **actual verified task outcome**, not a mandatory GitHub PR. The Agent API does NOT require a repository, baseRef, GitHub account or PR URL.

## 2. Candidate endpoints

| Method | Path | Request | Response / result |
|---|---|---|---|
| POST | /api/v1/agent/workspaces | name?, source: { kind:'blank' } | 201 { workspace } |
| GET | /api/v1/agent/workspaces?cursor=&limit= | pagination | 200 { items, nextCursor } |
| GET | /api/v1/agent/workspaces/:id | none | 200 { workspace } |
| PATCH | /api/v1/agent/workspaces/:id | name? + expectedRevision | 200 { workspace }, 409 stale |
| DELETE | /api/v1/agent/workspaces/:id | none | 204 after authorized lifecycle cleanup (retention clarified) |
| GET | /api/v1/agent/workspaces/:id/files?path= | directory path | 200 { items: FileEntry[] } from saved snapshot |
| GET | /api/v1/agent/workspaces/:id/files/content?path= | file path | 200 { path, content, encoding, revision } for bounded text |
| POST | /api/v1/agent/workspaces/:id/uploads | multipart / signed upload flow (TBD) | 202 { uploadId, status } (later milestone) |
| GET | /api/v1/agent/runs?cursor=&limit= | pagination, optional workspaceId | 200 { items, nextCursor } |
| POST | /api/v1/agent/runs | { workspaceId, task, mode?, runtime?, modelId? } | 201 { run } |
| GET | /api/v1/agent/runs/:id | none | 200 { run } |
| GET | /api/v1/agent/runs/:id/events | Last-Event-ID or after cursor | 200 text/event-stream |
| POST | /api/v1/agent/runs/:id/messages | { content }, Idempotency-Key | 202 { message, run } or documented 409 terminal |
| POST | /api/v1/agent/runs/:id/cancel | empty, Idempotency-Key | 202 { run } or 409 when irreversible external effect |
| GET | /api/v1/agent/runs/:id/steps | pagination | 200 { items, nextCursor } |
| GET | /api/v1/agent/runs/:id/artifacts | none | 200 { items, nextCursor } |
| GET | /api/v1/agent/artifacts/:id/download | none | 302 to short-lived authorized URL OR streamed download, never direct permanent storage key |
| GET | /api/v1/agent/approvals/:id | none | 200 { approval } |
| POST | /api/v1/agent/approvals/:id/decision | { decision:'approve'|'reject', effectHash }, Idempotency-Key | 202 { approval, run } |

**MVP reduction:** workspace create/list/get/files, run create/list/get/events/cancel, steps, artifacts/download and approval decision are first priority. Upload/patch/delete/workspace editor content may be deferred until secure artifact/snapshot protocols are ready. Explicitly document the implemented subset and mock the rest; do not claim all endpoints available from this proposal.

## 3. DTO examples (types to migrate to packages/contracts only after review)

~~~ts
type AgentMode = 'ask' | 'plan' | 'execute';
type AgentPublicStatus =
  | 'queued' | 'running' | 'awaiting_approval'
  | 'applying' | 'completed' | 'failed' | 'cancelled';
type AgentPhase = 'planning' | 'executing' | 'observing' | 'verifying' | 'waiting_runtime';

interface AgentWorkspace {
  id: string;
  name: string;
  sourceKind: 'blank' | 'upload' | 'import';
  revision: number;
  activeSnapshotId?: string;
  createdAt: string;
  updatedAt: string;
}
interface AgentRun {
  id: string;
  workspaceId: string;
  task: string;
  mode: AgentMode;
  runtime: 'cloud';  // local runner is future capability
  modelId: string;   // allowlisted alias, not arbitrary provider options
  status: AgentPublicStatus;
  phase?: AgentPhase; // optional progress
  createdAt: string;
  updatedAt: string;
  result?: {
    summary: string;
    artifactIds: string[];
    verifiedChecks: Array<{ name: string; outcome: 'passed'|'failed'|'not_run' }>;
  };
  error?: { code: string; message: string };
}
interface FileEntry {
  name: string; path: string; kind: 'file'|'directory';
  sizeBytes?: number; sha256?: string;
}
interface AgentArtifact {
  id: string; runId: string; name: string; mimeType: string;
  sizeBytes: number; sha256: string; createdAt: string;
  expiresAt?: string;
}
interface AgentApproval {
  id: string; runId: string; actionSummary: string; target: string;
  effectHash: string; status: 'pending'|'approved'|'rejected'|'expired';
  expiresAt: string;
}
~~~

**New-run request** (without GitHub):

~~~json
{
  "workspaceId": "a20bf2e1-ab87-4fd7-a92a-d1df98fc81db",
  "task": "Build a responsive React task manager, run build and fix errors.",
  "mode": "execute",
  "runtime": "cloud",
  "modelId": "default"
}
~~~

Return 201 { run }, with run.status=queued. Server verifies workspace owner, mode policy, runner availability/quota, allowed model alias, task length and Idempotency-Key for retries; no caller-supplied owner ID. Failure to allocate an expensive runtime may return queued with an explicit quota/availability policy, not an unbounded promise.

**Workspace create:** POST { "name":"Task Manager", "source":{"kind":"blank"} } => 201 { workspace } with revision=1. Future imports must be bound to grants and checksums; no arbitrary GitHub URL can silently grant access.

## 4. Runs and messages

POST messages is for safe follow-up instruction, **not a second independent run initiation**. During running it may queue a user instruction for next agent turn; during awaiting_approval it must not silently approve an action or change the exact frozen effect. For completed/failed/cancelled, prefer 409 + offer a new run within same workspace (or separately reviewed resume protocol). Cap message length, apply CSRF/owner checks and idempotency. Do not allow a message to grant tools/runner capabilities.

Ask: no mutations; Plan: read-only inspection and plan artifact; Execute: normal sandbox file edits/build tools within policy. An Ask/Plan user cannot escalate to Execute by sending text; mode changes require a separate reviewed endpoint or new run.

## 5. Agent SSE protocol

GET events uses EventSource/standard SSE with credentials per reviewed deployment topology; Last-Event-ID is **per-run** monotonic sequence, not global wall-clock timestamp. On connect, confirm owner, fetch saved run/current state, replay bounded events after given ID and continue live until terminal. When old event history expired, return a documented replay-expired behavior and fetch current run + steps (not invented events). Payloads redact full file bodies, secrets and private tool output.

Candidate event types (additive relative to initial draft, pending reviewer check):

| Event | Data | Meaning |
|---|---|---|
| run.status | { runId, status, phase? } | Public lifecycle |
| plan.updated | { runId, version, steps: safe summaries[] } | New plan |
| tool.started | { runId, toolCallId, name, stepNumber } | Tool dispatch |
| tool.completed | { runId, toolCallId, outcome, durationMs, summary? } | Tool result |
| tool.failed | { runId, toolCallId, code, summary } | Tool failure |
| approval.required | { runId, approvalId, actionSummary, expiresAt } | Explicit human action |
| artifact.ready | { runId, artifactId, name } | Durable result available |
| run.completed | { runId, artifactIds, verifiedChecks } | Terminal completion |
| run.failed | { runId, code, message } | Terminal failure |
| heartbeat | empty / safe timestamp | Connection keepalive |

Example:

~~~text
id: 12
event: tool.started
data: {"runId":"...","toolCallId":"...","name":"run_tests","stepNumber":3}

id: 13
event: tool.completed
data: {"runId":"...","toolCallId":"...","outcome":"success","durationMs":2150}

id: 14
event: artifact.ready
data: {"runId":"...","artifactId":"...","name":"project.zip"}

id: 15
event: run.completed
data: {"runId":"...","artifactIds":["..."],"verifiedChecks":[{"name":"npm run build","outcome":"passed"}]}
~~~

**Ordering:** persist the result and its event durably before broadcasting. On reconnect, resend saved events with duplicate IDs safely ignored by frontend. Unknown event types must not crash clients. Heartbeat is not a persisted business-state transition. An unavailable stream does not cancel the background task.

## 6. Approval and cancellation

Approval represents a bounded **external/privileged** action. It is NOT required to edit a normal file inside a disposable authorized sandbox. Approval must bind authenticated user, run, exact canonical effect hash, target/params, expiry, current policy and privileges. Race with cancellation/revocation must fail securely. A repeated idempotent decision returns prior accepted decision; a conflicting request is 409.

The historical POST /agent/runs/:id/decision (proposalId, approve/reject) is **superseded for new generic Agent design** by /agent/approvals/:id/decision. Because contract is DRAFT, document this migration rather than implementing two inconsistent interpretations. If old mock clients still require legacy path, implement a temporary explicit adapter after review, never silently repurpose it.

Cancel uses best-effort stop of an isolated runner. For external effects already dispatched, report indeterminate/committed facts and reconcile; 409 may mean cannot guarantee safe cancellation. Mark completed only on proven saved outcome, not because frontend optimistic state updated.

## 7. Errors, quotas, UX response matrix

| Scenario | Status / code | UX |
|---|---|---|
| No session or invalid CSRF | 401/403 | Sign in or retry safely |
| Cross-owner run/workspace ID | 404 NOT_FOUND | Generic missing state |
| Invalid mode/tool config | 400 VALIDATION_ERROR | Inline feedback |
| Outdated snapshot revision | 409 CONFLICT | Refresh/rebase workspace |
| Workspace busy writable session | 409 CONFLICT | Queue/read-only options |
| Runner unavailable/cold start | 503 RUNTIME_UNAVAILABLE or queued with declared timeout | Progress/error guidance |
| Budget exceeded | 429 RATE_LIMITED at admission; terminal run.failed with LIMIT_EXCEEDED in background | Show usage and partial artifacts |
| File too large/unsafe archive | 413 PAYLOAD_TOO_LARGE / validation | File feedback |
| Need permission | run awaiting_approval + approval.required | Review specific effect |
| Stale/expired approval | 409 CONFLICT | Inspect/restart explicit action |
| LLM/API failure | 502 UPSTREAM_ERROR / run.failed | Retry/new run after policy |
| Snapshot/artifact not ready | 404 or 409 by agreed contract | Loading and retry |
| Stop while external effect exists | 409 or accepted with partial/indeterminate status | Honest remote state |

## 8. Compatibility matrix: legacy draft versus proposal

| Previously drafted | New preferred direction | Impact |
|---|---|---|
| POST agent/runs {task,repository,baseRef?} | POST agent/runs {workspaceId,task,mode,runtime,modelId?} | **Breaking vs old draft**; not yet FROZEN. Frontend mock must update |
| Every run tied to GitHub | Repository import optional | Product change |
| GET agent/runs/:id/proposal required | Artifacts/steps, optional proposal when action needs approval | Remove GitHub-only assumption; preserve old mock as historical |
| POST agent/runs/:id/decision | POST agent/approvals/:id/decision | Proposed replacement; review migrations |
| Run.completed implies PR URL | Run.completed means evidenced task result | Client semantics change |
| Seven public statuses | Keep seven draft statuses; optional phase | Minimize client break |
| SSE run.status/tool.started/tool.completed etc. | Same core + plan.updated/approval/artifact (draft additions) | Additive only after parser tests |
| Chat SSE / conversations | **Unchanged** | No Chat coupling |

## 9. Contract acceptance

- [ ] Trà approves route and runtime permission semantics, tenant filters, worker/event durability and response shapes.
- [ ] Thư approves Agent Manager/Editor loading, refresh, pending approval, file tree, editor, terminal, preview and artifact UX.
- [ ] Shared DTOs/fixtures, API negative tests, SSE replay/unknown events and CSRF browser tests pass before API freeze.
- [ ] Optional GitHub integration has its own later contract/grants and never blocks empty-workspace run.
- [ ] No API path here is claimed available in main; the existing mock frontend is not proof of implementation.
