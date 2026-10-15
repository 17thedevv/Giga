# 17T-36 — First real Chat provider handoff

Issue: [17T-36](https://linear.app/17thedev/issue/17T-36/integrate-first-real-gigachat-llm-provider).
Owner: Trà. Intended independent reviewer: Thư; review pending.
Related: [17T-31](https://linear.app/17thedev/issue/17T-31),
[17T-32](https://linear.app/17thedev/issue/17T-32),
[17T-35](https://linear.app/17thedev/issue/17T-35).
Branch: `feat/17t-36-real-llm-provider`; base main
`94736f6cbbcff64dd2b3ce8317e38aab7fe85d1d`.
Exact delivered SHA, Draft PR and final CI links are recorded in Linear and the PR.

## Changed areas and behavior

- [ADR-005](../decisions/ADR-005-first-chat-provider.md) records the provider choice before
  implementation: Gemini Developer API, one stable `gemini-3.1-flash-lite` model,
  public/internal alias `giga-chat-default`. It cites official selection, limits, pricing,
  authentication, rate-limit and usage documentation. API v1 remains DRAFT.
- `modules/llm/providers/gemini/` implements streamText and generateText via one direct HTTP
  SSE path, no new dependency. Fixed HTTPS URL, rejected redirects, server x-goog-api-key
  header, minimal thinking and text-only request configuration. Roles map to Gemini
  user/model/systemInstruction; prompts cannot supply configuration or authority.
- Incremental parsing handles arbitrary byte splits, UTF-8, multiple events, comments,
  multiline data and LF/CRLF/CR. Bounds: 128KiB per frame, 1MiB response, 64KiB text and
  85s adapter deadline. The existing Chat idle/total/write bounds remain. AbortSignal
  cancels the request/reader immediately, suppresses buffered late text and cleans up even
  when a test transport ignores cancellation. No provider stream replay or retry is added.
- Normalized deltas retain order. Completion requires a valid finish reason and clean EOF;
  malformed/blocked/tool responses and truncated/error streams fail safely. Thought parts
  are suppressed. 4xx/429/5xx are classified with fixed messages; error bodies and arbitrary
  transport/parser exception text are discarded. Retry-After metadata is bounded at 60s,
  with no automatic wait/retry policy. Existing persisted user Retry remains explicit.
- Successful usage is source=provider, emitted once from final cumulative metadata.
  Output includes thinking via total-minus-prompt when available, otherwise requires both
  candidate and thought counts. Missing counters stay absent; no exact complete usage
  is invented for failed/cancelled streams. No usage ledger or cost calculation.
- `chat-bootstrap.ts`, AppConfig and startServer construct/validate the registry and real
  engine before DB/socket work. Enabled Chat requires GEMINI_API_KEY and allowlisted
  CHAT_MODEL_ID; output cap is 1–2048, default 1024. Production defaults enabled; explicit
  false disables. Unconfigured development/test stays offline. Test DI remains available;
  FakeProvider is never imported or installed by bootstrap.
- Migration 008 adds nullable resolved provider/model identity without changing 005–007.
  Pair consistency and a PostgreSQL trigger make identity write-once at streaming start;
  historical rows remain null. The engine prepares/resolves once, runtime commits identity,
  then begins provider reading. Persistence failure prevents provider invocation. Prepared
  requests retain their recorded model even if trusted alias configuration later changes.
  Public generation/variant DTOs remain explicitly mapped and do not expose identity.
- Existing new-message, durable Stop and Retry/Regenerate coordinator is reused. Config,
  engine and Chat edits are the necessary integration boundary for normal startup.
  Migration fixtures now account for 008; no unrelated product implementation is changed.
- Optional `npm run chat:smoke` reads server env, sends one tiny non-sensitive prompt and
  prints only completion/usage availability and alias/provider metadata. Never part of CI.
  Operator `.env` loading must be explicit; `.env.example` contains placeholders only.

## Executed verification — 2026-10-15

Windows with disposable local PostgreSQL 18.4 on loopback port 55436 and a dedicated test
database, guarded by the repository's NODE_ENV=test / TEST_DATABASE_URL checks. No existing
application database, cloud resource, live provider or user credential was used by tests.

| Check | Result |
|---|---|
| `npm run typecheck`, apps/api (including smoke script) | PASS |
| `npm run build`, apps/api | PASS |
| `npm test`, real PostgreSQL | 300 passed, 0 failed, 0 skipped; 42 suites |
| `npm test`, pg-mem | 285 passed, 0 failed, 15 PostgreSQL-only skips; 42 suites |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | 6 passed |
| `git diff --check` | PASS |

The fixture transport is per instance; global network/pg internals are not patched.
Adapter tests cover single-byte/UTF-8/many-event chunking, valid delimiters, ordered text,
usage and missing usage, finish reasons, malformed/oversized/incomplete data, unsafe/tool
responses, 4xx/429/5xx, pre-abort, buffered late output, pending-reader cancellation,
deadlines, generateText success/failure, fixed auth/model controls and error redaction.
Bootstrap tests cover disabled defaults, missing/invalid keys/model/limits/endpoint flags,
production fail-closed behavior, alias/capability resolution and prepared identity stability.

An actual local HTTP server started with config and mocked provider transport exercises
new-message → Regenerate → failed new-message → Retry → stopped Regenerate, all through
one Gemini engine. It observes committed identity inside the provider boundary, tests the
configured output cap and checks that private fields do not reach GET. A repository fault
test proves no provider call occurs when identity cannot be persisted.

Real PostgreSQL directly rejects identity assignment before streaming, rewrite/clearing,
and terminal legacy assignment. The isolated populated-007 upgrade preserves messages,
completed outputs, selections and operation keys; identity remains null, SQL matches the
runner, pair constraints reject incomplete identity and rerunning migrations is a no-op.
pg-mem strips unsupported trigger DDL and does not claim to prove trigger immutability.
Existing 17T-31/32/34/35 regression suites remain in the full run.

Backend CI (PostgreSQL 16) and Git Workflow must pass on the exact published PR head;
local test evidence is not a claim of remote CI. Final runs and SHA are recorded in Linear.

## Remaining review and deployment questions

Keep Draft / In Review for Thư. Review startup defaults/disable policy, one-model allowlist,
safe error/usage behavior, Gemini stable-code version semantics and deployment key setup.
Apply migration 008 before these writers. Older application versions can leave new rows'
identity unknown; retain schema/history on rollback and disable Chat until compatible
writers are restored. No fabricated backfill or destructive down migration.

Live smoke was not run: GEMINI_API_KEY is absent from the shell environment. Credentials
provided in chat were not copied into source, command arguments, logs or artifacts. An
operator must provision the secret in server environment and explicitly run the optional
smoke before claiming live connectivity. Key validity, account/model access, region/egress,
free-versus-paid data terms, actual rate/spend limits and public proxy timing remain open.

No deployment/browser/provider-live acceptance or cloud cross-training was performed.
No second provider, model picker, fallback, tools, embeddings, structured generation,
Memory/RAG, Skills/Profile composition, quotas/billing, Agent work, API freeze or merge.
