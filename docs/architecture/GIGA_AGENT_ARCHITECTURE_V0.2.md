# GigaAgent — Agentic Workspace Architecture v0.2

> **Status: PROPOSED TECHNICAL DESIGN / PRODUCT DIRECTION CONFIRMED (2026-10-13). FULL RUNTIME NOT IMPLEMENTED; control-plane candidate below.**
> Owner: Trà; UX and API reviewer: Thư. Tracking: [17T-24](https://linear.app/17thedev/issue/17T-24/redesign-gigaagent-as-agentic-workspace-with-sandbox-runtime). See [ADR-003](../decisions/ADR-003-agentic-workspace-and-isolated-runtime.md), [Sandbox and Permissions](GIGA_AGENT_RUNTIME_SECURITY_V0.2.md), [Data Model](GIGA_AGENT_DATA_MODEL_V0.2.md), [Draft API](../contracts/GIGA_AGENT_API_V0.2.md), [UX](../design/frontend/GIGA_AGENT_UX_V0.2.md), [Delivery Plan](../planning/GIGA_AGENT_DELIVERY_V0.2.md).

## 1. Product definition and agreed scope

**17T-44 implementation boundary:** [ADR-008](../decisions/ADR-008-agent-control-plane-foundation.md)
and the [API subset](../contracts/GIGA_AGENT_API_V0.2.md#implementation-candidate--17t-44)
provide durable Workspace metadata, unavailable Run admission/history and replayable events.
The orchestrator, execution plane, sandbox tools and artifacts described below remain proposals.
No actual Agent task execution is claimed by the control-plane foundation.

**GigaAgent is a general-purpose tool-using agentic development/workspace environment**, with coding as a flagship capability, not a GitHub bot. It accepts a user goal, explores allowed context, plans tasks, selects registered tools, executes work in an isolated runtime, observes/verifies results, repairs failures within limits, and returns durable artifacts and truthful status.

**GigaChat and GigaAgent are separate product experiences.** They share Auth, backend infrastructure, provider adapters and underlying persistence facilities, but they do not share task context, personal memory or execution authority implicitly. There is no default Chat-to-Agent handoff or agent access to GigaChat Hybrid Memory. A later explicit scoped integration would require a separate proposal.

**Git/GitHub is optional:** a user can create a blank workspace, upload files or explicitly import a repo. A successful run may produce project files, ZIP, report, analysis, preview or an optionally approved external PR. No repository, GitHub credentials or PR is required to start, run or complete an Agent task.

### Representative success case — mandatory MVP E2E

1. An authenticated user creates an empty Workspace (no repository).
2. User requests: "Build a responsive React task manager and fix any TypeScript/build errors."
3. GigaAgent produces a plan, creates files under its isolated workspace, runs an approved package/install/build/test command inside an **isolated sandbox**, reads output, repairs failures up to a limit and verifies success.
4. Giga persists run history, tool events, file snapshot and downloadable source artifact.
5. UI refresh/reconnect does not lose status. The task succeeds without any Git/GitHub action.
6. If runtime unavailable or build fails after capped retries, the result is **failed/partial with evidence**, never an unverified "completed".

Other possible runs: analyze CSV, research docs via approved web tools, edit a project uploaded by user, produce Markdown/ZIP reports, inspect and optionally work with a Git repository.

## 2. Scope cuts

| MVP foundation | Next milestone | Later |
|---|---|---|
| One isolated Cloud Sandbox runner; one active run/user; user-owned workspaces | Browser preview and visual checks in controlled runtime | Local Runner, desktop agent |
| Agent loop, typed tool registry and budget guard | Browser UI automation, screenshots | Parallel subagents and task delegation |
| Filesystem/terminal/build/test tools inside sandbox | Optional tool-enabled Skills/MCP allowlisted integrations | Distributed orchestration at scale |
| Persistent plan/events, artifact ZIP, resume/reconnect | GitHub optional import and approved PR publishing | Marketplace and hosted integrations |
| Ask / Plan / Execute modes with scoped permission engine | Structured reusable project knowledge | Autonomous cross-system pipelines |

An editor-like interface in the web UI does **not** imply a full IDE/VS Code clone. Monaco or an equivalent editor may be used later for a constrained file view. Preview, screenshot/browser tools and local runner are not prerequisites to the first runnable Agent MVP.

## 3. Architecture and trust boundaries

~~~mermaid
flowchart TD
  WEB[GigaAgent Web - Agent Manager/Workspace Editor] --> API[Hono Control Plane - Auth, CSRF, API, SSE]
  API --> DB[(PostgreSQL - states, jobs, plans, approvals, event outbox)]
  API --> ORCH[Agent Orchestrator - durable decision loop]
  ORCH --> LLM[LLM Provider Port]
  ORCH --> POL[Permission & Budget Policy]
  POL --> REG[Typed Tool Registry]
  REG --> EXEC[Execution Runtime Port]
  EXEC --> CLOUD[Cloud Sandbox Runner - isolated untrusted code]
  EXEC -. later .-> LOCAL[Local Runner - explicit device pairing]
  CLOUD --> OBJ[(Artifact/Snapshot Storage)]
  CLOUD --> TOOL[Filesystem, terminal, build and optional browser tools]
  TOOL --> VERIFY[Verification & bounded self-correction]
  VERIFY --> ORCH
  ORCH --> DB
  API --> OBJ
~~~

**Trust boundary A — browser → Control Plane:** browser does not receive provider keys, persistent connection secrets or sandbox daemon credentials. Every API resource is authorized by the authenticated owner. No browser-client-selected tenantId is trusted.

**Trust boundary B — Control Plane → Execution Plane:** Hono does not spawn a model-generated shell, mount writable host root or execute untrusted code in the server process. Runners authenticate via short-lived scoped capability and emit bounded/redacted outcomes. Sandbox compromise must not grant access to main DB or Cloud control plane.

**Trust boundary C — tools → external systems:** external writes, billing and destructive actions require server-side explicit capability scope and human approval. The model cannot override policy by text.

**Trust boundary D — data → model:** user uploads, repository content, web pages, tool outputs and stored agent messages are untrusted input, never privileged instructions. Skills/MCP tools remain allowlisted under server policy.

## 4. Agent Engine and deterministic loop

The model *proposes* a next action. The orchestrator validates schemas, permissions, step budgets, preconditions and the runner's actual state before executing. Tool results become observations, not commands.

~~~mermaid
flowchart TD
  Q[Receive task] --> R[Load authorized workspace, run state and budgets]
  R --> P[Understand goal and plan]
  P --> M[LLM proposes tool call, response or plan revision]
  M --> V{Validate tool + scope + budget}
  V -->|Disallowed| D[Deny or request approval]
  D --> M
  V -->|Allowed| X[Execute via runner]
  X --> O[Observe bounded result; persist event]
  O --> T{Task verified or terminal?}
  T -->|Needs repair and budget remains| M
  T -->|Completed with evidence| S[Persist snapshot/artifacts and completed]
  T -->|Failure/limit| F[Persist failed/partial reason]
~~~

State and data integrity:
- **User-facing run statuses** retain the *draft* enum: queued, running, awaiting_approval, applying, completed, failed, cancelled. Within running, record internal **phase** planning, executing, observing, verifying (do not silently expand the public status enum).
- "applying" is only used for an approved external side-effect, not every harmless internal file edit. Ordinary sandbox edits remain **running**.
- A task can continue across multiple user instructions within a Workspace; run messages form scoped follow-up context, but a run has one durable terminal outcome and can spawn a subsequent run for further work.
- Save commands/plans/events before dispatch; use worker lease/fencing + idempotency to prevent duplicate effects after crashes. A refresh of UI is a read/replay, not restart.
- Stop/cancel signals terminate sandbox processes cooperatively then forcefully after a bounded grace period, with explicit partial-state handling. If an external write has already committed, cancellation cannot pretend it was undone.
- Accurate completion requires verified outputs and persisted artifacts, not a model saying "done".

## 5. Workspace as primary resource

Workspace belongs to user and is independent of any single run. It can be:
1. **blank** — generated project directory and files;
2. **upload** — user-provided files checked for traversal/malware/size and unpacked only in sandbox;
3. **optional import** — an explicitly authorized Git repository snapshot, with grants and revision pinned.

Logical entities: Workspace metadata, workspace files/snapshots, Agent Runs/messages/steps/events/tool calls, permissions/approvals, Sandbox Sessions, Artifacts and Jobs. This is NOT an authorization to create physical Cloud services or apply migrations.

Persistent state: PostgreSQL holds metadata, indexed histories and job states; encrypted object storage (or other reviewed durable artifact backend) holds workspace snapshots/ZIPs and large outputs. Ephemeral sandbox disk is disposable. Snapshot and artifact access use authenticated short-lived downloads; prevent path traversal and cross-user lookups.

Workspace continuation: a new Agent Run starts from an explicitly selected saved snapshot, not an arbitrary leftover live container. Track snapshot version / expectedRevision and refuse concurrent destructive edits without lock/version review. Local files must not silently become a second source of truth.

## 6. Tool ports (capabilities, not hardcoded workflow)

~~~ts
interface ToolDefinition<TArgs, TResult> {
  name: string;
  version: string;
  argsSchema: unknown;       // runtime validated, e.g. Zod
  risk: 'read' | 'sandbox_write' | 'network' | 'external_write';
  run(args: TArgs, ctx: AuthorizedToolContext): Promise<TResult>;
}
interface ExecutionRuntime {
  prepare(workspaceSnapshotId: string, limits: RuntimeLimits): Promise<RunnerSession>;
  invoke(session: RunnerSession, tool: ValidatedToolCall): Promise<BoundedToolResult>;
  stop(session: RunnerSession): Promise<void>;
  snapshot(session: RunnerSession): Promise<ArtifactManifest>;
}
~~~

Proposed names:
- **Filesystem**: list_directory, read_file, search_files, write_file, edit_file, delete_file (workspace root only, allowlist sensitive files, symlink defenses).
- **Terminal**: run_command / install_dependencies / run_tests (sandbox only; no host shell; separate approved network policy).
- **Browser** (next milestone): open_page, interact, capture_screenshot in browser sandbox or proxied isolated preview.
- **Research/Artifacts**: optional web_search/fetch_url, package_files, create_report, preview_artifact.
- **Git** (optional): status/diff/commit on explicit workspace; GitHub PR is separate external_write tool, not run completion prerequisite.
- **Instructions / text Skills:** a shared, separately owner-scoped [Skills Engine](GIGA_SKILLS_ENGINE_V0.1.md) supports explicitly selected text-only SKILL.md-style guidance and Agent Workspace defaults without tools. The Skill itself cannot grant filesystem/terminal, Memory, GitHub or MCP authority. Text Skills are P0 in their own program, integrated only after the relevant Agent text/model path is functional.
- **Tool-enabled Skills and extensions (later):** MCP and scripts require allowlisted Tool Registry, explicit grants and adopted isolated sandbox permissions; not part of the initial text Skills.
- **Parallel subagents** (later): separate budget/risk/task namespaces; no invisible delegated authority.

Tool Registry must be capability- and policy-driven. The LLM does not gain every tool merely because a connector is installed.

## 7. Model/Context management

The Agent Runtime selects a server-side allowlisted model alias via a provider adapter. Plan/execute/verification phases may share one model in MVP. Provider tokens, secrets and raw internal prompts are never exposed to browser logs. Context includes the current task, current plan/steps, authorized workspace inventory and bounded recent observations; file contents are supplied on-demand by tools and truncated to budget. Do not dump entire workspace, prior user chat history or personal memory by default.

LLM output must be validated against strict schemas, with bounded retries and error handling for malformed tool calls. All evaluation data and external texts are treated as untrusted. Provide truthful user-visible progress summaries; do not promise access to private reasoning traces.

## 8. Output and artifact verification

Results may include edited workspace, source ZIP, report, preview link, logs summary, test output, screenshots or external PR when requested. Preserve content hashes, sanitized manifests, timestamps, source snapshot and MIME type. Artifacts cannot authorize additional tool privileges.

A completed run records **what was actually verified** (e.g. npm run build exit code 0), which checks were not executed, and durable result references. A failed run may expose partial artifacts with a clear label. Do not claim runtime, sandbox, file preview or artifact persistence implemented from this document alone.

## 9. Explicit non-goals / migration from v0.1

The legacy [API Contract v0.1 §5](../contracts/API_CONTRACT_V0.1.md) and [Frontend UX v0.1](../design/frontend/UX_FLOW_V0.1.md) described a GitHub-first demonstration. Those are **historical draft flows superseded for the GigaAgent product direction**, not evidence of frozen backwards compatibility. The independent GigaChat and Auth flows remain unaffected.

An actual implementation still requires an approved ADR, runner threat-model tests, model/runner decisions, front/backend DTO sign-off and reviewed migration PRs. The canonical v1 API is still **DRAFT**.

## 10. Review checklist

- [ ] Trà verifies control/execution isolation, durable event/worker behavior, data ownership and cost ceilings.
- [ ] Thư verifies multi-panel Workspace UX, mode permissions, empty/loading/error states, API/SSE DTOs.
- [ ] Both approve permission boundary (sandbox self-edits vs external effects), cancellation, artifact download and retention.
- [ ] Demo without GitHub passes: empty workspace -> React app -> build/test -> artifact after implementation.
- [ ] Document remaining Cloud runner feasibility, sandbox pricing, runtime quotas and threat model evidence before provision.
