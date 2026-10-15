# 17T-34 — Durable Chat cancellation handoff

Issue: [17T-34](https://linear.app/17thedev/issue/17T-34/implement-durable-gigachat-generation-cancellation).
Owner: Trà. Intended independent reviewer: Thư; approval pending.
Related: [17T-32 runtime](https://linear.app/17thedev/issue/17T-32) and
[17T-33 frontend consumer](https://linear.app/17thedev/issue/17T-33).
Branch: `feat/17t-34-chat-generation-cancel`, based on main
`69dff5eb4cdcc0740316df44041a8f64130fff3c`.
Exact delivered SHA, draft PR and remote CI links are recorded in Linear and the PR.

## Changed areas and integration reason

- `apps/api/src/db/migrations/006_chat_generation_cancel.sql` and runner: upgrade the
  existing 005 schema without editing 005, add cancel intent/stopped/cancelled, replace
  generated CHECK names, preserve completed consistency and the active-generation guard,
  and enforce terminal status transitions with a PostgreSQL trigger.
- `chat_operation_keys` supplies durable operation identity instead of a single nullable
  first-cancel key. Backfilled prompt keys and new prompt/cancel keys share an owner/key
  namespace. Content-free identity tombstones survive conversation deletion until owner
  deletion so keys cannot be rebound to another generation/operation.
- `apps/api/src/modules/chat/`: empty-body authenticated cancel route, shared bounded
  key validation, owner-checked active controllers (cap 256, unconditional cleanup),
  intent-before-abort ordering, row-lock completion/finalization fencing, stopped DTO/SSE.
- Tests: deterministic Stop/Completion winners, actual PostgreSQL lock waiting, concurrent
  idempotent cancel, upgrade from populated 005, partial/SSE/GET reconciliation, cross-owner
  and CSRF guards, late events, terminal preservation, disconnect and deletion behavior.
- Canonical API/runtime docs and API README describe the new DRAFT enum/event/route.
  These documentation edits are required by the public contract change. No frontend or
  shared-package implementation changed.

## Executed checks — 2026-10-15

Windows, disposable local PostgreSQL 18.4 cluster on loopback and a dedicated test DB,
verified by existing `NODE_ENV=test` / `TEST_DATABASE_URL` safety checks. A separate test
schema validates the actual migration-005 generated constraint names and populated upgrade.
No existing application database or cloud resource was changed.

| Command / environment | Result |
|---|---|
| `npm run typecheck` in `apps/api` | PASS |
| `npm run build` in `apps/api` | PASS |
| `npm test`, real PostgreSQL | 234 passed, 0 failed, 0 skipped; 39 suites |
| `npm test`, pg-mem | 226 passed, 0 failed, 8 PostgreSQL-only skips; 39 suites |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | 6 passed |
| `git diff --check` | PASS |

Memory tests name the anonymous 005 CHECKs as PostgreSQL names them, strip unsupported
trigger DDL, and retain the existing partial-index planner workaround. They do not claim
to prove triggers or concurrent locks. Real PostgreSQL uses the unmodified migration 005,
observes cancel waiting in `pg_stat_activity`, and verifies the terminal constraints/races.
Race gates reject after two seconds and release in finally; concurrency tests are bounded.
No pg.Pool/PoolClient internals are patched.

Backend CI (PostgreSQL 16) and Git Workflow must also pass on the exact published head;
their final results and links are in the Linear/PR handoff. Local checks do not imply CI.

## Contract and remaining boundaries

API remains **DRAFT**. The [candidate contract](../contracts/GIGACHAT_RUNTIME_API_V0.2.md#durable-stop-implementation-candidate--17t-34)
specifies 202 for active cancel acceptance, 200 for terminal reconciliation, empty body,
owner-scoped operation keys, optional `cancelRequestedAt` and `message.stopped`.
Normal provider finish `stop` and user Stop `cancelled` are distinct. Browser abort alone
stays interrupted. No stopped generation inserts an assistant message. A committed
completion cannot be downgraded by later cancel; terminal delivery failure cannot undo it.

Immediate abort is local to the owning coordinator instance. Another coordinator records
intent and finalizes from the last durable checkpoint; the owning provider is stopped on
its next normalized event or existing deadline. No instant multi-worker abort, pub/sub,
background polling or sharing of uncheckpointed memory is implemented. Database reads
before normalized events fence late output; partial writes remain batched.

If DB finalization fails after durable intent, GET can temporarily report active with
cancelRequestedAt. Repeated cancel or stale admission recovery can finalize it. A known
ordinary Stop does not fabricate a failure/success event. Concurrent deletion may make
reconciliation return 404; no row or message is recreated.

Migration is forward-only: preserve table, keys and data on application rollback; disable
chat/cancel traffic and old writers before reverting application code. Enable cancel only
after all generation writers use the new cancellation fences. Any removal requires a
separately reviewed forward migration.

Thư review questions: 202/200 reconciliation, stopped enum/event parsing, key-retention
policy, remote checkpoint behavior and browser delivery. Retry/Regenerate remains unresolved.
No real provider, frontend Stop UI, Memory/RAG, Skills/Profile composition, usage/quotas,
Agent work, deployment or API freeze. Browser/cloud/provider checks and cloud cross-training
were not performed. Keep Draft / In Review pending independent review; do not auto-merge.
