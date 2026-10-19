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

5. **Human Approval Gate (Invariant INV-07)**:
   - Ordinary sandbox operations (file edits, running test suites, internal builds) execute automatically within container boundaries without requiring approval.
   - The sensitive human approval card renders **only** when an out-of-sandbox side effect is requested (`awaiting_approval` status), clearly detailing the external action, risk level, and parameters.
   - Simulated approval transitions state to `applying` before `completed`, strictly preserving lifecycle invariants.

6. **Real Mode Truthfulness & Zero Silent Fallback**:
   - In Real API Mode (`apiMode === 'real'`), the launcher checks capability discovery via `getAgentCapabilities()`.
   - Because Cloud sandbox execution is pending under Linear 17T-48, the launcher displays a clear warning banner (`real-mode-runtime-warning`), disables the launch button (`Execution Unavailable (Real Mode)`), and **never fabricates mock workspaces or runs**.
   - In `AgentRunView`, real runs reflect backend admission status and error details (`RUNTIME_UNAVAILABLE`) with empty file lists and zero fake artifacts.

7. **Demo Simulation Transparency**:
   - In Demo Mode (`?demo=1`), simulated sandbox execution, verification, and artifact metadata are prominently labeled (`DEMO SIMULATION`, `SIMULATED SANDBOX FILES`, `SIMULATED EVIDENCE`, `DEMO LABELED`).
   - Artifact downloads are disabled with explicit notice that downloads are not supported or advertised in Demo Mode.

---

## 2. Test Verification & Code Quality

### Frontend Test Results
- **Suite**: `vitest run`
- **Results**: **196 / 196 tests passing** across 13 test files.
- **Dedicated Test File**: `apps/web/tests/agent-workspace-ux.test.tsx` (20 scenarios covering Blank Workspace defaults, prompt validation, gated sources, mode toggling, runtime boundaries, Golden Flow execution, Ask/Plan modes, failed runs, cancellation, INV-07 approval gates, Real mode truthfulness, and subpath routing).

### Compiler & Production Build
- **Typecheck**: `npm run typecheck --prefix apps/web` (0 errors, clean TypeScript emit).
- **Production Build**: `npm run build --prefix apps/web` (Clean production bundle built in 1.49s).

### Repository Workflow & Skill Validation
- **Skills Validation**: `.agents/scripts/validate-skills.mjs` (PASSED).
- **Git Workflow Validation**: `.agents/scripts/validate-git-workflow.mjs` (Branch, PR Title, Commit Header valid).

---

## 3. Visual Verification Evidence

All screenshots captured from the live local preview (`http://localhost:5173/agent?demo=1`).

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
