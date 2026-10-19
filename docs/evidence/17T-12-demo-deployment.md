# 17T-12 — Demo deployment evidence

Issue: [17T-12](https://linear.app/17thedev/issue/17T-12).
Runbook: [Render demo deployment](../cloud/runbooks/RENDER_API_DEPLOY_V0.1.md).
Status: **PREFLIGHT ONLY — GigaChat and Full Giga v0.2 NOT ACCEPTED**.
Date: 2026-10-19 (Asia/Bangkok).
Operator: development agent; no human review/cross-training claimed.
Intended owner/reviewer: Trà / Thư.

## Source and local checks

At 2026-10-19T14:16:30+07:00, local and GitHub main both resolved to
`f06d46462134f92f7626a515782f93e0c5f7f8e9`; remote main was checked again during follow-up.
The primary checkout remained on `feat/17t-71-agent-sandbox-sessions`,
`081db5dedbe3bb2f4368409e380f016a7df4ae3b` (5 commits ahead).
Six pre-existing frontend modifications were excluded and preserved.
Checks below ran on a separate git archive of the exact main SHA.

Environment: Windows, Node v24.20.0, npm 11.19.0.
The configured CI/target Node 22 and Linux were not reproduced.

| Exact command / action | Outcome | Limit |
| --- | --- | --- |
| `npm ci --no-audit --no-fund` in apps/api and apps/web | PASS, exit 0 | Install-script policy warnings for argon2/esbuild |
| `npm run build` in apps/api | PASS, exit 0 | Compile only |
| `npm run build` in apps/web | PASS, exit 0 | TypeScript + Vite |
| `npm exec -- tsx --test --test-concurrency=1 tests/config.test.ts tests/health.test.ts tests/csrf.test.ts tests/auth-negative.test.ts` in apps/api | PASS 33/33, 0 skipped, exit 0 | In-process/pg-mem, no hosted or real-Postgres proof |
| `npm test -- tests/auth-guard.test.tsx tests/chat-stream.test.tsx tests/chat-generation-controls.test.tsx tests/byok-settings.test.tsx` in apps/web | PASS 64/64, 4 files, exit 0 | jsdom/fixtures; React act warnings |
| Dynamic import of compiled API capabilities module in retained monorepo layout | PASS, exit 0 | Shared contract resolution only |

GitHub combined status returned an empty status list. The workflow-runs wrapper returned an empty list and is limited to PR-triggered runs. Neither establishes main Actions success. The PR #35 formal-review wrapper returned no reviews; other review evidence was not audited.

## Authenticated Render inventory

On 2026-10-19 the user confirmed **My Workspace**. Authenticated connector reads then succeeded:

| Read | Result |
| --- | --- |
| List services | Six existing services, all linked to other repositories; no Giga service |
| List Postgres instances | No Render Postgres instances |
| Dashboard access | Separate browser login still at GitHub sign-in; billing/usage/secret/proxy settings not verified |

No service IDs, personal account identifiers, credentials or unrelated service configuration are copied into this record.
No resources created, no cloud deployment, no live model/sandbox request and no external migration in this recorded preflight.

## Open prerequisites

- Review workspace billing/usage and approve dedicated resource/cost scope before creation; Free still consumes shared quotas.
- Retain repository root for both app services because packages/contracts is needed at build/runtime.
- Resolve production frontend relative /api routing and prove POST/cookies/CSRF/SSE; a Vite dev proxy is insufficient.
- Provision DB, provider and BYOK secrets privately; no corresponding secret variables were found in the inspected shell (name-only inspection). Remote secret availability remains unknown.
- Explicitly select Real API; fresh frontend sessions currently default to Mock.
- Main contains migrations 001–013 and auto-migrates at startup; validate the dedicated demo DB before boot.
- Independent source review, Linux/Node 22, public health/URLs/SHA, real Postgres, provider/browser P0 and cross-training remain unverified.
- Full additionally requires approved live Agent runtime/security/build/test/artifact evidence. Unmerged branch-only adapter/session code is not main.

## Deployment and browser record (not yet collected)

| Field | Actual value |
| --- | --- |
| Frontend URL / resource ID / full deploy SHA | NOT RUN |
| API URL / resource ID / full deploy SHA | NOT RUN |
| DB resource / migration version / restart persistence | NOT RUN |
| Model / provider access / capped test budget | NOT RUN |
| P0 C01–C06 | NOT RUN |
| P1 C07–C09; P2 C10 | NOT RUN; no deferral decision claimed |
| Full A01–A03 | NOT RUN |
| Browser screenshots/traces / safe logs | NOT RUN |
| Reviewer / review time / decision | NOT RUN |
| Cross-training operator / peer / outcome | NOT RUN |

For every actual case append: case ID, scope Chat/Full, priority, environment,
frontend/API SHA, ISO-8601 timestamp with timezone, action/command, expected/actual,
PASS/FAIL/BLOCKED/NOT RUN/DEFERRED, redacted evidence, operator, reviewer and blocker/decision.
Do not replace a NOT RUN result with PASS from a fixture.

**Current conclusion:** neither acceptance level has deployed evidence. This record does not authorize provisioning, production rollout, a paid plan or live sandbox execution. API remains DRAFT.
