# GigaAgent — Incremental Delivery, Acceptance and Ownership v0.2

> **PROPOSED DEVELOPMENT PLAN / NO RUNTIME IMPLEMENTATION.** Task [17T-24](https://linear.app/17thedev/issue/17T-24/redesign-gigaagent-as-agentic-workspace-with-sandbox-runtime). Owner Trà; Frontend reviewer Thư. Product: independent GigaChat and GigaAgent; workspace-first generic agent; GitHub optional. Cloud mini-project budget and deployment evidence remain mandatory.

## Milestones and gates

| Milestone | Deliverable | Backend owner (Trà) | Frontend owner (Thư) | Acceptance |
|---|---|---|---|---|
| D0 — Design | This architecture/API/security/UX/ADR PR | Author proposal | Review UX/API | Peer review, open questions documented |
| D1 — Control Plane | Workspace CRUD, jobs, run statuses, SSE/event persistence, bounded agent loop with fake runner | Implement/review state machine and tests | Agent Manager + mocked event replay | No GitHub required; owner isolation; crash/replay tests |
| D2 — Secure sandbox | Separate isolated Cloud runner, filesystem + command tools, CPU/memory/network limits | Sandbox/adapters/security tests | Tool activity and terminal output | Host secrets inaccessible; task timeout/cancel/cleanup |
| D3 — Functional vertical slice | Empty workspace -> React scaffold -> build -> fix -> ZIP | Generic tool loop, test failure repair and snapshots | Workspace file tree + artifact downloads | Real build result and immutable ZIP; no GitHub/PR |
| D4 — UX/visual | Editor, diff snapshots, safe preview, browser verification | Preview proxy/browser adapter after security gate | Resizable Editor, logs, preview, Approvals | Browser origin isolated, user can inspect files |
| D5 — Integrations | Optional Git/GitHub, Skills/MCP, approved external effects | Grants, effect hashes, remote reconcile | Connect/review/PR option | No external writes without approval |
| D6 — Runtime expansion | Local runner and parallel subagents | Protocol, pairing, isolation, quotas | Device/runtime selection and task manager | Separate threat model and rollout |
| D7 — Cloud/evidence | HTTPS, storage, reliable DB, cost/monitoring, incident/rollback | Runtime/worker operations | Browser auth/UX, cross-training | Public demo with sanitized logs and quota evidence |

**Actual scheduling:** Cloud/HTTPS and a small functioning slice should be established before D6 and advanced features. Avoid delaying required cloud course acceptance for local runner or multiagent complexity. D1–D3 may be further decomposed into separate Linear tasks only after D0 review.

## Implementation issue boundaries (proposed)

- **Agent Core:** durable run/job state, typed tool registry, step budgets, SSE replay, Auth/tenant tests; use fake runner until safe runtime available.
- **Cloud Sandbox:** provision only with user-approved cost and isolation review, separate API-host execution, permissions/network/resource tests.
- **Filesystem + Terminal:** owned workspace file tools, command runner, exit-code verification, cancellation, self-correction budgets; no GitHub dependency.
- **Workspace UI:** Manager + run timelines, modes, file tree, terminal logs and error states integrated against reviewed DTOs.
- **Artifacts:** immutable snapshots, ZIP generation, safe download/storage, deletion/retention and crash cleanup.
- **Preview / Browser Agent:** separately audited web-origin, network and screenshot security.
- **Optional integrations:** Git/GitHub (grants, remote action approval), then Skills/MCP and Local Runner.

Each issue = one branch + PR, peer review; don't create fake "Done" states for UX mocks or doc-only capabilities.

## Mandatory proof-of-functionality scenario

Given two signed-in users A and B:
1. A creates blank Workspace, never connects GitHub.
2. A requests a React task manager in Execute mode.
3. Model plans, writes TypeScript/React files into **isolated** sandbox, runs real build/test and automatically repairs a demonstrated error (if any) up to cap.
4. API records tool calls with exit codes, logs and ownership; SSE events are replayable after a disconnected browser.
5. Files and source ZIP are uploaded to durable artifact store with checksums; A can download.
6. B cannot list/read/edit A's run, files, artifact or event stream.
7. A cancels a second run; tool subprocess stops, partial state labeled honestly, no remote side effect occurs.

Fail cases: sandbox unavailable, package network denied, build never passes, step/token limit reached, status race, disk quota, permission escalation prompt injection and owner mismatch. Do not mark completed without actual verification.

## Reviewer questions blocking implementation

- Which provider/hosting supports truly isolated untrusted code and per-user sandbox allocation at a known price?
- Minimum security boundary and egress policy for npm/pip/package lifecycle scripts?
- Limits for run duration/CPU/RAM/outputs and artifact/snapshot retention after end of run?
- Whether client sends mode at run create and whether mode can change mid-run.
- Which proposed routes/DTOs are required for D1 vs later UX features, and which legacy mock endpoints need a compatibility adapter?
- Exact terminal event ordering, follow-up messages and replay-expired semantics.
- What class of external writes may ever be approved and how are idempotent effects reconciled?

## Governance

- Canonical v1 API remains DRAFT under ADR-001; do not freeze at the design stage.
- Original INV-07 continues to forbid arbitrary command execution on Hono/API host; ADR-003 proposes isolated runner semantics subject to review.
- The [Memory/RAG design](../architecture/AI_MEMORY_RAG_V0.1.md) belongs to **GigaChat**; its auto-memory is NOT an implicit source for Agent Runs.
- Follow Giga Git workflow; no auto-merge, no live resource provisioning before explicit cost/security approval.
- Store actual E2E logs, screenshots and costs as sanitized evidence once executed; no unverified claims in the mini-project report.
