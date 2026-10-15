# GigaChat Generation REST + SSE API v0.2

> **DRAFT, NOT FROZEN.** Product design accepted on 2026-10-13; exact endpoints, DTOs, new SSE event types and browser compatibility still require Trà/Thư review. Tracking [17T-25](https://linear.app/17thedev/issue/17T-25/specify-gigachat-runtime-and-shared-llm-engine-v02). Read [Runtime](../architecture/GIGACHAT_RUNTIME_V0.2.md), [LLM Engine](../architecture/LLM_ENGINE_V0.1.md), [API v0.1](API_CONTRACT_V0.1.md) and ADR-001.

## Durable Stop implementation candidate — 17T-34

This DRAFT addition follows [17T-32](https://linear.app/17thedev/issue/17T-32) and is the
backend candidate for [17T-33](https://linear.app/17thedev/issue/17T-33) consumers.
Thư review is pending. No frontend control or Retry/Regenerate transport is added.

| Existing behavior | Addition | Compatibility / review |
|---|---|---|
| POST stream and GET generation | POST `/api/v1/conversations/:id/generations/:generationId/cancel` | Additive; same session/strict Origin/CSRF middleware |
| Five generation statuses | Terminal `stopped`, finish reason `cancelled`, optional `cancelRequestedAt` | DTO enum extension requires consumer review |
| completed / failed SSE terminal | `message.stopped` | Parser must recognize exactly one terminal |
| Prompt keys | Shared owner-scoped prompt/cancel key namespace | Keys cannot switch operation or generation, including after deletion |

Cancel accepts **zero body bytes**; `{}`, null, whitespace and provider/model fields yield
400 `VALIDATION_ERROR`. Required Idempotency-Key uses the same 1–128 ASCII character
policy as prompt admission. Missing/invalid session yields 401, invalid Origin yields 403,
and cross-owner or mismatched conversation/generation IDs yield non-disclosing 404 before
any abort or key binding. No provider/model information is accepted.

| Cancel outcome | HTTP / envelope |
|---|---|
| Valid key on pending/streaming generation | 202 `{generation}`; intent has committed |
| Same key while still active with intent | 202 `{generation}`; original intent timestamp preserved |
| Same key after finalization | 200 `{generation}`; authoritative terminal DTO unchanged |
| Fresh key on an already completed/failed/interrupted/stopped row | 200 `{generation}`; generation unchanged; operation key bound |
| This owner's key already belongs to another generation or prompt operation | 409 `{error:{code:'CONFLICT',message}}`, even for terminal targets |

202 means durable intent, not guaranteed provider shutdown. It may return pending/streaming
with `cancelRequestedAt`; GET or the original SSE reconciles finalization. Without a local
run, cancel finalizes stopped from persisted partial text before responding. With a local
run, provider abort occurs only after intent commits; the runner finalizes its full bounded
buffer. A stopped generation has no assistant message or error. Provider finish `stop`
still means normal completion; user Stop means `cancelled`.

Connected SSE after Stop wins is one `message.started`, zero or more `message.delta`,
then exactly one terminal:

```text
event: message.stopped
data: {"messageId":"assistant-id","generationId":"generation-id","finishReason":"cancelled"}
```

Ordinary Stop emits no `stream.error`, `message.failed` or `message.completed`. A disconnected
stream may receive no terminal; GET remains authoritative. Browser abort without durable
cancel remains interrupted. If completion commits first, cancel returns unchanged completed
state. If intent commits first, completion cannot insert an assistant message. All
finalizers lock conversation then generation and preserve the terminal winner.

Migration 006 replaces 005's generated status/finish CHECKs by explicit names, preserves the
completed check and active index, and guards terminal status changes. `chat_operation_keys`
is the equivalent durable cancel identity: `(owner_id,idempotency_key)` binds operation +
generation and backfills existing prompt keys. Identity tombstones store no prompt/output
and survive conversation deletion until owner deletion, preventing reuse for another
operation. Another owner's independent key namespace grants no access to this owner.

The local registry is capped at 256 controllers per coordinator, owner-checked, registered
only during `run()` and removed in `finally`. Overflow uses the failed-stream path with
safe code `RUNTIME_CAPACITY`. Immediate abort works only for the **same coordinator instance**.
No cross-worker signal, LISTEN/NOTIFY or background polling is implemented. A different
coordinator finalizes stopped from the last persisted checkpoint. The owning runner reads
DB state before accepting each normalized event and fences completion transactionally;
it observes remote Stop at the next event or existing deadline. Remote Stop can preserve
only checkpointed partial text; uncheckpointed memory is not shared. These are DB reads,
not a per-token durable write log.

If DB access fails after intent commits, stopped finalization may be delayed. A known
ordinary Stop fabricates no failed/success terminal. GET, repeated cancel or stale-admission
recovery reconciles state. Review questions: 202/200 semantics, enum/event extension, key
retention, remote checkpoint behavior and deployed-browser compatibility. API v1 is DRAFT.

## Implementation candidate — 17T-32

This first backend slice implements only POST `messages:stream` and GET generation reconciliation.
The original slice deferred Cancel (now specified above). Retry/Regenerate,
model discovery, assistant variants, Memory, Skills composition, usage and quotas are deferred.

| Previous draft/mock behavior | This implementation candidate | Consumers / compatibility |
|---|---|---|
| POST content/modelId without an idempotency header | Same route/body, required `Idempotency-Key` | Draft mock clients must add the header; requires Thư review |
| started/delta/completed | Existing fields preserved, `generationId` added | Fetch SSE parser must tolerate the added field |
| stream.error and close | `stream.error` immediately followed by terminal `message.failed` | New terminal event requires consumer review |
| No generation reconciliation | Owner-scoped GET returns `{generation}` | Additive; no existing history DTO changes |
| Existing session + strict Origin/CSRF | Same middleware and non-disclosing cross-owner 404 | Auth semantics preserved |

Candidate details under review:

- Body is a strict object with nonblank `content` (at most 16,384 UTF-8 bytes), optional
  `modelId` equal to `giga-chat-default`. Content is preserved verbatim. Unknown fields,
  null model aliases, unsupported aliases and invalid JSON return 400 `VALIDATION_ERROR`.
  Encoded request body limit is 100,000 bytes.
- Key is 1–128 ASCII characters: first a letter/digit, then letters/digits or `._:-`.
  Missing/malformed keys return 400. Uniqueness is scoped to the authenticated owner.
  Fingerprint covers conversation ID, exact content and normalized model alias. Omitted
  alias and explicit default alias are equivalent.
- Same key/fingerprint returns 409 `{error:{code:'CONFLICT',message},generation}` for
  pending, active or terminal generations. No SSE replay or provider repeat. Same key with
  another payload/conversation returns ordinary 409 without the original generation.
- Without an injected LLM Engine, admission returns 503 `SERVICE_UNAVAILABLE` before
  inserting a prompt. GET remains available. No automatic fake or live provider exists.
- Persisted statuses in this slice are `pending | streaming | completed | failed | interrupted`.
  GET always returns `partialContent` (empty initially, complete text on success), and
  omits absent optional fields. It exposes no owner ID, fingerprint, key or provider data.
  `assistantMessageId` exists only after successful final commit. The provisional SSE
  `messageId` equals the generation UUID; that UUID becomes the persisted assistant ID.
- Every connected stream emits one started, zero or more deltas, and one completed or
  failed terminal event. A post-header error emits diagnostic `stream.error` immediately
  before `message.failed`; both include `{messageId,generationId,error:{code,message}}`.
  Error text is fixed and redacted. Candidate safe codes are `GENERATION_FAILED`,
  `UPSTREAM_ERROR`, `GENERATION_TIMEOUT`, `OUTPUT_LIMIT`, `INTERRUPTED` and
  `SERVICE_UNAVAILABLE`. Raw provider errors never appear in SSE/GET.
- Completion commits assistant insertion + generation state atomically before emitting
  `message.completed`. A terminal write failure cannot downgrade completed DB state.
  A disconnect may prevent terminal delivery; GET is authoritative.
- Output/partial content is capped at 65,536 UTF-8 bytes. Context contains at most 40
  previous complete persisted messages plus the current persisted prompt, capped at
  65,536 UTF-8 bytes; old messages are removed whole. Failed/interrupted user turns and
  partial output are excluded. These are transport bounds, not a claim of model token fit.
- Provider reads use 15s idle and 90s total deadlines; downstream writes are bounded at 5s.
  Disconnect aborts the provider and records interrupted when the DB is available. Partial
  checkpoints occur after 4KiB growth or 1s elapsed at the next delta, plus finalization.
  Admission reclaims active rows older than 120s as interrupted; stale writes are fenced by
  terminal status. There is no background sweeper in this slice. After worker loss, GET
  may remain active until the next admission reclaims it. Persistent DB outages can delay
  finalization; no completed event is fabricated.

Review questions remain open: duplicate reconciliation status/envelope, byte/context limits,
deadline/recovery policy, provisional IDs and safe error codes, frontend terminal parser
fixtures, real model token budget, and the separate Retry/Regenerate transport/variant design.
No deployed-browser or contract-freeze approval is implied.

## 1. Compatibility impact

| Existing DRAFT | Proposed behavior | Impact |
|---|---|---|
| POST /api/v1/conversations/:id/messages:stream | Same route; request still content/modelId; add Idempotency-Key header | A new required header is breaking for draft mock clients; agree before implementation |
| message.started/delta/completed | Preserve event names and required existing fields; optionally include generationId | Additive only if client tolerates unknown fields |
| stream.error then close | stream.error diagnostic followed by message.failed terminal; message.stopped for stop | **New event names require review and fixtures** |
| No stop/reconcile API | Add GET generation status and POST cancel | Additive routes |
| One active generation | DB-enforced, same observable restriction | Behavior clarified |
| Legacy single message per response | Preserve assistant variants for last-turn regenerate; choose a current variant | GET conversation DTO needs reviewed extension |

Auth and Agent API are unaffected. The canonical public v1 remains **DRAFT** under ADR-001.

## 2. Candidate endpoints

| Method | Path | Request | Result |
|---|---|---|---|
| POST | /api/v1/conversations/:id/messages:stream | JSON {content,modelId?}; Idempotency-Key | 200 text/event-stream |
| GET | /api/v1/conversations/:id/generations/:generationId | none | 200 {generation} |
| POST | /api/v1/conversations/:id/generations/:generationId/cancel | empty; Idempotency-Key | 202 {generation} means stop requested, not necessarily finished |
| POST | /api/v1/conversations/:id/generations | JSON {userMessageId,action:'retry' or 'regenerate',modelId?}; Idempotency-Key | **Transport unresolved**: cannot claim streamed regeneration from plain 202 without a companion stream channel |
| GET | /api/v1/models | none | Optional MVP discovery; server allowlisted aliases only |

**Important:** The original POST messages:stream creates a *new user message*. Retry/Regenerate must reuse a prior user message, so whether to use a dedicated streaming POST or creation plus GET event stream is an **open contract gate**. Implementing plain 202 without a stream must not silently pretend regenerate provides tokens. Prioritize new messages and Stop in first functional slice; implement Regenerate after a reviewed transport/DTO decision.

All endpoints require session. POST uses hardened Origin/CSRF and ownership; guessed cross-user IDs yield non-disclosing 404. Model aliases cannot become arbitrary provider names.

## 3. Candidate Generation DTO

~~~ts
type GenerationStatus = 'pending' | 'streaming' | 'completed' |
  'stopped' | 'interrupted' | 'failed';
interface ChatGeneration {
  id: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId?: string;
  modelId: string;
  status: GenerationStatus;
  partialContent?: string;
  finishReason?: 'stop' | 'length' | 'cancelled' | 'other';
  error?: { code: string; message: string };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequestedAt?: string;
}
~~~

An incomplete generation remains explicitly partial. GET generation is the source of truth after disconnect or race. A completed answer has a persisted assistant message; no fabricated assistant output on provider failure.

## 4. SSE protocol proposal

~~~text
event: message.started
data: {"messageId":"assistant-id","generationId":"generation-id","conversationId":"conversation-id"}

event: message.delta
data: {"messageId":"assistant-id","generationId":"generation-id","text":"Hello"}

event: message.completed
data: {"messageId":"assistant-id","generationId":"generation-id","createdAt":"2026-10-13T08:00:00.000Z","finishReason":"stop"}
~~~

Valid sequence while connected: message.started once, zero or more message.delta, then exactly one terminal **message.completed** / **message.stopped** / **message.failed**. On error **stream.error** is diagnostic just before message.failed, not a second terminal event. A disconnected browser may receive no terminal; GET status reconciles persisted state. Heartbeats are non-business events.

Before streaming, errors are ordinary HTTP JSON. After headers, no attempt to rewrite HTTP status. Completed SSE MUST be emitted only after successful final transaction. If DB commit succeeds but SSE write fails, generation remains completed. Browser parser must buffer byte chunks/UTF-8 and tolerate unknown additive events after explicit fixtures are accepted.

## 5. Cancel, idempotency and retry

POST cancel authenticates owner, records cancel intent, signals the correct provider AbortSignal and returns **requested** (not guaranteed). Stop vs completed races resolve to one DB-terminal winner; repeated requests return the actual terminal state according to a status rule reviewed before freeze.

Unique Idempotency-Key scoped by user and operation fingerprint. Duplicate same key must NEVER call provider or insert user message twice; changed payload with same key -> 409. For MVP non-replayable POST, duplicate live request should return reconciliation information, not a pretend fresh stream. A conscious Retry uses a new key and generation ID on the most recent user turn. Regenerate preserves previous assistant variants and must not contaminate later context with all variants.

## 6. Error semantics and required review

| Case | Candidate behavior |
|---|---|
| Missing session / invalid Origin | 401 / 403, no LLM call |
| Cross-owner conversation or generation | 404 |
| Unsupported model | 400 VALIDATION_ERROR |
| Quota/rate exceeded | 429 RATE_LIMITED |
| Active generation already present | 409 CONFLICT |
| Reused key, changed request | 409 CONFLICT |
| Provider unavailable before headers | 502 or persisted failed response per admission boundary |
| Provider error after SSE begins | stream.error + message.failed; partial persisted |
| Stop | 202 request accepted; later GET stopped/completed/failed |
| Lost network | GET authoritative interrupted or completed state |

- [ ] Thư signs off new event names and parser behavior.
- [ ] Both choose actual streamed Retry/Regenerate protocol and assistant variant DTO.
- [ ] Both agree repeated cancel and idempotency reconciliation response codes.
- [ ] Trà verifies transactional completion, owner scope, CSRF, downstream abort and quotas.
- [ ] Actual HTTPS browser+Cloud verifies streaming flush, cookie/CSRF and disconnect.
- [ ] API remains DRAFT until contract tests and ADR-001 freeze gate.
