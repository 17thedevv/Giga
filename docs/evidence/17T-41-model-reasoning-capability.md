# 17T-41 — Model reasoning capability verification and handoff

Date: 2026-10-16. Intended backend owner: Trà; independent reviewer: Thư (pending).
Inspected starting implementation: `460e5d5`; branch base: `5cab354`.
Remote main advanced to `08162e0` with frontend-only changes. Branch history was preserved;
the final pull request must validate integration against current main.
Branch: `feat/17t-41-model-reasoning-capability`.
Linear Issue: [17T-41](https://linear.app/17thedev/issue/17T-41/implement-provider-agnostic-reasoning-capability-framework-for-gigachat).
Linear currently assigns the issue to `17thedev`; no peer approval or status transition is claimed.
Delivery SHA and CI results belong to the Draft PR linked in the final handoff.

## Changes and integration scope

- **Normalized product contract:**
  - `ReasoningEffort = 'low' | 'medium' | 'high'`.
  - Rejection of provider-native reasoning fields (e.g., `thinkingLevel`, `thinkingBudget`,
    `reasoning.effort`, `output_config.effort`, raw token budgets, provider URLs) with 400 `ValidationError`.
  - When `reasoningEffort` is absent: **no explicit user reasoning override is requested; the registered
    model/adapter default policy applies.** For the current Gemini adapter, Giga's legacy policy applies
    `MINIMAL` thinkingLevel to preserve backward compatibility.
  - Complete suppression of raw internal thoughts / chain-of-thought (`includeThoughts: false`, thought frames skipped).
- **Capability-driven Model Registry:**
  - Per-model reasoning declaration (`ModelReasoningConfig: { supported: boolean, efforts: readonly ReasoningEffort[] }`).
  - Cross-validation between registered model alias reasoning claims and adapter support at startup.
  - Discovery endpoint `GET /api/v1/models` projecting trusted models with normalized capabilities.
  - Discovery returns `{ id, capabilities, reasoning }` for streaming aliases. Chat validates
    selected aliases against this registry, with no provider-specific admission branch.
  - Adapter support is required for each advertised level; absent capability hooks fail closed.
    Copies isolate registry policy from caller/metadata mutation; contradictory/native values fail validation.
- **Provider Agnosticism in Core Engine:**
  - Core LLM Engine contains zero provider names, zero provider-specific reasoning branching, and no heuristics.
  - Preflights capability against registry before transport and throws `UnsupportedReasoningEffortError` (400) if unsupported.
- **Gemini Adapter Mapping Hook:**
  - Implements `getReasoningCapabilities(modelId)` and `mapReasoningEffort(effort?, modelId)`.
  - Maps `low -> LOW`, `medium -> MEDIUM`, `high -> HIGH`, and absent -> `MINIMAL`.
  - BYOK and platform credential paths produce identical reasoning request bodies.
- **Database & Persistence (Migration 010):**
  - Added nullable column `reasoning_effort VARCHAR(10)` with CHECK constraint on `chat_generations`.
  - Trigger `prevent_chat_reasoning_effort_rewrite` enforces row immutability.
  - Historical rows remain `null`.
  - Snapshotted per generation on new message (`POST /messages:stream`), Retry, and Regenerate (`POST /generations:stream`).
  - Durable Stop remains race-safe on generations with reasoning effort.
  - Explicit requested effort equals effective normalized policy; defaults remain unspecified.
    Retry/Regenerate resolve independently and never inherit a previous attempt's effort.
  - Omitted effort preserves pre-upgrade prompt and variant idempotency fingerprints.
- **Contracts and Architecture:**
  - Added `docs/decisions/ADR-007-model-reasoning-capability.md`.
  - Updated `docs/contracts/GIGACHAT_RUNTIME_API_V0.2.md` and `docs/contracts/API_CONTRACT_V0.1.md`.

## Executed locally

Environment: Windows PowerShell, Node v24.20.0, npm 11.19.0; `NODE_ENV=test`.
Real PostgreSQL 18.4 ran in a newly initialized local cluster on loopback port 56441,
database `giga_reasoning_test`, separate from application databases. PostgreSQL 16 CI
results must be read from the PR checks. Provider transports use deterministic fixtures.

| Check | Result |
|---|---|
| `npm run typecheck` in `apps/api` | PASS: 0 errors |
| `npm run build` in `apps/api` | PASS: code 0 |
| `npm run typecheck` in `apps/web` | PASS: 0 errors |
| `npm run build` in `apps/web` | PASS: Vite production build |
| `npm test -- --reporter=dot` in `apps/web` | PASS: 56 tests; existing React `act(...)` warnings |
| Full API `npm test` with dedicated `TEST_DATABASE_URL` | PASS: 354 passed, 0 failed, 0 skipped |
| Full API `npm test` with `TEST_DATABASE_URL` unset | PASS: 336 passed, 0 failed, 18 PostgreSQL-only skips |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | PASS: 6 tests |
| `node .agents/scripts/validate-git-workflow.mjs` with branch/title/body and base/head env vars | PASS: branch, title, issue reference and commit range |
| Git diff hygiene `git diff --check` | PASS: clean |

Reproduce API integration checks from `apps/api` with `NODE_ENV=test` and an isolated
`TEST_DATABASE_URL` whose database name contains `test`; run `npm run typecheck`,
`npm run build`, then `npm test`. Unset `TEST_DATABASE_URL` for the separate pg-mem run.
Never substitute the application `DATABASE_URL`. The final PostgreSQL run includes the
fixture restoration assertion; the same migration ledger and reasoning column are present
after the suite, rather than leaving a partially restored schema for the next run.

## Analysis of skipped tests under pg-mem

The 18 PostgreSQL-only cases skip under `pg-mem`, whose SQL emulation cannot prove these
constraints and races. They execute against the dedicated real PostgreSQL instance:

1. `tests/chat/chat-reasoning-migration.test.ts`: `prevent_chat_reasoning_effort_rewrite` trigger immutability (pg-mem intercepts & strips PL/pgSQL triggers).
2. `tests/chat/chat-provider.test.ts`: PostgreSQL write-once trigger enforcement.
3. `tests/chat/chat-runtime.test.ts` (12 tests):
   - Real PostgreSQL unique arbitration and advisory locks.
   - Real PostgreSQL composite foreign keys and check constraints.
   - Real PostgreSQL MVCC and `SELECT FOR UPDATE` row locks.
   - Real PostgreSQL variant completion race condition.
   - Concurrent transaction isolation (pg-mem lacks concurrent isolation).
   - Partial index planner verification.
   - Terminal transition guards and stopped/completed constraints.
   - Concurrency race arbitration.
4. `tests/conversations/conversations-persistence.test.ts`: Real PostgreSQL microsecond timestamp precision.
5. `tests/credentials/credentials.test.ts` (2 tests):
   - Concurrent transaction isolation and user-row locking.
   - Real PostgreSQL composite foreign key constraints and row locks.

## Scenarios covered in test suite

1. Model Registry capability declaration & discovery (advertises per-model reasoning, distinguishes models with/without).
2. Model Registry rejects invalid reasoning configurations at registration time.
3. Fail-fast validation detects mismatch between alias reasoning claims and adapter support.
4. Core LLM Engine passes normalized effort to fake adapter without provider branching.
5. Core LLM Engine rejects unsupported effort before transport / provider invocation.
6. Gemini adapter maps normalized `low`/`medium`/`high` to native `LOW`/`MEDIUM`/`HIGH`.
7. Gemini adapter maps absent effort to registered model/adapter default policy (`MINIMAL`).
8. Gemini adapter always sets `includeThoughts: false` and suppresses any thought chunks from delta stream.
9. BYOK and platform credential paths produce identical reasoning request shapes.
10. HTTP request validation rejects provider-native fields (`thinkingLevel`, `thinkingBudget`, raw token budgets) with 400.
11. `GET /api/v1/models` exposes discoverable trusted capabilities without provider leaks.
12. End-to-end: new prompt with `reasoningEffort` snapshots in DB and streams cleanly.
13. New message, Retry, and Regenerate can each independently select different reasoning effort levels.
14. Durable Stop remains race-safe on generations with `reasoningEffort`.
15. Migration 010 upgrades cleanly and preserves legacy nulls; CHECK constraint rejects invalid values.
16. Trigger immutability rejects mutation of `reasoning_effort` once set on Real PostgreSQL.
17. Second fake provider/model works via registry metadata for new prompt, Retry and Regenerate.
18. Omitted effort on Retry/Regenerate returns to model default rather than inheriting effort.
19. Unsupported model/effort is rejected before persistence; pre-upgrade keys still reconcile.
20. Actual encrypted BYOK service and platform routing produce identical native bodies and normalized
    persisted effort for omission and all three levels.

## Verification findings corrected

- Registry previously permitted unsupported reasoning claims when adapters omitted the capability
  hook; legacy stream-only engines also invented three supported levels. Both now fail closed.
- Absent effort previously appended null to old idempotency fingerprints; legacy reconciliation
  is preserved and explicit effort remains part of request identity.
- Migration 010's allowed-value fixture now terminalizes each inserted row so the real PostgreSQL
  one-active-generation constraint does not invalidate subsequent inserts.
- A repeated full PostgreSQL run exposed the existing Skills migration-coordination fixture
  dropping `chat_generations` while retaining migration 010's ledger entry. That failed run was
  stopped; the fixture now replays 010 and asserts the restored reasoning column exists. This
  test-only integration edit is needed to restore the schema after the new Chat migration.

## Checks not executed and remaining gates

- No live/billable Gemini request, cloud deployment, production migration, HTTPS browser check or
  cloud role-swap was performed. Native request mapping and suppression are fixture-verified.
- No formatter/linter scripts are defined in the API/web package manifests.
- No shared `packages/contracts` package exists; the candidate DTOs are documented in the DRAFT contracts.
- Capability-driven frontend controls are separately tracked; this task provides discovery and validation.
- Independent Thư review remains required; contract freeze and merge are not authorized by these checks.

## Review Gates & Handoff

- Linear Issue: [17T-41](https://linear.app/17thedev/issue/17T-41/implement-provider-agnostic-reasoning-capability-framework-for-gigachat).
- Feature Branch: `feat/17t-41-model-reasoning-capability`.
- Status: independent review by Thư pending. Keep the PR Draft.
