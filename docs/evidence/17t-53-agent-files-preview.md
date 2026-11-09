# 17T-53 — Agent file explorer and safe source preview

## Scope and trust boundaries

This frontend MVP adds a read-only file explorer to the Demo Agent run page. Demo file snapshots are deterministic local fixtures and are explicitly labeled sample content. They are independent of the run's `fileChanges` entries, which continue to represent change metadata only.

Real mode uses the authenticated Agent capabilities request. The current API advertises `sandboxFiles.available = false` and exposes no reviewed file list/content route. Real mode therefore displays an unsupported state and never renders the Demo snapshot. Even an affirmative capability response is insufficient to enable a guessed route; the UI remains pending until the API contract and endpoint are reviewed under 17T-74.

Trust boundaries are the local fixture projection, React text rendering, the authenticated capability response, and the server's existing workspace authorization. This UI does not open host files, execute source, render HTML, download, edit, or save file contents. Future Real file ownership and authorization must be enforced by the API.

## Implementation

- `apps/web/src/features/agent/agent-file-model.ts` validates and projects the bounded frontend-only snapshot shape. It accepts only relative slash-separated paths, rejects absolute/drive/UNC/traversal/control/ambiguous paths and file-directory collisions, rejects duplicate canonical identities, and copies only known UI fields. The tree is nested by complete relative path, folders sort before files, and sibling names use deterministic code-unit ordering. Limits are 2,000 entries, 32 path segments, 1,024 path characters, 255 characters per segment, 64 KiB per preview, and 512 KiB retained text per snapshot.
- `apps/web/src/features/agent/agent-file-fixtures.ts` provides three deterministic synthetic snapshots: a representative TypeScript project, a nested/Unicode/whitespace/duplicate-basename project, and a partial edge-case snapshot with empty, large, binary, unsupported, unavailable, and error entries.
- `apps/web/src/features/agent/AgentFileExplorer.tsx` renders the Demo file tree, filename/path search, selection, source preview, and safe Real capability state. Tree nodes and previews are plain React text. HTML and Markdown remain source text. No iframe, raw HTML insertion, source-driven URL, or file endpoint is used.
- `apps/web/src/features/agent/AgentRunView.tsx` adds a separate Demo Files tab while preserving Workspace Changes and its existing diff view.
- `apps/web/src/features/agent/AgentRealViews.tsx` adds a Real workspace files status section to authenticated run detail. The capability request is protected by request and session-generation fencing; workspace changes clear prior state. Session expiry clears the panel state.
- `apps/web/src/styles/workspace.css` adds desktop two-pane layout, independently scrollable tree/source panes, focus-visible styles, overflow-safe names, and a single-column layout below 700 px.

Source content reuses `sanitizeUntrustedText`, then React escapes it as a text child. Recognized text types include TS/TSX/JS/JSX, JSON/JSONC, Markdown, CSS, HTML/XML source, plain text, YAML/TOML/INI, `.env.example`, and Dockerfile. There is no syntax highlighter, editor, or execution context. Unknown extensions do not retain preview text. Large, binary, unsupported, empty, unavailable, and error cases use explicit bounded placeholders.

The explorer uses complete relative paths as file identity; duplicate basenames remain separate. Search matches full displayed paths and expands matching ancestors without changing snapshot identity. The tree is memoized from the projected snapshot; interaction state only changes selection, expansion, or query. Native buttons provide tab access, and folder/file controls accept Enter and Space while focus remains on the selected control.

## Regression coverage

- `apps/web/tests/agent-file-model.test.ts`: safe relative path acceptance; traversal, absolute path, drive, UNC, controls, ambiguous separators, excess depth/length, duplicates/collisions and symlink-like record rejection; Unicode/whitespace identity; metadata projection; redaction; bounded content; deterministic nested tree and sorting.
- `apps/web/tests/agent-file-explorer.test.tsx`: nested expansion/collapse, complete-path search/identity, duplicate basenames, empty folder, deep/long/Unicode names, snapshot switch reset, keyboard activation/focus, text-only HTML/Markdown, source whitespace, language labels, empty/large/binary/unsupported/unavailable/error states, and Real capability/session/route isolation.
- `apps/web/tests/agent-workspace-ux.test.tsx`: the existing Golden Flow now also opens Demo Files and verifies its sample source is separate from the Workspace Changes tab and diff viewer.
- `apps/web/tests/agent-real-views.test.tsx`: Real run detail displays the disabled-capability state and does not render a Demo explorer or sample files.

## Verification evidence

Environment: Windows PowerShell, Node/npm from the repository environment. Base: `origin/main` at `6fec91b54898a81ea205424201f43ae5fb9f134c`. Browser screenshots are not available: `apps/web` does not declare Playwright, no Playwright package is installed, and no browser automation tool is connected to this workspace. The mobile layout is covered by responsive CSS and component-level tests, but has not received visual browser verification. No deployed API or production behavior is claimed.

Executed locally:

| Command | Result |
| --- | --- |
| `npm ci` in `apps/web` | PASS; lockfile install, 0 audit findings |
| `npm run typecheck` in `apps/web` | PASS |
| `npm test -- --reporter=dot` in `apps/web` | PASS; 23 files, 412 tests |
| Focused Agent file and Agent integration Vitest run | PASS; 4 files, 158 tests |
| `npm run build` in `apps/web` | PASS; Vite production build completed |
| `npm run test:production-security` in `apps/web` | PASS; scanned 1 JavaScript asset |
| `npm audit --audit-level=moderate` in `apps/web` | PASS; 0 vulnerabilities |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | PASS; 6 tests |
| `node .agents/scripts/validate-skills.mjs` | PASS |
| `git diff --check` | PASS |

