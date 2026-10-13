# Giga — Documentation Index

**GitHub is the canonical location for technical and planning documents.** Linear manages ownership, due dates, blockers, evidence and progress.

## Current documents

| Document | Purpose | Status |
|---|---|---|
| [Project Plan v0.1](01-project-plan-v0.1.md) | Original mini-project baseline; GitHub-first Agent scope now superseded | Historical / course context |
| [API Contract v0.1](contracts/API_CONTRACT_V0.1.md) | Proposed frontend–backend endpoints, DTOs, SSE, agent tools, approvals and error semantics | **Draft: requires joint review** |
| [Architecture Invariants v0.1](architecture/INVARIANTS_V0.1.md) | Stable architecture policies, exceptions and design-gate checklist | Policy baseline |
| [ADR-001: API Stability](decisions/ADR-001-api-compatibility.md) | Backward compatibility rules, `/api/v2` migration and freeze gate | Policy accepted, concrete API pending |
| [Week 01 Daily Plan](planning/W01-daily-plan.md) | Day-by-day activities for 12–18 Oct 2026, tasks and evidence | Proposed schedule |
| [Team Workflow](TEAM-WORKFLOW.md) | How GitHub, Linear, pull requests and cross-training are used | Baseline / review |
| [Git Workflow v0.1](engineering/GIT_WORKFLOW_V0.1.md) | Branch naming, Conventional Commits, reviews, safe sync, conflicts and CI | Review proposed |
| [Shared Development Agent Skills](../.agents/README.md) | Shared skill pack for Codex/Antigravity, eight task-specific workflows and manual acceptance cases | Draft; requires joint trial |

## GigaChat Runtime & Shared LLM Engine (13 October 2026)

**Product design accepted; technical DTOs/provider/runtime parameters remain DRAFT.** Documents below define the real Chat generation path and the shared provider-neutral AI model layer without coupling Agent to Chat Memory.

| Document | Purpose | Status |
|---|---|---|
| [GigaChat Runtime v0.2](architecture/GIGACHAT_RUNTIME_V0.2.md) | Generation lifecycle, persistence, Stop/Retry, context and SSE orchestration | Design agreed; implementation proposed |
| [Shared LLM Engine v0.1](architecture/LLM_ENGINE_V0.1.md) | Model aliases, adapters, capabilities, budgets and provider usage | Design agreed; provider choice open |
| [GigaChat Runtime API Addendum](contracts/GIGACHAT_RUNTIME_API_V0.2.md) | Proposed status/cancel, SSE events, idempotency, regenerate review gates | **DRAFT** |
| [GigaChat Runtime Test Plan](architecture/GIGACHAT_RUNTIME_TEST_PLAN_V0.2.md) | 34 test scenarios incl. persistence, provider/streaming, privacy, billing | Not executed |
| [ADR-004](decisions/ADR-004-chat-generation-lifecycle.md) | Persistent generation/stop and shared LLM engine rationale | Proposed technical ADR |

Existing Conversation History 17T-21 owns messages; Memory 17T-22 handles retrieval/extraction; GigaAgent remains an independent execution runtime. API v1 is not frozen.

## GigaChat / Hybrid Memory technical specification

The product direction **Hybrid Memory** was selected on 2026-10-13. The detailed DB, API and provider implementation is **proposed, not implemented or frozen**.

