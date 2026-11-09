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

GitHub Actions have not yet been checked because the implementation has not been pushed in this evidence revision. Final PR and CI references will be added after delivery. The repository has no frontend lint script.

## Dependencies and limitations

The Real files API, persistence, and server-side file authorization depend on Linear 17T-74. No backend or shared contract code is changed here. The Real UI is a truthful unsupported state until 17T-74 publishes a reviewed endpoint contract and implementation. Local tests do not prove deployed Real API behavior, cloud persistence, or production security.

Evidence commit and GitHub Actions status: pending final commit and Draft PR creation.
