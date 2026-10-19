# Warm Giga workspace — candidate evidence

Issue: 17T-62. User chose a warm light interface inspired by Claude. Intended owner/reviewer: Thư / Trà. Operator: Codex; no human review or cross-training recorded.

Changes: cream/stone palette with a warm accent; serif welcome and auth headings; compact workspace rail, searchable keyboard-operable conversation history, suggestion cards, readable chat typography, floating composer, mobile drawers, shared light/dark styling and theme-aware loading. Light is the default; an explicitly saved theme is retained. No new UI dependency or copied third-party brand asset.

User-directed auth expansion: existing Create account API now has an accessible UI on /login. A successful registration returns to sign-in with the email retained and password cleared; failure preserves a usable correction form. Real-mode credentials start blank. Fresh production visitors use Real mode; explicit saved fixture mode remains labelled and never silently substitutes for Real API failures. No password enters persistent client storage. Existing backend registration does not establish a session, so the client does not claim one until normal login succeeds.

## Compatibility assessment

| Surface | Before | Candidate | Impact |
| --- | --- | --- | --- |
| Backend routes, auth cookies, DTOs, SSE and persistence | Existing DRAFT contract | Unchanged | Existing clients retain protocol |
| Registration | API/client method exists, no visible form | Existing API called from Create account form, then explicit login | Additive UI; no new backend |
| Initial production mode | Mock | Real unless an explicit stored mode exists | Deliberate user-requested usable demo default |
| Initial theme | Dark | Warm light unless a stored theme exists | Preference only |

## Executed verification

Windows / Node 24: production build (TypeScript + Vite) PASS; all 180 web tests PASS (13 files). Tests include auth validation/registration/success/duplicate failure/no password persistence, theme controls, conversation selection/search/delete separation and existing streaming, cancel, retry, model/reasoning and BYOK behavior. Earlier failures were stale UI copy selectors; those selectors were updated to the new visible labels and the full suite passed. React act warnings remain in existing async tests. No lint script exists.

Local browser: same-origin iframe CSS viewports, height 640px, not device emulation. Chat measured at 320/375/768/1024/1440: no horizontal document overflow, composer inside viewport. Agent, Skills, Personalization, Settings and Login loaded at 375; no horizontal document overflow (Login client width slightly narrower due to vertical scrollbar). Mobile history opened and New Chat closed it. Screenshots and measurements: [17t-62](17t-62/). Screenshots at 1440 are cropped by the host browser viewport; layout width was measured at 1440. Fixture screenshots prove layout only, not backend behavior.

Not executed: physical touch device / virtual keyboard, 200% text zoom, OS reduced-motion emulation, full accessibility audit, complete primary-route real-data matrix and independent peer review. Reduced-motion CSS and semantic focus states are retained but are not claimed as a completed audit. Live registration/chat verification and exact deployed SHA are recorded in deployment evidence after integration. Issue remains open.

Dependency audit from npm ci reported 3 existing web dependency advisories (1 moderate, 2 critical); no dependency upgrade or lockfile modification was made in this UI change. Review separately before public release.
