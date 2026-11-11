# 17T-54 — Agent code change review and read-only diff panels

**Status:** Draft frontend MVP; independent review pending.\
**Branch:** `feat/17t-54-agent-change-review`\
**Base:** `main` at `7cacaaaa61cb7ee2542ad2d12b6a275a0f8d811c` (merged PR #52 / 17T-53).
**Code commit:** `f37c53c3585d179a64e91f0dd68c765fe7a801f8`.

## Threat model and trust boundaries

This change renders change summaries and structured diff samples in the Agent run UI. Paths, counts, revision labels, structured hunks, and line text are treated as untrusted input at the projection boundary. React renders source as text. No source is interpreted as HTML, executed, applied, committed, pushed, approved, or deployed. Copy is an explicit user action and is limited to projected sample data.

Demo examples are deterministic frontend fixtures and are labeled as synthetic. Only the known `run-golden-react` fixture is available through an own-key `Map` lookup. The legacy abbreviated `diffPreview` string is not accepted as a patch source. Run summary metadata and fixture patch data must agree on path and status before any file is projected.

Real mode has no reviewed file-diff API route in the current contract. Its panel states that the feature is unavailable and never uses Demo fixtures, regardless of capability metadata. Backend-authoritative file-change review remains dependent on 17T-74 and its reviewed DTO/authorization contract. This PR adds no API route, contract, database, or cloud behavior.

## Attack surface and controls

| Surface | Attack / failure | Control | Validation |
| --- | --- | --- | --- |
| File paths and summary metadata | Traversal, absolute/drive/UNC paths, credential-like names, duplicate paths, file-parent collision, invalid status/count | Reuse workspace-relative path validation; reject conflicting/unsafe records as a whole; project allowlisted fields | `agent-diff-model.test.ts`: credential-shaped paths; duplicate identities, parent collisions, summary mismatch; invalid hunk/count cases |
| Structured line text | HTML/script-looking source, ANSI/control sequences, embedded line breaks, credential-shaped text | Sanitize untrusted text; remove terminal controls; reject embedded line separators; render as React text | `agent-diff-model.test.ts`: sanitizes credentials/terminal controls; rejects mixed line endings; `agent-diff-viewer.test.tsx`: renders HTML-like source inertly |
| Patch structure | Contradictory ranges/counts, unsorted hunks, false complete totals, malformed no-newline markers | Validate hunk ordering and old/new counts; complete samples must match computed counts and status | `agent-diff-model.test.ts`: malformed hunk counts/order and contradictory complete totals |
| Resource use | Many files, long lines, newline-dense patches, excessive hunks/rows, oversized clipboard text | Bound files (100), per-file diff text (64 KiB), aggregate text (256 KiB), hunks (80), lines/rows (2,000), line length (8,192 chars), expanded context (200), copy (32 KiB) | `agent-diff-model.test.ts`: newline-dense rows, line lengths, byte/file limits, oversized copy |
| Copy action | Partial excerpt mistaken for an applicable full patch; clipboard denial falsely reported as success | Label partial copies as excerpts; label provenance and revisions; disable unavailable/binary/oversized copy; report failure | `agent-diff-viewer.test.tsx`: labeled excerpt, provenance copy, unavailable copy, clipboard denial/fallback |
| Mode and fixture selection | Real run accidentally displays synthetic patch or inherited fixture registry property | Distinct Real unsupported component; only Demo route obtains known fixture via `Map`; no diff endpoint call | `agent-change-review.test.tsx` and `agent-real-views.test.tsx`: Real/Demo isolation and capability metadata cannot enable an unreviewed route |
| UI interaction | Keyboard-only user cannot choose files, toggle layout, fold context, or copy; narrow viewport overflows | Native buttons, focus-visible states, explicit labels/live announcements, responsive single-column layout | Viewer/component tests cover keyboard-operable buttons and selection; responsive CSS reviewed. No browser visual test was available. |

Summary totals include only files with both known counts; incomplete metadata is visibly reported as unavailable rather than coerced to zero. Same-basename files remain separate because identity uses the full path. Deleted-file state explicitly says the path is not current.

## Implementation and regression-test mapping

- `apps/web/src/features/agent/agent-diff-model.ts`: bounded validation/projection, hunk line-number derivation, count reconciliation, complete/partial distinction, safe copy serialization, and linear split-row alignment.
- `apps/web/src/features/agent/agent-diff-fixtures.ts`: deterministic synthetic examples for created, modified, deleted, same-basename, Unicode/space paths, partial patches, binary, and oversized content.
- `AgentDiffFileList.tsx`, `AgentDiffViewer.tsx`, and `AgentChangeReview.tsx`: accessible file chooser, unified/side-by-side presentation, foldable context, safe explicit copy, status/empty/unavailable states, and Real-mode unsupported panel.
- `AgentRunView.tsx`, `AgentRealViews.tsx`, and `workspace-fixtures.ts`: Demo integration and Real unsupported state; no use of a guessed Real diff endpoint.
- `apps/web/tests/agent-diff-model.test.ts`: path and DTO validation, counts/ranges, malformed structures, partial vs complete, sanitization, bounded data, serialization, unknown fields, and row alignment.
- `apps/web/tests/agent-diff-viewer.test.tsx`: rendering, Unicode/whitespace, split/unified, folding, keyboard access, clipboard outcomes, and unavailable states.
- `apps/web/tests/agent-change-review.test.tsx`: mult-file selection, statuses, route/run reset, summary consistency, fixture own-key lookup, and Real/Demo isolation.
- `apps/web/tests/agent-real-views.test.tsx`: Real API remains unavailable even if `sandboxFiles` metadata says available without a reviewed diff route.
- `apps/web/tests/agent-workspace-ux.test.tsx`: updates existing golden-flow selectors for the semantic file buttons.

## Verification evidence

Environment: Windows PowerShell, Node/npm from the repository environment. Commands below were run on the implementation source at code commit `f37c53c3585d179a64e91f0dd68c765fe7a801f8`. The documentation-only commit and final GitHub Actions results are recorded in the PR/final handoff after push.

| Command | Result |
| --- | --- |
| `npm ci --prefix apps/web` | PASS; lockfile install, 0 vulnerabilities (one upstream deprecation warning) |
| `npm run typecheck --prefix apps/web` | PASS |
| `npm test --prefix apps/web -- --reporter=dot` | PASS; 26 files, 466 tests |
| `npm run build --prefix apps/web` | PASS; 84 modules; JS 481.94 kB / 130.39 kB gzip; CSS 39.09 kB |
| `npm run test:production-security --prefix apps/web` | PASS; scanned 1 JavaScript asset |
| `npm audit --prefix apps/web --audit-level=moderate` | PASS; 0 vulnerabilities |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | PASS; 6 tests |
| `node .agents/scripts/validate-skills.mjs` | PASS |
| `git diff --check` and `git diff --cached --check` | PASS before implementation commit |
| Frontend lint | Not configured in `apps/web/package.json` |
| Browser/E2E and screenshots | Not run: this checkout has no configured browser runner or browser automation connection. Responsive CSS and interaction behavior have component-level coverage only. |
| Deployed Real API | Not tested or claimed; the Real diff route is not implemented. |
| GitHub Validate Git Workflow | PASS on `09ebe92d95e5695f2b3222448bbdfe3d28c1d33e`; [run #276](https://github.com/17thedevv/Giga/actions/runs/42981846015) |
| GitHub Frontend CI | PASS on `09ebe92d95e5695f2b3222448bbdfe3d28c1d33e`; [run #88](https://github.com/17thedevv/Giga/actions/runs/42981846166) |

The suite emits existing React `act()` warnings in unrelated Chat/BYOK tests; all 466 tests passed. No production deployment was performed.

## Review and delivery

Draft PR #54 is open at https://github.com/17thedevv/Giga/pull/54. The two GitHub Actions runs above passed on the PR head when this evidence update was prepared. A following documentation-only commit will trigger CI again; verify that exact final head before handoff. Intended independent reviewer: Trà. Keep the PR Draft until review. Do not merge or deploy. Linear 17T-54 should remain In Review after the Draft PR and evidence are linked.

## Limitations and follow-up

- The current UI demonstrates safe presentation using clearly marked Demo samples. It does not prove that an Agent backend persisted, authorized, or returned these patches.
- Real-mode change review requires 17T-74 to define and implement an authenticated, workspace/run-scoped DTO and endpoint, then frontend integration and backend authorization review.
- Browser screenshots, mobile visual QA, and authenticated Real API tests were not available in this session.
- Independent API/DTO and UX review remain open.

## Review remediation — 5856366350

**Finding review:** [PR review #5856366350](https://github.com/17thedevv/Giga/pull/54#pullrequestreview-5856366350) · **Implementation commit / reviewed code HEAD:** `1bdd74ab9f819a5b2f04d3b598e303b8ce1736ef`.

### DIFF-STATE-01 — Created/deleted side contradictions

The prior projector rejected additions in deleted files and deletions in created files, but still allowed context rows or nonempty hunks on a side the status said did not exist. This let the viewer claim a created file had no before revision while showing old-side content, including in a partial preview.

`parsePreview()` now enforces status invariants for both complete and partial samples at the projection boundary:

- `created` requires the canonical empty old range (`oldStart: 0`, `oldCount: 0`) and accepts only additions plus a no-final-newline marker for the `after` side.
- `deleted` requires the canonical empty new range (`newStart: 0`, `newCount: 0`) and accepts only deletions plus a no-final-newline marker for the `before` side.
- Contradictory context/addition/deletion rows, noncanonical absent-side ranges, and markers naming a missing side reject the entire change set. Invalid patches do not reach the viewer or clipboard; they are not silently converted to partial content.
- Modified files continue to accept context, additions, deletions, multiple hunks, and valid before/after/both no-newline markers.

### DIFF-HUNK-02 — Complete multi-hunk gap consistency

Previously only hunk start ordering was checked, so a complete patch could omit a change between hunks and still be called complete and copied as a patch.

The parser normalizes nonempty one-based ranges and zero-count boundary ranges, rejects overlapping/decreasing ranges, and for each adjacent pair of `complete` hunks requires the omitted unchanged-line span to match on the old and new sides. Starts and counts are bounded to 10 million before boundary/gap arithmetic. This permits line shifts accounted for by represented additions/deletions, and permits unchanged source outside the hunks. `partial` excerpts still allow unequal omitted spans but remain explicitly partial and copy only as a labeled excerpt. A rejected complete patch is rejected atomically and has no copyable projection.

### DIFF-STATUS-03 — Strict status validation

The summary status check previously used `String(item.status)`, which accepted arrays such as `['created']`, then projected the original array through a type cast. The projector now uses an exact runtime type guard: only the strings `created`, `modified`, and `deleted` are accepted. No unchecked cast or coercive status conversion remains. Arrays, objects, `null`, `undefined`, numbers, booleans, case variants, and whitespace variants reject before rendering or copy.

### Regression coverage

`apps/web/tests/agent-diff-model.test.ts` adds deterministic cases for created/deleted context and opposite-side content, nonzero absent-side ranges, partial contradictions, no-newline markers on missing sides, valid created/deleted/modified patches, exact status acceptance/rejection, equal and unequal complete gaps, insertion/deletion line shifts, zero-count hunk boundaries, overlap/decreasing ranges, partial unequal gaps, and complete-vs-excerpt copy labels.

`apps/web/tests/agent-diff-viewer.test.tsx` verifies that created/deleted unified and split rows render only on existing sides, and that shifted multi-hunk line numbers agree in both layouts. `apps/web/tests/agent-change-review.test.tsx` verifies malformed status and contradictory partial patches show an invalid-state message without source content or copy controls. The prior 466 tests remain; the full suite now has 476 passing tests.

### Verification for the fix commit

| Command | Result |
| --- | --- |
| `npm ci --prefix apps/web` | PASS; 0 vulnerabilities; upstream `whatwg-encoding` deprecation warning |
| `npm run typecheck --prefix apps/web` | PASS |
| Focused diff tests (`agent-diff-model`, `agent-diff-viewer`, `agent-change-review`) | PASS; 3 files, 54 tests |
| `npm test --prefix apps/web -- --reporter=dot` | PASS; 26 files, 476 tests |
| `npm run build --prefix apps/web` | PASS; 84 modules; JS 482.37 kB / 130.51 kB gzip; CSS 39.09 kB |
| `npm run test:production-security --prefix apps/web` | PASS; scanned 1 JavaScript asset |
| `npm audit --prefix apps/web --audit-level=moderate` | PASS; 0 vulnerabilities |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | PASS; 6 tests |
| `node .agents/scripts/validate-skills.mjs` | PASS |
| `node .agents/scripts/validate-git-workflow.mjs` | PASS for branch, PR title/body, base `7cacaaaa61cb7ee2542ad2d12b6a275a0f8d811c`, and implementation HEAD above |
| `git diff --check` | PASS |
| GitHub Frontend CI | PASS on implementation commit above; [run #90](https://github.com/17thedevv/Giga/actions/runs/42997282511) |
| GitHub Validate Git Workflow | PASS on implementation commit above; [run #279](https://github.com/17thedevv/Giga/actions/runs/42997282548) |

The full suite continues to emit unrelated React `act()` warnings from Chat/Auth/BYOK tests; all tests pass. Browser/mobile screenshots remain unavailable because this environment has no browser runner/executable. No deployed Real API integration is claimed. Real diff support remains dependent on 17T-74.

The evidence-only follow-up commit changes no application code; its exact PR head and GitHub checks are verified in the PR and delivery handoff. PR #54 remains Draft and Linear 17T-54 remains In Review. No backend, contract, database, deployment, or merge change was made.
