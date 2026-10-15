# 17T-37 — Chat BYOK verification and handoff

Date: 2026-10-15. Intended owner: Trà; independent reviewer: Thư (pending).
Base: `a594025cb4027e784536d8c1f74893b4c6019c52`.
Branch: `feat/17t-37-chat-byok-credentials`.
The exact delivery SHA, PR URL and CI evidence are recorded in the Linear handoff.

## Changes and integration scope

- API credential module: owner-scoped management, validation and Chat preference.
- Migration 009: encrypted Gemini rows and owner-bound preference; 001–008 unchanged.
- LLM engine/adapter and Chat runtime: per-call transport credential capability,
  current preference resolution for new/Retry/Regenerate, safe BYOK errors and
  unchanged platform behavior/Stop fencing.
- App/config/bootstrap and `.env.example`: server-only encryption configuration
  and explicit Chat-only dependency injection; no new dependencies.
- Tests: encryption, REST/CSRF, PostgreSQL FK/uniqueness/cascade, replacement,
  concurrent users, cancellation and migration upgrade. Existing provider fixtures
  now supply credentials separately. Historical migration assertions are bounded
  to their target versions, and pg-mem cleanup orders the new composite FK.
- ADR-006 and additive DRAFT contract. No frontend, Agent, Memory, KMS or cloud changes.

## Executed locally

Environment: Windows PowerShell, Node.js, isolated temporary PostgreSQL **18.4**
on loopback; `NODE_ENV=test` with a dedicated `TEST_DATABASE_URL` whose database
name contains `test`. Existing databases/services were not modified. All Gemini
transport calls were deterministic fixtures, with synthetic random credentials.

| Check | Result |
|---|---|
| `npm run typecheck` in `apps/api` | PASS |
| `npm run build` in `apps/api` | PASS |
| `npm test` with real PostgreSQL | PASS: 328 tests; 0 failed, 0 skipped |
| Focused `npx tsx --test --test-concurrency=1 tests/credentials/*.test.ts` | PASS: 28 tests with real PostgreSQL |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | PASS: 6 tests |
| `git diff --check` | PASS |

The full suite initially caught a legacy Skills migration fixture comparing all
registered migrations to versions 1–4; the fixture now queries only that baseline.
Final boundary review also scoped the BYOK body-limit middleware to its own paths;
an integration fixture confirms existing 4 KiB Skills preferences still work.

The pg-mem focused suite passed 26 tests with 2 PostgreSQL-specific concurrency/FK
cases explicitly skipped. Real PostgreSQL executed those cases above.
Backend CI runs the full suite on PostgreSQL 16; exact-head CI is tracked in Linear.

## Configuration and review gates

Provide a dedicated server master key as canonical base64 encoding **32 random
bytes** in `CREDENTIAL_ENCRYPTION_KEY`. Missing means BYOK disabled; malformed
configured values prevent startup. Never derive it from another application
secret. Stored key version is 1; rotation/re-encryption is not implemented.

Deletion preserves BYOK mode with a null selection and safe failure. Replacement
rebinds an existing BYOK preference to the new immutable ID. Selection is at provider
invocation, once per call; no credential-source audit columns are added to historical
generations. Transient validation failures preserve validity and record attempt time.
See [ADR review questions](../decisions/ADR-006-chat-byok-credentials.md#review-questions).

No live provider call, deployed browser verification, cloud provisioning, production
migration or secret-manager setup was performed. No deployment/PASS claim is made
for those checks. API v1 remains **DRAFT**. Keep the PR Draft and task In Review
until Thư independently reviews; no merge is authorized by this evidence.

Related: [17T-37](https://linear.app/17thedev/issue/17T-37),
[17T-36](https://linear.app/17thedev/issue/17T-36),
[17T-35](https://linear.app/17thedev/issue/17T-35),
[17T-34](https://linear.app/17thedev/issue/17T-34).
