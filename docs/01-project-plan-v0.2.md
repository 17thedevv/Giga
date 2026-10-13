# Giga — Product & Engineering Plan v0.2

> **Status: PRODUCT DIRECTION CONFIRMED; TECHNICAL SPECIFICATIONS PROPOSED / NOT FROZEN.** This document supersedes the **product-definition and Agent scope** in [historical v0.1 baseline](01-project-plan-v0.1.md), not course evidence or past task logs. Date 2026-10-13. Owner Trà; reviewer Thư. Tracking: [17T-24](https://linear.app/17thedev/issue/17T-24/redesign-gigaagent-as-agentic-workspace-with-sandbox-runtime).

## 1. Product vision

Giga is a web-first AI workspace combining **two independent experiences**:

1. **GigaChat** — multi-turn conversational AI, persistent message history and opt-in user-controlled Hybrid Memory (Manual / Suggest / Auto), with PostgreSQL + preferred pgvector RAG design. This experience **does not** start GigaAgent automatically.
2. **GigaAgent** — general-purpose, Antigravity/Codex-inspired agentic workspace that can plan, create/edit files, execute builds/tests in an **isolated** sandbox, inspect results, self-correct and deliver artifacts. Git and GitHub are optional integrations rather than preconditions.

Both share login, frontend shell, backend platform, observability and DB infrastructure but have **separate** histories, context policies, data access and action permissions. Neither may implicitly consume the other's memory or tool authority.

## 2. Product design milestones

| Area | Minimum outcome | Later extension |
|---|---|---|
| Auth / Platform | Session, secure CSRF/origin, owner-scoped data, HTTPS | Multi-device security, richer admin |
| GigaChat | Conversations + messages, LLM SSE, History CRUD, graceful errors | Hybrid long-term Memory, Knowledge PDF RAG |
| Skills & Personalization | After basic Chat Core: user Profile, built-in/private text Skills, explicit activation | Skill imports, auto suggestions, Plugin/MCP tools and marketplace |
| GigaAgent Manager | Create workspace/run, observe persistent status/events, cancel | Parallel and delegated agents |
| GigaAgent Core | Plan/tool/observe/verify loop with hard budgets | Multi-model routing, reusable skills |
| GigaAgent Workspace | Blank workspace, durable file snapshot, file tree | Imports, full editor, local devices |
| Sandbox | Independently isolated runner; filesystem/terminal/build/test | Browser UI automation, previews, local runner |
| Outputs | Build evidence, downloadable source ZIP / report artifacts | Browser screenshots, rich interactive preview |
| External tools | None needed for empty-workspace MVP | GitHub/MCP, deployments with explicit approval |
| Cloud | HTTPS app, durable Postgres + artifacts, CI, logs, resource budgets, backup/recovery evidence | Scaled queues/runners, distributed tracing |

The UI can be built incrementally from current mock components, but a mock demonstration is NOT a completed agent capability.

**Skills (product decision 2026-10-13):** A shared, text-only Skill Resolver/Instruction Composer can guide Chat answers and Agent tasks using explicit user-selected versions, but must never merge Chat and Agent data/permissions. Profile, Skills, Memory and external tools are separate services. See [Skills Architecture](architecture/GIGA_SKILLS_ENGINE_V0.1.md) and [ADR-005](decisions/ADR-005-skills-personalization-plugin-boundaries.md). P0 user Skills follow the first real Chat Runtime slice; Tool-enabled Skills/MCP remain later.

## 3. Mandatory first vertical slices

**GigaChat slice:** authenticated user creates a conversation, sends a prompt, receives proper SSE from a real allowlisted LLM, and reopens the persisted response after refresh. No memory/vector engine required for the first chat slice.

**GigaAgent slice:** authenticated user creates an **empty workspace with no repository**, requests "Create a responsive React task manager", agent plans, creates source files, runs actual build/tests in isolated sandbox, repairs errors when needed and produces a downloadable source artifact and honest verification record. No GitHub/PR required. This is the primary proof of general agent capability.

**Cloud slice:** verify hosted UI/API HTTPS, PostgreSQL persistence, sandbox cost/isolation and controlled runner provisioning, secrets, logs, quotas, restart and incident evidence. Since this is a Cloud mini-project, do not postpone all Cloud testing until advanced features.

## 4. Technical baseline and current evidence boundary (2026-10-13)

- TypeScript-first stack, Hono backend, React/Vite web frontend and PostgreSQL Auth foundation exist; their precise operational correctness is verified separately via PR/CI evidence.
- Frontend includes Chat/Agent UI scaffolds and mock adapter. Agent UI is **not** an actual runtime.
- GigaAgent runtime/tooling/sandbox are **not yet implemented**; expected agent backend folder was a placeholder at inspection.
- GigaChat Hybrid Memory architectural documents exist, but Memory/RAG runtime is not implemented by documents.
- API v1 remains **DRAFT** until cross-team review, contract fixtures and deployed browser auth/SSE verification.

## 5. Architecture and separation

~~~mermaid
flowchart TD
  USER[User] --> WEB[React/Vite App]
  WEB --> CHAT[GigaChat independent UX]
  WEB --> AGENT[GigaAgent Manager + Editor]
  CHAT --> API[Hono API/Auth]
  AGENT --> API
  API --> DB[(PostgreSQL: users, chat, agent state)]
  API --> LLM[LLM Provider Adapters]
  API --> MEMORY[Optional GigaChat memory]
  API --> CTRL[Agent Control Plane]
  CTRL --> RUNNER[Isolated Cloud Runner]
  RUNNER --> OUTPUT[(Artifact/Snapshot Store)]
  CTRL -. optional approved effect .-> EXT[GitHub/MCP/External Systems]
~~~

Backend business logic must not be duplicated in browser. Personal memory is not available to an Agent by default. Remote writes require authenticated scoped approval, not just a model instruction.

## 6. Two-person ownership

| Stream | Primary | Reviewer/cross-training |
|---|---|---|
| API, Auth, Chat persistence, LLM integration | Trà | Thư validates DTO/UI and runbook |
| Agent orchestration, runner interface, tools/security | Trà | Thư reviews UX, tests threat cases |
| Chat + Agent Manager + Editor UI | Thư | Trà verifies API/SSR/SSE and cloud front |
| Managed database/artifact storage/preview | Shared | Cross-train each other's procedures |
| Cloud deploy, budgets, incident/rollback evidence | Shared | Both independently operate a staging scenario |
| Requirements/report/contract freeze | Shared | Peer approval and reproducible evidence |

Keep task assignments and durations in Linear. Do not claim these deliverables are done until code, tests, deployment and actual review exist.

## 7. Contract and architecture references

- [Architecture Invariants](architecture/INVARIANTS_V0.1.md) (locked policy remains in effect).
- [ADR-001 Compatibility](decisions/ADR-001-api-compatibility.md), [ADR-003 Sandbox proposal](decisions/ADR-003-agentic-workspace-and-isolated-runtime.md).
- [Canonical API v0.1 DRAFT](contracts/API_CONTRACT_V0.1.md), [Candidate Agent API v0.2](contracts/GIGA_AGENT_API_V0.2.md).
- [GigaChat Memory/RAG](architecture/AI_MEMORY_RAG_V0.1.md).
- [GigaAgent Architecture](architecture/GIGA_AGENT_ARCHITECTURE_V0.2.md), [Sandbox Security](architecture/GIGA_AGENT_RUNTIME_SECURITY_V0.2.md), [Data Model](architecture/GIGA_AGENT_DATA_MODEL_V0.2.md), [Frontend UX](design/frontend/GIGA_AGENT_UX_V0.2.md), [Test Plan](architecture/GIGA_AGENT_TEST_PLAN_V0.2.md).
- [Agent Delivery Plan](planning/GIGA_AGENT_DELIVERY_V0.2.md), [GigaChat Delivery Plan](planning/GIGACHAT_DELIVERY_V0.1.md).

## 8. Non-goals, cost and operational gates

Do not build a complete IDE clone, arbitrarily execute user code on Hono host, provision unlimited Cloud runners, enable uncontrolled network or unapproved remote writes, or require GitHub accounts to begin. Local Runner, subagents, advanced browser automation and broad Skills/MCP ecosystems are phased enhancements.

Provisioning a real sandbox requires specific human cost authorization and tested isolation. Every artifact and database schema change requires review and retention/deletion planning. Track model token budgets, tool step/time caps, disk/CPU limits and external expenses.

## 9. Definition of Done (new scope)

- [ ] Real GigaChat login/conversation/LLM SSE/history works via hosted HTTPS and real browser.
- [ ] Real GigaAgent completes an **empty-workspace, no-GitHub** create→build→verify→artifact workflow in isolated runtime.
- [ ] Agent jobs/events survive browser refresh and runner restart/cancellation according to policy.
- [ ] External writes are optional and require exact scoped approval; no model-generated command runs on API host.
- [ ] Strict per-user/workspace isolation, URL/path/secret protections and time/cost limits pass adversarial tests.
- [ ] Durable file artifacts, downloaded source and failure evidence verified against checksums.
- [ ] Cloud runbook, CI, quota and failure/restore/cross-training evidence documented.
- [ ] Frontend/backend jointly review accepted DTOs and freeze only after ADR-001 criteria.

**Historical v0.1 course/report deadlines and evidence requirements remain useful context**; update concrete schedules in Linear rather than silently rewriting the original baseline. This v0.2 document is the canonical **proposed product scope** once reviewed and merged.
