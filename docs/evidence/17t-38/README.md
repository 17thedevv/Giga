# Chat generation controls — local evidence

Issue: [17T-38](https://linear.app/17thedev/issue/17T-38/implement-gigachat-stop-retry-and-regenerate-controls-ui).
Intended owner: Thư. Reviewer: Trà; human review remains pending.
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
- `npm test --prefix apps/web`: PASS, 122 tests across 10 files.
- `node --test .agents/scripts/validate-git-workflow.test.mjs`: PASS, six tests.
- `node .agents/scripts/validate-skills.mjs`: PASS, eight skills.
- `git diff --check`: PASS.

Focused coverage includes Stop/stopped SSE, completion winning Stop, lost cancel
response, latest-turn Retry without output, failed/stopped regeneration preserving
selection, duplicate admission envelopes, admission discovery before started,
synchronous double actions including conversation creation, active-generation route
refresh, and Enter-to-send. Existing stream, model capability, auth and other web
regressions remain in the full suite.

## Local browser evidence

In-app browser at `http://127.0.0.1:5173`, explicit Mock mode, 614 × 508 viewport:

1. Regenerate, then Stop: original completed answer stays selected; stopped status
   and Retry/Regenerate are visible. Controls wrap and use 44px minimum height.
2. Activate Retry with Enter: controls disable while streaming, then completion
   selects the new answer.
3. Activate Previous completed answers with Enter: original answer remains readable;
   native focus outline is visible.

![Stopped regeneration with original answer retained](stopped-mock.png)
![Completed retry with prior variants available](completed-variants-mock.png)
![Keyboard-expanded prior completed answer](previous-variant-mock.png)

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
