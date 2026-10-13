# GigaChat Memory Verification and Retrieval Evaluation v0.1

> **TEST PLAN / NOT YET EXECUTED.** Source: [Architecture](AI_MEMORY_RAG_V0.1.md), [Data Model](AI_MEMORY_RAG_DATA_MODEL_V0.1.md), [Pipelines](AI_MEMORY_RAG_PIPELINES_V0.1.md), [API Proposal](../contracts/GIGACHAT_MEMORY_API_V0.1.md). Owner: Trà; frontend UX reviewer: Thư; tracking: 17T-22.

## 1. Verification tiers and expected evidence

| Tier | Environment | Required evidence |
|---|---|---|
| Contract | HTTP schema fixtures, typed DTOs | Register errors, status, pagination, settings and suggestion decisions match approved draft |
| Unit | Mock LLM/embedding/DB interfaces | Filter/extraction/dedup rules, token budget, sanitization, missing-model failures |
| Integration | Disposable **real PostgreSQL + pgvector** | Migration/reindex, actual distance queries, owner scoping, job leasing, transaction atomicity |
| Browser/E2E | React/Vite frontend + authorized backend | Cookie + CSRF, consent UI, suggestion acceptance, edit/delete, refreshed chat |
| Operational | Local worker and later Cloud staging | Restart/retry, timeouts, dead letters, no DB lock held during provider call |
| Retrieval evaluation | Labeled Vietnamese/English/project queries | Metrics, baselines and error inspection; do not declare recall success without dataset |

**Test DB safety gate:** complete 17T-23 isolation fixes first. Integration tests MUST fail if real PostgreSQL/pgvector is required but absent, never silently substitute pg-mem. Never point migrations, truncation or cleanup at application/production DATABASE_URL.

## 2. Functional behavior matrix

| ID | Given / when | Expected |
|---|---|---|
| MEM-01 | New user; GET settings | enabled=false; captureMode=suggest; no capture/retrieval |
| MEM-02 | User enables suggest; a turn completes | Candidate suggestion pending; not retrievable |
| MEM-03 | User accepts suggestion | Exactly one active memory, durable index job; retry is idempotent |
| MEM-04 | User rejects suggestion | No active memory, not included in prompts |
| MEM-05 | Explicit manual save | DB commit before success reply; provenance and pending embedding |
| MEM-06 | Auto opt-in; durable safe fact | Auto item created only if policy allows |
| MEM-07 | Model infers sensitive/weak fact | Not auto-stored; appropriate safe refusal or omission |
| MEM-08 | User edits with stale expectedRevision | 409, original item intact |
| MEM-09 | Edit succeeds; embedding worker delayed | Old embedding invalid; item pending index |
| MEM-10 | User deletes memory during embed | No vector/item recreation after worker completes |
| MEM-11 | User toggles enabled=false mid-extraction | Retrieval stops immediately; stale jobs cannot persist |
| MEM-12 | User toggles useInChat=false | Memory records remain; no retrieval in context |
| MEM-13 | Switch auto to suggest during worker call | Automatic write rejected by consent-generation check |
| MEM-14 | Two identical accepts in parallel | Single effect, same logical result or reviewed conflict code |
| MEM-15 | Two contradictory project decisions | Confirmed preference wins; review required for conflict |
| MEM-16 | User B guesses user A memory ID | 404/no content leakage on GET/PATCH/DELETE |
| MEM-17 | Source conversation is deleted | Provenance updated; policy-driven derived memory purge |
| MEM-18 | Provider embedding API fails | Chat continues with recent context; job is pending/failed |
| MEM-19 | Missing/corrupt vector or wrong model ID | Not retrieved; explicit reindex status |
| MEM-20 | Malicious "ignore previous rules" stored in memory | No instruction escalation or agent tool authorization |
| MEM-21 | Empty memory history | 200 empty page, no fabricated recall |
| MEM-22 | Wrong origin / missing session on mutation | CSRF/401 behavior matches approved security policy |
| MEM-23 | Worker crash and lease expiry | Job reclaimed once; no duplicate side effects |
| MEM-24 | Delete user/account | Memory content, vectors, jobs and suggestions are removed under retention policy |
| MEM-25 | Suppressed fact reappears in old source | No immediate automatic re-learning |
| MEM-26 | Chat aborts mid-stream | Extraction policy does not treat incomplete assistant reply as confirmed |
| MEM-27 | Duplicate/cross-user source reference | Rejected before persistence; no source exposure |

