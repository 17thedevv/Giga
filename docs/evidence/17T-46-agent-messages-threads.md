# Verification Evidence — Linear 17T-46: Persist GigaAgent messages and follow-up conversation threads

**Date:** 2026-10-17<br>
**Linear Task:** [17T-46](https://linear.app/17thedev/issue/17T-46/persist-gigaagent-messages-and-follow-up-conversation-threads)<br>
**Branch:** `feat/17t-46-persist-agent-messages`<br>
**Review Status:** Addressed Formal Review (GitHub Review ID: 5556852328). Pending re-review.

---

## 1. Summary of Changes

This implementation adds **durable server-side GigaAgent conversation messages** (`agent_messages`), eliminating any browser-local authoritative history. Reconnecting or refreshing on any device authoritatively reconstructs the exact ordered conversation thread from PostgreSQL.

### Key Deliverables & Review Resolutions

1. **Forward-Only Migration 013 (`apps/api/src/db/migrations/013_agent_messages.sql`):**
   - Creates `agent_messages` table with composite foreign key `(owner_id, workspace_id, run_id) REFERENCES agent_runs(owner_id, workspace_id, id) ON DELETE CASCADE`.
   - Strictly validates roles (`user`, `assistant`, `tool_summary`) and content bounds (`1` to `16,384` UTF-8 bytes).
   - Enforces unique constraints: `UNIQUE (run_id, sequence)` and `CONSTRAINT uq_agent_messages_idempotency UNIQUE (owner_id, run_id, idempotency_key)`.
   - Backfills initial instruction (`agent_runs.task`) as `sequence = 1` and completed summary as `sequence = 2` for existing migration 011/012 runs without data loss or downtime.
   - Enforces database-level immutability and monotonicity via PostgreSQL triggers:
     - `trg_agent_message_insert`: verifies run exists, workspace matches, sequence is monotonic (`sequence = MAX(sequence) + 1`), and sequence 1 matches `agent_runs.task`.
     - `trg_agent_message_update`: raises exception (`Agent messages are immutable`).
     - `trg_agent_message_delete`: rejects direct row deletion (`Agent messages cannot be deleted directly`; cascade delete only).

2. **Canonical Message & Run Relationship:**
   - Single authoritative source of truth: `agent_runs.task` is persisted into `agent_messages` at sequence 1 upon run admission.
   - The thread displays initial instruction and subsequent user follow-ups, assistant summaries, and bounded tool summaries in deterministic ascending sequence.

3. **Follow-Up Message API (`POST /api/v1/agent/runs/:id/messages`):**
   - Authenticated owner only; cross-owner access returns generic 404 `NOT_FOUND`.
   - Strictly validates payload `{ content: string }` and rejects unknown fields.
   - Requires `Idempotency-Key` header with SHA-256 request fingerprint.
   - Duplicate same-key + same payload replaying returns HTTP 200 OK.
   - Same key with altered payload returns HTTP 409 Conflict.
   - Concurrency handled safely via PostgreSQL `SELECT ... FOR UPDATE` and per-run async lock.

4. **Terminal Run Semantics:**
   - Follow-up messages against terminal runs (`completed`, `failed`, `cancelled`) return documented HTTP 409 Conflict with message advising client to create a new run in the workspace.
   - Terminal runs are never silently reopened.

5. **Authoritative Message Read API (`GET /api/v1/agent/runs/:id/messages`):**
   - Returns paginated messages ordered strictly by `sequence ASC`.
   - Stable cursor pagination (`limit` default 20, max 100).
   - Clear separation of concerns:
     - `agent_messages`: user-visible conversation thread.
     - `agent_run_events`: internal execution timeline.
     - `agent_run_steps`: granular tool execution records.

6. **Context Boundary Interface & Workspace Continuation (`getConversationContext`):**
   - Implemented workspace-level continuation: queries chronological messages across prior completed runs within the same workspace up to the current run.
   - **Decoupled Current Run Context Query (Infinite Loop Prevention):** Separates current run retrieval from historical workspace retrieval. The current run's messages are queried independently and guaranteed to be present first, ensuring that even with 200+ historical messages from prior completed runs, current run tasks and follow-up instructions are NEVER dropped by a SQL `LIMIT`.
   - **Completed-Only Prior History:** Prior runs in the continuation context are strictly filtered to `status = 'completed'`, excluding failed or cancelled runs from polluting future prompts.
   - **SQL Bounded Limits:** Workspace history is queried in reverse chronological order (`DESC`) bounded by `LIMIT` (default 200) to fetch the most recent completed history without unbounded table scans.
   - Enforces UTF-8 byte bounds and message count limits.
   - Isolated: messages from other workspaces or personal memory/GigaChat are strictly excluded.

7. **Follow-Up vs Completion Race Guard:**
   - `finalizeRun` requires `expectedMaxSequence`. Under row lock, if `outcome.status === 'completed'` and `currentMaxSeq > expectedMaxSequence`, throws `ConflictError`.
   - `AgentOrchestrator` catches this conflict when new follow-up messages are admitted during decision/verification and continues execution loop with fresh context.

8. **Mutex Memory Leak Resolution in `withRunLock`:**
   - Stored chained promise reference in `runLocks` and verified exact reference on cleanup.
   - Added `getActiveLockCount()` and regression test 22 ensuring map is cleaned up after both success and failure.

9. **Security, UTF-8 Bounding & Unified Sensitive-Key Redaction:**
   - DTOs never contain `leaseToken`, `workerId`, `leaseExpiresAt`, provider API keys, or raw reasoning traces.
   - Prompt injection resistance: user follow-up text cannot escalate run mode (`ask` -> `execute`), modify tool policies, or alter worker/lease state.
   - **Unified Sensitive-Key Policy (`isSensitiveKey`, `SENSITIVE_KEY_NAMES`, `redactJsonValue`, `redactStringPatterns`):** Shared canonical key policy across structured JSON traversal and regex fallback. Recognizes generic opaque tokens (`token`, `id_token`, `session_token`), custom headers (`X-API-Key`, `x-api-key`, `x-auth-token`), auth schemes (Basic, Bearer), cookies, and credentials without requiring known key prefixes. Double-checks stringified JSON with regex passes before database persistence across assistant messages, tool summaries, run step arguments/outputs, run summaries, and events.
   - **Unicode-Aware Code-Point Bounding (`boundUtf8`):** Assistant and tool summaries strictly bounded by scanning back past continuation bytes, ensuring multi-byte characters (e.g. 4-byte emojis like `'🙂'`) are never split in the middle, preventing replacement character expansion and ensuring PostgreSQL `octet_length <= 16384` is never breached.

---

## 2. Test Execution Evidence

### A. Focused 17T-46 Agent Messages Test Suite (`apps/api/tests/agent/agent-messages.test.ts`)

Run against **Real PostgreSQL 18.4** (`postgres://postgres@127.0.0.1:56446/giga_agent_test`):

```text
▶ GigaAgent Durable Messages and Follow-up Threads (17T-46)
  ✔ 1. initial user instruction appears in the message thread exactly once (198.9048ms)
  ✔ 2. follow-up user message persists durably with incremented sequence (168.3886ms)
  ✔ 3. refresh reconstructs identical ordered thread (175.1846ms)
  ✔ 4. two independent readers/devices see the same messages (390.0044ms)
  ✔ 5. duplicate same-key follow-up returns/replays exactly one message (200 OK) (198.6576ms)
  ✔ 6. changed payload with reused key -> 409 Conflict (196.868ms)
  ✔ 7. concurrent same-key inserts -> one durable message (291.1971ms)
  ✔ 8. concurrent different messages -> unique monotonic sequences (249.5304ms)
  ✔ 9. cross-owner run/message access -> generic 404 (309.4593ms)
  ✔ 10. terminal completed follow-up -> documented 409 Conflict (235.6557ms)
  ✔ 11. terminal failed follow-up -> documented 409 Conflict (215.9828ms)
  ✔ 12. terminal cancelled follow-up -> documented 409 Conflict (184.784ms)
  ✔ 13. message text cannot escalate Ask/Plan permissions or override tool policy (394.2811ms)
  ✔ 14. message cannot mutate approval, worker ID or lease state (189.6833ms)
  ✔ 15. oversized message (> 16384 bytes) rejected with 400 VALIDATION_ERROR (187.5248ms)
  ✔ 16. unknown fields in message payload rejected with 400 VALIDATION_ERROR (243.4766ms)
  ✔ 17. real PostgreSQL triggers enforce message immutability and reject direct delete (264.3695ms)
  ✔ 18. safe pagination with sequence cursor and ascending order (406.5837ms)
  ✔ 19. assistant summary and tool summaries appear cleanly in conversation history (436.6486ms)
  ✔ 20. public AgentMessage DTOs never contain leaseToken, workerId, reasoning, or provider secrets (642.9167ms)
  ✔ 21. getConversationContext provides bounded deterministic conversation context without external dependencies (593.8832ms)
  ✔ 22. withRunLock cleans up Map entry after both success and failure (327.32ms)
  ✔ 23. workspace continuation carries forward selected prior conversation context from completed runs (568.0776ms)
  ✔ 24. workspace isolation: context strictly isolates messages to the current workspace (399.6517ms)
  ✔ 25. finalizeRun rejects completion when a new follow-up message arrived during processing (380.3254ms)
  ✔ 26. boundUtf8 truncates at Unicode code-point boundaries without splitting characters or exceeding 16384 bytes (297.8871ms)
  ✔ 27. workspace context with > 64 KB history prioritizes current run follow-ups and prevents infinite completion loops (382.8711ms)
  ✔ 28. non-completed prior runs (failed or cancelled) are excluded from workspace continuation context (345.3008ms)
  ✔ 29. workspace with > 200 historical messages never drops current run follow-ups or enters completion loops (477.5502ms)
  ✔ 30. redactSensitiveContent sanitizes secrets in assistant and tool summaries before database persistence (355.0411ms)
  ✔ 31. JSON credential leakage prevention in DB rows, run steps, events, and public GET APIs (385.2415ms)
  ✔ 32. generic opaque tokens and custom header keys in nested structured JSON and raw logs (392.1154ms)
✔ GigaAgent Durable Messages and Follow-up Threads (17T-46) (11174.4525ms)
ℹ tests 32
ℹ suites 1
ℹ pass 32
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11759.8325
``````

### B. Migration Upgrade Tests (`apps/api/tests/agent/agent-migration.test.ts` & `apps/api/tests/db-migrations.test.ts`)

```text
[giga-db] Applied migration: 013_agent_messages (version 13)
✔ 013 upgrades populated current 012 preserving all existing agent and product tables and reruns idempotently (169.4992ms)
✔ runs migrations deterministically and idempotently (384.2171ms)
```

### C. Full Repository Test Suite on Real PostgreSQL 18.4

```text
ℹ tests 421
ℹ suites 55
ℹ pass 421
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 70434.5417
```

### D. TypeScript Typecheck and Production Builds

- `apps/api run typecheck`: 0 errors
- `apps/api run build`: clean build
- `apps/web run typecheck`: 0 errors
- `apps/web run build`: clean build (61 modules transformed, 279 kB bundle)

---

## 3. Invariants & Security Confirmation

- **No Browser-Local Authoritative History:** The browser stores only client UI state. All conversation threads are reconstructed from `GET /api/v1/agent/runs/:id/messages`.
- **No Chain-of-Thought Persistence:** Neither PostgreSQL nor public DTOs persist model reasoning or chain-of-thought traces.
- **Strict Isolation:** Cross-owner IDs return generic 404 without leaking presence or metadata.
- **Contract Status:** The GigaAgent API remains **DRAFT / NOT FROZEN**.
