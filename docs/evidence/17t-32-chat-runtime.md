# 17T-32 — Persisted Chat Runtime handoff

Issue: [17T-32](https://linear.app/17thedev/issue/17T-32/implement-gigachat-persisted-streaming-generation-runtime).
Intended owner: Trà. Independent reviewer: Thư; approval remains pending.
Branch: `feat/17t-32-chat-generation-runtime`, based on `main` at
`b43db1767f0a920253c91b109ed2ec816f7d7ce9`.
Exact delivered SHA, draft PR URL and CI results are recorded in the linked Linear handoff.

## Scope and integration reason

- `apps/api/src/modules/chat/`: owner-scoped generation repository, coordinator, DTOs and
  authenticated POST SSE / GET reconciliation routes. No provider call runs in a transaction.
- `apps/api/src/db/migrations/005_chat_generations.sql` and runner: additive forward-only
  lifecycle table, owner/key uniqueness, one pending/streaming generation per conversation,
  byte-bounded partial text and completion consistency check.
- `apps/api/src/app/create-app.ts`: explicit LLM Engine/runtime injection. Unconfigured POST
  fails closed with 503; GET remains available. FakeProvider is imported only by tests.
- Backend tests: deterministic provider success/failure, owner isolation, idempotency,
  actual PostgreSQL concurrent admission, DB guard/rollback, completion durability and
  delivery failure. Existing migration fixtures updated for 005 and restored after DDL tests.
- `docs/contracts` and runtime/test-plan docs: required integration changes describing the
  new public DRAFT SSE/GET surface and review questions. No frontend/shared-package changes.

## Executed checks — 2026-10-15

Windows, local Node/TypeScript and disposable PostgreSQL 18.4 on loopback, separate cluster
and port; guarded `NODE_ENV=test` + dedicated `TEST_DATABASE_URL`. No existing database or
cloud service was changed. Commands run from `apps/api` unless otherwise stated:

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm test`, isolated real PostgreSQL | 211 passed, 0 failed, 0 skipped; 39 suites |
| `npm test`, pg-mem | 207 passed, 0 failed, 4 explicitly skipped; 39 suites |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` (root) | 6 passed |
| `git diff --check` (root) | PASS |

pg-mem cannot prove concurrent row locking/transaction isolation. Its planner also uses
partial indexes without checking the predicate, incorrectly hiding terminal generation
rows. The memory helper omits only the chat partial index; PostgreSQL-only tests verify
that constraint using the unmodified migration. No pool internals are patched.

Required remote gate: Backend CI on PostgreSQL 16 and Git Workflow on the exact published
PR head; inspect their linked runs in the Linear handoff. CI is not implied by local tests.

## Contract / database / operational impact

API v1 remains **DRAFT**. Existing history/auth DTOs are preserved. Stream callers must add
Idempotency-Key and handle `generationId`, duplicate 409 reconciliation and `message.failed`.
Details: [implementation candidate](../contracts/GIGACHAT_RUNTIME_API_V0.2.md#implementation-candidate--17t-32).

Migration 005 changes no existing table. Apply with the existing migration runner. Rollback
means stopping new chat traffic and reverting application code; preserve the additive table
and data. Any removal would need a separately reviewed forward migration.

Known limits / required review:

- No real provider credentials/adapter or deployment; normal app startup cannot generate
  without an explicitly injected Engine. All provider tests use the deterministic fixture.
- Thư must review duplicate 409 envelope, new failed terminal event, provisional message
  IDs, byte/deadline bounds and frontend parsing. Retry/Regenerate transport stays unresolved.
- Byte bounds are not a vendor-specific tokenizer/context guarantee. Actual model choice
  and token budgets remain a separate gate.
- A crashed worker is reclaimed by the next admission after 120 seconds, with terminal
  status fencing. No background sweeper; GET alone may show stale active state until then.
- A persistent DB outage can prevent immediate failure persistence. No fabricated completed
  event is emitted. GET is authoritative after recovery; ambiguous commit delivery cannot
  overwrite a terminal completed row.
- No Stop/Retry/Regenerate, Memory/RAG, Skills composition, usage, quotas, Agent, frontend
  changes or Cloud/Render deployment. Deployed HTTPS/browser and real-provider checks were
  not run and remain outside this task. No cloud cross-training was performed or claimed.

Keep the PR Draft and issue In Review pending actual independent review; no agent merge.
