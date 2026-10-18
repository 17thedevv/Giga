# Chat generation controls — local evidence

Issue: [17T-38](https://linear.app/17thedev/issue/17T-38/implement-gigachat-stop-retry-and-regenerate-controls-ui).
Intended owner: Thư. Reviewer: Trà; re-review remains pending after Request Changes.
Date: 2026-10-16 (Asia/Saigon).

## Scope and compatibility

Web-only implementation plus this evidence directory. The backend, database, auth,
Agent and shared contract files are unchanged. The API remains **DRAFT**.
`packages/contracts` still contains no executable shared DTOs; local web DTOs mirror
the implemented runtime contract and backend types.

| Previous client behavior | New behavior | Compatibility / evidence |
| --- | --- | --- |
| Partial failed regeneration could replace the selected answer | Reconcile selected completed answer from history and latest-turn variants; retain alternatives | Existing GET endpoints and envelopes; no server changes |
| Retry depended on a partial assistant bubble | Latest attempt status controls Retry, including zero-output failed/stopped/interrupted attempts | Existing variants DTO; refresh and admission tests |
| Nonterminal/error polling could re-enable generation actions | Retain synchronous action lock and offer status/Stop recovery | Existing generation GET and cancel semantics |
| Duplicate stream handlers could race across route/mode changes | Operation and mode fences isolate callbacks and reconciliation | Existing route/mode regression tests |
| Mock inspection fabricated completed state | Track mock attempts and completed-only selection independently from Real | Dedicated mock regression test |

No variant selection write endpoint or earlier-turn branching is introduced.
Completed-only selection follows durable completion or its terminal SSE. A stopped
candidate is distinct from failure and does not displace a selected completed answer.

## Executed validation

Environment: Windows, Node v24.12.0, npm 11.6.2. Base: `6dc2b1a` from `origin/main`.

- `npm ci` in `apps/web`: succeeded; lockfile unchanged. npm reported three existing dependency audit findings (one moderate, two critical); no dependency upgrades were made.
- `npm run typecheck --prefix apps/web`: PASS.
- `npm run build --prefix apps/web`: PASS.
- `npm test --prefix apps/web`: PASS, 134 tests across 10 files (28 focused generation-control tests).
- `node --test .agents/scripts/validate-git-workflow.test.mjs`: PASS, six tests.
- `node .agents/scripts/validate-skills.mjs`: PASS, eight skills.
- `git diff --check`: PASS.

Focused coverage includes Stop/stopped SSE, completion winning Stop, lost cancel
response, latest-turn Retry without output, failed/stopped regeneration preserving
selection, duplicate admission envelopes, admission discovery before started,
synchronous double actions including conversation creation, active-generation route
refresh, Enter-to-send, cross-conversation stop prevention, late SSE event isolation,
model and reasoning effort preservation on regenerate, rapid conversation switching,
durable generation recovery after navigation (active stream recovery & terminal state recovery),
and history loading failure / retry recovery with Composer unblocking.
Existing stream, model capability, auth and other web regressions remain in the full suite.

## Review follow-up: stale operations and duplicate active admission

Reviewed head: `840075e`. Both reported P1 cases were reproduced by new deferred
promise regression tests before the fixes (16 focused tests passed, two failed).

- A late creation rejection now checks operation, mode and route before releasing
  state or showing an error. The test navigates from pending creation at `/chat`
  to conversation B, starts B's generation, then rejects the old request. B keeps
  its action lock, accepts later deltas and sends Stop for its own generation ID.
- The same route fence now covers a late history-recovery rejection. A third test
  verifies that this related failure cannot hide B's ongoing stream.
- A same-conversation duplicate admission enables Stop for its nonterminal
  generation before GET completes. Authoritative nonterminal GET responses keep
  Stop enabled through bounded polling while new actions remain locked. The test
  then cancels that generation and reconciles stopped state.

## Review follow-up: cross-conversation stop prevention and late SSE isolation

- An `activeGenerationConversationIdRef` tracks the owning conversation ID alongside
  each active generation ID.
- `handleStopStreaming` strictly fences against mismatched conversation IDs, ensuring
  the client never sends `(conversation B, generation A)` when navigating during streaming.
- SSE callbacks and `reconcileAuthoritativeGeneration` verify route and owning
  conversation IDs so late events arriving from conversation A cannot mutate conversation B.
- Retry and Regenerate preserve currently selected `modelId` and `reasoningEffort`.
- 4 additional regression tests added to `chat-generation-controls.test.tsx`.

## Review follow-up: durable generation recovery and composer unlock on retry

Reviewed head: `909999d`. Addressed two P1 review findings:

1. **P1 Blocker 1 — Durable Generation Recovery After Navigation (`ChatView.tsx`):**
   - Distinguishes local SSE connection teardown (`abortControllerRef.current?.abort()`) from durable backend cancellation.
   - Never fabricates `'stopped'` state merely because local transport aborted; local abort sets status to `'interrupted'`.
   - When navigating away (A -> B), local SSE is aborted without firing backend cancellation.
   - When returning to conversation A, authoritative generation state is recovered from backend (`inspectTurn` / `getTurnVariants`).
   - If backend generation is active: restores owning conversation ID (`activeGenerationConversationIdRef`) and generation ID (`activeGenerationIdRef`), locks new actions (`setActionLock(true)`), displays truthful status, keeps Stop button enabled for the owning conversation, and fences against cross-conversation dispatches.
   - If backend generation reached terminal state: restores completed answer, updates latest-turn variants, enables Retry/Regenerate, and unlocks Composer.

2. **P1 Blocker 2 — Composer Lock Recovery After History Loading Failure (`ChatView.tsx`):**
   - Replaced pure ref-based action locking with reactive `isActionLocked` synchronized via `setActionLock(locked: boolean)`.
   - Separates history loading failure (`historyLoadError`) from active generation lock.
   - Prominently displays a visible "Retry Loading History" button in both the Error Banner and the empty feed state.
   - Triggering retry re-invokes `loadMessages()`: upon recovery, restores conversation messages/variants and unlocks the Composer if no active generation exists.
   - Fences history loading rejections by route request ID to prevent stale rejections from conversation A mutating conversation B.
- 5 new regression tests added to `chat-generation-controls.test.tsx` (suite now at 28 tests, 134 total web tests).

## Local browser evidence

Browser verification at `http://127.0.0.1:4173/chat?demo=1` (Edge headless automation):

1. **Stop generation:** Clicking Regenerate followed by Stop cancels streaming, updates
   status to "Response stopped by user", and keeps Retry and Regenerate available.
2. **Retry generation:** Resumes generation to completion and displays the new variant.
3. **Regenerate & Previous answers:** Generates another variant; previous completed
   answers are preserved in the expandable `<details>` section.
4. **Durable generation recovery after navigation:** Navigating away (A -> B -> A) preserves backend state, recovers active/terminal turn status, restores message variants, and keeps appropriate controls enabled.
5. **History loading failure & visible retry:** Displays Error Banner with "Retry Loading History" button, empty-state retry CTA, and disabled Composer (`Chat is disabled`).
6. **Retry history recovery:** Clicking "Retry Loading History" recovers conversation messages and unlocks the Composer.
7. **Mobile responsive layout (390x844):** Renders clean responsive layout with collapsible discussions header and accessible touch targets.

![Stopped generation with original answer retained](screen_17t_38_stop.png)
![Completed retry with prior variants available](screen_17t_38_retry.png)
![Regenerate with prior variants expanded](screen_17t_38_regenerate.png)
![Durable generation recovery after navigation](screen_17t_38_nav_recovery.png)
![History loading failure with visible retry button](screen_17t_38_history_error.png)
![History retry recovery with unlocked composer](screen_17t_38_history_retry.png)
![Mobile responsive layout](screen_17t_38_mobile.png)

## Checks not executed / review gates

- No deployed Real API browser test, cloud deployment, production writes or new
  provisioning. Cookie/CORS/CSRF and provider behavior need the existing approved
  integration environment with the backend owner.
- No backend/database tests: no backend/database changes.
- No standalone lint/format script exists in `apps/web/package.json`.
- Mock fixtures live in memory and reset on full page reload. Real refresh reads
  durable history and latest-turn variants; automated tests cover this path.
- Trà's independent review and public browser integration remain open. Keep the PR
  Draft; do not merge or mark the issue Done. No cloud cross-training was performed
  or required by this local frontend implementation.
