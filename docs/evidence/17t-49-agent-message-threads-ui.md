# 17T-49 — Durable Agent Message Threads

**Status:** Draft implementation evidence; API contract v0.2 remains DRAFT.
**Branch:** `feat/17t-49-agent-message-threads-ui`
**Baseline:** `64ec9eda349521974fe16dad2d4b5b01c822a6ac` (`origin/main`, includes PR #46).
**Linear:** [17T-49](https://linear.app/17thedev/issue/17T-49/implement-durable-gigaagent-message-threads-and-follow-up-composer).
**Scope:** frontend API client, Real Agent run detail, message thread and follow-up composer. No API implementation, database migration, deployment, or Mock behavior change.

## Trust model and boundaries

- Browser state is a view of authenticated API responses. Run messages are fetched from `GET /api/v1/agent/runs/:id/messages`; the client does not persist the transcript in local or session storage.
- The shared Agent message schema is the response boundary. The web client projects only the canonical public fields, checks each message's run and workspace against the requested run, validates size/NUL/sequence constraints, and discards additive private fields.
- Message content is rendered as React text with preserved whitespace. Markdown and raw HTML are not interpreted. Role labels distinguish user, assistant, and tool summary messages.
- Follow-up is permitted only when the authenticated capability DTO explicitly says `followUp.available === true` and the run status is not `completed`, `failed`, or `cancelled`. The API remains responsible for authentication, CSRF, owner/workspace checks, idempotency and terminal-state rejection.
- Real API failures remain visible as safe, generic UI states. The new feature does not read from or fall back to Mock data.

## API compatibility

No public route, DTO, status, cursor, or error contract was changed. The frontend now consumes the already implemented candidate endpoints documented in `docs/contracts/GIGA_AGENT_API_V0.2.md`:

| Operation | Existing API behavior | Frontend behavior |
| --- | --- | --- |
| `GET /api/v1/agent/runs/:id/messages?limit=&cursor=` | `{ items, nextCursor }`, default 50/max 100, ascending sequence, opaque per-run cursor | Typed projection; checks requested run/workspace and strict ascending sequence; preserves cursor exactly |
| `POST /api/v1/agent/runs/:id/messages` with `Idempotency-Key` | 201 new message, 200 exact replay, 409 changed key/body or terminal run | Sends a normalized 1–16,384 UTF-8 byte message; exact replay retains the same body/key after uncertainty; 409 refreshes authoritative run state |
| `GET /api/v1/agent/capabilities` | `durableMessages` available; `followUp` disabled as `runtime_unavailable` | Loads history; displays a read-only reason and does not render an enabled composer under the current runtime metadata |

Message pagination shows older persisted messages first and requests further pages only with the server-provided cursor. A conflicting local sequence causes a safe reconciliation failure instead of silently replacing a different message. Terminal runs link to the existing workspace launcher to admit a new run; they cannot be resumed or mutated from this view.

## Persistence and backend limitations

Repository inspection found migration `013_agent_messages.sql`. It creates owner/workspace/run-scoped messages with unique run sequence and idempotency keys, an immutable-message trigger, and backfills the initial user task plus completed assistant summary. Existing API tests cover monotonic pagination, terminal 409 behavior, tenant isolation and internal-field redaction.

`AgentRepository.canPersistMessages()` checks whether migration 13 is recorded. If not, the GET path returns only a synthesized view of the initial run task; it does not persist follow-ups. This is a compatibility fallback, not proof that any deployed database has migration 13 applied. The backend capability response currently disables `followUp` because run execution is unavailable. No real follow-up POST, assistant response, or live database durability is claimed by this frontend change.

## Regression coverage

Added API-client tests in `apps/web/tests/agent-api-client.test.ts` for:

- Projection dropping synthetic owner, lease, provider, reasoning and internal fields.
- Rejecting mismatched run/workspace IDs and non-increasing message sequences.
- Query parameter encoding and preserving the opaque message cursor.
- Stable idempotency key/body replay after a network failure; definite 409 is not retried.
- UTF-8 byte limit and NUL rejection before fetch.

Added Real Agent UI tests in `apps/web/tests/agent-real-views.test.tsx` for:

- Plain-text handling of script-shaped content and no rendering of synthetic private properties.
- Restored route history, refresh, cursor pagination and stale response fencing after run navigation.
- Read-only behavior when `followUp` is disabled; a terminal run's new-run workspace action.
- Synthetic enabled-capability path for eligible nonterminal statuses, synchronous double-submit prevention, stable-key retry after uncertain outcome, keyboard submission, and authoritative status refresh after a 409.

## Verification evidence

| Command | Result |
| --- | --- |
| `npm ci --prefix apps/web` | PASS; 149 packages, 0 vulnerabilities |
| `npm run typecheck --prefix apps/web` | PASS |
| `npm test --prefix apps/web -- --reporter=dot` | PASS; 300 tests in 19 files |
| `npm run build --prefix apps/web` | PASS; Vite production bundle built |
| `npm run test:production-security --prefix apps/web` | PASS; one JavaScript asset scanned |
| `npm audit --prefix apps/web --audit-level=moderate` | PASS; 0 vulnerabilities |
| Frontend lint | Not configured in `apps/web/package.json` |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | PASS; 6 tests |
| `node .agents/scripts/validate-skills.mjs` | PASS |
| `git diff --check` | PASS at local verification checkpoint |
| GitHub Frontend CI | PASS on implementation commit `105607edf25800811cea4ba00d7fcc05bbb65ecb`; [run #66](https://github.com/17thedevv/Giga/actions/runs/41025581394) |
| GitHub Validate Git Workflow | PASS on implementation commit `105607edf25800811cea4ba00d7fcc05bbb65ecb`; [run #213](https://github.com/17thedevv/Giga/actions/runs/41025581472) |
| Final evidence-commit CI refresh | PASS on `4ac42738bd2fde8dbf9cfac2989fb49fe2ef0199`; Frontend CI [run #67](https://github.com/17thedevv/Giga/actions/runs/41025731548), Git Workflow [run #214](https://github.com/17thedevv/Giga/actions/runs/41025731768) |
| `npm run typecheck --prefix apps/api` / `npm run build --prefix apps/api` | PASS; backend sources unchanged |
| Agent API focus: `npx tsx --test --test-concurrency=1 tests/agent/agent-messages.test.ts tests/agent/agent-api.test.ts tests/agent/agent-contract.test.ts` | PASS; 56 passed, 3 PostgreSQL-specific skips |
| `npm test --prefix apps/api` | BLOCKED/FAIL in this environment; see below |

The full API suite was also attempted. This worktree has no dedicated safe `TEST_DATABASE_URL`, so the suite used pg-mem and exited nonzero in unchanged sandbox lifecycle tests that call PostgreSQL-only functions/constraints (for example `settle_agent_sandbox_allocation`). Real PostgreSQL locking, trigger, and privilege checks were skipped by the test harness. This is not API compatibility evidence for a live deployment; CI's PostgreSQL-backed run remains the authoritative check.

No browser/Playwright runner is configured in `apps/web/package.json`, and no browser automation tool is available in this session. Responsive rules, focus-visible behavior, semantic controls, and keyboard submission have source/test coverage; no browser screenshot or deployed Real API test is claimed.

## Dependency audit note

The requested frontend audit is clean. A separate, unchanged backend audit reports one moderate advisory: `GHSA-rmxm-3fg6-px4f` for `@hono/node-server` versions 1.19.10–2.1.2 (`serveStatic` double-decodes request paths). This PR does not change backend code or its lockfile; backend owner should review/fix that dependency independently, particularly if `SERVE_WEB` static hosting is enabled.

## Review and delivery state

Draft PR #47: https://github.com/17thedevv/Giga/pull/47. The PR was created at implementation commit `105607edf25800811cea4ba00d7fcc05bbb65ecb`; CI runs #66 and #213 passed on that commit. The code and verification record are separate commits so the evidence file can contain a stable SHA for the code commit.

An explicit GitHub reviewer request for the Linear reviewer account `17thedev` was rejected with HTTP 422 because that account is not a repository collaborator. A PR conversation comment mentioning `@17thedev` was posted (comment ID `6518343353`); GitHub's formal requested-reviewer list remains empty. Trà's independent review is still pending.

The API contract remains DRAFT. No deployed frontend/backend SHA, authenticated browser flow, or database migration state is verified here. Keep the PR Draft; local checks and CI are not deployment evidence.
