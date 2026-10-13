# GigaChat Generation REST + SSE API v0.2

> **DRAFT, NOT IMPLEMENTED OR FROZEN.** Product design accepted on 2026-10-13; exact endpoints, DTOs, new SSE event types and browser compatibility still require Trà/Thư review. Tracking [17T-25](https://linear.app/17thedev/issue/17T-25/specify-gigachat-runtime-and-shared-llm-engine-v02). Read [Runtime](../architecture/GIGACHAT_RUNTIME_V0.2.md), [LLM Engine](../architecture/LLM_ENGINE_V0.1.md), [API v0.1](API_CONTRACT_V0.1.md) and ADR-001.

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