| Document | Purpose | Status |
|---|---|---|
| [Hybrid Memory and RAG Architecture](architecture/AI_MEMORY_RAG_V0.1.md) | Scope, consent modes, chat/RAG architecture, user memory policy, source lifecycle | Draft technical design |
| [Memory Data Model](architecture/AI_MEMORY_RAG_DATA_MODEL_V0.1.md) | PostgreSQL + pgvector schema/migration sketches, ownership, versioning, jobs | **Non-executable** proposed DDL |
| [Memory Pipelines and Security](architecture/AI_MEMORY_RAG_PIPELINES_V0.1.md) | Capture, embedding, retrieval, worker leases, delete/forget and threat model | Draft |
| [Memory API v0.1](contracts/GIGACHAT_MEMORY_API_V0.1.md) | Settings, memory CRUD, suggestions, DTO/errors and contract questions | **DRAFT; not canonical frozen API** |
| [Memory Verification & Eval](architecture/AI_MEMORY_RAG_TEST_PLAN_V0.1.md) | Behavior matrix, privacy tests, real pgvector integration and retrieval benchmarks | **Plan; not executed** |
| [ADR-002](decisions/ADR-002-hybrid-memory-pgvector.md) | Hybrid Memory product choice, preferred pgvector candidate, alternatives and gates | Proposed technical ADR |
| [GigaChat Delivery Plan](planning/GIGACHAT_DELIVERY_V0.1.md) | Incremental milestones, two-person ownership, review dependencies | Proposed |

## GigaAgent — Agentic Workspace v0.2

**Direction selected 2026-10-13:** GigaChat and GigaAgent are independent. Agent creates/edits/files, builds/tests and returns artifacts using a separately isolated sandbox; GitHub is OPTIONAL. No new backend/runner is implemented by these documents.

| Document | Purpose | Status |
|---|---|---|
| [Product Plan v0.2](01-project-plan-v0.2.md) | Independent Chat and workspace-first Agent product scope | Review proposal |
| [Agent Architecture](architecture/GIGA_AGENT_ARCHITECTURE_V0.2.md) | Generic loop, control/execution planes, tools, workspace and result | Draft |
| [Agent Runtime Security](architecture/GIGA_AGENT_RUNTIME_SECURITY_V0.2.md) | Sandbox isolation, permissions, budgets, approvals and threats | Draft |
| [Agent Data Model](architecture/GIGA_AGENT_DATA_MODEL_V0.2.md) | Workspace, run, steps/events, snapshots, artifacts, jobs | Non-executable draft |
| [Agent API v0.2](contracts/GIGA_AGENT_API_V0.2.md) | Workspace-first REST/SSE DTOs, approval and artifact endpoints | DRAFT |
| [Agent Workspace UX](design/frontend/GIGA_AGENT_UX_V0.2.md) | Agent Manager, Workspace Editor, activity and approvals | Draft |
| [Agent Test Plan](architecture/GIGA_AGENT_TEST_PLAN_V0.2.md) | 35 acceptance/security cases and no-GitHub golden E2E | Not executed |
| [ADR-003](decisions/ADR-003-agentic-workspace-and-isolated-runtime.md) | Change from GitHub bot to isolated general Agent | PROPOSED, needs review |
| [Agent Delivery Plan](planning/GIGA_AGENT_DELIVERY_V0.2.md) | Incremental implementation slices and Cloud gates | Proposed |

Original v0.1 Agent GitHub-only UX/contract assumptions are marked historical or revised in the DRAFT; Chat/Auth flows remain distinct. **Locked INV-07 is still effective** until ADR-003 is reviewed.

## Tracking

- [Giga on Linear](https://linear.app/17thedev/project/giga-cloud-mini-project-0656a578ee3b)
- [Docs review PR #1](https://github.com/17thedevv/Giga/pull/1)

## Documentation policy

1. Keep the repository-level `README.md` about the **Giga product only**. Do not put team assignment, coursework, day-to-day plans or management instructions in that README.
2. Put plans under `docs/planning/`, contracts under `docs/contracts/` and decisions under `docs/decisions/` as they are created.
3. Update canonical specifications through GitHub pull requests. A contract marked **Draft** is not a frozen or implemented interface.
4. Manage tasks and planned deadlines in Linear, link each task to its corresponding documentation and PR, and keep evidence free of secrets.
5. Create the next weekly daily plan only after reviewing the previous week's acceptance gate and actual progress.
