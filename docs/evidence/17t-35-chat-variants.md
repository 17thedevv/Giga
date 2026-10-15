# 17T-35 — Streamed Retry / Regenerate variants

Issue: [17T-35](https://linear.app/17thedev/issue/17T-35/implement-streamed-gigachat-retry-and-regenerate-variants).
Owner: Trà. Intended reviewer: Thư; independent approval remains pending.
Related: [17T-32](https://linear.app/17thedev/issue/17T-32),
[17T-34](https://linear.app/17thedev/issue/17T-34),
[17T-33 consumer](https://linear.app/17thedev/issue/17T-33).
Branch: `feat/17t-35-chat-retry-regenerate`, created from current main
`8e878d01fa0e6b73a02ecbbb0d8b7663dff7f265`.
Exact delivered SHA, Draft PR and CI results/links are recorded in Linear.

## Changes and integration reasons

- The DRAFT contract was updated before implementing the public route: dedicated POST
  `generations:stream`, latest-turn eligibility, safe variant DTO, duplicate 409 reconciliation,
  and automatic selection only after durable completion. API v1 remains DRAFT.
- Migration 007 adds action provenance and completed selection metadata. Composite foreign
  keys enforce owner/conversation/user/status identity. Existing completed generations are
  backfilled; 001–006 SQL is unchanged. Prompt/cancel/retry/regenerate share the durable key
  namespace, with content-free tombstones after conversation deletion.
- `modules/chat/` admits a new generation using the existing user message and reuses the
  existing streaming coordinator, provider AbortSignal, deadlines, checkpoints, controller
  registry, Stop, completion/failure and recovery paths. No second engine is introduced.
- Completion commits new assistant output, completed state and selected generation together.
  Failure/Stop/interruption leaves the old completed selection untouched. GET generation
  still reconciles any owned attempt; latest-turn variant inspection exposes completed text
  and safe metadata, with no keys, fingerprints, owner IDs or provider details.
- `chat-history.ts` and message history select one answer per turn, ordered immediately
  after its user. Context excludes candidate output and all alternatives; the target user
  occurs once at the end without its old answer. Message/count and UTF-8 byte bounds remain.
  These conversation repository edits are necessary integration work for preserved variants.
- Full PostgreSQL validation exposed an existing conversation cursor precision loss:
  converting PostgreSQL microseconds through JS Date could skip conversation rows. Opaque
  cursors now retain the exact UTC timestamp; decode preserves it after validation. Existing
  conversation DTOs/envelopes are unchanged. A deterministic sub-millisecond regression
  exercises the failure rather than relying on machine timing.
- Migration fixture maintenance removes 007 metadata before simulating old schemas; pg-mem
  names PostgreSQL's generated operation CHECK, strips unsupported precision formatting,
  and removes retained indexes during table recreation. It does not prove PostgreSQL locks,
  partial-index arbitration, composite constraints or microsecond behavior.

## Executed validation — 2026-10-15

Windows with Node.js and a newly initialized, disposable PostgreSQL 18.4 cluster bound to
loopback port 55435. Tests used a dedicated database with the existing NODE_ENV=test and
TEST_DATABASE_URL safeguards; no application/cloud database or provider was used.

| Command / environment | Result |
|---|---|
| `npm run typecheck` in `apps/api` | PASS |
| `npm run build` in `apps/api` | PASS |
| `npm test`, real PostgreSQL | 257 passed, 0 failed, 0 skipped; 39 suites |
| `npm test`, pg-mem | 243 passed, 0 failed, 14 PostgreSQL-only skips; 39 suites |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | 6 passed |
| `git diff --check` | PASS |

New coverage includes CHAT-10/11, retry from failed/stopped/interrupted, HTTP incremental
tokens, selection before/after completion, retained old output, unsuccessful candidates,
exact context across multiple variant-bearing turns, no duplicate users, invalid latest
states/earlier turns, safe DTOs, auth/CSRF/source ownership, key operation/target conflicts,
Stop on both actions, rollback and deletion tombstones. Both concurrent retry and regenerate
POSTs yield one admission and provider call on real PostgreSQL. Direct writes prove
selection cannot point to an active/unsuccessful generation, another owner/conversation/turn
or a non-user message. MVCC tests observe old selection and invisible new output while
completion holds its transaction lock; cancel is observed waiting in pg_stat_activity.
The opposite race records Stop before completion and preserves selection. Gates/timeouts
are bounded and released in finally; no pg.Pool or PoolClient monkey-patching is used.

The 007 upgrade test starts with populated 006 in an isolated schema, preserves users,
sessions, messages, conversation rows, all six generation states and operation keys,
checks completed-selection backfill and migration-runner idempotency. Existing 17T-32/34
tests remain in the full run.

## Review, rollout and limits

Keep the PR Draft and issue In Review for Thư's independent compatibility review. Review
latest-turn-only inspection, automatic successful selection, duplicate 409 envelopes,
completed-only variant text and fetch SSE parser integration. No review approval is implied.
Backend CI (PostgreSQL 16) and Git Workflow must pass on the exact published PR head;
local PostgreSQL evidence alone is not remote CI evidence.

Migration 007 is forward-only. Apply it before enabling these application writers, and
quiesce old generation writers during rollout: old completion code does not maintain turn
selections. On application rollback, disable variant admission and preserve schema/output,
keys and selection metadata. Reverting to pre-007 history readers would expose variants
as flat alternatives; do not route traffic to those readers without a separately reviewed
compatibility change. Do not roll back by dropping metadata or rewriting completed output.

Same coordinator Stop aborts locally; another coordinator relies on durable checkpoints
and existing event/deadline fences. HTTP disconnect remains interruption and GET remains
authoritative. Variants are retained without a new retention/cleanup policy in this slice.
The list is latest-turn-only; historical attempts remain available via known generation IDs.

Not performed: frontend UI/parser integration, real provider, deployed HTTPS/browser/cloud,
or cross-training rehearsal. No deployment, Memory/RAG, Skills/Profile injection, usage,
Agent runtime, earlier-turn branching, manual selection, API freeze or merge is included.
