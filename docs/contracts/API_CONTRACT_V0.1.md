# Giga API Contract v0.1 — DRAFT

> **Status:** PROPOSED / NOT IMPLEMENTED · **Date:** 2026-10-12 · **Primary:** Trà (backend) · **Reviewer:** Thư (frontend).
> This document is a frontend–backend interface proposal, not evidence of implemented endpoints. Review proposed routes and DTOs together at the W1 contract gate; mark the concrete v1 contract FROZEN only after W2 browser auth/SSE integration checks and compatibility tests pass.
> **Compatibility policy:** [ADR-001](../decisions/ADR-001-api-compatibility.md) · [Architecture Invariants](../architecture/INVARIANTS_V0.1.md). The **policy** is locked; the exact v1 endpoint schema remains DRAFT until sign-off.
> **References:** [Project Plan v0.1](../01-project-plan-v0.1.md) · [W1 daily plan](../planning/W01-daily-plan.md) · [Linear Giga](https://linear.app/17thedev/project/giga-cloud-mini-project-0656a578ee3b).

## 1. Principles

- Public API prefix: `/api/v1` (except `/health`). JSON properties use `camelCase`, timestamps use UTC ISO 8601, resource IDs are opaque strings (UUID initially).
- HTTPS only on public cloud. All protected endpoints require an authenticated session. No API keys or GitHub tokens are sent to the browser.
- Errors use a stable shape; validate all request bodies server-side; typed DTOs shared under `packages/contracts` after review.
- Streaming uses standard Server-Sent Events (SSE). For POST chat streams, the browser uses `fetch()` + readable stream, NOT native `EventSource` (which only sends GET).
- Routes and payloads below are tentative. Every change affecting compatibility must update this contract with a PR.

## 2. Common types

```ts
type ID = string;
type ISODateTime = string;
type User = { id: ID; email: string; displayName: string };
type Conversation = { id: ID; title: string; createdAt: ISODateTime; updatedAt: ISODateTime };
type Message = { id: ID; conversationId: ID; role: 'user' | 'assistant'; content: string; createdAt: ISODateTime };
type AgentRunStatus = 'queued' | 'running' | 'awaiting_approval' | 'applying' | 'completed' | 'failed' | 'cancelled';
type AgentRun = { id: ID; workspaceId: ID; status: AgentRunStatus; task: string; mode: 'ask' | 'plan' | 'execute'; runtime: 'cloud'; createdAt: ISODateTime; updatedAt: ISODateTime; result?: { summary: string; artifactIds: ID[] }; error?: ApiError };
// ChangeProposal is an OPTIONAL GitHub integration artifact, not a required Agent outcome.
type ChangeProposal = { id: ID; runId: ID; baseCommitSha: string; files: Array<{ path: string; status: 'added' | 'modified' | 'deleted'; unifiedDiff: string }>; createdAt: ISODateTime };
type ApiError = { code: string; message: string; details?: Record<string, unknown>; requestId?: string };
type ReasoningEffort = 'low' | 'medium' | 'high';
type ModelMetadata = {
  id: string;
  capabilities: ('text' | 'streaming' | 'structured' | 'embeddings' | 'tool_calling')[];
  reasoning: { supported: boolean; efforts: ReasoningEffort[] };
};
```

**JSON response convention:** one object for single-resource operations; collection responses contain `{ items: T[], nextCursor: string | null }`; failures contain `{ error: ApiError }`. HTTP status conveys success/failure.

**Recommended error codes:** `VALIDATION_ERROR` (400/422), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `RATE_LIMITED` (429), `UPSTREAM_ERROR` (502), `INTERNAL_ERROR` (500). Do not expose upstream secrets, stack traces, or sensitive prompts in public errors.

## 3. Auth & session

| Method | Path | Input | Output |
|---|---|---|---|
| POST | `/api/v1/auth/register` | `{ email, password, displayName }` | `201 { user }` |
| POST | `/api/v1/auth/login` | `{ email, password }` | `200 { user }` + session cookie |
| POST | `/api/v1/auth/logout` | session | `204` + expired cookie |
| GET | `/api/v1/auth/me` | session | `200 { user }` |

- Passwords must be hashed with a current password hashing algorithm (Argon2id recommended). Do not log raw passwords.
- **Proposed session:** server-managed session ID in `HttpOnly; Secure` cookie; browser sends credentials where necessary. All state-changing cookie-authenticated routes require CSRF protection and strict allowed origins.
- **Cloud deployment decision gate:** Render static site and API may be cross-site; cookie `SameSite` and browser third-party restrictions require real-browser testing. Prefer a same-origin API proxy/custom domain; if separate cross-site origins are retained, document browser support and implement correct `SameSite=None; Secure`, CORS and CSRF measures. Do not claim this is solved until W2 cloud test passes.
- Account registration may be restricted to demo users if public signups increase abuse risk.

## 4. Conversations & Chat

The [17T-37 Chat BYOK candidate](CHAT_BYOK_API_V0.1.md) adds optional,
owner-scoped encrypted Gemini credentials and a dedicated Chat preference.
Platform mode stays the default; API v1 remains DRAFT.

The [17T-41 Model Reasoning candidate](GIGACHAT_RUNTIME_API_V0.2.md#model-reasoning-capability-candidate--17t-41)
and [ADR-007](../decisions/ADR-007-model-reasoning-capability.md) add provider-agnostic
model reasoning controls (`reasoningEffort: 'low' | 'medium' | 'high'`) and trusted model capability
discovery via `GET /api/v1/models`.

The [17T-32 implementation candidate](GIGACHAT_RUNTIME_API_V0.2.md#implementation-candidate--17t-32)
specifies the first persisted POST stream + GET generation slice, required Idempotency-Key,
duplicate reconciliation and failed terminal events. The
[17T-34 durable Stop candidate](GIGACHAT_RUNTIME_API_V0.2.md#durable-stop-implementation-candidate--17t-34)
adds cancel, stopped state and a stopped SSE terminal. The
[17T-35 streamed variant candidate](GIGACHAT_RUNTIME_API_V0.2.md#streamed-retry--regenerate-candidate--17t-35)
adds latest-turn Retry/Regenerate SSE, variant inspection and completed-only selection.
API v1 remains DRAFT.

> **2026-10-13 approved product direction, proposed technical detail:** See [GigaChat Runtime v0.2](../architecture/GIGACHAT_RUNTIME_V0.2.md), [Shared LLM Engine v0.1](../architecture/LLM_ENGINE_V0.1.md) and [Runtime API/SSE addendum](GIGACHAT_RUNTIME_API_V0.2.md). The existing POST stream route and message.started/delta/completed core remain a DRAFT starting point. Generation status + Stop + streamed retry/regenerate transport, additive terminal events and idempotency header still require Trà/Thư compatibility review; they are **not implemented or frozen**.


| Method | Path | Input | Output |
|---|---|---|---|
| GET | `/api/v1/models` | session | `200 { models: ModelMetadata[] }` |
| GET | `/api/v1/conversations?cursor=&limit=20` | query pagination | `200 { items: Conversation[], nextCursor }` |
| POST | `/api/v1/conversations` | `{ title?: string }` | `201 { conversation }` |
| GET | `/api/v1/conversations/:id` | conversation ID | `200 { conversation, messages: Message[] }` |
| DELETE | `/api/v1/conversations/:id` | conversation ID | `204` |
| POST | `/api/v1/conversations/:id/messages:stream` | `{ content: string, modelId?: string, reasoningEffort?: 'low' \| 'medium' \| 'high' }` | `200 text/event-stream` |

**Streaming example** (each SSE `data:` is valid JSON):

```text
event: message.started
data: {"messageId":"msg_1","conversationId":"conv_1"}

event: message.delta
data: {"messageId":"msg_1","text":"Hello"}

event: message.completed
data: {"messageId":"msg_1","createdAt":"2026-10-12T00:00:00.000Z"}

```

- Server persists the user message and completed assistant result; decide on partial-response persistence in W2 design. Errors after a stream starts use `event: stream.error` followed by a terminal event/close, not an HTTP status rewrite.
- A single conversation must not initiate overlapping chat generations in v0.1 (`409 CONFLICT`). UI handles retry, abort, empty responses, rate limit and unauthenticated states.
- `modelId` is an allowlisted alias exposed by backend, not arbitrary provider/model parameters. MVP may offer just one model.

## 5. GigaAgent — Workspace-first Runs and Approvals (DRAFT v0.2)

The [17T-44 implementation candidate](GIGA_AGENT_API_V0.2.md#implementation-candidate--17t-44)
implements only blank Workspace create/list/get, Run create/list/get, and durable event
replay. No runner exists: admitted runs persist `failed` / `RUNTIME_UNAVAILABLE`.
The table below remains the broader proposal; files/messages/cancel/artifacts/approvals
are not implemented by this slice. See [ADR-008](../decisions/ADR-008-agent-control-plane-foundation.md).

> **Design direction changed 2026-10-13.** The GitHub-first repository→diff→PR design was an unfrozen draft, not a required Agent behavior. GigaAgent is now a general-purpose Agentic Workspace, independent from GigaChat. [Agent API v0.2](GIGA_AGENT_API_V0.2.md), [Architecture](../architecture/GIGA_AGENT_ARCHITECTURE_V0.2.md) and proposed [ADR-003](../decisions/ADR-003-agentic-workspace-and-isolated-runtime.md) are the current candidates. Only the 17T-44 subset above has an implementation candidate; nothing is FROZEN.

| Method | Route | Responsibility |
|---|---|---|
| POST | /api/v1/agent/workspaces | Create blank workspace; Git optional |
| GET | /api/v1/agent/workspaces | List authorized workspaces |
| GET | /api/v1/agent/workspaces/:id | Workspace metadata |
| GET | /api/v1/agent/workspaces/:id/files | Saved file tree |
| POST | /api/v1/agent/runs | Create run with workspaceId, task, mode, runtime |
| GET | /api/v1/agent/runs | List run history |
| GET | /api/v1/agent/runs/:id | Current run status and result |
| GET | /api/v1/agent/runs/:id/events | Replayable SSE |
| POST | /api/v1/agent/runs/:id/messages | Follow-up instructions |
| POST | /api/v1/agent/runs/:id/cancel | Safe cancellation |
| GET | /api/v1/agent/runs/:id/artifacts | Durable results and downloads |
| POST | /api/v1/agent/approvals/:id/decision | Decide exact privileged/external effect |

**Request**: { workspaceId, task, mode: 'ask'|'plan'|'execute', runtime:'cloud', modelId? }; no required repository/baseRef. GitHub import and PR publication are optional integrations.

**States**: queued, running, awaiting_approval, applying, completed, failed, cancelled. Within running, use an optional phase planning/executing/observing/verifying. Completed means evidenced task output, **not** PR creation. Applying is for approved external actions; normal sandbox file edits/builds stay running.

**SSE**: Keep proposed run.status, tool.started, tool.completed, run.completed, run.failed, heartbeat; new plan.updated, approval.required, artifact.ready are candidates requiring DTO/replay tests and Thư review. Store event IDs before broadcasting; Last-Event-ID reconnection cannot restart a task.

**Safety**: Hono/API host never executes model-generated shell. A separately isolated sandbox may run bounded code only after security/ADR approval. Ordinary authorized sandbox file writes need no GitHub-style review; privileged/external actions require explicit authenticated effect approval. Existing INV-07 remains controlling.

**Compatibility**: This replaces an unfrozen Agent-only draft. The Auth/Conversation/Chat SSE draft sections are unaffected.

## 6. HTTP status, security & UX acceptance tests

- Every resource is scoped to the authenticated user; another user requesting its ID gets `403` or `404` without information leakage.
- Unknown input fields rejected or stripped consistently; JSON body size/rate limits defined in config.
- Login invalid password returns generic error; logout clears the session; browser refresh preserves authorized state.
- Streaming works from deployed HTTPS web UI, including network abort and upstream error.
- Chat delete denies cross-user data access and does not leave orphaned user-visible records.
- Agent users cannot access another user's workspace/run/artifacts or approve another user's privileged effect; duplicate approval cannot duplicate external actions.
- CORS is origin-allowlisted; no wildcard with credentialed endpoints; CSRF policy tested from an unrelated origin.
- Health checks never expose connection strings or credentials.

## 7. Open questions — resolve at W1/W2 gate

- Auth deployment topology: same-origin reverse proxy or explicit cross-site cookie policy?
- Database schema details, message deletion semantics, TTL for run events?
- LLM provider/model selection, provider failure recovery and configurable user quotas?
- GitHub authentication: fine-grained token for a dedicated demo repository or GitHub App? Document exact permissions.
- Event replay mechanism and persistence strategy during Render service restarts?
- Whether agent proposals need a second confirmation when base branch changes?

## 8. Contract sign-off checklist

- [ ] Trà validates routes, persistence assumptions, run state machine and security.
- [ ] Thư validates full UX states, typed payloads, SSE handling and error/empty cases.
- [ ] Both validate authentication in deployed browser environment and cost limits.
- [ ] Freeze accepted DTOs under `packages/contracts` with mock fixtures and integration tests.

**Tracking:** [17T-8 API contract](https://linear.app/17thedev/issue/17T-8/w1-api-contract-va-database-design-v01).
