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

**Preflight conclusion at this checkpoint:** neither acceptance level had deployed evidence. This record does not authorize production rollout, a paid plan or live sandbox execution. API remains DRAFT.

## Hosted infrastructure and topology test — 2026-10-19

The dashboard browser login succeeded. Billing preflight showed Hobby, no card
on file, 9.43/750 Free hours used, 1 MB/5 GB bandwidth and 0/500 build minutes used.
These are workspace-level observations, not a guarantee of future usage or cost.

Dedicated resources created in the user-confirmed workspace:

| Resource | ID / plan | Actual URL / state |
| --- | --- | --- |
| Frontend static site | srv-dbasfsks728c739goud0 | https://giga-web-demo-17t12.onrender.com — live at main f06d4646... |
| API Node service | srv-dbasg08m7kps73a4ecug / Free, Singapore | https://giga-api-demo-17t12.onrender.com — live at main f06d4646... |
| PostgreSQL | dpg-dbasff3bc2fs73ckaem0-a / Free, Singapore, version 16 | Available; expires 2026-11-18; no public credential copied |

Frontend deploy: dep-dbasfsss728c739govi0.
API first build succeeded on Linux/Node 22.23.3, but startup failed before
DATABASE_URL was configured. After configuring backend-only secrets,
dep-dbashd8m7kps73a4jl90 became live at
`f06d46462134f92f7626a515782f93e0c5f7f8e9`.
The user-supplied provider key was stored only in backend environment settings.
Output token cap for these bounded smoke requests was 256. Autodeploy was disabled.

### Executed HTTP checks on main deployment

A bounded CLI smoke recorded at 2026-10-19T07:40:37.463Z used two generated test
identities, not personal accounts. Raw sanitized results:
[HTTP smoke](17t-12/main-http-smoke.json),
[stream timing](17t-12/main-stream-timing.json) (2026-10-19T07:41:42.345Z).
Seventeen assertions passed: frontend deep-link and API health, unauthenticated
401 through both hosts, structured 404, A/B registration/login/me, owner-scoped
conversation read, real-provider response/history reopen, and old-session
rejection after logout for each user. Login cookies carried Secure, HttpOnly,
SameSite=Lax.

**Correction to the smoke's broad provider-stream PASS:** it proved real-provider
content and valid SSE events, not incremental delivery through the static proxy.
A longer comparative stream produced:

| Transport | First started | Delta delivery | Completion | Incremental |
| --- | --- | --- | --- | --- |
| Direct API | 151 ms | 2420–2845 ms, 9 transport chunks total | 2845 ms | PASS |
| Static-site /api rewrite | 2265 ms | All events at 2265 ms, 2 chunks total | 2265 ms | FAIL |

The static URL is diagnostic only and does not pass streaming P0. No browser
acceptance or Full Agent acceptance is claimed from these HTTP tests.

### Source fix candidate

Optional SERVE_WEB hosts the reviewed web bundle on the Node/API service origin,
bypassing the measured buffering static rewrite. Known UI/assets are additive;
API handlers, JSON errors, cookie/CSRF and SSE schemas remain unchanged.
See the compatibility table in the runbook and the API DRAFT deployment note.

Validation on the candidate, Windows/Node 24:

- API typecheck and build PASS.
- Focused web-host/config/server/404/CSRF suite: 29/29 PASS, 0 skipped.
- Full API suite: 459 PASS, 25 skipped, 0 FAIL (484 tests); skipped cases require
  real PostgreSQL constraints, triggers, MVCC, locks or timestamp precision.
  They were not run on the live demo database, and no all-security-PASS is claimed.
- Existing frontend production build PASS.
- Built-server socket smoke: /login 200 HTML, /health 200 JSON,
  /api/v1/missing 404 JSON.

An initial focused test found the HTML Cache-Control header was missing when
set in the static adapter's onFound callback. It was moved before response
creation, and the focused suite passed after that correction.

### Open security incident and acceptance gates

A database connection URL was accidentally emitted once by a browser form
snapshot. Its value is not copied into this document, source, screenshots or PR.
Subsequent form observations redact all values. The user was asked to create a
replacement default credential; API cutover and retirement of the exposed
credential remain OPEN and block security acceptance. No credential rotation
is claimed.

Browser login/reload/streaming on the new topology, Retry/Cancel, error/loading/
quota, controlled restart persistence, secret review, independent human review,
cross-training and Full Agent live sandbox/artifact evidence remain open.
