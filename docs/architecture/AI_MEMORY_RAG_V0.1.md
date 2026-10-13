# GigaChat Hybrid Memory & RAG Architecture v0.1

> **Status: DESIGN PROPOSAL / NOT IMPLEMENTED.** Product direction **Hybrid Memory** was selected on 2026-10-13. Storage, API shapes, embedding provider, migrations and deployment must still pass Trà + Thư design review. Tracking: [17T-22](https://linear.app/17thedev/issue/17T-22/w1-design-giga-long-term-ai-memory-and-rag-architecture). Auth/Chat contract remains [DRAFT](../contracts/API_CONTRACT_V0.1.md).

## 1. Product intent and boundaries

GigaChat is an authenticated multi-conversation AI chat with optional durable, user-controlled memory. SQL history is an exact record of messages; **RAG** is a retrieval-and-context-building workflow, not another database or a promise that the LLM remembers all messages. The Coding Agent's source-code/repository index is a **separate, permission-scoped product capability** and MUST NOT share personal memory indiscriminately.

| Layer | Purpose | Storage / access | MVP |
|---|---|---|---|
| Conversation history | Exact user/assistant messages and history operations | PostgreSQL relational rows, ordered by conversation | Yes; implemented separately by 17T-21 |
| Working context | Recent turns and optional bounded prior summary | Built from authorized messages; any stored summary has provenance/version | Recent turns first; rolling summary later |
| Personal long-term memory | Selective preferences, explicit project decisions, goals and facts | PostgreSQL records + embedding vectors via pgvector | Yes |
| Knowledge RAG | Search within uploaded documents / Markdown / PDFs | Future document/chunk ingestion, access-controlled indexing | **Deferred** |
| Coding-agent knowledge | Authorized repo files, code references and task records | Separate namespace, repository grants, revision-aware index | **Separate later design** |

Do not embed every message, dump all SQL rows into prompts, or treat retrieved records as system instructions.

## 2. Explicitly chosen Hybrid Memory policy

Three capture behaviors are supported; all personal long-term memory is off until the user opts in.

- **Manual**: user explicitly instructs Giga to remember, or creates an item in the Memory page. Persist only after explicit user action and successful DB commit.
- **Suggest (default after opt-in)**: after a completed chat turn, the service may propose a non-sensitive memory; it is stored as a pending suggestion, **never retrievable** until accepted.
- **Auto (separate opt-in)**: after completed turns, automatically save only high-confidence, non-sensitive, permitted information; conflicting or uncertain candidates become suggestions instead of silently changing confirmed memory.

Two independent gates govern operation:

- **enabled** (default false): master switch for all personal-memory capture and use. Disabling stops new capture and retrieval, cancels/invalidate queued work, but does not delete existing records.
- **captureMode**: off / suggest / auto. With enabled=true and captureMode=off, **manual** saves are still allowed, but background extraction is not.
- **useInChat** (default true, effective only when enabled=true): determines whether eligible saved memories are retrieved into chat prompts; disabling does not erase them.

Automatic capture may not store passwords, access/session tokens, financial account details, health or other sensitive personal attributes, or inferred sensitive facts without specific consent. Add a sensitive-content classifier plus conservative rules, treat confidence as a heuristic rather than truth, and store minimal facts. User editing/deleting/clearing and a clear Memory settings UI are mandatory.

## 3. Architecture and dependency flow

~~~mermaid
flowchart TB
    WEB[GigaChat Web: chat + memory settings] --> API[Hono API: session, CSRF, ownership]
    API --> CHAT[Chat Orchestrator]
    API --> MEMAPI[Memory CRUD / Suggestions]
    CHAT --> HIST[(PostgreSQL: conversations / messages)]
    CHAT --> CONTEXT[Context Builder]
    CONTEXT --> RETRIEVE[Memory Retriever]
    RETRIEVE --> VECT[(PostgreSQL + pgvector)]
    CONTEXT --> LLM[LLM Provider Adapter]
    LLM --> SSE[POST fetch SSE to browser]
    SSE --> HIST
    HIST --> JOBS[(Durable memory jobs)]
    JOBS --> WORKER[Background Memory Worker]
    WORKER --> EXTRACT[Extract / policy / dedup]
    EXTRACT --> MEMAPI
    MEMAPI --> VECT
    WORKER --> EMBED[Embedding Provider Adapter]
    EMBED --> VECT
~~~

Boundaries:
1. Browser uses public REST + POST streaming fetch; **no DB/vector/LLM keys in browser**.
2. Auth middleware supplies user ID; user-supplied tenant IDs are ignored for authorization.
3. A separate worker uses leased DB jobs; HTTP response streaming never waits for memory extraction.
4. An embedding provider interface decouples the model; model ID and dimensions are pinned per index generation.
5. The retrieval service is internal, behind user authorization and consent. No public vector search API in MVP.

## 4. Sequence: streaming chat with retrieval

~~~mermaid
sequenceDiagram
  actor U as User
  participant API as Chat API
  participant DB as PostgreSQL
  participant R as Memory Retriever
  participant L as LLM Adapter
  participant W as Memory Worker
  U->>API: POST conversations/{id}/messages:stream
  API->>DB: authorize conversation; save user message
  API->>DB: bounded recent messages
  opt enabled AND useInChat
    API->>R: query(userId, question, scope)
    R->>DB: owner-filtered vector + metadata search
    R-->>API: bounded, current-revision memories
  end
  API->>L: instructions + safe bounded context
  L-->>API: incremental tokens
  API-->>U: message.started / delta / completed SSE
  API->>DB: persist completed assistant message; durable extraction job if eligible
  W->>DB: claim eligible job
  W->>DB: write suggestions or memories + pending index job
~~~

The existing draft chat API specifies message.started, message.delta and message.completed events. Do not add or reorder client-visible SSE events without an explicit contract review. Cancellation, upstream error, interrupted message persistence and job scheduling must have documented atomicity/terminal semantics. Only persisted complete turns should trigger automatic extraction.

## 5. Sequence: memory capture paths

### Manual

1. Explicit instruction or Memory UI action is recognized. The chat assistant MUST NOT announce success until the memory CRUD operation commits.
2. Validate ownership, consent, payload size, category and sensitive data rules. Normalize/derive a stable logical key.
3. Look for existing related items in the same user/scope. For an obvious explicit update, supersede or revise with optimistic concurrency; ask for confirmation if ambiguity remains.
4. Transactionally save item revision + provenance + index job. Respond with stored item and indexStatus=pending. The item is not eligible for vector retrieval until matching-revision embedding is ready; exact keyed recall may be implemented separately with the same authorization/policy filters.

### Suggest

1. User has enabled=true, captureMode=suggest.
2. On committed assistant turn, enqueue extraction job with source message IDs and policy generation; worker extracts candidate, validates, deduplicates and stores it as pending **suggestion only**.
3. UI accepts or rejects. Accept is atomic/idempotent, confirms ownership/expiry/policy generation, creates/revises memory and enqueues embedding. Rejected suggestion is never retrieved.
4. Suggestions expire automatically; avoid repeatedly nagging about rejected equivalent candidates.

### Automatic

1. User opts into captureMode=auto. After complete turn, worker extracts conservative factual candidates with source pointers.
2. Run privacy filter, confidence/utility check, ownership and duplicate/contradiction matching.
3. If sensitive, uncertain, low-confidence or conflicting with user-confirmed memory, do not autosave. Optionally present a suggestion when safe.
4. If eligible, upsert a versioned memory and enqueue embedding. Recheck enabled, mode and policy generation **inside commit**.

## 6. Deletion, correction, conflicts and consent race safety

- All memory records, vectors, sources and suggestions are scoped to an authenticated user; APIs return 404 to unauthorized IDs without leaking existence.
- Editing increments revision and invalidates retrieval of old vectors immediately, even if re-embedding is delayed. Worker updates only when current revision and policy generation still match.
- User deletes a memory: hard-delete content and linked vector, unlink provenance, invalidate queued work. Maintain only an intentionally minimal suppression marker for the source/fact (e.g., keyed HMAC plus source exclusions, no raw deleted text) to avoid automatic re-learning; users can clear suppression history independently.
- Turning enabled off prohibits retrieval AND new capture immediately. Queued jobs check consent generation before persisting.
- Deleting a conversation removes its raw messages according to History semantics. **Auto-derived unconfirmed memories sourced solely from it** should be removed; explicitly user-confirmed memories may be preserved with transparent UX and source links removed. Shared-source memories need provenance-aware handling.
- Manual/confirmed information wins over later inferred facts. Conflicts with confirmed memory become suggestions; keep a version/audit trail without retaining deleted secret content.
- Suppression records are not a guarantee of permanent global forgetting. Explain remaining chat history, backups, logs and external providers as applicable.

## 7. Retrieval & context strategy

1. Authenticate and authorize the conversation and optional project scope.
2. Load latest N messages in deterministic order; trim by token budget.
3. If memory is enabled and allowed for the current chat, embed the new query using the active pinned embedding model. Select **only active memories owned by this user**, matching allowed scope, valid/current embedding revision, not suppressed.
4. MVP: exact nearest-neighbor search with cosine distance, filtered by user. Optionally mix PostgreSQL keyword search and exact identifier matching for code/project IDs; design an interface for hybrid rank fusion later.
5. Deduplicate, enforce score/quality thresholds from evaluation data, favor user-confirmed, fresh and source-backed memories; use at most a small top-k (initial experiment k=3–5, not a universal constant).
6. Assemble separate untrusted context blocks with source, timestamp and explicit instruction not to obey embedded commands. Source content may inform answers but cannot authorize agent tools, GitHub writes or privilege changes.
7. Track safe context provenance IDs (not full private prompt in logs), prompt/token budgets and recall metrics.
8. If retrieval/embedding fails or no relevant memory exists, continue with recent conversation context; do not hallucinate a retrieved source.

Priority: system policy > current user request > recent authorized turns > user-confirmed memories > automatic memories > future document excerpts. Token budgets, ranking threshold and model choice require measurement, not blind constants.

## 8. Failure, observability and cost controls

- An embedding outage must not break basic chat; expose memory indexing state when relevant.
- Use a durable DB queue with leased jobs, unique idempotency keys, bounded exponential backoff, crash recovery and dead-letter / failed status. Store references rather than copies of sensitive message text.
- Set limits for memory content size, candidate count/turn, embeddings per user, concurrent jobs and per-user request rates; budget LLM context and embedding API calls.
- Log only operation IDs, counts, latency, status/error codes and redacted provider messages; **never** raw session tokens, complete user prompts, embedding vectors or DB URLs.
- Monitor memory suggestion acceptance, relevant-hit rate, cross-user isolation, index lag, job retries, streaming latency and consent-policy violations.
- Store real durable data in managed PostgreSQL later; local Postgres 16 Alpine currently used for Auth does **not necessarily contain pgvector**. Confirm extension availability in chosen image/provider before migrations.

## 9. Alternatives and decisions pending validation

| Option | Pros | Tradeoffs | Assessment |
|---|---|---|---|
| PostgreSQL + pgvector | Existing relational users/messages; one DB/backup; joins/ownership; inexpensive MVP | Need pgvector image/provider; vector dimension/reindex planning | **Preferred candidate** |
| Qdrant / Pinecone / other standalone vector DB | Specialized vector operations and scaling | Extra service, secrets, synchronization, quota and deletion complexity | Defer until measured need |
| Plain SQL full-text only | No embedding cost; exact keywords | Weak semantic/paraphrase recall | Supplemental baseline, not long-term semantic solution |
| Save every message as vector | Simple ingestion | Privacy, noise, duplication, unnecessary cost, low precision | Reject |

**Open review gates:** embedding model & dimensions; actual pgvector support, recall evaluation and scale; exact-vs-HNSW threshold; tenant and future project scope; retention/backup policies; automatic eligibility policy; handling of user requests like "forget"; contract UX status/error semantics; browser auth/CSRF/CORS after 17T-23.

## 10. References and status

- [Data model and migration proposal](AI_MEMORY_RAG_DATA_MODEL_V0.1.md)
- [Pipelines, data lifecycle and security](AI_MEMORY_RAG_PIPELINES_V0.1.md)
- [Proposed Memory API](../contracts/GIGACHAT_MEMORY_API_V0.1.md)
- [Acceptance and evaluation plan](AI_MEMORY_RAG_TEST_PLAN_V0.1.md)
- [ADR-002 candidate](../decisions/ADR-002-hybrid-memory-pgvector.md)
- [Delivery plan](../planning/GIGACHAT_DELIVERY_V0.1.md)
- [API Contract DRAFT](../contracts/API_CONTRACT_V0.1.md), [ADR-001](../decisions/ADR-001-api-compatibility.md)
- [pgvector upstream](https://github.com/pgvector/pgvector), [PostgreSQL full text search](https://www.postgresql.org/docs/current/textsearch.html), [Neon pgvector](https://neon.com/docs/extensions/pgvector)

**No schema or service described here is evidence that GigaChat RAG has been deployed, benchmarked or implemented.**