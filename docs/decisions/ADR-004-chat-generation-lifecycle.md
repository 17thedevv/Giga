# ADR-004 — Persistent GigaChat Generations and Shared LLM Engine

- **Status: PROPOSED TECHNICAL ADR.** User approved product behavior on 2026-10-13; Trà/Thư technical sign-off pending. No code, model/Cloud provisioning or API freeze.
- **Owner:** Trà; **reviewer:** Tráng A Thư. [17T-25](https://linear.app/17thedev/issue/17T-25/specify-gigachat-runtime-and-shared-llm-engine-v02).
- **References:** [Runtime](../architecture/GIGACHAT_RUNTIME_V0.2.md), [LLM Engine](../architecture/LLM_ENGINE_V0.1.md), [API Proposal](../contracts/GIGACHAT_RUNTIME_API_V0.2.md), [ADR-001](ADR-001-api-compatibility.md), [Memory](../architecture/AI_MEMORY_RAG_V0.1.md).

## Context

Conversation + Message rows alone do not express a generated answer that was partially streamed, user-stopped, crashed or retried; cannot safely meter simultaneous requests or recover browser state. Provider-native event schemas should not leak into GigaChat frontend. GigaAgent uses models through a distinct Tool/Agent Runtime and remains independent from GigaChat history and Memory.

## Approved product decisions

1. POST fetch SSE and a PostgreSQL-backed generation lifecycle independent from conversation.
2. Exactly one active generation per conversation in MVP, atomically enforced.
3. Stop tries to cancel provider and saves partial state; failures/disconnects do not masquerade as completed.
4. Retry and Regenerate create new generation variants for the **latest** user message while retaining old variants.
5. Completed and durably persisted assistant response is prerequisite to automatic Memory extraction.
6. A shared provider-neutral LLM Engine is consumed by both GigaChat and GigaAgent but owns neither Chat persistence nor Agent tool execution.

## Proposed implementation choices

17T-36 selects Gemini with one server-only chat model and direct HTTP text adapter in
[ADR-005](ADR-005-first-chat-provider.md). Normal startup validates configuration and
constructs the existing engine. Migration 008 records provider/model identity at start,
without reconstructing legacy rows or adding public DTO fields. This does not implement
the broader usage ledger, quota, Memory or Agent proposals below.

17T-35 narrows the Retry/Regenerate candidate to a dedicated fetch SSE POST, a latest-turn
variant list and migration-007 selection table. The existing streaming coordinator and
durable cancellation fences are reused. Selection moves only in the successful completion
transaction; composite foreign keys prove completed status and owner/conversation/user
identity. Earlier-turn branching and manual selection are deferred. See the
[DRAFT transport/DTO candidate](../contracts/GIGACHAT_RUNTIME_API_V0.2.md#streamed-retry--regenerate-candidate--17t-35).
This records an implementation candidate, not Trà/Thư technical sign-off.

- Database chat_generations with pending/streaming/completed/stopped/interrupted/failed and an owner-scoped idempotency key; migrate only after inspecting 17T-21 merged schema.
- Transactionally record user input/generation at admission; keep network streaming outside DB transaction; commit assistant message + usage + eligible memory job before terminal success event.
- Throttled partial checkpoints, cancellation signal, deadlines and sweeper for orphaned active generations.
- MVP generation tied to HTTP request; disconnect aborts upstream and generation is reconciled via GET. Durable resumable stream worker is future.
- One real model provider first, behind model registry/capability adapter, actual resolved model/usage captured with budget reservation. No automatic provider switch after partial text.

## Alternatives

| Design | Benefit | Drawback | Outcome |
|---|---|---|---|
| Only raw messages | Small schema | Ambiguous failures, stop and retries | Reject |
| Persistent generation records | Explicit state, audit, idempotency and recovery | More migrations/transactions | Preferred |
| HTTP-bound stream first | Small MVP | Stream cannot resume after disconnect | Preferred now |
| Durable worker/replay from day one | Resumable chat | Queue, leases and event log complexity | Later |
| Provider SDK coupled to API | Fast | Frontend/Agent vendor lock-in | Reject |
| Multiple provider fallback immediately | Potential availability | Risk of double billing/incoherent partials | Defer |

## Adoption and verification gates

- [x] Product-level design approved.
- [ ] Trà/Thư agree on exact cancel, Retry/Regenerate streaming route and SSE terminal event schema.
- [ ] Generation migration owner/locking/idempotency tests on guarded disposable real PostgreSQL.
- [ ] One real provider and tokenizer/output limits measured; quota/cost admission tested.
- [ ] Actual browser HTTPS cookie/CSRF/proxy SSE tested before freeze (ADR-001).
- [ ] ADR reviewed and adopted; implementation PR separate.

No changes to production state, credentials, provider or API are made by this ADR.
