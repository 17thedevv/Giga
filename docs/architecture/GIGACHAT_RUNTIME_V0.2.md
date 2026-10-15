# GigaChat Runtime v0.2 — Generation lifecycle

> **Product direction approved 2026-10-13. Broader technical design PROPOSED; first implementation slice pending review; API not frozen.** Backend: Trà; frontend/API reviewer: Thư. [17T-25](https://linear.app/17thedev/issue/17T-25/specify-gigachat-runtime-and-shared-llm-engine-v02). See [LLM Engine](LLM_ENGINE_V0.1.md), [API](../contracts/GIGACHAT_RUNTIME_API_V0.2.md), [ADR-004](../decisions/ADR-004-chat-generation-lifecycle.md) and [test plan](GIGACHAT_RUNTIME_TEST_PLAN_V0.2.md).

## 1. Responsibilities

Implementation candidate [17T-32](https://linear.app/17thedev/issue/17T-32) adds the first
persisted new-prompt streaming slice under `apps/api/src/modules/chat/`, using migration
005 and the injected Shared LLM Engine. [17T-34](https://linear.app/17thedev/issue/17T-34)
adds a durable Stop candidate with migration 006. The 17T-35 candidate adds latest-turn
Retry/Regenerate through the same coordinator and migration 007 selections. The 17T-36
candidate adds Gemini startup and migration 008 write-once resolved identity before
provider I/O ([ADR-005](../decisions/ADR-005-first-chat-provider.md)). Memory, Skills and usage/quota accounting
remain future work; the broader lifecycle below is still proposed. See the
[API implementation candidate](../contracts/GIGACHAT_RUNTIME_API_V0.2.md#implementation-candidate--17t-32)
for its limits and recovery behavior. The API remains DRAFT pending independent review.

The [durable Stop candidate](../contracts/GIGACHAT_RUNTIME_API_V0.2.md#durable-stop-implementation-candidate--17t-34)
commits intent before local abort. Completion and failure/interruption finalizers lock
conversation then generation and preserve one terminal winner. Local Stop persists the
runner's bounded buffer; remote Stop uses persisted checkpoints and is observed at the
next event/deadline. No instant cross-worker abort or background polling/sweeper is claimed.
Operation-key identity is retained separately from content to reject reuse after deletion.
Stop and browser disconnect remain distinct persisted states.

The [17T-35 DRAFT contract](../contracts/GIGACHAT_RUNTIME_API_V0.2.md#streamed-retry--regenerate-candidate--17t-35)
chooses POST `generations:stream` and latest-user-turn variant inspection. Admission locks
the owned conversation, validates the latest target and action, and reuses its user message.
Completion atomically inserts a new assistant, completes its generation and upserts one
`chat_turn_selections` row. Composite PostgreSQL foreign keys enforce same owner,
conversation and user plus completed status. Failure/Stop/interruption leaves selection
unchanged; old completed answers remain durable. History shows one selected answer per
turn; provider context excludes alternatives and the current target's old answer. Keys
distinguish prompt/cancel/retry/regenerate and retain content-free deletion tombstones.
Independent compatibility review by Thư remains pending; this is no API freeze.

GigaChat Runtime owns authorization, user-turn admission, context preparation, generation lifecycle, provider abort, SSE delivery, persistence and memory-extraction eligibility. Shared LLM Engine (a different module) owns model registry, provider calls, normalization and metering. GigaAgent calls LLM Engine but **never** Chat Runtime or GigaChat private memories implicitly. Nothing in this design implies running terminal commands on the Hono host.

17T-21 owns conversations/messages and forward migration 002. **Do not implement duplicate history tables or RAG in 17T-21.** 17T-22 owns personal Memory/RAG settings/retrieval and extraction jobs. Chat must work without embeddings.

~~~mermaid
flowchart TD
  UI[React Chat] -->|POST fetch SSE| API[Hono Auth CSRF API]
  API --> G[Chat Generation Coordinator]
  G --> DB[(Postgres History and Generations)]
  G --> C[Context Builder]
  C --> DB
  C -. consented .-> MEM[Owner-scoped Memory Retriever]
  G --> E[Shared LLM Engine]
  E --> P[Model Provider Adapter]
  G -->|SSE| UI
  G --> U[(Usage and Budget)]
  G -. completed and committed only .-> J[Memory Extraction Queue]
~~~

## 2. MVP behavior

| Concern | Rule | Deferred |
|---|---|---|
| Transport | Authenticated POST using fetch SSE | Durable streaming replay |
| Concurrency | One pending or streaming generation per conversation; DB guard | Branches |
| Stop | Explicit server-side cancel, provider AbortSignal, persist partial | Cross-runner orchestration |
| Disconnect | Abort and mark interrupted; refresh reads DB | Continue on reconnect |
| Retry | New generation from latest user message; new idempotency key | Earlier-turn retries |
| Regenerate | New candidate for latest user turn; preserve previous output | Conversation tree/branch UX |
| Persistence | Throttled partial checkpoints, final assistant message on completed commit | Per-token durable event log |
| RAG | Honor enabled and useInChat; ignore pending suggestions | Knowledge upload |
| Provider failure | No fabricated success, partial labeled | Cross-provider fallbacks |

A browser disconnect can be invisible to some proxies. Add no-output and wall-clock deadlines and stale-generation sweeper so active generation cannot remain permanently locked. Browser refresh does **not** restart a model call. A client abort alone does not guarantee upstream cancellation; the server must also receive/use the explicit Stop endpoint where possible.

## 3. Detailed flow

1. Validate session, CSRF/origin, payload, model alias, conversation ownership and per-user rate/quota. Cross-owner IDs yield non-disclosing 404.
2. Require Idempotency-Key; compute request fingerprint. Same key+same request may only reconcile an existing generation, **never** start a second provider call. Same key+different content -> 409. MVP POST streaming is not replayable: duplicate submissions resolve via GET generation status and conflict/reconciliation response.
3. Transaction: lock/guard active conversation; insert user message and pending generation and reserve resource budget exactly once, then commit. Retry/regenerate instead reuses latest user message and creates a new generation.
4. Fetch bounded complete history, actual current user request and optional owner-authorized active Memory only when enabled and useInChat. Fail open for **retrieval outage only** (continue without memory); never bypass authorization/consent.
5. Transition pending → streaming via compare-and-swap and call LLM Engine outside transaction with deadlines/AbortSignal. Emit message.started once after generation persisted.
6. Buffer text deltas safely with output/size limits and periodically checkpoint partial_content. Avoid one SQL write per token and never hold DB transaction across network calls.
7. Normal model completion: transactionally persist assistant message, completed generation, usage and eligible Memory extraction job. **Emit message.completed only after transaction commits.**
8. Explicit Stop: abort upstream, suppress late deltas, persist partial, finalize stopped, emit message.stopped if stream still connected.
9. Upstream/internal failure: finalize failed with redacted error and any partial text; emit stream.error then message.failed when still connected.
10. Network/proxy disconnect: abort and finalize interrupted (unless explicit Stop/Completion won DB terminal transition). UI fetches authoritative status; terminal event is not guaranteed to arrive.

The provider may ignore abort and bill extra tokens. Late upstream messages must never overwrite finalized state; termination/usage must be reconciled and disclosed honestly.

## 4. State machine and persistence model

~~~mermaid
stateDiagram-v2
  [*] --> pending
  pending --> streaming
  pending --> failed
  pending --> stopped
  pending --> interrupted
  streaming --> completed
  streaming --> stopped
  streaming --> failed
  streaming --> interrupted
~~~

Statuses: pending, streaming, completed, stopped, interrupted, failed. The last four are terminal in MVP. Terminal updates are guarded by generation revision/lease so Stop vs Completion has a single winner. **Completed** requires durable assistant message + final transaction; incomplete responses remain labeled partial and do not become completed context.

A database-level partial unique index on conversation_id for pending/streaming generations (or equivalent transactional guard) prevents multi-worker overlap. A startup/periodic sweeper finalizes lease-expired interrupted generations; worker fencing prevents stale writes.

Candidate data after 17T-21 schema review:
- chat_generations: id, owner_id, conversation_id, user_message_id, assistant_message_id?, model_alias, resolved_model_id, status, partial_content, checkpoint_version, idempotency_key, request_fingerprint, finish_reason, error_code, input/output usage?, created_at, started_at, finished_at, deadline_at.
- Optional assistant generation selection pointer if needed for last-turn regenerate. Preserve old candidates and choose latest completed assistant candidate for future context. Never accidentally inject two alternative assistants in one context.
- llm_usage_events and budget reservations: separate internal metering design in [LLM Engine](LLM_ENGINE_V0.1.md).

Only finalized completed turns trigger automatic Memory extraction. A failed/stopped/interrupted generation does not trigger extraction. If user deletes a conversation, cancel active generation and apply 17T-21/17T-22 source-deletion rules.

## 5. Context building

Budget input = actual model context window - output reserve - safety margin. Honor real provider tokenizer/capability; truncate entire low-priority old turns rather than corrupting roles/structured data. Keep server instructions, current user request, bounded recent complete turns and (if permitted) top-k active Memory with source/time. Never treat retrieved text as privileged instructions. No user chat history is implicitly available to GigaAgent.

Rolling conversation summary is deferred; it differs from long-term cross-conversation Memory. On memory retriever timeout, answer from recent history without pretending a memory was found.

## 6. Browser and distributed runtime rules

POST event-stream uses fetch, incremental TextDecoder and a parser that buffers arbitrary network chunk splits; one chunk is not one SSE event. Frontend prevents double-submit and updates provisional assistant content from message.delta. After reconnect/error/cancel it fetches persisted generation and conversation state. Unknown additive events are ignored only by a parser explicitly tested for that.

For single Hono instance, in-process AbortController map can signal the provider; still store durable cancel request/deadline. **For multi-instance deployment an in-memory map alone cannot cancel another instance's generation.** Require durable signal/polling/pubsub with worker-lease routing before claiming multiple replicas supported.

Before stream begins, errors use ordinary HTTP JSON. After headers, errors use stream.error and a terminal event when possible. A successful DB commit can precede a lost network terminal event: DB state is authoritative. Rate-limit both new generations and stop/retry endpoints.

## 7. Non-goals and pending deployment gates

No implementation, DB migrations, provider credentials, Cloud provisioning or API freeze in this documentation PR. Still to select and test: actual provider/model, tokenizer, quotas, hosted proxy idle timeout/flush behavior, CSRF/cookie topology, persistence schema after 17T-21, user-facing text for partial and retry. Hono and Cloud SSE behavior require **real browser** tests on deployed HTTPS topology before a contract freeze.