The implementation commit `eacac20394a3c3329a5cecf83157bb1000c65e5a` is on [Draft PR #52](https://github.com/17thedevv/Giga/pull/52), targeting `main`. GitHub Actions passed on that commit: [Frontend CI run 83](https://github.com/17thedevv/Giga/actions/runs/42579008013) and [Validate Git Workflow run 267](https://github.com/17thedevv/Giga/actions/runs/42579111137). The PR is open and Draft; independent review is pending. The repository has no frontend lint script.

## Dependencies and limitations

The Real files API, persistence, and server-side file authorization depend on Linear 17T-74. No backend or shared contract code is changed here. The Real UI is a truthful unsupported state until 17T-74 publishes a reviewed endpoint contract and implementation. Local tests do not prove deployed Real API behavior, cloud persistence, or production security.

Initial implementation commit SHA: `eacac20394a3c3329a5cecf83157bb1000c65e5a`. The review remediation is documented below.

## Review remediation — 5822808203

### FILE-PREVIEW-01 — bounded rendered line count

The byte limit alone allowed a small newline-dense source file to produce tens of thousands of React line-number elements. The read-only preview now has `MAX_AGENT_PREVIEW_LINES = 2,000`, in addition to the existing 64 KiB byte cap.

`countAgentPreviewLines()` counts CRLF as one delimiter and LF/CR as one delimiter each. It stops immediately at the first line beyond the maximum. Snapshot projection drops over-limit source text and records a `too-many-lines` preview state. `AgentSourcePreview` independently enforces byte and line limits for callers that bypass projection, displays an accessible “too many lines” status, and never truncates source as if it were complete. Normal previews keep original text and use at most 2,000 numbered lines. Preview derivation is memoized by file identity, and the preview component is memoized to avoid repeating work during unrelated explorer interactions.

Regression coverage in `apps/web/tests/agent-file-model.test.ts` and `apps/web/tests/agent-file-explorer.test.tsx` includes:

- `counts LF, CRLF and CR as logical lines and stops at the configured bound`
- `keeps text at the maximum line count and projects maximum plus one as a placeholder`
- `projects newline-dense source under the byte limit without retaining its text`
- `renders normal multiline TypeScript with correct bounded line numbering`
- `supports exactly the maximum rendered line count`
- `shows an accessible too-many-lines placeholder at maximum plus one`
- `does not render excessive line-number DOM for newline-dense content below 64 KiB`
- `handles mixed CRLF, LF and CR line endings without changing source text`
- Existing whitespace/Unicode, empty-file, HTML-as-text, and large-file placeholder tests remain green.

The newline-dense component test passes a 60,000-character preview directly to `AgentSourcePreview`, bypassing snapshot projection, and asserts that zero source line-number `<li>` elements are created.

### FILE-FIXTURE-02 — own-property fixture lookup

`getDemoWorkspaceSnapshot()` now checks `Object.prototype.hasOwnProperty.call()` before indexing the fixture registry. Unknown workspace keys—including `constructor`, `toString`, `__proto__`, and `hasOwnProperty`—receive an empty sample snapshot; malformed identifiers use the existing safe fallback. Known IDs still return the same deterministic fixture.

`returns only own known Demo fixture IDs and empty snapshots for prototype or unknown keys` covers known, ordinary unknown, all listed prototype keys, malformed IDs, and verifies that no prototype value is returned. The Real run integration test spies on `getDemoWorkspaceSnapshot()` and confirms that Real mode never calls the Demo fixture lookup.

### Verification and CI

Validated review-fix code commit: `85041832eeb43b7b7277b51e34cb99ab4cc946b0`.
The review adds 9 executed regression cases; the full frontend suite increased from 412 to 421 tests.

| Command | Result |
| --- | --- |
| `npm ci --prefix apps/web` | PASS; lockfile install, 0 vulnerabilities |
| `npm run typecheck --prefix apps/web` | PASS |
| `npm test --prefix apps/web -- --reporter=dot` | PASS; 23 files, 421 tests |
| Focused Agent model/explorer/workspace/Real views tests | PASS; 4 files, 167 tests |
| `npm run build --prefix apps/web` | PASS |
| `npm run test:production-security --prefix apps/web` | PASS; one JS asset scanned |
| `npm audit --prefix apps/web --audit-level=moderate` | PASS; 0 vulnerabilities |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | PASS; 6 tests |
| `node .agents/scripts/validate-skills.mjs` | PASS |
| `node .agents/scripts/validate-git-workflow.mjs` | PASS |
| `git diff --check` | PASS |

GitHub Actions passed on the review-fix code commit: [Frontend CI run 85](https://github.com/17thedevv/Giga/actions/runs/42591001543) and [Validate Git Workflow run 272](https://github.com/17thedevv/Giga/actions/runs/42591118560). Review-fix code changes only the frontend explorer/model/fixtures and tests; no backend or shared contracts changed.

Existing non-blocking React `act()` warnings remain in Chat streaming/generation and BYOK tests; these unrelated tests passed. No frontend lint script is configured. Browser/mobile screenshots remain unavailable because no Playwright package or connected browser automation runner is present. No deployed Real API behavior is claimed; file listing/content API work remains dependent on 17T-74.
