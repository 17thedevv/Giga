# 17T-48 — Real Agent workspaces and run history

**Owner:** Thư · **Backend DTO reviewer:** Trà · **Priority:** High

**Branch:** `feat/17t-48-agent-workspaces-real-ui`

**Base checked:** `origin/main` at `e5b429593f126857a2a3a4213b2ab04a629d41a2`
**Contract:** Agent API v0.2 remains DRAFT; no backend or contract files were changed.

## Implemented API surface

The Real UI uses the existing authenticated endpoints only:

| Purpose | Endpoint | Client/UI behavior |
|---|---|---|
| Capability gating | `GET /api/v1/agent/capabilities` | Runtime schema reader fails closed for unknown or inconsistent capabilities. |
| Create blank workspace | `POST /api/v1/agent/workspaces` | Creates a backend-owned metadata record; no files or runtime are implied. |
| List workspaces | `GET /api/v1/agent/workspaces?limit=&cursor=` | 20-item pages; workspace cursor tracked separately from run history. |
| Restore workspace | `GET /api/v1/agent/workspaces/:id` | Used for `/agent/workspaces/:workspaceId` and `?workspace=` restoration. Owner-scoped 404 is shown safely. |
| Admit run | `POST /api/v1/agent/runs` | Includes `Idempotency-Key`; only advertises Ask/Plan/Execute when capability metadata permits. |
| List runs | `GET /api/v1/agent/runs?limit=&cursor=&workspaceId=` | 20-item pages, optional selected-workspace filter, independent run cursor. |
| Restore run detail | `GET /api/v1/agent/runs/:id` | Route refresh re-fetches authoritative status/result; owner-scoped 404 is not replaced with Demo data. |

The backend source at the checked base advertises workspace management, run admission, run history, durable messages and event replay. It reports `runExecution`, Ask/Plan/Execute and Cloud runtime as unavailable. The UI therefore allows the backend-supported durable admission when no mode is advertised, labels it as execution unavailable, and only displays the status/error/result returned by the API. It does not synthesize execution, files, tests, or artifacts.

## Real and Demo behavior

`AgentLauncherView` and `AgentRunView` select separate Real and Demo components from the explicit API mode. Real mode reads/writes only through `realApiClient`; API/network errors remain errors and never substitute fixtures. Demo mode retains the existing fixture-backed simulation. Request-generation fences reject late Real responses after route, mode, or unmount changes.

The Real workspace view supports create/select, metadata, refresh, load-more, URL selection and deep-link restoration. The run form validates the current workspace and advertised capabilities, uses a synchronous action lock, generates one idempotency key per logical request, and retains that key across uncertain retries of the same input. A changed input gets a new key. After a transport/5xx uncertainty, the client replays the exact POST with the same key, then confirms the returned run ID using `GET /runs/:id`; if replay also fails it preserves the uncertainty and never guesses from a similar task in history. A backend 409 without a run reference remains a conflict: the checked contract defines 409 as an idempotency-key/payload conflict, so the client does not guess a resource ID or bypass that conflict. Exact duplicate admission is returned as HTTP 200 with the run DTO by the existing route.

Every API response is parsed through the canonical workspace/run/capability schemas and projected into public DTO fields before UI state. Unknown owner, worker, lease, provider, or reasoning fields do not survive. Known task/error/result text is sanitized and rendered as React text. Requests use same-origin relative URLs with included session credentials; the shared API client continues to fence responses across session invalidation.

## Regression tests

| Test file | Coverage |
|---|---|
| `apps/web/tests/agent-api-client.test.ts` (7 tests) | Create/list/get workspace DTO projection; independent opaque cursor encoding; run DTO projection; generated/custom idempotency key and 200 replay; 409 conflict preservation; uncertain timeout replay with the same key followed by authoritative GET; replay failure remains unresolved without history-based guessing; malformed DTO rejection; GET restoration and 401/404 preservation. |
| `apps/web/tests/agent-real-views.test.tsx` (18 tests) | Existing Real workspace/run flows plus deterministic workspace deep-link resolution, stale B response after C, mismatched/404 workspace response rejection, filter-bound run cursors, deferred stale run pages, first-page Load More disabling, refresh/load-more exclusion, retry after error, all-workspaces reset, and in-page ID deduplication. |
| `apps/web/tests/agent-workspace-ux.test.tsx` (43 tests) | Existing workspace-first and Demo behavior retained; Real-specific expectations now assert separate API state, unavailable execution, safe errors and absence of fixture data. |
| `apps/web/tests/security-boundaries.test.tsx` | Canonical Agent create request carries an `Idempotency-Key`; existing public DTO security projection tests remain in the full suite. |