## 3. Retrieval benchmark: small, reproducible, privacy-safe

Start with **30–50 synthetic/labeled evaluation queries**, including:
- Vietnamese paraphrases of user preferences and project decisions.
- English paraphrases with different surface vocabulary.
- Exact identifiers: 17T-20, DATABASE_URL, API route names, filenames.
- Time-sensitive contradictions: old choice vs confirmed new decision.
- No-answer questions and misleading near-match text.
- Two-user collision cases with identical content but different ownership.
- Injection strings contained inside retrieved source text.

For each query record:
- Query text (synthetic/approved only), user scope, expected memory IDs and relevant source IDs.
- Top-k ranked hits, similarity score, false positives/negatives, whether memory setting permits retrieval.
- End-to-end context contribution and answer faithfulness, separate from bare retrieval quality.
- Model ID/version, vector dimension, indexing freshness, query latency and token/cost usage.

Metrics to report (do **not** claim target achieved without measurements):
- recall@5 and precision@5 against labeled relevance;
- precision of "no relevant memory" decisions;
- unauthorized cross-user hits (must be **zero**);
- stale/deleted memory retrieval count (must be **zero**);
- acceptance rate of suggested memories and duplication rate;
- p50/p95 retrieval latency and embedding-job lag/cost.

Baseline A: recent SQL context only. Baseline B: keyword/exact identifier matching. Candidate C: exact pgvector cosine. Future D: hybrid fusion/rerank. Compare identical queries, owner scopes and datasets rather than making blanket claims that embeddings are always better.

## 4. Migration / worker / security verification

- Install pgvector in **real** disposable Postgres test image; run extension creation and migration twice; test concurrent runner safety. Record extension and PostgreSQL versions.
- Verify exact vector dimension/model filtering, embedding revision mismatch, archived/superseded status and memory use-off cases.
- Ensure DB tests never read normal DATABASE_URL implicitly or write to unverified targets.
- Simulate two workers claiming same job, crash, expired lease, request timeout and retried embedding; no duplicated memory effects or held DB transactions during network call.
- Verify no user content/session token/connection strings/embeddings leak into logs, HTTP error details, CI traces or GitHub PR.
- Check app-level and DB-level authorization for all memory sources. Never rely on vector similarity alone to enforce tenant isolation.
- Validate conservative sensitive content classifier with approved synthetic fixtures and report false positives/negatives.

## 5. Exit criteria by delivery stage

1. **Architecture/spec PR (17T-22):** links, design decisions, schema/API review questions, threat model, test plan, ADR proposed; no runtime PASS claims. Thư review required.
2. **Chat/history foundation:** auth + persisted messages + valid POST fetch SSE terminal/error events work against draft; no forced RAG.
3. **Memory storage/manual CRUD:** migration, owner-scoped APIs, optimistic edits/deletes, all basic privacy and regression checks pass.
4. **Suggested/auto/worker:** consent, extraction, dedup, review UI, retry and no-resurrection tests pass on disposable real PostgreSQL.
5. **Retriever/context:** eval data and reports demonstrate useful recall and zero cross-user/deleted hits; live-stream Chat works without memory provider.
6. **Cloud/browser gate:** actual HTTPS cookie/CSRF/CORS, migration and backup/retention evidence, cost/quotas and cross-training; only then consider freezing accepted API.

## 6. Test evidence template

~~~text
Issue/PR:
Commit SHA:
Database image + Postgres/pgvector versions:
Chat/embedding provider and model/version:
Setup commands and database isolation guard:
Unit tests (commands/counts/result):
Real PostgreSQL integration tests (commands/counts/result):
Browser validation (topology/browser):
Retrieval dataset size / recall@5 / precision@5 / no-answer accuracy:
Latency p50/p95 / embedding calls / estimated cost:
Security regressions:
Unverified items and limitations:
Reviewer and decision:
~~~

No step should be marked complete merely because the design exists or another component has green CI.