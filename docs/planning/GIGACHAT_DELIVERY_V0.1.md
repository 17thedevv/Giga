# GigaChat Chat + Hybrid Memory Delivery Plan v0.1

> **PROPOSED ROADMAP, not implemented work.** Product direction approved 2026-10-13. Owner Trà (backend/DB/LLM), reviewer and Frontend owner Thư. Linked [17T-22 Memory/RAG design](https://linear.app/17thedev/issue/17T-22), [17T-21 Conversation History](https://linear.app/17thedev/issue/17T-21), [17T-23 Auth security fix](https://linear.app/17thedev/issue/17T-23). No dates are committed by this plan.

## Milestone sequence

| Gate | Trà (Backend) | Thư (Frontend) | Exit criteria / proof |
|---|---|---|---|
| G0 — stabilize | Finish 17T-23 auth CSRF/test DB safety; review API 17T-8 | Review auth/security and typed client behavior | Safe test DB, approved candidate auth contract, CI |
| G1 — history | 17T-21 migrations 002, authenticated conversation/message repos | Conversation list/details UI; empty/unauthorized/error | Owner-scoped persistence across restart; peer review |
| G2 — real chat | LLM provider adapter, bounded context, POST chat SSE and persisted completion | Chat composer, incremental fetch SSE parser, abort/retry states | Valid complete/error/abort streams and persisted messages |
| G3 — manual memory | Review Memory spec; pgvector-capable DB migration, settings/manual CRUD, embedding adapter | Memory toggle, list/edit/delete, index status UI | Owner isolation, manual save→retrieve→forget tests |
| G4 — suggested + auto | Extraction worker, dedup, suppression, consent revision and retries | Suggestion accept/reject, explicit auto opt-in | No silent autosave in suggest, no resurrection on delete |
| G5 — RAG quality | Retriever, ranking evaluation, token budgets and provider fallback | Safe memory source/context visibility | Labeled recall metrics; no cross-user/stale hits |
| G6 — Cloud + freeze gate | Managed PostgreSQL, HTTPS API/stream deploy and evidence | Deployed browser cookie/CSRF + SSE E2E | Reviewer sign-off, quotas, migration/backup and ADR-001 conditions |

## Implementation workstream boundaries

- 17T-21 **must not** implement RAG; it owns raw history persistence only.
- This 17T-22 PR **is documentation only**; not a migration, API runtime implementation or confirmation that pgvector works in current Docker/Cloud setup.
- New implementation issues should be created **after design review** per independently reviewable slice: G2 Chat SSE, G3 Manual Memory, G4 Extraction/Worker, G5 Retrieval/Evals, Thư UI integration. Each gets its own issue-based branch and PR.
- Shared DTOs/events under packages/contracts are cross-boundary and require both developers' review; canonical API is DRAFT until full gate.
- Repo coding agent/Cloud GitHub writes remain governed by INV-07 separately from conversational memory.

## MVP vs later

**MVP:** authenticated chat, durable conversations, POST fetch SSE, limited context, explicit manual memory, suggestions, separately opt-in automatic memory, pgvector retrieval, edit/delete/forget, source references, access isolation.

**Later:** PDF/Markdown uploads and knowledge_documents/chunks, file ingestion worker, hybrid ranking with advanced reranker, project/repo multi-tenant memory, separate vector engine, extensive memory analytics and syncing external applications.

## Decision/evidence checkpoints

1. Sign off consent semantics and UI; agree on what happens when a source conversation is deleted.
2. Choose actual embedding provider/model/dimension, test extension version and deployment cost.
3. Agree on literal API paths/DTOs/errors/idempotency keys from draft Memory API; preserve existing Auth/Conversation/SSE behavior.
4. Run real disposable-Postgres migration and tenant isolation tests; ensure tests cannot touch production DB.
5. Verify extraction/forget policy and privacy text before default auto mode could be offered.
6. Run retrieval evaluation corpus and Cloud HTTPS/browser E2E before API freeze.

**Review request:** Trà validates backend/data security and operational gates; Thư validates UX states, consent/review interfaces and API client compatibility. Do not mark 17T-22 Done until the spec is actually reviewed.