# ADR-003 — General-purpose GigaAgent with Isolated Execution Runtime

- **Status: PROPOSED FOR JOINT REVIEW.** Product direction selected 2026-10-13; implementation and any amendment to locked architecture policies **not effective until review and adoption**.
- **Owner:** Trà (Agent/Backend). **Reviewer:** Tráng A Thư (Frontend/UX). Tracking: [17T-24](https://linear.app/17thedev/issue/17T-24/redesign-gigaagent-as-agentic-workspace-with-sandbox-runtime).
- **Supersedes as a product design:** GitHub-only assumptions in the earlier *draft* Project Plan, API Contract Agent section, Agent UX mock and old runtime skill. It **does not** repeal the locked policy INV-07 without the normal approval gate.
- **Related:** [Architecture](../architecture/GIGA_AGENT_ARCHITECTURE_V0.2.md), [Security](../architecture/GIGA_AGENT_RUNTIME_SECURITY_V0.2.md), [API](../contracts/GIGA_AGENT_API_V0.2.md), [Invariants](../architecture/INVARIANTS_V0.1.md), [ADR-001](ADR-001-api-compatibility.md).

## Context

The first GigaAgent draft equated the agent with repository inspection, exact-diff approval and GitHub PR creation. The desired product is an Antigravity/Codex-like **agentic environment** that can produce or modify local workspace files, execute build/tests in a controlled environment, inspect outputs, self-correct and return downloadable artifacts, whether or not a Git repository exists. An API-host-only runtime cannot safely execute untrusted model-generated code. The project remains a two-person cloud mini-project with real resource and cost constraints.

## Product decision

1. **Separation:** GigaChat and GigaAgent are separate UX, task histories and authority scopes. They may share Auth, DB and LLM adapter, but personal memory is not implicitly made available to Agent.
2. **Workspace-first:** A user-owned workspace with versioned durable snapshots is primary; GitHub/Git are optional import/publish integrations. Agent run has no required repository.
3. **Generic agent loop:** bounded plan → tool → observation → verification → correction; completion is an evidenced result, not necessarily a PR.
4. **Control/Execution Plane split:** Hono manages control/auth/state; model-generated terminal commands run **only** in an independently isolated runtime that passes security gates, never directly on API host.
5. **Phased runners:** cloud sandbox first for MVP because Giga is web/cloud-oriented; a future paired local runner uses the same typed runtime contract, subject to separately approved device permissions.
6. **Permission classes:** normal file edits and build/test inside authorized disposable sandbox may be automatic in Execute; external side effects, privileged access, deployment, financial/destructive operations require explicit authenticated, scoped approval or are denied.
7. **Durable artifacts/events:** PostgreSQL for metadata/queue/events; durable artifact storage for snapshots/exports; SSE is observation, not the source of truth.
8. **Open extension surface:** tools, browser, skills, MCP, GitHub and subagents are capability-specific and not assumed available by default.

## Proposed policy reconciliation for INV-07

Preserve exactly the prior principle **"No arbitrary agent-generated shell/terminal execution on the API host."** This ADR proposes explicitly allowing bounded commands in an **isolated, separately authenticated and permission-scoped sandbox**, after runtime isolation is proven. Keep exact approval for consequential remote writes. Routine sandbox-local file mutations must not inherit the previous blanket GitHub diff approval rule.

**Until this ADR is reviewed and adopted, the existing INV-07 locked policy remains controlling.** No coding agent is authorized to deploy the proposed command runner merely because this document exists.

## Alternatives

| Alternative | Benefits | Downsides | Decision |
|---|---|---|---|
| GitHub-first bot | Small, easy GitHub demo | Fails empty workspace, file generation, build/test and non-GitHub tasks | Reject as main product architecture; optional integration |
| Host-based shell on Hono | Quick proof of concept | Secrets/tenant boundary violations, code execution hazard | Reject |
| Separate cloud sandbox | Browser-first, repeatable CI/runner, isolated resource budget | Real isolation/cloud cost complexity | Preferred MVP after tests |
| Local runner first | Familiar desktop filesystem access | Requires paired client and device permission model | Later |
| Hybrid runner on day 1 | Broad capabilities | Two runtime products to build simultaneously | Reject initial scope |

## Consequences

Advantages: correct product scope, extensible tool system, authentic autonomous task capability, cloud demonstration possible without GitHub, clear separation of privileges.

Costs: expensive/complex sandboxing, build/dependency abuse controls, object storage lifecycle, runner provisioning and restart/rehydration, browser preview security, UX/API migration and more negative security tests.

## Approval and implementation gates

- [x] User chose separate GigaChat and GigaAgent, generic Antigravity-like workspace direction.
- [ ] Trà/Thư peer review this ADR, UI, public DTOs, security model and run semantics.
- [ ] Choose sandbox technology, hosting, image, quotas and actual costs; demonstrate strict host/tenant isolation before untrusted command execution.
- [ ] Approve runtime permission/egress policy and external effect reapproval behavior.
- [ ] Verify event replay, stale worker fencing, cancellation and artifact durability in disposable test infrastructure.
- [ ] Confirm API contract DRAFT changes and compatibility impact in front/backend tests; browser auth/SSE checks before FROZEN.
- [ ] Separate implementation issues and PRs for Agent Core, sandbox, toolset, UI, artifacts, permissions and integration.
- [ ] No paid resource provisioning or Cloud write without user approval.

**No Agent Runtime, Cloud sandbox, terminal tool, GitHub write capability or public API is made live by this ADR.**
