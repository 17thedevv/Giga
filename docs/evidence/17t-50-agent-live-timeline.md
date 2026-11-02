# 17T-50 — Durable Agent Live Timeline and SSE Replay

**Status:** PR #48 was merged externally on 2026-11-02 at `41db8937f2b94d577c3300aeb72e672449e7e68a`. This document records a local follow-up to review `5733317585` against pre-merge HEAD `7c3002b8e2779b4e91f247abc51d602b32b971df`; the follow-up is not part of the merged commit. API contract v0.2 remains DRAFT.
**Branch:** `feat/17t-50-agent-live-timeline`
**Baseline:** `463646a44244b1aabfc0c597612f2c102d67f5b9` (`origin/main`, includes merged PR #47).
**Implementation commit:** `733ad11fdc3d83e2c4f8ca08b1a7c12a1f228460`.
**Linear:** [17T-50](https://linear.app/17thedev/issue/17T-50).
**Scope:** Real Agent run detail, typed frontend SSE observation, replay projection and UI. No backend changes, API contract edits, Demo behavior changes, run admission/control, or deployment.

## Review `5733317585` follow-up

The requested fixes are implemented locally on the existing feature branch. The PR has already merged, so its head cannot be updated for re-review; no new PR was created. These changes do not modify the backend or shared contract.

| Finding | Remediation | Regression coverage |
| --- | --- | --- |
| P1 `TL-REPLAY-01` | EOF is no longer replay-completion evidence. Completion requires a contiguous terminal event marker (`run.completed`, `run.failed`, or terminal `run.status`) matching the owner-scoped authoritative run GET, with no unresolved gap/conflict. Empty/partial history preserves GET status, shows an incomplete warning, and retries from the last contiguous cursor with bounded backoff and manual retry. | `does not treat an empty clean EOF as complete for a terminal run and bounds retries`; `does not treat a silent observer error as terminal replay evidence`; `resumes a partial terminal replay from the last contiguous cursor`; `accepts a contiguous terminal marker even when the observer then errors`; existing gap and session-fence regressions. |
| P2 `TL-PHASE-02` | `run.status.phase` accepts any contract string up to 120 characters, including empty and unfamiliar future values. Non-strings, control characters, and excessive values are rejected; text is sanitized and React renders it as text. Status, run ID, sequence and cursor validation are unchanged. | `accepts bounded contract-valid phases, including empty and unfamiliar values`; `preserves future phase strings through SSE and continues parsing later events`; `accepts an unfamiliar phase over SSE and renders HTML-like text without creating markup`. |
| Recovery warning | A transport warning clears only after a valid replay event/duplicate confirms recovery. Sequence gaps stay visible through no-progress retries and manual retry; incomplete terminal history remains visible until its terminal marker is confirmed. Run changes clear prior run events and warnings. | `clears a transient disconnect warning only after a replay event confirms recovery`; `keeps a sequence-gap integrity warning through repeated no-progress replay and manual retry`; `keeps a nonterminal run incomplete after a clean stream close`; `isolates replay warnings and events when navigating to another run`. |

**Frontend/backend limit:** GET run status does not expose an authoritative event high-watermark. The frontend can prove continuity only from sequence 1 through a terminal marker that matches GET. If the marker never arrives, the UI deliberately remains incomplete and retries; it cannot distinguish a permanently failing backend observer from an empty event history using the current API. The backend's silent close behavior and replay persistence were inspected previously but were not changed. No deployment, authenticated browser run, or runtime behavior is claimed by these local changes.

## Trust boundaries and contract

- The Real view observes the authenticated owner-scoped `GET /api/v1/agent/runs/:id/events` endpoint. It sends `Last-Event-ID` as a header, never as a query parameter, and uses same-origin `credentials: include`.
- The stream reader does not start, stop, cancel, or mutate a run. Aborting it closes only the browser's observation. Run status and terminal state come from owner-scoped `GET /api/v1/agent/runs/:id` reconciliation.
- Event names and payloads are untrusted. The frontend validates the numeric sequence and run identity, projects known fields into a public discriminated union, sanitizes displayed text, and discards provider/internal additions. Unknown ID-bearing event names advance only as a sanitized “unsupported event skipped” entry; their payloads are never retained. Heartbeats and ID-less frames do not advance the cursor.
- Duplicate sequence records are ignored only when projected data matches. A conflicting duplicate or non-contiguous sequence stops that stream attempt; the frontend keeps the last contiguous cursor, reconciles status, then reconnects with bounded exponential backoff. After six unsuccessful reconnects, a keyboard-accessible retry control is shown.
- At most 200 projected events are retained in component memory. The cursor continues independently and the UI labels the visible window when older entries have been trimmed. No event data is put in local storage, session storage, URL state, logs, or telemetry.
- `eventReplay` and `runHistory` must both be advertised by the authenticated capabilities response. Missing/disabled capability metadata fails closed; Real mode does not fall back to Demo data.
- The backend still owns authentication, tenant isolation, replay persistence, event ordering, session/cookie and CSRF policy. These frontend changes do not prove deployed Real API behavior.

## Surface / threat / control matrix

| Surface | Threat | Frontend control | Regression evidence |
| --- | --- | --- | --- |
| SSE route and cursor | Wrong endpoint, query cursor, unauthenticated request | Same-origin GET, cookies included, `Last-Event-ID` header, response content-type validation | `agent-api-client.test.ts` |
| SSE framing | Heartbeat inherits an older ID; fragmented or oversized frames | Opt-in frame-local ID clearing in shared parser; existing bounded parser remains in use | `sse-parser.test.ts` |
| Event DTO | Cross-run or malformed payload; private fields survive | Runtime projection, run ID match, numeric sequence bounds, allowlisted fields only | `agent-events.test.ts`, `agent-api-client.test.ts` |
| Replay order | Duplicate, conflict, or sequence gap | Exact duplicate dedupe; conflict/gap rejects attempt without cursor advance; authoritative GET and bounded replay retry | `agent-run-timeline.test.tsx` |
| Session and route | Old events render after 401/session change or unmount | Shared session generation checks, clear protected event state, abort observation on invalidation/unmount | `agent-run-timeline.test.tsx` |
| Run outcome | Stream closure mistaken for completion | Only an authoritative run GET changes the displayed run status; active run reconnects | `agent-run-timeline.test.tsx` |
| Capability / mode | Unsupported Real API silently shown as Demo history | Require `eventReplay` and `runHistory`; unsupported state is explicit and does not open SSE | `agent-run-timeline.test.tsx`, `agent-real-views.test.tsx` |
| Rendered content | HTML/script injection or event metadata leakage | React text rendering; sanitized text; no raw HTML, raw payload display, or download links | `agent-events.test.ts`, UI tests |

## Implementation mapping

- `apps/web/src/lib/api/agent-events.ts` defines the frontend-only public event union and validates/project known event families without changing shared DTO contracts.
- `apps/web/src/lib/api/client.ts` adds the authenticated GET stream reader, header cursor, session fencing, event projection, and reader cleanup.
- `apps/web/src/lib/api/sse-parser.ts` adds `clearIdAfterDispatch`; default behavior remains unchanged for Chat.
- `apps/web/src/features/agent/AgentRunTimeline.tsx` renders the bounded event window, reconciles on stream closure, retries with backoff, handles gaps, and clears on session expiry.
- `apps/web/src/features/agent/AgentRealViews.tsx` mounts the timeline only in the Real run view and supplies its authoritative GET callback.

## Regression coverage

- `tests/agent-events.test.ts`: sensitive/internal DTO fields are excluded; provider credentials are redacted; heartbeat and unknown additive events are handled without retaining raw payload; malformed cursor, wrong run ID, and invalid event data fail closed.
- `tests/agent-api-client.test.ts`: cookie-authenticated same-origin GET, `Last-Event-ID` header rather than query, frame-local heartbeat behavior, public event projection, and aborting the observation reader.
- `tests/sse-parser.test.ts`: Agent frame-local ID reset is opt-in and existing Chat ID persistence remains unchanged.
- `tests/agent-run-timeline.test.tsx`: exact replay dedupe, cursor-gap recovery from the last contiguous cursor, terminal GET reconciliation, capability fail-closed behavior, and session invalidation clearing/aborting.
- `tests/agent-real-views.test.tsx`: Real run detail mounts the timeline while preserving all existing message-thread and run-detail regressions.

## Verification and delivery evidence

| Check | Result |
| --- | --- |
| `npm ci` in `apps/web` | PASS — lockfile install completed; npm reported 0 vulnerabilities |
| `npm run typecheck` in `apps/web` | PASS |
| `npm test` in `apps/web` | PASS — 326 tests across 21 files |
| Focused Agent event/client/parser tests | PASS — 31 tests across 4 files |
| `tests/agent-real-views.test.tsx` | PASS — 41 tests |
| `npm run build` in `apps/web` | PASS — production Vite bundle generated |
| `npm run test:production-security` in `apps/web` | PASS — 1 JS asset; no mock debug global, source map, or credential pattern found |
| `npm audit --audit-level=low` in `apps/web` | PASS — 0 vulnerabilities |
| `npm ci` in `apps/api` | PASS — installed test dependencies; npm reported four moderate advisories (details below) |
| API Agent replay tests (`npx tsx --test --test-concurrency=1 tests/agent/agent-api.test.ts`) | PASS — 14 pass, 2 skipped because pg-mem cannot verify PostgreSQL-specific concurrency/timestamp behavior |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | PASS — 6 tests |
| `node .agents/scripts/validate-skills.mjs` | PASS — 8 skill manifests |
| `git diff --check` | PASS on the implementation changes before commit; rerun for the evidence-only update |
| GitHub Frontend CI on implementation commit | PASS — [run 75](https://github.com/17thedevv/Giga/actions/runs/41406478206) |
| GitHub Validate Git Workflow on implementation commit | PASS — [run 225](https://github.com/17thedevv/Giga/actions/runs/41406478156) |
| Authenticated browser against a deployed staging SHA | Not run; no Playwright/browser test dependency is installed/configured for `apps/web`, and no deployed 17T-50 SHA or secure browser environment was verified in this task |
| GitHub Frontend CI on evidence update `de2ca84f3da05d3d50c5d9f06f0fe25b20ba1b24` | PASS — [run 76](https://github.com/17thedevv/Giga/actions/runs/41406649104) |
| GitHub Validate Git Workflow on evidence update `de2ca84f3da05d3d50c5d9f06f0fe25b20ba1b24` | PASS — [run 226](https://github.com/17thedevv/Giga/actions/runs/41406649199) |
| Live status for subsequent documentation-only updates | See [PR #48 checks](https://github.com/17thedevv/Giga/pull/48/checks) |

### Follow-up verification for review `5733317585`

These results apply to the local follow-up changes on `feat/17t-50-agent-live-timeline`, not to the already-merged PR commit. No files outside the frontend and this evidence document were changed.

| Check | Result |
| --- | --- |
| `npm ci --prefix apps/web` | PASS — lockfile install; zero vulnerabilities |
| `npm run typecheck --prefix apps/web` | PASS |
| `npm test --prefix apps/web -- --reporter=dot` | PASS — 337 tests across 21 files |
| Focused Agent event, API client, and timeline tests | PASS — 32 tests across 3 files |
| `npm run build --prefix apps/web` | PASS — production Vite bundle generated |
| `npm run test:production-security --prefix apps/web` | PASS — one JavaScript asset scanned |
| `npm audit --prefix apps/web --audit-level=moderate` | PASS — zero vulnerabilities |
| Agent API replay test file (`npx tsx --test --test-concurrency=1 tests/agent/agent-api.test.ts`) | PASS — 14 pass, 2 skipped for PostgreSQL-specific semantics unavailable in pg-mem |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | PASS — 6 tests |
| `node .agents/scripts/validate-skills.mjs` | PASS — 8 skill manifests |
| `git diff --check` | PASS |
| Git workflow validator on the follow-up commit | Pending commit; run with exact branch/title/body/base/head after commit |
| GitHub CI on follow-up HEAD | Not available: PR #48 was merged before these changes; no follow-up ref or PR exists. Existing CI results above are for the earlier PR commits only. |
| Authenticated browser against a deployed follow-up SHA | Not run: no deployed follow-up SHA or configured Playwright runner was available. |

### Dependency audit scope note

The frontend audit is clean. Installing and auditing `apps/api` to run its replay tests exposed four **moderate** findings outside this frontend task; no API dependency or lockfile is changed here:

| Installed path | Advisory | Reachability / scope |
| --- | --- | --- |
| `@hono/node-server@1.19.17` | [GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f) | `serveStatic` is used for API `/assets/*` and `/giga/*` routes in `apps/api/src/app/web-ui.ts`; backend owner should assess and patch. |
| `e2b@2.56.0` → `glob@13.0.6` → `minimatch@10.2.6` | [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4), [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | API production dependency path. Cloud execution is currently advertised unavailable; no backend dependency changes are in scope. `npm audit fix --force` proposes a breaking E2B downgrade and was not run. |

The API `npm audit` exits 1 with four moderate findings; this is an existing backend dependency risk and requires a separate backend-owned change/review. It does not change the clean frontend audit result.

## Limitations and reviewer responsibilities

- This evidence is local frontend test evidence, not production or deployed API/browser evidence. Do not claim that deployed cookies, CORS, owner checks, SSE proxy buffering, replay persistence, or session expiry have passed based on these tests.
- Backend event replay route and event persistence are existing behavior and were not modified. Backend reviewer Trà should confirm event field compatibility, owner scoping, and the interpretation of connection close/high-watermark replay.
- Cloud execution, cancellation, approvals, sandbox files and artifact downloads remain capability-gated/unavailable according to the current API metadata. Timeline entries do not imply that a tool executed or that an artifact is downloadable.
- PR #48 was merged while review `5733317585` still required changes. This local follow-up does not alter that merge and is not yet independently reviewed. Linear 17T-50 was marked Done by the external merge automation; the follow-up should remain In Review until these changes receive review and an integration path is agreed. Do not claim the post-review fixes are merged, and do not deploy them.
