# 17T-64 — Frontend security and privacy audit

**Owner:** Thư · **Backend reviewer:** Trà · **Priority:** High

**Audit date:** 2026-10-26 (Asia/Saigon)

**Branch:** `chore/17t-64-frontend-security-audit`

**Base:** `origin/main` at `6ce98b1b8758f6a429a32316f4ed723220d92646` (merged 17T-33 / PR #41)

**Branch sync:** `origin/main` advanced to `207d78327fd58962dd9acdb4f2cf3048234df0d9` through PR #42 while this branch remained based on `6ce98b1`. GitHub reported PR #43 mergeable and no conflicting paths were present; no rebase/history rewrite was needed or performed.

**Related work:** [17T-39](https://linear.app/17thedev/issue/17T-39) is Done; [17T-49](https://linear.app/17thedev/issue/17T-49), [17T-52](https://linear.app/17thedev/issue/17T-52), and [17T-60](https://linear.app/17thedev/issue/17T-60) were Todo when inspected.
**Historical exposure evidence:** [PR #37](https://github.com/17thedevv/Giga/pull/37) and its deployment preflight record.

## Scope and trust boundaries

This is a frontend audit of the current `main` implementation. Browser input, API responses, stream frames, agent task/output text, filenames, and external URLs are untrusted. The browser holds only the HttpOnly session cookie and transient component/API state; provider keys are sent to the credential endpoint and must remain server-side after submission. The API and database are separate trust boundaries. This patch changes frontend code and the web test toolchain only; it does not change backend authentication, CORS/CSRF policy, provider behavior, or live infrastructure.

Chat currently renders message text with React text nodes. There is no Markdown/HTML renderer, syntax-highlighter HTML insertion, untrusted image/embed renderer, `dangerouslySetInnerHTML`, `innerHTML`, DOM parser, or application `eval` path. React escaping preserves code and Markdown-like text while preventing it from becoming markup. Task 17T-52's future Markdown renderer and 17T-49's unfinished Agent message/artifact flows were not treated as implemented surfaces.

The current Real Agent UI reads a run and capabilities. The API client also retains historical helper methods for run admission, proposals, decisions and cancellation; these are not called by the current Real UI. The v0.2 draft expects `workspaceId` for run admission and does not implement proposal/decision/cancel routes, while the legacy helper signatures use `repository`/`baseRef` and historical routes. This follow-up projects any returned data from those helpers but does not change their request contract or claim their routes are operational. Trà should reconcile this with the unfinished 17T-49/Agent integration work.

## Audit matrix

| Surface | Attack vector | Negative test / evidence | Finding and risk | Remediation / status |
|---|---|---|---|---|
| Dependency graph | Vulnerable test runner packages | Reproducible lockfile audit before/after; package graph inspected | Three dev-only package records were vulnerable in the baseline; see dependency table. They do not ship in the browser bundle, but can affect developer/CI execution. | Raised Vitest to the fixed 4.1 line; lockfile updated. Post-patch audit reports zero vulnerabilities. **Fixed locally; CI pending PR.** |
| PR URL | `javascript:`, `data:`, mixed-case schemes, encoded path, userinfo, query redirect, hostile host | `security-boundaries.test.tsx` tests schemes, userinfo, evil subdomain, query and encoded path; valid URL case retained | `AgentRun.result.prUrl` had been used as an unrestricted link and clipboard value. | Accept only canonical `https://github.com/{owner}/{repo}/pull/{number}` URLs; reject unsupported values and use `rel="noopener noreferrer"`. **Fixed.** |
| Chat/SSE | Malformed JSON, unexpected event fields, provider secrets or internal data in payloads | `sse-parser.test.ts` validates malformed shapes, secret-bearing error text, and internal extra fields | Known events were cast wholesale and validation errors retained raw payloads; stream error text could reach UI. | Validate and project known fields, discard unknown fields, sanitize credential-shaped values, and remove raw payload retention. **Fixed for implemented event types.** |
| Generation/variant DTOs | Server returns `rawReasoning`, worker lease tokens, provider config, or candidate output on a failed attempt | `security-boundaries.test.tsx` supplies those fields and asserts they are stripped; malformed shapes reject | Generation and latest-turn results were accepted via TypeScript casts. | Validate and project only contract fields; sanitize partial/completed content and omit content for non-completed variants. **Fixed client-side; backend contract still needs independent verification.** |
| Conversation DTOs | Unexpected fields, injected markup, credential strings in history | `security-boundaries.test.tsx` supplies extra reasoning fields and synthetic credential/DB URL text | API conversation responses were trusted through TypeScript casts. | Validate and project conversation/message fields; redact recognized credential patterns from text. React still renders text, never HTML. **Fixed for conversation list/detail.** |
| Chat and diff rendering | HTML/script injection in assistant text, user text, diff lines or filenames | `security-boundaries.test.tsx` renders `<script>`, `<img onerror>`, and traversal-like filename fixtures | Current code renders these values as React text; no unsafe HTML sink found. | Keep raw HTML rendering absent; tests assert no script/image/iframe/anchor nodes are created. **No vulnerable sink found; regression coverage added.** |
| Agent PR result and artifacts | Malicious URL or path-like filename | URL tests plus text-only diff test; source review of `ApprovalBar.tsx`, `DiffViewer.tsx`, `AgentRunView.tsx` | Filenames are displayed as text; the PR result URL was the direct-navigation risk. | URL allowlist applied; filenames remain text and are not used for browser navigation/download. **Fixed for existing UI.** |
| Gemini BYOK | Server echoes submitted key in error text/details or unexpected success DTO | `security-boundaries.test.tsx` uses only synthetic sentinels; existing BYOK tests verify successful save clears the input | Credential response was accepted via a type cast, so an unexpected `apiKey` field could remain in UI state; API errors could echo request secrets. A failed save also left the field populated. | Project only validated metadata fields; sanitize error text/details using the submitted secret; clear plaintext after either success or failure. Mock BYOK remains in memory only. **Fixed in frontend; backend behavior still needs Trà review.** |
| Browser storage | Demo run/task text persists in `localStorage` | `agent-workspace-ux.test.tsx` checks synthetic key/DB URL absent before and after rehydrate | Demo Agent workspace/run data is persisted; credential-shaped text could otherwise survive refresh. | Redact credential-shaped strings and sensitive field names before persistence and during rehydrate. API mode/theme values are the only other app-owned local storage; mock auth stores a boolean in session storage. **Fixed for recognized credential formats.** |
| Session expiry | A protected API call returns 401 after protected data has loaded | `auth-guard.test.tsx` loads an authenticated user, forces a 401, and asserts protected content disappears and route returns to login | A later 401 did not invalidate the AuthContext user, leaving mounted protected UI visible until another session check. | Real API 401 dispatches a session-invalid event; AuthContext clears the user and AuthGuard hides protected children/routes to login. **Fixed.** |
| Auth/API boundary | Cross-tenant IDs, invalid resource IDs, expired cookies, forged success, CORS/CSRF mismatch | ID path is encoded; a 404 remains an error; API calls use relative `/api/v1` URLs and `credentials: 'include'`. Backend source review and anonymous browser CORS smoke below. | Frontend cannot authorize tenant ownership. API routes/services must enforce authenticated owner scope; authenticated cookie and CSRF behavior were not exercised against Real API. 17T-60 is incomplete. | No frontend auth redesign. Trà must independently verify backend owner scoping and deployed Origin/CORS/cookie configuration. **Open backend/browser verification.** |
| Real versus Mock | Real API failure silently switching to demo fixtures | Existing Real/Mock tests and source review of `ApiModeContext`, adapter selection and Agent workspace mode branches | Mode is explicit and saved as a non-secret preference; Real mode does not fall back to mock data. | No silent fallback found; existing mode separation retained. **No finding.** |
| Bundles, logs and telemetry | Build-time secret injection, sourcemaps, console/analytics leakage | Production bundle scanned for synthetic sentinel, common key/token patterns and connection URLs; source searched for analytics, broad console output, sourcemap config and service workers | No production secret environment substitution, analytics/error-reporting SDK, service worker, or application console logging path found. Build emits no `.map` file. | No production debug tooling or secret-bearing environment configuration found in the web app. **Local bundle scan clean.** |
| Real API browser boundary | Credentialed cross-origin fetch and CORS preflight from the deployed Web origin | Redacted browser trace in [real-api-browser-smoke-2026-10-26.json](real-api-browser-smoke-2026-10-26.json); HTTP GET/OPTIONS probes with expected Web and localhost origins | API commit `d676288090d3c3b5ecb63516f797cf3928885769` returned `/api/v1/auth/me` 401 without `Access-Control-Allow-Origin` or `Access-Control-Allow-Credentials`; OPTIONS returned 404. Chrome blocked the fetch from the expected Web origin. The deployed Web cannot read API responses. | Backend/Render owner must enable exact-origin credentialed CORS and preflight while preserving CSRF checks, then re-run on a controlled deployment. **Fail on this demo deployment; backend-owned.** |
| Previously exposed database credential | Browser-visible database URL in PR #37 deployment preflight snapshot | Historical PR #37/preflight evidence reviewed; Render service/database metadata inspected read-only without reading or printing secret values | Treat the exposed credential as compromised. No independent evidence of rotation, application cutover, or retirement of the old credential was available. | No production secret or infrastructure was changed. Rotation/cutover/retirement checklist below is a **release blocker**. |

## PR #43 follow-up findings (2026-10-26)

| Finding | Severity | Location | Risk | Remediation | Exact regression validation | Status |
|---|---|---|---|---|---|---|
| F-02 — Incomplete runtime DTO projection | P1 | `apps/web/src/lib/api/client.ts`; Agent/Skills views | Generic `response.json()` values and asserted response shapes could carry unexpected provider, worker, credential, or internal fields into UI state. | The shared request method now returns `unknown`; every returned JSON DTO is validated/projected at its boundary. Auth, conversations/messages, models, generations/variants, Agent runs/proposals/capabilities, preferences, Skills and provider credential responses expose only known fields. API error bodies are projected to safe error fields and a validated generation only. The workspace Agent contract has no public `approvalRequest`; that unknown legacy property is dropped rather than used to fabricate approval UI. | `security-boundaries.test.tsx`: `projects auth, conversation, model, Agent, preference and Skills responses to public DTO fields`; `projects every Agent run response path to the workspace-run contract`; `rejects malformed auth, chat, model, preference, Skills and Agent response shapes`. `agent-workspace-ux.test.tsx`: `P1 RunView: Real mode disables Cancel and omits uncontracted Approval controls`. | Fixed; local suite and Frontend CI run #46 plus Git Workflow run #160 passed on implementation SHA `b0b2857f5675f7dfb1a765c1bd5aa357356338b7`. |
| F-03 — SSE credential split across events | P1 | `apps/web/src/lib/api/sse-parser.ts`, `apps/web/src/features/chat/ChatView.tsx`, `apps/web/src/features/chat/MessageBubble.tsx`, `apps/web/src/lib/security/untrusted-content.ts` | Redacting individual delta strings misses a credential split between events; concatenation could expose it in streaming UI, final content, or clipboard. | The parser validates and projects each event but leaves delta text intact. ChatView concatenates deltas before sanitizing them; only sanitized text enters display state, completed messages and turn variants. Copy/display sanitize again. Known partial token fragments and secret assignments are redacted as they become recognizable; only short unresolved prefixes are withheld, while ordinary text is emitted without a fixed-size delay. This is pattern-based defense in depth, not a replacement for server-side provider-secret filtering. | `security-boundaries.test.tsx`: `withholds only unresolved credential-shaped stream suffixes, then redacts split credentials at completion`; `redacts a sufficiently long credential-shaped stream suffix interrupted before completion`; `redacts long credential assignments immediately without buffering their value`. `chat-conversation-streaming.test.tsx`: `keeps a credential split across stream deltas out of rendered state and clipboard` verifies the split synthetic sentinel is absent while streaming, after completion, and from copy output. | Fixed for documented patterns; local suite and Frontend CI run #46 plus Git Workflow run #160 passed on implementation SHA `b0b2857f5675f7dfb1a765c1bd5aa357356338b7`. Backend must prevent provider credentials from entering streamed content. |
| F-04 — Production debug global | P2 | `apps/web/src/features/chat/ChatView.tsx` and production assets | `window.__mockDataAdapter` exposed the mock adapter through a browser global, enabling inspection/mutation of demo state in production. | Removed the assignment and all application references; no development global is needed. | `chat-conversation-streaming.test.tsx` asserts the global is absent at runtime. `production-bundle-security.test.ts` scans built JavaScript assets for the global. Post-build scan: 1 JavaScript asset, 0 source maps, 0 credential/debug-pattern matches. | Fixed; local suite and Frontend CI run #46 plus Git Workflow run #160 passed on implementation SHA `b0b2857f5675f7dfb1a765c1bd5aa357356338b7`. |
| F-05 — Initial session invalidation fence | P2 | `apps/web/src/lib/api/client.ts`, `apps/web/src/app/context/AuthContext.tsx` | An in-flight successful protected response could arrive after another request returned 401; stale `getMe()` could restore authenticated UI. A protected 204 response also needed an epoch check. | The initial patch fenced AuthContext updates and 204/SSE results. Independent review later found that regular JSON returns and late 401s still needed generation checks; see the four findings below. | Earlier `auth-guard.test.tsx` and `security-boundaries.test.tsx` covered state fencing and 204. Follow-up tests now assert API-level 200/201/204 rejection and stale-login protection. | Superseded by the complete session-generation fix below. |

## Independent review follow-up findings (2026-10-26)

| Finding | Severity | Root cause and risk | Fix | Exact regression validation | Status |
|---|---|---|---|---|---|
| SESSION-01 — Stale successful protected response | P1 | `RealApiClient.request()` checked the generation on 204 and SSE paths, but returned ordinary JSON without a final generation assertion. A protected 200/201 could complete after a 401 and carry old-session data into caller state. | A single shared session generation is checked immediately after `fetch` and again after body consumption, before returning or projecting an error. Login/register remain exempt from protected-response rejection; login validates its own generation before returning. | `session-generation.test.tsx`: `rejects a protected 200 response that arrives after a 401 invalidates its generation`; `rejects a protected 201 response arriving after session invalidation`; `keeps protected 204 responses fenced after session invalidation`; `allows ordinary concurrent protected successes in the same generation`; `does not restore a Real user after switching to Mock mode while getMe is in flight`. | Fixed locally; final commit and CI status recorded below after push. |
| SESSION-02 — Old 401 invalidating a new session | P1 | Every protected 401 incremented the global epoch, including responses started before a later login; a stale logout could also clear a newly authenticated user. | Protected requests carry the originating shared generation. Only a 401 from the current generation invalidates it, making concurrent 401 handling idempotent. Real login/logout, Mock login/logout, and API-mode transitions advance the same generation; AuthContext commits only current-generation results. | `session-generation.test.tsx`: `ignores an old-session 401 after a new login without clearing authenticated UI`; `invalidates only once for multiple 401s from the same session generation`; `does not let a delayed logout response clear a newer authenticated user`; `does not restore a Real user after switching to Mock mode while getMe is in flight`. Existing `auth-guard.test.tsx` verifies protected UI disappears on current-session 401. | Fixed locally; final commit and CI status recorded below after push. |
| STREAM-01 — Unbounded SSE buffers | P2 | An incomplete line and accumulated multiline `data:` payload had no size limits. A malformed stream could grow parser buffers until the connection ended. | Parser now enforces 64 Ki UTF-16 code units per line and 256 Ki per event data payload. It validates each fragment before copying, processes large chunks incrementally, clears retained fields on overflow, reports a generic error, and becomes terminal. Both stream callers cancel the reader on parser errors and release its lock. | `sse-parser.test.ts`: `rejects an oversized incomplete line without retaining or echoing its payload`; `bounds accumulated multiline event data before joining it`; `processes a large chunk incrementally while rejecting a large unterminated line`. `session-generation.test.tsx`: `cancels and releases an oversized message SSE stream`; same test for `variant`. Existing fragmented UTF-8 / ordinary event tests remain enabled. | Fixed locally; final commit and CI status recorded below after push. |
| TEST-01 — Production bundle check could be skipped | P2 | `production-bundle-security.test.ts` skipped when `dist/assets` did not exist, so CI's normal unit-test command did not make bundle inspection a required gate. | Unit tests now exercise the scanner with temporary fixtures and do not depend on repository build output. CI runs `npm run test:production-security` immediately after a successful build; the command fails closed if dist/assets or JavaScript assets are missing and scans all chunks, forbidden credential/debug patterns, and emitted or referenced source maps. Reports include filenames/categories only, never matching contents. | `production-bundle-security.test.ts`: `fails closed when the required build output or JavaScript assets are missing`; `scans every JavaScript asset without assuming a fixed chunk count`; `reports debug globals and secret patterns without printing matching values`; `rejects emitted source maps and sourceMappingURL references`. The CI workflow includes a required post-build step. | Fixed locally; final commit and CI status recorded below after push. |

The parser bounds individual lines and event data, not the total duration or cumulative size of an otherwise valid stream. Backend generation limits and cancellation remain necessary to bound total output. A parser limit is fail-closed: the stream caller cancels the reader, drops the parser's retained payload, and surfaces a generic failure; this can reject a legitimate event larger than the documented cap.

### Streaming redaction limits

The browser can redact the credential formats currently recognized by `sanitizeUntrustedText` (Gemini/GitHub/OpenAI-style keys, Slack/Google tokens, JWT-shaped values, Bearer values, connection URLs, and common secret assignments). It cannot know every provider's proprietary format, prove that arbitrary model text contains no secret, or prevent a secret already sent by the server from appearing in network tooling, server logs, browser extensions, or memory inspection. The backend must filter provider credentials before emitting SSE events and must not place credentials in assistant content or public DTOs. No deployed Real API behavior was verified for this follow-up.

## Local verification

| Command | Result |
|---|---|
| `npm ci --prefix apps/web` | Pass; lockfile install completed. npm printed one upstream package deprecation warning (`whatwg-encoding@3.1.1`), with no audit finding. |
| `npm run typecheck --prefix apps/web` | Pass. |
| `npm test --prefix apps/web` | Pass: **247 tests across 16 files** (includes the built-bundle security assertion). |
| `npm run build --prefix apps/web` | Pass: Vite production bundle built. |
| `npm audit --prefix apps/web` | Pass: **0 vulnerabilities** after patch. |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | Pass: **6/6**. |
| `git diff --check` | Pass. |
| Frontend lint | Not configured in `apps/web/package.json`; no lint command exists. |
| Built bundle scan | **1 JavaScript asset**, **0 source maps**, and **0 matches** for synthetic/common Gemini, GitHub, OpenAI-style, Bearer, database URL, or `__mockDataAdapter` patterns. Scan prints only matching asset names (none), never matched contents. |

These local checks were run against implementation commit `b0b2857f5675f7dfb1a765c1bd5aa357356338b7`. GitHub Frontend CI run [#46](https://github.com/17thedevv/Giga/actions/runs/40289073850) and Validate Git Workflow run [#160](https://github.com/17thedevv/Giga/actions/runs/40289073925) both completed successfully on that SHA. The earlier runs #45/#153 validated only the pre-follow-up baseline `51d7b45ed3fc609acf3862d37570147fd1a37de4`.

These are local checks. They do not establish GitHub CI status, production deployment health, or browser behavior against the Real API.

## Dependency advisories

Baseline was the merged `origin/main` web lockfile, before this patch. Initial `npm audit` reported **3 vulnerable package records (1 moderate, 2 critical)**, all in the web development/test dependency graph. Their exact baseline paths were:

| Baseline package path | Advisory | Affected range | Upstream patched version | Exposure |
|---|---|---|---|---|
| `apps/web` → dev `vitest@3.2.7` → `@vitest/mocker@3.2.7` | [GHSA-82fw-gwwq-j7x9](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9), Moderate | `@vitest/mocker` and `vitest` `>=2.1.0 <4.1.11` (also 5.0.0 betas) | 4.1.11 | Test/dev server mock redirect path traversal / file read. Not in production browser code; exploitation requires access to an affected mocker/dev server path. |
| `apps/web` → dev `vitest@3.2.7` → `@vitest/mocker@3.2.7` | [GHSA-qxg6-89mg-rqv8](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8), Moderate | `@vitest/mocker >=2.1.0-beta.7 <4.1.12` | 4.1.12 | Unauthenticated manual mock registration can inject served JavaScript when the affected dev-server mocker endpoint is reachable. Not shipped to browser production. |
| `apps/web` → dev `vitest@3.2.7` → `tinypool@1.1.1` | [GHSA-5gmw-xhrv-c9v3](https://github.com/tinylibs/tinypool/security/advisories/GHSA-5gmw-xhrv-c9v3), High | `tinypool <=2.1.0` | 2.1.1 | Prototype-polluted worker options can cause worker code execution in a process using the affected pool. Dev/CI execution risk; not browser runtime. |
| `apps/web` → dev `vitest@3.2.7` → `tinypool@1.1.1` | [GHSA-85c8-ppgw-ccpr](https://github.com/tinylibs/tinypool/security/advisories/GHSA-85c8-ppgw-ccpr), High | `tinypool <=2.1.0` | 2.1.2 | Prototype pollution of worker filename options can redirect worker execution. Dev/CI execution risk; not browser runtime. |

The smallest compatible update was to direct dev dependency `vitest@^4.1.12`, which supports this repository's Node 22/Vite 6 environment. The resulting lock uses `vitest@4.1.12` and `@vitest/mocker@4.1.12`; Vitest 4 no longer brings `tinypool` into this graph. `npm audit` after the change reports **0 vulnerabilities**. No production dependency was upgraded. The baseline npm severity summary and upstream per-advisory severity labels are recorded as reported by their respective tools.

## BYOK and exposed database credential handling

The BYOK input is password-typed, held in component state while being entered/submitted, and cleared on success, dismiss, or failure. The browser sends it only to the credential API. The frontend now accepts only the metadata contract (`id`, `provider`, masked four-character hint, status and timestamps); unexpected response properties are dropped. Error strings/details are sanitized, including exact sensitive values extracted from the JSON request body. Synthetic fixtures used in tests are not real credentials.

PR #37's preflight record exposed a database connection URL through browser form observation. This is treated as a compromised credential. **Rotation, cutover and retirement are not verified.** Render metadata was inspected read-only; it did not establish that the old credential is retired. No credential values were fetched, printed, rotated, revoked, or changed.

Required verification checklist for the authorized backend/infrastructure owner:

1. Identify the affected service and credential through an approved secret-management view without copying its value into browser evidence, logs, tickets, or this repository.
2. Provision a new database credential and update the intended service configuration through the approved production change process.
3. Deploy/restart and verify the application connects successfully using the new identity; record deploy/configuration metadata only.
4. Retire/revoke the old credential and verify authentication with it fails, without exposing either value.
5. Review/remove or access-restrict any retained browser snapshots containing the value, following the organization's retention process.
6. Attach independent evidence of all steps to 17T-64 and have Trà verify the backend boundary.

## Auth, deployment, and verification limits

The frontend sends same-origin relative API requests with `credentials: 'include'`. Backend source reviewed for this audit sets the session cookie `HttpOnly`, `Secure` in production by default, with configurable `SameSite`; mutation routes are guarded by fail-closed Origin/Referer CSRF middleware; production allowed origins must be configured. Conversation routes pass the authenticated owner ID into service queries. These are source observations only; this frontend change does not certify every backend route, actual deployed environment setting, cross-tenant behavior, or production CORS/cookie behavior.

### Render and demo endpoint verification (read-only, 2026-10-26)

Using the explicitly confirmed Render workspace `My Workspace`, the read-only service/deploy listing independently verified the demo resources and current deployment metadata. No environment variables, connection strings, secrets, or logs were inspected; no settings or infrastructure were changed, and no deploy was triggered.

| Resource | Verified state |
|---|---|
| API `giga-api-demo-17t12` | Auto-deploy disabled; latest listed deploy is `live` on commit `d676288090d3c3b5ecb63516f797cf3928885769`. |
| Web `giga-web-demo-17t12` | Auto-deploy disabled; latest listed deploy is `live` on commit `45fd5adba18aef58fbe5d47dfe58022689f622e1`. |
| PostgreSQL `giga-demo-17t12-db` | `available`, PostgreSQL 16, Singapore. |

The deployed API and Web commits are not the 17T-64 branch/head, so no 17T-64 deployment is verified. The public endpoints are [Giga API Demo](https://giga-api-demo-17t12.onrender.com/) and [Giga Web Demo](https://giga-web-demo-17t12.onrender.com/).

Unauthenticated HTTP smoke checks from this environment on 2026-10-26 returned `200` for `GET /health`, `401` for `GET /api/v1/auth/me`, and `200` for the Web root. Response bodies were not inspected or printed; no cookie or credential was sent. These checks establish endpoint reachability and anonymous `/auth/me` rejection only. They do not verify browser cookie behavior, CSRF, credentialed CORS, tenant authorization, or authenticated chat workflows.

The repository still has no Playwright, Puppeteer or Cypress dependency. For this follow-up, Playwright 1.64.1 was installed in a temporary directory and run headlessly with the installed Chrome 155 executable; nothing was added to the repository. The owner confirms an approved demo account and secure runner exist, but that account and runner are not connected to this session. No account credentials or preloaded session cookies were used. The anonymous browser test found the deployed CORS failure documented below; it did not exercise login, logout, cookie attributes, authenticated authorization, chat streaming, or BYOK. Those checks remain **NOT TESTED**. Frontend `package.json` has no lint script; repository CI runs install, typecheck, build, the mandatory production bundle scan, and Vitest.

**F-01 — BLOCKED.** Render’s supported flow is to add a managed PostgreSQL user (which becomes default), update and redeploy every dependent service, verify connections using the old user have drained, then delete/deactivate the old user; see [Render credential rotation](https://render.com/docs/postgresql-credentials) and the [create](https://api-docs.render.com/reference/create-postgres-user), [list](https://api-docs.render.com/reference/list-postgres-users), and [delete](https://api-docs.render.com/reference/delete-postgres-user) API references. The connected Render MCP exposes none of these credential lifecycle operations, and no secure Dashboard/API write session is attached. The available interface therefore could not perform the managed-user rotation or secure cutover; no credential or service configuration was changed, no deployment was triggered, and no old-user login test was attempted.

The verified database plan is `free`. Render documents that Free Postgres has no PITR recovery and no managed logical backups; a secure `pg_dump` plus restore validation or another approved recovery path is required before cutover. No backup/export or restore validation is available as evidence. Because environment values were not inspected and no managed-user listing is exposed, the compromised username and every service using it remain unverified. The accessible PR #37 metadata has no image/recording links or comments, and its committed deployment evidence files contain no PostgreSQL URL or obvious credential-assignment pattern. This does not establish whether browser-session captures, local snapshots, or external retained artifacts exist; none could be identified or removed/restricted through the available tools.

## Final credential and Real API verification attempt (2026-10-26)

### A. Credential rotation — BLOCKED

| Check | Result | Evidence / limitation |
|---|---|---|
| Database identity and state | PASS | Read-only Render metadata identifies `giga-demo-17t12-db`, PostgreSQL 16, Singapore, plan `free`, status `available`. |
| Replacement credential provisioned | NOT DONE | No Render credential create/list/delete operation or connected secure Dashboard/API session is available. No secret value was requested or read. |
| API cutover and service dependency inventory | NOT DONE | Service environment values were not inspected; no managed-user metadata was available to identify every consumer. No Render service configuration was changed or deployed. |
| Old credential revoked and rejected | NOT DONE | No safe way to identify the old managed user or perform the delete/deactivation and negative authentication test. |
| Backup/recovery readiness | BLOCKED | The database is on the Free plan; Render documents no PITR or managed logical backups for Free Postgres. No secure export/restore evidence is available. See [Render Postgres recovery and backups](https://render.com/docs/postgresql-backups). |
| PR #37 artifact/snapshot remediation | PARTIAL / BLOCKED | Accessible PR metadata has no screenshot links, recording files or comments; scanned committed deployment evidence files had no PostgreSQL URL or obvious credential assignment. External browser captures and retained snapshots remain uninspected and unchanged. |

**F-01 final status: BLOCKED.** No replacement, cutover, revocation, old-user rejection, backup validation, or complete snapshot remediation is evidenced.

### B. Real API browser testing — FAIL (partial); remaining checks NOT TESTED

The anonymous Chrome/Playwright evidence is [real-api-browser-smoke-2026-10-26.json](real-api-browser-smoke-2026-10-26.json), captured at `2026-10-26T09:52:09.975Z` (`16:52:09.975 Asia/Saigon`). Browser: Playwright 1.64.1 with Chrome 155.0.8059.85 in fresh headless contexts. No test account credentials or preloaded session cookies were used; response bodies were not inspected or recorded, and no screenshots were captured.

| Check | Result | Details |
|---|---|---|
| Tested frontend implementation SHA | NOT TESTED | No 17T-64 frontend deployment exists in the inspected Render resources. The live Web deployment is `45fd5adba18aef58fbe5d47dfe58022689f622e1`. |
| Tested API SHA | Identified, not security-passed | Live API deployment is `d676288090d3c3b5ecb63516f797cf3928885769`. Direct browser navigation to `/health` returned 200. |
| Credentialed API fetch from expected Web origin | FAIL | Browser fetch to `/api/v1/auth/me` was blocked by CORS. The direct HTTP probe returned 401 but had no `Access-Control-Allow-Origin` or `Access-Control-Allow-Credentials` header. |
| Disallowed localhost origin | BLOCKED_BY_CORS | Browser fetch was not readable, as expected for an untrusted origin. The expected Web origin fails too, so the CORS security boundary is not correctly configured for the application. |
| OPTIONS preflight | FAIL / incomplete | Direct OPTIONS probes returned 404 without CORS headers. Playwright did not expose an OPTIONS request in its trace, so a browser preflight sequence is not claimed as verified. |
| Authentication, cookies, CSRF mutation tests, two-account isolation | NOT TESTED | Approved account and secure runner are reported to exist but are not connected to this session; no credentials were provided. |
| Chat streaming, Stop/Retry/Regenerate, BYOK/privacy | NOT TESTED | Deployed Web is not the reviewed frontend; authenticated browser workflows were not run. |

The deployed API source at `d676288090d3c3b5ecb63516f797cf3928885769` registers CSRF middleware but no CORS middleware. The exact deployed behavior is therefore a backend/deployment issue for Trà and the API service owner to resolve; this frontend PR does not change backend code or Render settings. Preserve an exact origin allowlist and existing CSRF checks when fixing it.

**Real API browser gate: FAIL (CORS); full browser suite: BLOCKED/NOT TESTED.** No production deployment or authenticated security conclusion is claimed.

### C. Overall decision

- Credential Rotation: **BLOCKED**.
- Real API Browser Testing: **FAIL (partial CORS failure); other required checks NOT TESTED**.
- Both tasks completed: **NO**.
- Evidence sufficient for merge consideration: **NO**. F-01 is unresolved and the deployed demo API fails the expected Web-origin CORS check. PR #43 remains Draft; do not merge or deploy from this result.

## Open blockers and reviewer actions

| Blocker | Owner | Required evidence |
|---|---|---|
| F-01 credential rotation, backup readiness and snapshot retention are unverified | Authorized infrastructure/service owner; Trà to verify | Provide a managed credential path; establish and validate recovery first; cut over all dependent services; verify old-user rejection; address external retained evidence. Do not mark PASS before independent evidence. |
| Deployed API CORS failure blocks the expected Web origin | Trà / backend and Render service owner | Add exact-origin credentialed CORS and preflight without weakening CSRF; verify Web can read authenticated responses, disallowed origins cannot, and mutation preflights fail closed. The current API source commit has no CORS middleware registration. |
| Real API browser flow: authentication and feature coverage incomplete | Trà / environment owner | Connect the secure runner/account and a controlled deployment of the reviewed frontend; test login/logout/expiry/cookies, two-account isolation, streaming/Stop/Retry/Regenerate, and BYOK with synthetic values. |
| PR #37 browser-observation snapshot retention | Authorized evidence/retention owner | Locate original browser captures/snapshots outside accessible PR metadata and confirm redaction, deletion, or restricted access without reproducing the value. |
| Backend owner authorization, public DTO fields, CSRF and cookie settings | Trà | Review route/service scoping and deployed configuration; test cross-tenant IDs, expired session, worker lease/internal reasoning fields and BYOK DTOs. |
| Legacy Agent admission/proposal/decision/cancel helpers do not match the current v0.2 draft routes and request shape; current Real UI does not call them | Trà / 17T-49 owner | Confirm whether to remove, migrate or formally scope these helpers when the Agent integration is delivered; validate against the backend contract. |
| Dependency and source changes not yet independently reviewed | Trà | Review this Draft PR and confirm frontend/backend trust boundary. |
| Markdown rendering, Agent message/artifact flows, and complete account/session expiry work are incomplete dependencies | Owners of 17T-52, 17T-49, 17T-60 | Re-run this audit against the delivered implementations before treating their surfaces as covered. |

**Gate:** BLOCKED. The limited real-browser check **FAILED** for CORS on the deployed demo; authentication, tenant isolation and chat/BYOK flows remain untested. F-01 remains blocked with no verified backup, rotation, cutover, revocation or snapshot remediation. The reviewed frontend is not deployed, related Linear dependencies remain incomplete, and independent review is pending.

## Independent-review follow-up validation

| Command | Result |
|---|---|
| `npm ci --prefix apps/web` | Pass; lockfile install completed, 0 vulnerabilities. npm reported only the existing `whatwg-encoding@3.1.1` deprecation notice. |
| `npm run typecheck --prefix apps/web` | Pass. |
| `npm test --prefix apps/web` | Pass: **263 tests across 17 files**. |
| `npm run build --prefix apps/web` | Pass; Vite built 72 modules. |
| `npm run test:production-security --prefix apps/web` | Pass; scanned 1 JavaScript asset, 0 source maps, and 0 forbidden-pattern matches. |
| `npm audit --prefix apps/web --audit-level=moderate` | Pass: **0 vulnerabilities**. |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | Pass: **6/6**. |
| `git diff --check` | Pass. |
| Frontend lint | Not configured; no lint script exists. |
| Repository Git workflow validator | Pass on branch `chore/17t-64-frontend-security-audit`, PR title `chore(web): harden frontend security and privacy`, and committed PR range. |
| GitHub Frontend CI | Pass: run [#48](https://github.com/17thedevv/Giga/actions/runs/40295634793) on implementation commit `7614d1e788663ec581e3e4f1ae021005957bfff6`; typecheck, build, mandatory bundle scan, and all Vitest tests succeeded. |
| GitHub Validate Git Workflow | Pass: run [#163](https://github.com/17thedevv/Giga/actions/runs/40295634789) on implementation commit `7614d1e788663ec581e3e4f1ae021005957bfff6`. |
| Render read-only inspection | Pass: service/deploy metadata and PostgreSQL state above verified through the authorized workspace; no secret values read and no infrastructure writes performed. |
| Unauthenticated demo HTTP smoke | Limited pass: API `/health` 200, anonymous `/api/v1/auth/me` 401, Web `/` 200; response bodies not inspected or printed. Not browser or authenticated-flow evidence. |
| GitHub CI on documentation head `8b68721b39436f5c0766683c69bc10539ad26eae` | Pass: Frontend CI run [40298508267](https://github.com/17thedevv/Giga/actions/runs/40298508267) and Validate Git Workflow run [40298508168](https://github.com/17thedevv/Giga/actions/runs/40298508168). Both completed successfully. |

The final code/test implementation commit for the frontend findings is `7614d1e788663ec581e3e4f1ae021005957bfff6`. That implementation was tested locally after a clean `npm ci` and verified by the two GitHub workflows listed above. The production bundle script is mandatory in `.github/workflows/web-ci.yml` after `npm run build`; unit tests exercise its scanner using temporary fixtures and do not depend on pre-existing `dist/` output. The anonymous browser CORS smoke is recorded separately above and in `real-api-browser-smoke-2026-10-26.json`; it does not include an approved authenticated session or prove deployed security. CI for this final documentation/evidence commit is pending and will be recorded after GitHub reports it.
