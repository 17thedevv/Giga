# Giga — Documentation Index

**GitHub is the canonical location for technical and planning documents.** Linear manages ownership, due dates, blockers, evidence and progress.

## Current documents

| Document | Purpose | Status |
|---|---|---|
| [Project Plan v0.1](01-project-plan-v0.1.md) | Goals, scope, team responsibilities, cloud split, roadmap, report requirements, Definition of Done | Baseline / review |
| [API Contract v0.1](contracts/API_CONTRACT_V0.1.md) | Proposed frontend–backend endpoints, DTOs, SSE, agent tools, approvals and error semantics | **Draft: requires joint review** |
| [Architecture Invariants v0.1](architecture/INVARIANTS_V0.1.md) | Stable architecture policies, exceptions and design-gate checklist | Policy baseline |
| [ADR-001: API Stability](decisions/ADR-001-api-compatibility.md) | Backward compatibility rules, `/api/v2` migration and freeze gate | Policy accepted, concrete API pending |
| [Week 01 Daily Plan](planning/W01-daily-plan.md) | Day-by-day activities for 12–18 Oct 2026, tasks and evidence | Proposed schedule |
| [Team Workflow](TEAM-WORKFLOW.md) | How GitHub, Linear, pull requests and cross-training are used | Baseline / review |
| [Git Workflow v0.1](engineering/GIT_WORKFLOW_V0.1.md) | Branch naming, Conventional Commits, reviews, safe sync, conflicts and CI | Review proposed |
| [Shared Development Agent Skills](../.agents/README.md) | Shared skill pack for Codex/Antigravity, eight task-specific workflows and manual acceptance cases | Draft; requires joint trial |

## Tracking

- [Giga on Linear](https://linear.app/17thedev/project/giga-cloud-mini-project-0656a578ee3b)
- [Docs review PR #1](https://github.com/17thedevv/Giga/pull/1)

## Documentation policy

1. Keep the repository-level `README.md` about the **Giga product only**. Do not put team assignment, coursework, day-to-day plans or management instructions in that README.
2. Put plans under `docs/planning/`, contracts under `docs/contracts/` and decisions under `docs/decisions/` as they are created.
3. Update canonical specifications through GitHub pull requests. A contract marked **Draft** is not a frozen or implemented interface.
4. Manage tasks and planned deadlines in Linear, link each task to its corresponding documentation and PR, and keep evidence free of secrets.
5. Create the next weekly daily plan only after reviewing the previous week's acceptance gate and actual progress.
