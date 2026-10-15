# GigaChat Runtime / LLM Engine — Verification v0.2

> **Broader test plan; the 17T-32/34 backend subsets have scoped execution evidence.** [17T-25](https://linear.app/17thedev/issue/17T-25/specify-gigachat-runtime-and-shared-llm-engine-v02). Owner Trà, frontend reviewer Thư. [Runtime](GIGACHAT_RUNTIME_V0.2.md) · [LLM Engine](LLM_ENGINE_V0.1.md) · [API](../contracts/GIGACHAT_RUNTIME_API_V0.2.md).

17T-32 implements automated coverage under `apps/api/tests/chat/chat-runtime.test.ts` for
CHAT-01/02/05/06/07/08/09/12/19/20, strict model/key/body validation, auth/CSRF, bounded
context/output/checkpoints, disconnect/deadline behavior, lazy stale-state recovery and
deletion fencing. PostgreSQL-only assertions cover concurrent row locks, partial uniqueness
and admission rollback. See [scoped execution evidence](../evidence/17t-32-chat-runtime.md).
This does not establish Stop, Retry/Regenerate, Memory, quotas, real provider or deployed
browser acceptance from the broader matrix.

## Test levels

17T-34 adds backend tests for CHAT-03/18/21: pending and active cancellation, original HTTP
SSE stopped delivery, partial preservation, owner/CSRF/key guards, operation-key conflicts,
unchanged terminal rows, disconnect versus Stop, deletion and empty controller registry
after every terminal path. PostgreSQL tests prove both race winners (including observed
cancel lock waiting), concurrent duplicate cancellation and terminal transition constraints.
A populated migration-005 schema is upgraded by 006 and reapplied without row loss.
See [17T-34 evidence](../evidence/17t-34-chat-cancel.md). Browser/real-provider acceptance
and Retry/Regenerate remain outside this backend slice.

- Unit: deterministic fake provider stream, token budgeting, AbortSignal, error and malformed output.
- Contract: runtime-validated JSON/SSE fixtures, UTF-8 parser split across arbitrary chunks, unknown-event tolerance.
- Integration: guarded disposable real PostgreSQL, 17T-23 test DB safety, migrations only after 17T-21; no fallback to pg-mem for Postgres-specific assertions.
- Browser/cloud: actual HTTPS origin, secure cookies/CSRF, streaming proxy flush, cancellation, reconnect status.
- Cost/security: reserve/settle usage with concurrent requests; secrets redacted; owner isolation.

## Scenario matrix

| ID | Input / scenario | Expected |
|---|---|---|
| CHAT-01 | Authenticated prompt | started/delta/completed, persisted response |
| CHAT-02 | Refresh after completion | Exactly stored message, no provider repeat |
| CHAT-03 | Stop mid-stream | Abort requested, partial stopped, no Memory job |
| CHAT-04 | Client disconnect | Bounded interruption and cleanup |
| CHAT-05 | Duplicate same idempotency key | No second user message or provider call |
| CHAT-06 | Reused key with different payload | 409 conflict |
| CHAT-07 | Two concurrent requests same conversation | Only one active generation |
| CHAT-08 | Provider fails before first token | Failed, no fabricated completed reply |
| CHAT-09 | Provider fails after token output | Partial failed, stream.error then failed terminal |
| CHAT-10 | Regenerate last turn | New generation, old version retained |
| CHAT-11 | Retry a failed last turn | New key/new generation, same user message |
| CHAT-12 | Guess another user's IDs | 404; no content leak |
| CHAT-13 | Context cannot fit model budget | Fail safely before provider call |
| CHAT-14 | Memory disabled or useInChat=false | No retrieval call |
| CHAT-15 | Memory retriever unavailable | Continue history-only when safe |
| CHAT-16 | SSE JSON/UTF-8 split across chunks | Parser reconstructs correctly |
| CHAT-17 | Server restart with pending/streaming generation | Sweeper marks interrupted and releases slot |
| CHAT-18 | Stop vs Completion race | One terminal DB state, no duplicate job |
| CHAT-19 | Final DB transaction fails | No message.completed SSE or Memory job |
| CHAT-20 | DB commit succeeds but SSE terminal write fails | GET completed, no duplicate provider call |
| CHAT-21 | Late provider token after cancel | Discarded, cannot alter terminal record |
| CHAT-22 | Delete conversation with in-flight generation | Abort/guard; cannot recreate deleted rows |
| CHAT-23 | Wrong/missing Origin or CSRF | Mutations denied per 17T-23 |
| CHAT-24 | Invalid model alias | No provider call |
| CHAT-25 | Unknown additive SSE event | Safe frontend ignore after fixture approval |
| LLM-01 | Provider native deltas | Normalized ordered internal text events |
| LLM-02 | 429/timeout before first token | Bounded retry under budget |
| LLM-03 | Error after text started | No cross-provider splicing |
| LLM-04 | Unsupported capability or malformed tool call | Rejected before execution |
| LLM-05 | Two users approach quota concurrently | Atomic reservation prevents overspend on admission |
| LLM-06 | No usage on interrupted stream | Mark estimated or unknown, not exact |
| LLM-07 | Embedding model/version/dimension mismatched | Fail/reindex, do not mix vector spaces |
| LLM-08 | Production credentials missing | Safe error, no fake response |
| LLM-09 | Tool proposed by model | No Agent tool effect without Permission Engine |

## Golden slice

Signed-in browser creates conversation, posts a prompt, renders real streamed text and reloads it from DB. A second generation can be stopped from UI and shows persisted partial. Another user cannot access it. Tests show actual AbortSignal propagation, cost/usage source, stream terminal ordering and a clean CI run. Record browser topology, provider/model, DB test isolation, commit SHA and failures.

## Technical review blockers

- Exact transport for streamed regenerate, generation selection and old variants.
- Response semantics for duplicate idempotency key and already-terminal cancel.
- Provider/model choice, real token estimator, quota/cost settings.
- Cloud SSE proxy buffering/deadlines and secure cookie/Origin behavior.
- Signed off DTO fixtures, README link validation and browser E2E.

Do not mark these checks passed because only Markdown changed.
