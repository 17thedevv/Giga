# GigaAgent Workspace-First UX — Verification & Architecture Evidence

Issue: [17T-40](https://linear.app/17thedev/issue/17T-40/redesign-gigaagent-frontend-around-workspace-first-ux).  
Branch: `feat/17t-40-agent-workspace-ux`.  
PR: `feat(web): align GigaAgent UI with workspace architecture`.  
Date: 2026-10-19 (Asia/Saigon).  

---

## 1. Scope & Architectural Alignment

Web frontend redesign aligning the GigaAgent user experience with Giga's workspace-first architecture. This resolves the historical impedance mismatch where the agent interface was coupled to GitHub repository selection and remote Pull Requests.

### Key Architectural Invariants & UX Guarantees

1. **Workspace-First by Default (No GitHub Prerequisite)**:
   - The primary and default source is **Blank Workspace** (`Fresh isolated directory. No repository or GitHub account required`).
   - Eliminates the legacy requirement for selecting a GitHub repository or remote branch before starting an agent task.
   - Users can create new blank workspaces via modal dialog or select existing workspaces from the dropdown or cards.

2. **Gated Future Sources ("Coming Later")**:
   - Source cards for **Upload Files** and **Import Git Repository** are explicitly marked `Coming later` / `Optional / Coming later`.
   - Attempting to launch tasks with these non-operational source kinds presents an informative guidance banner and safely blocks execution.

3. **Three Agent Modes (Ask / Plan / Execute)**:
   - **Ask Mode**: Read-only consultative mode for exploring questions and codebase architecture. Produces informational answers with zero workspace file modifications or external requests.
   - **Plan Mode**: Structured analytical planning outlining step-by-step proposals without modifying workspace code.
   - **Execute Mode**: Autonomous implementation within the sandbox workspace creating files, executing typecheck/build/unit test verifications, and producing result artifacts.

4. **Sandbox File Changes & Diffs (No Remote PR Needed)**:
   - File edits and creations execute entirely within the isolated cloud workspace sandbox.
   - Expandable syntax-highlighted diffs (`file-diff-viewer`) display additions and deletions per file directly in the web UI.

5. **Human Approval Gate (Invariant INV-07) & Real Mode Capability Gating**:
   - Ordinary sandbox operations (file edits, running test suites, internal builds) execute automatically within container boundaries without requiring approval.
   - The sensitive human approval card renders **only** when an out-of-sandbox side effect is requested (`awaiting_approval` status), clearly detailing the external action, risk level, and parameters.
   - Simulated approval transitions state to `applying` before `completed`, strictly preserving lifecycle invariants.
   - In Real API Mode, Cancel and External Approval action controls are dynamically disabled when public API capabilities (`cancellation`, `externalApproval`) are not operational.

6. **Real Mode Truthfulness, Request Fencing & Zero Silent Fallback**:
   - In Real API Mode (`apiMode === 'real'`), the launcher checks capability discovery via `getAgentCapabilities()`.
   - Mock workspaces, runs, and selections are immediately cleared synchronously upon switching to Real mode. Generation fencing (`activeRequestIdRef`) ensures late responses from prior mode switches or unmounted components never leak or overwrite active state.
   - Accurately distinguishes frontend control-plane integration (Linear 17T-48) from backend Cloud runtime readiness. When runtime is unavailable, the launcher displays a clear warning banner (`real-mode-runtime-warning`), disables the launch button (`Execution Unavailable (Real Mode)`), and **never fabricates mock workspaces or runs**.
   - In `AgentRunView`, request generation fencing (`activeRunRequestIdRef`) prevents late responses from earlier runs or modes from overwriting current state. Real runs reflect backend admission status and error details (`RUNTIME_UNAVAILABLE`) with empty file lists and zero fake artifacts.

7. **Default Blank Workspace & Fixture Isolation**:
   - The default new-task flow clearly targets a fresh blank workspace (`selectedWorkspaceId = ''`, labeled `New Blank Workspace (Default)` in target selector and composer).
   - Launching with blank workspace creates a brand new workspace without mutating or attaching to existing fixtures (`ws-react-task-manager`, `ws-csv-analytics`, `ws-doc-site`). Existing workspace cards allow clear toggling of target selection.

8. **Demo Simulation Transparency & Explicit Runtime Boundary**:
   - In Demo Mode (`?demo=1`), simulated sandbox execution, verification, and artifact metadata are prominently labeled (`DEMO SIMULATION`, `SIMULATED SANDBOX FILES`, `SIMULATED EVIDENCE`, `DEMO LABELED`).
   - The runtime boundary notice explicitly distinguishes simulation from real execution: Demo mode simulates isolated sandbox execution, files and verification; Real mode Cloud execution is unavailable (tracked under Linear 17T-48); actual future execution must be constrained to an isolated runtime so that ordinary sandbox edits do not alter external repositories or host systems.
   - Artifact downloads are disabled with explicit notice that downloads are not supported or advertised in Demo Mode.

9. **Bounded Demo Persistence Across Hard Browser Refresh (Linear 17T-40 Acceptance)**:
   - Newly created user workspaces and runs persist across browser refresh and direct URL navigation via namespaced `localStorage` keys (`giga_demo_workspaces_v1` and `giga_demo_runs_v1`).
   - Deterministic seeded fixtures (`INITIAL_WORKSPACES` and `INITIAL_RUNS`) are always preserved and deduplicated, guaranteeing baseline fixtures are never erased.
   - Restored data is validated against canonical `AgentStatus` contracts (`queued`, `running`, `awaiting_approval`, `applying`, `completed`, `failed`, `cancelled`), canonical `AgentWorkspace` contract (`sourceKind: 'blank'` only), and deep nested presentation structures (`plan`, `timeline`, `fileChanges`, `verifications`, `artifacts`, `approvalRequest`). Outdated or malformed records are safely discarded without throwing or crashing React rendering.
   - Strictly bounded by storage quotas (max 20 user workspaces, 50 user runs).
   - Real API mode strictly isolates from Demo persistence, never loading or displaying mock fixtures.

---

## 2. Test Verification & Code Quality

### Frontend Test Results
- **Suite**: `vitest run`
- **Results**: **218 / 218 tests passing** across 13 test files (zero failures, zero regressions).
- **Dedicated Test File**: `apps/web/tests/agent-workspace-ux.test.tsx` (42 scenarios covering Blank Workspace defaults, prompt validation, gated sources, mode toggling, runtime boundaries, Golden Flow execution, Ask/Plan modes, failed runs, cancellation, INV-07 approval gates, Real mode truthfulness, subpath routing, hard refresh rehydration, canonical AgentStatus/sourceKind validation, deep nested structure validation, and quota bounds).

### Compiler & Production Build
- **Typecheck**: `npm run typecheck --prefix apps/web` (0 errors, clean TypeScript emit).
- **Production Build**: `npm run build --prefix apps/web` (Clean production bundle built with Vite).

### Repository Workflow & Skill Validation
- **Skills Validation**: `.agents/scripts/validate-skills.mjs` (PASSED).
- **Git Workflow Validation**: `node --test .agents/scripts/validate-git-workflow.test.mjs` (PASSED: 6/6 tests).

---

## 3. Visual Verification Evidence

All screenshots captured from the live local preview (`http://localhost:5173/agent`).

### Mode Switching & Default Blank Workspace Verification

#### Default Blank Workspace Selection & Target Label
Clearly defaults to a fresh blank workspace with `New Blank Workspace (Default)` selected and `Workspace Target: New Blank Workspace` indicated.
![Default Blank Workspace](screen_17t_40_workspace_default.png)

#### Real API Mode Isolation & Runtime Warning
Upon switching to Real API Mode, Mock fixtures and runs are immediately cleared. An explicit warning alert informs the developer that backend Cloud runtime execution requires separate infrastructure readiness (Linear 17T-48 tracks frontend control-plane integration), launch buttons are disabled, and zero mock data leaks.
![Real Mode Isolation](screen_17t_40_mode_switching_real.png)

#### Browser Refresh & Direct Run URL Reopening (Linear 17T-40 Acceptance)
User-created run opened directly via URL and persisted through hard page reload (`Page.reload`). The execution view accurately restores task requirements, workspace identity (`Blank Workspace 5`), execution plan steps, timeline, and `DEMO SIMULATION` badge without 404 or session loss.
![Persisted Run After Reload](screen_17t_40_run_persisted_reload.png)

---

### Desktop Launcher & Mode Controls

#### Full Launcher Layout (Blank Workspace Default & Recent Executions)
![Launcher Full](screen_17t_40_launcher_full.png)

#### Agent Modes: Execute, Plan, and Ask
| Execute Mode (Active) | Plan Mode (Exploratory) | Ask Mode (Read-Only) |
| :---: | :---: | :---: |
| ![Execute Mode](screen_17t_40_launcher_desktop.png) | ![Plan Mode](screen_17t_40_launcher_plan.png) | ![Ask Mode](screen_17t_40_launcher_ask.png) |

---

### Sample Run Execution Tabs (`run-golden-react`)

#### 1. Structured Plan Tab
5-step execution plan with progress indicators and completed states.  
![Plan Tab](screen_17t_40_run_plan.png)

#### 2. Workspace Changes & Diff Viewer
Sandbox file creations and modifications with inline syntax diffs (no GitHub PR required).  
![Changes Tab](screen_17t_40_run_changes.png)

#### 3. Execution Activity Timeline
Tool actions, durations, and activity logs.  
![Timeline Tab](screen_17t_40_run_timeline.png)

#### 4. Sandbox Verification Evidence
Automated test suite, typecheck, and build verification status.  
![Verification Tab](screen_17t_40_run_verification.png)

#### 5. Generated Artifacts Tab
Simulated artifact representations with explicit demo badges and disabled downloads.  
![Artifacts Tab](screen_17t_40_run_artifacts.png)

---

### Mobile Viewport Verification (390 × 844)

| Mobile Launcher View | Mobile Execution Run View |
| :---: | :---: |
| ![Mobile Launcher](screen_17t_40_launcher_mobile.png) | ![Mobile Run](screen_17t_40_run_mobile.png) |
