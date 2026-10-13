---
name: giga-agent-runtime
description: Guides development of Giga's general-purpose, workspace-first Agent Engine with isolated sandbox execution, tools, permissions, run state, artifacts and optional integrations. Not a GitHub-only bot.
---

# GigaAgent Runtime — Workspace-first General Agent

This skill guides coding agents **building** Giga. It does not authorize production provisioning, untrusted host shell execution or automatic remote writes.

## Read first

- Current product scope: `docs/01-project-plan-v0.2.md`.
- Agent architecture: `docs/architecture/GIGA_AGENT_ARCHITECTURE_V0.2.md`.
- Runtime sandbox/permissions: `docs/architecture/GIGA_AGENT_RUNTIME_SECURITY_V0.2.md`.
- Agent database draft: `docs/architecture/GIGA_AGENT_DATA_MODEL_V0.2.md`.
- API contract proposal: `docs/contracts/GIGA_AGENT_API_V0.2.md` and ADR-001.
- Proposed ADR-003 and still-locked architecture INV-07.
- `AGENTS.md`, `giga-git-workflow`, `giga-contract-guardian`, `giga-verification` and `giga-task-handoff` as needed.

## Product invariants

1. GigaChat and GigaAgent are separate experiences: never read GigaChat personal Memory or trigger Agent across products implicitly.
2. **Workspace, not GitHub, is the primary resource.** An empty Workspace with no repo must support a real task. GitHub/PR are optional capabilities and results.
3. Generic loop: authenticate task -> plan -> validate capability and budget -> select tool -> execute -> observe -> verify -> repair or finish, with durable state and replayable events.
4. Agent mode Ask only answers, Plan reads/plans, Execute can mutate its authorized isolated sandbox. No model-generated shell execution on Hono/API host.
5. Real command execution must use an independently isolated runner after adopted ADR-003, measured security gates and approved provisioning; never fall back to host shell.
6. Tools are typed and authorized per capability: filesystem, terminal/build/test, artifacts; browser/preview, Git, GitHub, Skills/MCP, Local Runner and subagents are separate milestones.
7. Routine sandbox file edits/builds within granted scope may run autonomously. External/privileged/destructive effects demand concrete one-use authenticated approvals tied to target and action hash.
8. PostgreSQL persists Workspace/Run/jobs/steps/events/approvals; durable storage persists snapshots and artifacts. Ephemeral sandbox disk is not canonical storage.
9. Allowlisted model aliases and step/token/time/CPU/memory/disk/network limits are enforced server-side, never just in an LLM prompt.
10. Completion means verified output/snapshot/real checks persisted, **not a required GitHub PR**.

## Implementation order

1. Fake-runner Agent Core: authenticated Workspace/Run objects, schema-validated tool loop, budgets, DB queue/lease/fencing, SSE replay and owner-negative tests.
2. External isolated Cloud Sandbox: no Control Plane secrets, host socket, unconstrained network or cross-user mount; observe actual security tests before running untrusted builds.
3. Filesystem/terminal tools within sandbox, build/test logs and bounded automatic repair.
4. Immutable snapshot and artifact ZIP with checksums and owner-scoped download/retention.
5. Agent Manager/Editor UI with Ask/Plan/Execute, file tree, plans, tools, terminal logs, artifacts, cancellation and approval UI.
6. Later: browser preview/automation, optional GitHub/MCP, local runner and parallel agents.

## Golden E2E required for MVP

Authenticated user creates blank Workspace, requests React task manager, Agent writes source files, runs real TypeScript/build/tests in sandbox, repairs mistakes within budget and returns ZIP artifact. GitHub integration is not connected or invoked. SSE refresh/replay works, user B cannot access A's files/artifacts, and runtime failure is reported honestly.

## Security and correctness gates

- Reject workspace path traversal, malicious archives, symlink escape, cross-user access, internal metadata network access and attempted secret extraction.
- Run only allowlisted scoped tools; redact large/untrusted logs. Tool and model outputs are untrusted data, not authority.
- Prevent duplicate side effects with persisted effect IDs, leases and reconciliation; don't retry ambiguous external writes blindly.
- No optimistic false success: record actual exit codes, artifacts, tests not run and partial/cancelled state.
- Use real disposable Postgres test environments with guarded test DB; never production DATABASE_URL.
- Do not assert sandbox/provider/runtime implementation, CI or testing results unless actually verified.

## Handoff

Report issue/branch/PR, implementation boundaries, mock-vs-real behavior, actual tests, budget/security evidence, changed API/DTO, owner/reviewer, open approvals and next step. No autonomous merging.
