# ADR-002 — Hybrid Personal Memory and PostgreSQL/pgvector RAG

- **Status:** **PROPOSED IMPLEMENTATION ADR**; Hybrid Memory product direction agreed 2026-10-13; DB/API specifics **NOT APPROVED / NOT IMPLEMENTED**.
- **Owner:** Trà; **Reviewer:** Tráng A Thư.
- **Tracking:** [Linear 17T-22](https://linear.app/17thedev/issue/17T-22/w1-design-giga-long-term-ai-memory-and-rag-architecture).
- **Related:** [ADR-001 API compatibility](ADR-001-api-compatibility.md), [Architecture invariants](../architecture/INVARIANTS_V0.1.md), [Full specification](../architecture/AI_MEMORY_RAG_V0.1.md).

## Context

GigaChat needs conversational history and optionally remembered user preferences/decisions across sessions. PostgreSQL history CRUD cannot provide relevance-based semantic recall alone. The team is two developers and already uses PostgreSQL for users/sessions. RAG should not introduce an independent database unless required by demonstrated scale/functionality. Privacy, provenance and ability to forget are first-class requirements.

## Product decision already selected

Implement **hybrid capture** with (a) explicit user-initiated memory saves; (b) AI-generated suggestions requiring approval in suggest mode; (c) separately opted-in automatic capture subject to a conservative policy. Default memory is disabled until enabled. Memory usage in chat is separately controllable from capture. View/edit/delete/forget must work and be enforced on queued work.

## Proposed technical decision

1. Use existing PostgreSQL as source of truth for users, conversations and versioned memory records.
2. Adopt pgvector in the **same DB** as preferred semantic embedding store, once extension availability, provider/model dimension and isolation benchmarks are verified.
3. Keep embedding adapter and MemoryRetriever / MemoryStore interfaces provider-independent; exact cosine search first, lexical/hybrid ranking after empirical evaluation.
4. Run extraction/indexing via durable Postgres job queue separate from streaming Chat; preserve ownership, source references, user consent generation and deletion invalidation.
5. Partition logical ownership by authenticated user and optional later project/repository ACLs. Personal memory MUST NOT be automatically exposed to repo agents or other users.
6. Keep API proposals in a dedicated draft document. The canonical /api/v1 contract is still DRAFT and requires two-person review plus browser validation before freezing.

## Alternatives evaluated

| Option | Benefit | Cost / risk | Result |
|---|---|---|---|
| PostgreSQL + pgvector | Minimal extra infrastructure; transactional joins/ownership and backups | Extension management, embedding dimension and index/latency tuning | Preferred |
| Standalone vector engine | Advanced ANN and scaling | A second service, credentials, sync/deletion and costs | Revisit on measured need |
| SQL keyword only | Cheap and simple | Misses paraphrases / semantics | Optional keyword supplement |
| Embed every chat row | Straightforward bulk indexing | Privacy/cost/noise/dedup risks | Rejected |
| Automatic-only memory | Fewer UX controls | Loss of consent and corrections | Rejected |
| Manual-only memory | Maximum user control | No useful discovery in prior chats | Supported mode, not sole product path |

## Consequences

Positive: one durable store, clear consent control, persistent user memory, less vendor lock-in, auditable source links, low starting complexity.

Tradeoffs: embedding call costs, extraction quality uncertainty, vector schema evolution/reindex requirements, worker retry/deletion complexity, extra privacy tests, need to implement UI for reviewing suggestions and forgetting.

## Approval and rollout gates

- [x] Product: Hybrid Memory selected in project discussion.
- [ ] Peer review (Trà + Thư) of Memory UI, privacy behavior, schema/API and sources.
- [ ] Choose and record embedding model/dimension/version and reproducible pgvector-capable Postgres in CI/local.
- [ ] Prove owner filtering, opt-out/forget no-resurrection tests and indexing idempotency on real PostgreSQL.
- [ ] Measure a small grounded retrieval quality corpus including Vietnamese and exact project identifiers.
- [ ] Confirm memory collection/deletion/retention policy and provider data handling.
- [ ] Freeze only the properly reviewed public contract under ADR-001 after browser auth/SSE tests.
- [ ] Separate implementation PRs follow conversation/message foundation and auth test safety fixes.

**Decision remains PROPOSED until these gates are completed. Do not mark pgvector deployed or production ready from this ADR alone.**