# Giga — Frontend-to-API Mapping Specification v0.1

> **Status:** DRAFT / PROPOSED · **Date:** 2026-10-13  
> **Author:** Tráng A Thư (Frontend / UX)  
> **Reviewer:** Trà (Backend / API)  
> **Linear Issue:** [17T-9](https://linear.app/17thedev/issue/17T-9/w1-ux-flows-wireframes-va-api-mocks)  
> **Companion Documents:** [UX Flow Blueprint](UX_FLOW_V0.1.md) · [Wireframes Blueprint](WIREFRAMES_V0.1.md) · [API Contract v0.1](../../contracts/API_CONTRACT_V0.1.md)

---

## 1. Principles & Mapping Rules

1. Every user interaction that triggers network traffic or server event stream handling is mapped explicitly.
2. If the current proposed contract (`docs/contracts/API_CONTRACT_V0.1.md`) does not define an endpoint, payload field, or lifecycle event required by the UI, it is flagged as `CONTRACT-QUESTION` for Trà (Backend owner) to review.
3. The frontend **never** treats an unconfirmed endpoint as settled architecture.
4. Approval writes require strict idempotency and zero optimistic status changes.

---

## 2. API Mapping Table

| UI Action | API Route/Event | Request | Response | UI State | Open Questions |
|---|---|---|---|---|---|
| **App Startup / Page Refresh** | `GET /api/v1/auth/me` | *Headers:* Cookie (session) | `200 { user: { id, email, displayName } }` | Authenticated shell rendered with user profile | What is the fallback if Render frontend and API are on different origins? Needs SameSite=None + Secure cookie or reverse proxy. |
| **App Startup (No Session / Expired)** | `GET /api/v1/auth/me` | *Headers:* Cookie (missing/invalid) | `401 { error: { code: "UNAUTHENTICATED", message: "..." } }` | Redirect to `/login` | None. |
| **Submit Login Form** | `POST /api/v1/auth/login` | *Body:* `{ email, password }` | `200 { user: { id, email, displayName } }` + `Set-Cookie` | Submitting (spinner) -> Success (navigate to `/chat`) | Should response also optionally return an explicit CSRF token if cookies are cross-site? *(CONTRACT-QUESTION)* |
| **Submit Login (Invalid Credentials)** | `POST /api/v1/auth/login` | *Body:* `{ email, password }` | `401 { error: { code: "UNAUTHENTICATED", message: "Invalid email or password" } }` | Error banner displayed; password input focused | Error message should remain generic to prevent account enumeration. |
| **Submit Login (Validation Failure)** | `POST /api/v1/auth/login` | *Body:* `{ email: "invalid", password: "" }` | `422 { error: { code: "VALIDATION_ERROR", details: { email: "...", password: "..." } } }` | Inline field error hints displayed | Ensure error format matches shared `ApiError.details`. |
| **Click Logout** | `POST /api/v1/auth/logout` | *Headers:* Cookie | `204 No Content` + expired cookie | Clear user cache; redirect to `/login` | None. |
| **Load Conversation List** | `GET /api/v1/conversations?cursor=&limit=20` | *Query:* `cursor`, `limit` | `200 { items: Conversation[], nextCursor: string \| null }` | Skeleton loader -> Populated sidebar list (or empty list placeholder) | Does the list return `lastMessage` preview snippet or just `title` and timestamps? *(CONTRACT-QUESTION)* |
| **Click "New Chat"** | `POST /api/v1/conversations` | *Body:* `{ title?: string }` (optional) | `201 { conversation: Conversation }` | Navigate to `/chat/:id`; focus composer | Can `title` be automatically generated from the first prompt, or should initial POST have empty title? *(CONTRACT-QUESTION)* |
| **Select Conversation from Sidebar** | `GET /api/v1/conversations/:id` | *Path:* `id` | `200 { conversation: Conversation, messages: Message[] }` | Skeleton loader -> Render full message history | Are messages paginated for very long chats, or always returned in full? *(CONTRACT-QUESTION)* |
| **Delete Conversation** | `DELETE /api/v1/conversations/:id` | *Path:* `id` | `204 No Content` | Confirmation modal -> Remove from sidebar; navigate to `/chat` | Should backend cascade delete messages or soft delete? |
| **Send Chat Message** | `POST /api/v1/conversations/:id/messages:stream` | *Body:* `{ content: string, modelId?: string }` | `200 text/event-stream` | Optimistic user bubble added; composer locked; Stop button active | If user aborts connection, does backend cancel upstream LLM call immediately? *(CONTRACT-QUESTION)* |
| **Receive Stream: Message Started** | `event: message.started` | None | `data: { messageId, conversationId }` | Assistant placeholder rendered with blinking cursor | None. |
| **Receive Stream: Message Delta** | `event: message.delta` | None | `data: { messageId, text: string }` | Markdown buffer updated; auto-scroll latest token | None. |
| **Receive Stream: Message Completed** | `event: message.completed` | None | `data: { messageId, createdAt: string }` | Blinking cursor removed; composer re-enabled; message finalized | None. |
| **Receive Stream: Error Event** | `event: stream.error` | None | `data: { code: string, message: string }` | Inline error box with "Retry" action; composer re-enabled | Does server persist partial message before error or discard it? *(CONTRACT-QUESTION)* |
| **Click "Stop Generation"** | Client `AbortController.abort()` | Network abort on fetch stream | Connection terminated | Assistant bubble marked `[Generation stopped]`; composer unlocked | Should client send an explicit `POST /api/v1/conversations/:id/messages/abort` endpoint to ensure server stops LLM generation? *(CONTRACT-QUESTION)* |
| **Overlapping Chat Submit** | `POST /api/v1/conversations/:id/messages:stream` | *Body:* `{ content }` | `409 { error: { code: "CONFLICT", message: "Generation in progress" } }` | Warning toast displayed; composer restored | None. |
| **Rate Limit Exceeded** | `POST /api/v1/conversations/:id/messages:stream` | *Body:* `{ content }` | `429 { error: { code: "RATE_LIMITED", message: "Quota exceeded" } }` | Rate limit alert banner with retry countdown | None. |
| **Launch Coding Agent Run** | `POST /api/v1/agent/runs` | *Body:* `{ task: string, repository: string, baseRef?: string }` | `201 { run: AgentRun }` | Button disabled with spinner -> Navigate to `/agent/runs/:id` | What validation rules apply to `repository`? (e.g. only allowlisted demo repositories in v0.1). *(CONTRACT-QUESTION)* |
| **Connect Live Agent Events** | `GET /api/v1/agent/runs/:id/events` | *Path:* `id`; *Header:* `Last-Event-ID` | `200 text/event-stream` | Connect indicator green; timeline initializes | If connection drops and reconnects with `Last-Event-ID`, does server replay missed events? *(CONTRACT-QUESTION)* |
| **Receive Event: Status Update** | `event: run.status` | None | `data: { status: AgentRunStatus }` | Status badge updates (`running`, `awaiting_approval`, etc.) | None. |
| **Receive Event: Tool Started** | `event: tool.started` | None | `data: { tool: string, path?: string, query?: string, stepNumber?: number }` | Step added to execution timeline with spinning icon | What is the exact payload structure of `tool.started`? *(CONTRACT-QUESTION)* |
| **Receive Event: Tool Completed** | `event: tool.completed` | None | `data: { tool: string, status: "success" \| "error", durationMs: number, summary?: string }` | Step marked with checkmark; duration displayed; collapsible output enabled | None. |
| **Receive Event: Proposal Ready** | `event: proposal.ready` | None | `data: { runId: string, proposalId: string }` | Trigger `GET /api/v1/agent/runs/:id/proposal` fetch | None. |
| **Receive Event: Heartbeat** | `event: heartbeat` | None | `data: { timestamp: string }` | Heartbeat timestamp updated; stream health verified | Every how many seconds is heartbeat sent? (Proposed: 15s). *(CONTRACT-QUESTION)* |
| **Receive Event: Run Completed** | `event: run.completed` | None | `data: { runId: string, prUrl?: string, prNumber?: number }` | UI transitions from `applying` to `completed`; PR link displayed | Is `prUrl` sent in `run.completed` event data or inside `AgentRun`? *(CONTRACT-QUESTION)* |
| **Receive Event: Run Failed** | `event: run.failed` | None | `data: { code: string, message: string }` | Status badge turns red (`failed`); diagnostic box shown | None. |
| **Click "Cancel Run"** | `POST /api/v1/agent/runs/:id/cancel` | *Path:* `id` | `202 { run: AgentRun }` | Timeline status marked `cancelled`; buttons disabled | If run is already in `applying` (creating PR), what does cancel return? (`409 Conflict`). |
| **Fetch Proposal Diff** | `GET /api/v1/agent/runs/:id/proposal` | *Path:* `id` | `200 { proposal: ChangeProposal }` | Diff viewer loads files and unified diff hunks | Does `ChangeProposal` include line change stats (`additions`, `deletions`) or must frontend calculate them from `unifiedDiff`? *(CONTRACT-QUESTION)* |
| **Proposal Not Ready Yet** | `GET /api/v1/agent/runs/:id/proposal` | *Path:* `id` | `404 { error: { code: "NOT_FOUND", message: "Proposal not generated yet" } }` | Diff viewer shows placeholder *"Generating diff..."* | None. |
| **Click "Approve Proposal"** | `POST /api/v1/agent/runs/:id/decision` | *Body:* `{ proposalId: string, decision: "approve" }` | `202 { run: { status: "applying" } }` | Confirmation dialog -> `applying` state (actions disabled, spinner active) | Should request support `Idempotency-Key` header to protect network retries? *(CONTRACT-QUESTION)* |
| **Click "Reject Proposal"** | `POST /api/v1/agent/runs/:id/decision` | *Body:* `{ proposalId: string, decision: "reject" }` | `202 { run: { status: "cancelled" } }` | `cancelled` state rendered; diff marked rejected | None. |
| **Decision on Stale Proposal** | `POST /api/v1/agent/runs/:id/decision` | *Body:* `{ proposalId, decision: "approve" }` | `409 { error: { code: "STALE_PROPOSAL", message: "Base commit SHA has diverged" } }` | Conflict banner displayed; action buttons locked; CTA to start new task | Does backend return the current HEAD commit SHA in `error.details`? *(CONTRACT-QUESTION)* |
| **Duplicate Decision Click** | `POST /api/v1/agent/runs/:id/decision` | *Body:* `{ proposalId, decision: "approve" }` | `409 { error: { code: "CONFLICT", message: "Decision already recorded" } }` | Client ignores if already in `applying` or `completed` state | Frontend must disable buttons immediately on click. |
| **Browse Past Agent Runs** | *No endpoint in draft contract* | None | *Needs endpoint* | Empty run history in sidebar | **CONTRACT-QUESTION:** Does backend provide `GET /api/v1/agent/runs?cursor=&limit=20` so user can see past runs? |
| **Rename Conversation Title** | *No endpoint in draft contract* | None | *Needs endpoint* | Inline title editor disabled | **CONTRACT-QUESTION:** Does backend support `PATCH /api/v1/conversations/:id` with `{ title: string }`? |

---

## 3. Open Contract Questions for Trà (Backend Review)

The following items are designated **`CONTRACT-QUESTION`** and require alignment before the API contract can be frozen:

### 1. Agent Run Listing Endpoint (`GET /api/v1/agent/runs`)
- **Current State:** The draft contract specifies `POST /api/v1/agent/runs` and `GET /api/v1/agent/runs/:id`, but lacks a collection endpoint (`GET /api/v1/agent/runs`).
- **Frontend Need:** The Agent sidebar needs to list past agent runs so users can revisit previous diffs, logs, and created PR links.
- **Proposed Signature:** `GET /api/v1/agent/runs?cursor=&limit=20` returning `{ items: AgentRun[], nextCursor: string | null }`.

### 2. GitHub Pull Request Metadata in Completed Agent Run
- **Current State:** `AgentRun` type in draft contract only defines `{ id, status, task, repository, createdAt, updatedAt, error? }`. When status reaches `completed`, where are the resulting GitHub Pull Request URL (`prUrl`) and PR number (`prNumber`) stored?
- **Frontend Need:** The UI must display a clickable external link to the created PR.
- **Proposed Signature:** Extend `AgentRun` with optional `result?: { prUrl: string; prNumber: number; branch: string; commitSha: string }` or include this in the `run.completed` event data.

### 3. Server-side Cancellation of LLM Chat Stream
- **Current State:** UI calls `fetch()` and can close the response reader via `AbortController.abort()`.
- **Frontend Need:** Does the Hono backend detect client disconnects and immediately abort the upstream LLM provider API call to prevent wasted token budget, or should the frontend send an explicit `POST /api/v1/conversations/:id/messages/abort`?

### 4. Diff Statistics in Change Proposal
- **Current State:** `ChangeProposal.files` currently provides `Array<{ path: string; status: 'added' | 'modified' | 'deleted'; unifiedDiff: string }>`.
- **Frontend Need:** The file sidebar and diff header need `additions` and `deletions` counts.
- **Proposal:** Either backend pre-calculates `{ additions: number, deletions: number }` per file, or frontend parses the unified diff headers locally. Having backend provide it improves consistency.

### 5. Rename Conversation Title
- **Current State:** No `PATCH /api/v1/conversations/:id` endpoint exists.
- **Frontend Need:** Can users edit conversation titles, or does the server auto-generate titles after the first exchange?

### 6. Idempotency Key for Decision Writes
- **Current State:** The contract states approval is single-use and idempotent, and suggests an `Idempotency-Key` header.
- **Frontend Proposal:** Frontend will send `Idempotency-Key: <uuid>` on `POST /api/v1/agent/runs/:id/decision` to guarantee retries due to transient network drops do not trigger duplicate operations. Please confirm backend support.
