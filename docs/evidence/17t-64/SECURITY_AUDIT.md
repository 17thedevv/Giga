# 17T-64 — Frontend security and privacy audit

**Owner:** Thư · **Backend reviewer:** Trà · **Priority:** High

**Audit date:** 2026-10-26 (Asia/Saigon)

**Branch:** `chore/17t-64-frontend-security-audit`

**Base:** `origin/main` at `6ce98b1b8758f6a429a32316f4ed723220d92646` (merged 17T-33 / PR #41)

**Related work:** [17T-39](https://linear.app/17thedev/issue/17T-39) is Done; [17T-49](https://linear.app/17thedev/issue/17T-49), [17T-52](https://linear.app/17thedev/issue/17T-52), and [17T-60](https://linear.app/17thedev/issue/17T-60) were Todo when inspected.
**Historical exposure evidence:** [PR #37](https://github.com/17thedevv/Giga/pull/37) and its deployment preflight record.

## Scope and trust boundaries

This is a frontend audit of the current `main` implementation. Browser input, API responses, stream frames, agent task/output text, filenames, and external URLs are untrusted. The browser holds only the HttpOnly session cookie and transient component/API state; provider keys are sent to the credential endpoint and must remain server-side after submission. The API and database are separate trust boundaries. This patch changes frontend code and the web test toolchain only; it does not change backend authentication, CORS/CSRF policy, provider behavior, or live infrastructure.

Chat currently renders message text with React text nodes. There is no Markdown/HTML renderer, syntax-highlighter HTML insertion, untrusted image/embed renderer, `dangerouslySetInnerHTML`, `innerHTML`, DOM parser, or application `eval` path. React escaping preserves code and Markdown-like text while preventing it from becoming markup. Task 17T-52's future Markdown renderer and 17T-49's unfinished Agent message/artifact flows were not treated as implemented surfaces.

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
| Auth/API boundary | Cross-tenant IDs, invalid resource IDs, expired cookies, forged success, CORS/CSRF mismatch | ID path is encoded; a 404 remains an error; API calls use relative `/api/v1` URLs and `credentials: 'include'`. Backend source review only. | Frontend cannot authorize tenant ownership. API routes/services must enforce authenticated owner scope; browser cookie/CORS/CSRF compatibility was not exercised against Real API. 17T-60 is incomplete. | No frontend auth redesign. Trà must independently verify backend owner scoping and deployed Origin/CORS/cookie configuration. **Open backend/browser verification.** |
| Real versus Mock | Real API failure silently switching to demo fixtures | Existing Real/Mock tests and source review of `ApiModeContext`, adapter selection and Agent workspace mode branches | Mode is explicit and saved as a non-secret preference; Real mode does not fall back to mock data. | No silent fallback found; existing mode separation retained. **No finding.** |
| Bundles, logs and telemetry | Build-time secret injection, sourcemaps, console/analytics leakage | Production bundle scanned for synthetic sentinel, common key/token patterns and connection URLs; source searched for analytics, broad console output, sourcemap config and service workers | No production secret environment substitution, analytics/error-reporting SDK, service worker, or application console logging path found. Build emits no `.map` file. | No production debug tooling or secret-bearing environment configuration found in the web app. **Local bundle scan clean.** |
| Previously exposed database credential | Browser-visible database URL in PR #37 deployment preflight snapshot | Historical PR #37/preflight evidence reviewed; Render service/database metadata inspected read-only without reading or printing secret values | Treat the exposed credential as compromised. No independent evidence of rotation, application cutover, or retirement of the old credential was available. | No production secret or infrastructure was changed. Rotation/cutover/retirement checklist below is a **release blocker**. |

## Local verification

| Command | Result |
|---|---|
| `npm ci --prefix apps/web --no-audit --no-fund` | Pass; lockfile install completed. npm printed one upstream package deprecation warning (`whatwg-encoding@3.1.1`), with no audit finding. |
| `npm run typecheck --prefix apps/web` | Pass. |
| `npm test --prefix apps/web` | Pass: **237 tests across 15 files**. |
| `npm run build --prefix apps/web` | Pass: Vite production bundle built. |
| `npm audit --prefix apps/web` | Pass: **0 vulnerabilities** after patch. |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | Pass: **6/6**. |
| `git diff --check` | Pass. |
| Frontend lint | Not configured in `apps/web/package.json`; no lint command exists. |
| Built bundle scan | No synthetic sentinel, common Gemini/GitHub token pattern, Bearer token, or DB connection URL matched; no `.map` files emitted. Scan prints only matching asset names (none), never matched contents. |

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

Render service/database metadata was inspected without reading secret values. The available deployment metadata showed the demo API service on the 17T-12 deployment line rather than this branch; this local build is not a production deployment verification. No browser automation/E2E configuration or browser session connected to the Real API was available. No browser smoke test, Real cookie/CSRF/CORS test, deployment test, or live rotation verification is claimed. Frontend `package.json` has no lint script; repository CI runs install, typecheck, build, and Vitest.

## Open blockers and reviewer actions

| Blocker | Owner | Required evidence |
|---|---|---|
| Previously exposed DB credential has no verified rotation/cutover/retirement | Authorized infrastructure/service owner; Trà to verify | New credential deployed; old one revoked and confirmed unusable; snapshot access/retention addressed. Do not mark security gate pass before this. |
| Backend owner authorization, public DTO fields, CSRF/CORS and cookie settings | Trà | Review route/service scoping and deployed configuration; test cross-tenant IDs, expired session, worker lease/internal reasoning fields and BYOK DTOs. |
| Real API browser flow | Trà / environment owner | Approved test account and environment, then verify cookie auth, Origin/CORS, Stop/retry/chat and credential save/revoke with synthetic test credentials. |
| Dependency and source changes not yet independently reviewed | Trà | Review this Draft PR and confirm frontend/backend trust boundary. |
| Markdown rendering, Agent message/artifact flows, and complete account/session expiry work are incomplete dependencies | Owners of 17T-52, 17T-49, 17T-60 | Re-run this audit against the delivered implementations before treating their surfaces as covered. |

**Gate:** BLOCKED. Local frontend checks are clean, but the historical database credential retirement is unverified, Real API browser verification is unavailable, related Linear dependencies remain incomplete, and independent review is pending.
