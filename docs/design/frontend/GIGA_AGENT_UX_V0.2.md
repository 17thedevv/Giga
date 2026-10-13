# GigaAgent — Agent Manager & Workspace Editor UX v0.2

> **DRAFT / DESIGN ONLY**. Product direction: general-purpose Antigravity-like workspace; **separate** from GigaChat, GitHub optional. Trà is Backend owner; Thư is Frontend reviewer/owner. [17T-24](https://linear.app/17thedev/issue/17T-24/redesign-gigaagent-as-agentic-workspace-with-sandbox-runtime). Based on [Architecture](../../architecture/GIGA_AGENT_ARCHITECTURE_V0.2.md) and [API](../../contracts/GIGA_AGENT_API_V0.2.md). Supersedes the **Agent** portion of [UX Flow v0.1](UX_FLOW_V0.1.md) and [API Mapping v0.1](API_MAPPING_V0.1.md); those documents' Chat and Auth sections remain valid drafts.

## 1. Information architecture

- /agent — Agent Manager: recent workspaces, active/completed/failed runs, new task CTA.
- /agent/workspaces/new — workspace creation: empty first, upload/import later.
- /agent/workspaces/:workspaceId — Editor/Workspace overview: files, task composer and activity.
- /agent/runs/:runId — live run detail, possibly embedded in workspace Editor.
- /agent/runs/:runId/artifacts — artifact list and verified outputs (could be tab, not dedicated route).
- /agent/approvals/:approvalId — explicit action review UI (modal or route).
- /chat — separate GigaChat experience. Do not mix message histories or memory controls.

**No mandatory repository picker.** Optional "Import from Git" appears only when integration is supported and authorized. Blank workspace + text task must be first-class.

## 2. Agent Manager UX

Desktop: left navigation (GigaChat / GigaAgent), workspace list, center active runs, latest artifacts/status. Mobile: single-column cards, actionable notifications and cancellation/approval.

Each run card: task title, workspace name, mode, public status, running phase, last updated, budget summary (if visible), action to Open / Cancel / Resume via new run. Distinguish queued, running, awaiting_approval, applying, completed, failed and cancelled using text/icons (never color alone). At most one active writable run/workspace for MVP; queue or show clear 409.

New task flow:
1. Create or select Workspace (default: Blank).
2. Describe task with multiline composer (examples: "Build React task manager", "Analyze CSV", "Write project docs").
3. Choose mode Ask / Plan / Execute. Default Plan or explicitly selected Execute (no hidden permission escalation).
4. Show runner type Cloud; Local "Coming later", not a working selector.
5. Show estimated limits/network permission summary.
6. Start with idempotent POST; transition UI only after 201 response, then subscribe SSE.

Empty state, loading, unauthorized, quota/retry, workspace busy and sandbox unavailable states must be actionable, not permanent spinners.

## 3. Workspace Editor UX

Three-pane desktop arrangement with flexible widths:
- **Explorer** left: workspace files, tree search, revision, snapshots, artifact exports; restrict editor to text files and show binary/download fallback.
- **Work/Preview** center: source editor (read-only or edited with explicit save strategy), build/terminal log viewer, preview when safe implementation available, screenshots/results, diff between snapshots.
- **Agent** right: task conversation, plan checklist, tool-activity timeline, Ask/Plan/Execute mode, stop, follow-up messages, explicit approval card.

Responsive collapse: mobile primarily shows Agent Activity, Approvals, Artifacts; file editor and live terminal can be limited/read-only.

Protect user edits from Agent writes: show unsaved draft state and workspace revision conflict, no silent overwrite. When user selects a previous snapshot, mark it immutable; new run can fork/continue from it.

## 4. Component mapping from current frontend

Existing main components (at inspection): AgentLauncherView, AgentRunView, Timeline, DiffViewer, ApprovalBar, ChatView, Composer, AuthGuard, mock adapter. **These are UI/mock scaffolds, not proof of runtime.**

Proposed adaptations:
- AgentLauncherView: remove required repository/baseRef; add workspace selection/creation + mode and runner indicators.
- AgentRunView: remove implied PR conclusion; show phase/plan/tools/verification/artifacts.
- Timeline: use persisted agent_events with replay ID; tool.started/completed, plan.updated, artifact.ready, approval.required.
- DiffViewer: optional snapshot diff view, not sole Agent screen or mandatory completion gate.
- ApprovalBar: surface only for scoped external effect, with exact target, digest summary, expiry and deny option.
- Add WorkspaceExplorer, EditorPanel (optional Monaco), TerminalOutput, ArtifactPanel and PreviewPanel incrementally; don't attempt full IDE immediately.
- ChatView and Memory UI remain **separate**; no implicit GigaChat memory injection into Agent.

## 5. Interaction states and details

| State | Primary UI | Recovery behavior |
|---|---|---|
| queued | Pending runtime allocation, status/position if known | Poll/stream persisted run; timeout clearly |
| running/planning | Updated plan and task summary | Continue after refresh; do not duplicate POST |
| running/executing | Tool timeline, file changes, safe terminal output | Reconnect SSE; fetch run + steps |
| running/verifying | Actual tests/checks in progress | Show passed/failed/not run separately |
| awaiting_approval | Action summary, resource/target, origin, expiry, risk | Accept/Reject; no optimistic approval |
| applying | External effect in progress | Disable duplicate approval; show indeterminate recovery |
| completed | Artifact downloads, verified checks, next task option | Artifacts remain accessible under retention policy |
| failed | Failure code, partial files/artifacts, retry/new run | No false success; preserve existing snapshot |
| cancelled | Clear stopped/partially-applied disclosure | Resume only via reviewed new-run flow |
| disconnected | Reconnecting indicator + latest persisted state | Use Last-Event-ID, dedupe replayed events |
| expired session | Login prompt preserving unsent draft locally | No token leak, no unauthorized preview |

"Stop" means cancel/terminate future sandbox actions, not undo external writes. The UI must present a confirmation if the run has an external action in-flight.

## 6. Approvals are not per-file gates

Execute mode can write sandbox-owned files and run bounded commands without constant confirmation. Only out-of-scope read/write, egress elevation, live deployment, external GitHub PR and consequential actions request explicit approval. An approval card must include:
- action summary and actual target;
- type/risk and relevant exact params/hashes;
- why elevated permission is required;
- expiry, approval scope and side effects;
- Approve / Reject buttons with duplicate submit prevention;
- explicit note that approving does not grant universal future permissions.

After a rejected external effect, agent may continue safe work or terminate according to task/plan, but cannot silently retry rejected operation.

## 7. Files, preview and artifacts

- **File tree:** names/paths from authorized snapshot. Download/edit actions depend on MIME, size and permissions; never embed secret storage URLs into long-lived frontend state.
- **Terminal:** read-only logs of sandbox command outputs, redacted/truncated, show command type, exit status, timestamp and "not executed" truthfully.
- **Preview:** milestone after sandbox/tool foundation. Serve on isolated origin / authenticated proxy, never under privileged app origin; browser errors and screenshot capture visible.
- **Artifacts:** name, type, size, checksum, creation date, retention/deletion information and verified vs draft status; safe content download headers.
- **User follow-up:** for active run, queue a safe message; for terminal run, new Run in same Workspace. Sending a message is not permission approval.
- **Multi-file changes:** optional snapshot diff; don't force an external PR reviewer metaphor for each sandbox write.

## 8. Accessibility, usability and visual direction

Keyboard-first navigation, visible focus and aria-labelled button/tabs; screen reader announcements for status changes; virtualized long event lists; copyable but redacted logs; responsive file tree. Neutral, uncluttered UI: status communicated by text and icon, not gratuitous color/animation. Avoid falsely labeling a mocked preview as live.

## 9. Acceptance and review

1. A user can create a blank workspace and start a run without GitHub account.
2. Plan/Ask never change workspace; Execute communicates resource/permission boundaries.
3. Live timeline survives refresh/reconnect; unknown SSE events do not crash UI.
4. Completion screen shows **artifacts and verification**, not required PR button.
5. Approval exists only when a concrete sensitive effect is pending, never an unconditional "review all diffs to finish".
6. Cancel/error/empty and expired-session paths are designed and fixture-tested.
7. Two users cannot see each other's runs, workspace files or artifacts.
8. Browser preview is marked deferred until runtime security gate passes.

**Required joint review:** Thư confirms interactions and DTOs; Trà confirms persistence/security semantics. Existing /agent mock app requires separate implementation PR to adopt these routes.
