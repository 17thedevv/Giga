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

The Real workspace view supports create/select, metadata, refresh, load-more, URL selection and deep-link restoration. The run form validates the current workspace and advertised capabilities, uses a synchronous action lock, generates one idempotency key per logical request, and retains that key across uncertain retries of the same input. A changed input gets a new key. After a transport/5xx uncertainty, the client looks for one exact recent run and confirms it with `GET /runs/:id`; ambiguous matches remain an error. A backend 409 without a run reference remains a conflict: the checked contract defines 409 as an idempotency-key/payload conflict, so the client does not guess a resource ID or bypass that conflict. Exact duplicate admission is returned as HTTP 200 with the run DTO by the existing route.

Every API response is parsed through the canonical workspace/run/capability schemas and projected into public DTO fields before UI state. Unknown owner, worker, lease, provider, or reasoning fields do not survive. Known task/error/result text is sanitized and rendered as React text. Requests use same-origin relative URLs with included session credentials; the shared API client continues to fence responses across session invalidation.

## Regression tests

| Test file | Coverage |
|---|---|
| `apps/web/tests/agent-api-client.test.ts` (7 tests) | Create/list/get workspace DTO projection; independent opaque cursor encoding; run DTO projection; generated/custom idempotency key and 200 replay; 409 conflict preservation; uncertain timeout reconciliation through list plus authoritative GET; ambiguous-match rejection; malformed DTO rejection; GET restoration and 401/404 preservation. |
| `apps/web/tests/agent-real-views.test.tsx` (14 tests) | Independent workspace/run pagination; blank workspace creation and URL selection; real run admission and authoritative `RUNTIME_UNAVAILABLE`; capability-gated modes; same-key retry after uncertainty; synchronous double-submit lock; definite 409 conflict followed by a new key; safe 401/403 handling; deep-link workspace restoration; no Real-to-Demo fallback; authoritative refreshed run detail; owner-scoped 404; stale route fencing; Real/Demo in-flight isolation. |
| `apps/web/tests/agent-workspace-ux.test.tsx` (43 tests) | Existing workspace-first and Demo behavior retained; Real-specific expectations now assert separate API state, unavailable execution, safe errors and absence of fixture data. |
| `apps/web/tests/security-boundaries.test.tsx` | Canonical Agent create request carries an `Idempotency-Key`; existing public DTO security projection tests remain in the full suite. |

Run totals after clean install: 19 files, 284 tests passed, 0 failed. React Testing Library emitted existing `act(...)` warnings in older asynchronous Chat/Auth tests; they did not fail tests.

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
| Repository Git workflow validator | To run on the committed PR range before push. |
| GitHub CI | To verify on final pushed HEAD. |

## Review and gate

Frontend implementation is ready for independent review after CI confirms the pushed HEAD. Browser acceptance is not evidenced locally. No PR was merged and no deployment was performed. Agent API compatibility review remains with Trà; runtime execution remains an existing backend limitation, outside this frontend change.