Initial PR baseline after clean install: 19 files, 284 tests passed, 0 failed. The review follow-up below raises the total to 288 tests. React Testing Library emitted existing `act(...)` warnings in older asynchronous Chat/Auth tests; they did not fail tests.

## Browser and backend verification limits

No browser E2E dependency (`playwright` or `@playwright/test`) is declared/installed under `apps/web`, and no browser-control tool is available in this session. `npm ls playwright @playwright/test --prefix apps/web --depth=0` returned an empty dependency tree (exit 1). No screenshots or browser evidence were created, and no deployed Real API behavior is claimed. The local tests mock API method responses and validate component behavior only.

The checked-in backend routes, schemas, and capability configuration were inspected to avoid inventing APIs. This work did not change backend code, run a deployed authenticated flow, or independently establish production owner authorization. Trà should verify request/DTO compatibility and the conflict/reconciliation boundary against the backend contract. A future browser acceptance needs an approved staging deployment with the frontend and API from compatible SHAs, a disposable authenticated test account, and browser automation.

## Verification on this change

| Command | Result |
|---|---|
| `npm ci --prefix apps/web` | Pass; installed from lockfile, 0 vulnerabilities; npm emitted only the existing `whatwg-encoding` deprecation notice. |
| `npm run typecheck --prefix apps/web` | Pass. |
| `npm test --prefix apps/web -- --reporter=dot` | Pass: 284 tests across 19 files. |
| `npm run build --prefix apps/web` | Pass; Vite built 73 modules. |
| `npm run test:production-security --prefix apps/web` | Pass; production bundle scanner passed on the generated JavaScript asset. |
| `npm audit --prefix apps/web --audit-level=moderate` | Pass; 0 vulnerabilities. |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | Pass: 6/6. |
| `node .agents/scripts/validate-skills.mjs` | Pass. |
| `git diff --check` | Pass before documentation was added; rerun after final edits. |
| Repository Git workflow validator | Pass on branch `feat/17t-48-agent-workspaces-real-ui`, PR title `feat(web): connect Agent workspaces and run history`, base `e5b429593f126857a2a3a4213b2ab04a629d41a2`, and implementation head `130e39f301ce4e46ed0aff4747008fd00eabec10`; both commit subjects passed. |
| GitHub Frontend CI | Pass: [run #60](https://github.com/17thedevv/Giga/actions/runs/40849169753) on implementation head `130e39f301ce4e46ed0aff4747008fd00eabec10`; typecheck, build, bundle security scan and Vitest all succeeded. |
| GitHub Validate Git Workflow | Pass: [run #205](https://github.com/17thedevv/Giga/actions/runs/40849169782) on the same implementation head. |

## Review and gate

Frontend implementation is ready for independent review after CI confirms the pushed HEAD. Browser acceptance is not evidenced locally. No PR was merged and no deployment was performed. Agent API compatibility review remains with Trà; runtime execution remains an existing backend limitation, outside this frontend change.

## Review follow-up — GitHub review 5709205529

**Reviewed starting head:** `2da3e29cfe8c87c7d26bfea94e489fe901b7a1d8`
**Validated code/test head:** `466c31de3d1feb8bb41ca466caeb90c7aaa6a4a8`
**Implementation code commit:** `c8826f697ed08dd21abedfdf78ad90add8bc23e1`
**Branch:** `feat/17t-48-agent-workspaces-real-ui`
**Base:** `origin/main` at `e5b429593f126857a2a3a4213b2ab04a629d41a2`; no rebase was needed.

### P1 — REAL-WS-01: stale selected workspace during deep-link resolution

**Root cause:** the Real launcher kept `selectedWorkspaceId` from workspace A while an unknown URL-linked workspace B was being fetched. The form only checked whether any workspace ID was selected, so it could admit into A while the route pointed to B. The detail response also was not checked against the requested ID.

**Fix:** the URL workspace ID now defines the active selection. A workspace is actionable only after that exact ID is present in the validated workspace list. During resolution, the UI announces a pending status, disables workspace selection controls and run admission, and the submit handler independently checks the current route ID. Route changes fence earlier detail requests, and a mismatched response is rejected without adding or selecting it. 401/403/404/network errors leave no previous workspace selected; Real mode still does not fall back to Demo.

**Regression tests:** `makes the URL workspace authoritative while resolving a new deep link` uses a deferred B response and verifies A is disabled, no POST occurs while pending, and the admitted run targets B after resolution. `ignores stale workspace detail responses and rejects mismatched or unavailable IDs` resolves B after navigating to C, returns a wrong ID for D, and returns a 404 for E while A remains in the loaded list. The existing `restores a workspace from a direct route after refreshing the launcher` test continues to cover deep-link restoration.

### P2 — REAL-RUNS-02: stale run history and cursor after workspace filter changes

**Root cause:** first-page fetches changed the filter but left the old `runs` and `runCursor` visible until a response arrived. Request IDs prevented some stale responses, but the rendered cursor was not tied to its workspace query, and duplicate IDs inside one page were not removed.

**Fix:** run history is keyed to the URL workspace filter. A layout-phase route fence synchronously invalidates older requests and resets rows, cursor, errors and loading flags. First-page fetches clear rows/cursor immediately; request and filter checks guard every result; Load More is disabled while the first page is loading and uses only the current query's cursor. Refresh and Load More cannot overlap in the UI, and page append deduplication now updates its ID set as each item is added.

**Regression tests:** `fences run pages and cursors by workspace filter and deduplicates IDs within a page` holds A's append and B's first page, confirms A rows/cursor are unavailable, rejects B then retries it, resolves stale A, and verifies B's cursor and duplicate IDs. `prevents refresh and load-more overlap, clears pages on refresh, and clears filters for All Workspaces` confirms refresh is disabled during append, refresh clears the prior page, and the all-workspaces query has no workspace filter.

### Changed files and verification

| File | Change |
|---|---|
| `apps/web/src/features/agent/AgentRealViews.tsx` | URL-authoritative workspace selection; fenced detail lookups; query-keyed run rows/cursors; loading locks and within-page deduplication. |
| `apps/web/tests/agent-real-views.test.tsx` | Four deterministic deferred-promise regression tests for REAL-WS-01 and REAL-RUNS-02; test file now has 18 tests. |
| `apps/web/package-lock.json` | Patched the compatible Vite minor release after the required dependency audit found one moderate advisory; `apps/web/package.json` is unchanged. |

| Command / check | Result |
|---|---|
| `npm ci --prefix apps/web` | Pass; 148 packages installed from the lockfile; 0 vulnerabilities. The existing `whatwg-encoding` deprecation notice remains. |
| `npm run typecheck --prefix apps/web` | Pass. |
| `npm test --prefix apps/web -- --reporter=dot` | Pass: 288 tests across 19 files, 0 failed. Existing React `act(...)` warnings in older Chat/Auth tests remain non-failing. |
| `npm run build --prefix apps/web` | Pass; Vite 6.4.5 built 73 modules. |
| `npm run test:production-security --prefix apps/web` | Pass; one production JavaScript asset scanned. |
| `npm audit --prefix apps/web --audit-level=moderate` | Pass; 0 vulnerabilities after updating locked `vite` from 6.4.4 to 6.4.5. Before the patch, audit identified `GHSA-8g5g-mxqh-grgj` (moderate, dev/build dependency, affected exact version 6.4.4). `npm audit fix` was run without `--force`; no major upgrade or package manifest change. |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | Pass: 6/6. |
| `node .agents/scripts/validate-skills.mjs` | Pass. |
| Repository Git workflow validator | The repository check passed on validated code/test head `466c31de3d1feb8bb41ca466caeb90c7aaa6a4a8`; GitHub Workflow run #209 also passed on that head. The evidence-only documentation commit is checked by its own PR workflow run after push. |
| `git diff --check` | Pass after the review follow-up evidence changes. |
| GitHub Frontend CI / Validate Git Workflow | Runs [#63](https://github.com/17thedevv/Giga/actions/runs/41021643172) and [#209](https://github.com/17thedevv/Giga/actions/runs/41021643174) passed on validated code/test head `466c31de3d1feb8bb41ca466caeb90c7aaa6a4a8`. Earlier implementation runs [#62](https://github.com/17thedevv/Giga/actions/runs/41021393597) and [#208](https://github.com/17thedevv/Giga/actions/runs/41021393674) also passed on `c8826f697ed08dd21abedfdf78ad90add8bc23e1`. |

No browser runner or browser-control tool was available in this session. No browser E2E, deployed Real API check, or live environment claim is made. The implementation and regression tests use local mocked API methods. Existing PR #46 stays Draft; no backend change, merge, or deployment was performed. The exact duplicate/409 idempotency behavior was not changed; 409 remains a definite key/payload conflict with no guessed run ID.
