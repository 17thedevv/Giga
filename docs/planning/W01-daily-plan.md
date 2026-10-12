# Giga — Daily Execution Plan / Week 01

> **Period:** 12–18 Oct 2026 · **Status:** Proposed schedule, not instructor deadline · **Owner:** Trà + Thư.
> Canonical overview: [Project Plan v0.1](../01-project-plan-v0.1.md). API draft: [Contract v0.1](../contracts/API_CONTRACT_V0.1.md). Execution tracking: [Linear project](https://linear.app/17thedev/project/giga-cloud-mini-project-0656a578ee3b).

## Working rules

- Each day, independently record completion in linked Linear issues. This document defines *planned outcomes*, not completion evidence.
- Trà owns backend/agent; Thư owns frontend/UX. Cloud ownership is split and checked by the other person.
- A task is done only if its acceptance condition is reproducible and there is a GitHub PR/docs link or cloud screenshot/log with credentials removed.
- If a due date is missed, update the Linear issue and mark the blocker. Dates are internal targets and adjustable.
- Thư must be invited to Linear before direct assignment; until then descriptions identify intended owner.

## Daily plan

### Monday 12/10 — Baseline & setup

**Trà:** review v0.1 scope, prepare GitHub documentation PR, establish Linear board, draft contract outline and repo boundaries. [17T-7](https://linear.app/17thedev/issue/17T-7/w1-phan-tich-yeu-cau-use-cases-va-kien-truc-tong-the), [17T-8](https://linear.app/17thedev/issue/17T-8/w1-api-contract-va-database-design-v01).

**Thư:** read project plan, identify UX states for Chat/Agent, gather questions about screens and API requests. [17T-9](https://linear.app/17thedev/issue/17T-9/w1-ux-flows-wireframes-va-api-mocks).

**Shared/cloud:** agree on GitHub + Linear conventions; invite Thư to Linear; neither creates billable cloud resources without examining terms.

**Exit:** docs PR is available; issues have intended owners; open questions captured. *Not an assertion this day is complete.*

### Tuesday 13/10 — Requirements, user flows, cloud requirements

**Trà:** document actors, input/output, business rules, use cases, security constraints; define chat/agent components and data ownership. [17T-7](https://linear.app/17thedev/issue/17T-7/w1-phan-tich-yeu-cau-use-cases-va-kien-truc-tong-the).

**Thư:** user journey, wireframes for Login, Chat, History, Agent task/timeline/diff approval; include loading, unauthorized, error and empty states. [17T-9](https://linear.app/17thedev/issue/17T-9/w1-ux-flows-wireframes-va-api-mocks).

**Shared/cloud:** define public URLs/environment separation, HTTPS, database durability and minimum metrics for report.

**Exit:** initial requirements + UX flows reviewed with open questions listed.

### Wednesday 14/10 — API/DB contracts and mocks

**Trà:** refine auth, conversation, chat SSE and agent run/approval contract; draft database ERD and entity relations; reconcile open security questions. [17T-8](https://linear.app/17thedev/issue/17T-8/w1-api-contract-va-database-design-v01).

**Thư:** create mock request/response fixtures from contract, review usability of SSE/events and errors; finalize primary screen wireframes. [17T-9](https://linear.app/17thedev/issue/17T-9/w1-ux-flows-wireframes-va-api-mocks).

**Shared/cloud:** compare Render/Neon with alternatives, identify quota, payment-card requirement, idle/sleep behavior and database connection restrictions.

**Exit:** reviewed first-pass contract and mock mapping; unresolved questions assigned an owner.

### Thursday 15/10 — TS scaffolding & integration boundaries

**Trà:** scaffold `apps/api`, validation/config, health endpoint and test/build scripts; draft migrations from reviewed schema. [17T-10](https://linear.app/17thedev/issue/17T-10/w1-backend-typescript-scaffold-va-health-endpoint).

**Thư:** scaffold `apps/web`, route/layout shells, mock API client, Chat/Agent visible states; responsive baseline. [17T-11](https://linear.app/17thedev/issue/17T-11/w1-frontend-typescript-scaffold-va-ui-shell).

**Shared/cloud:** choose reviewed stack/vendor and minimal server environment variables; no secrets in Git.

**Exit:** both apps build locally and can consume shared interfaces/mocks; contract change requests documented.

### Friday 16/10 — Cloud preflight & build verification

**Trà:** document Node web-service build/start, Docker option, config checks, `/health`, CI/CD trigger and log access. [17T-12](https://linear.app/17thedev/issue/17T-12/w1-public-cloud-preflight-api-deployment).

**Thư:** document static-site build/deploy, SPA routing, environment variables, managed DB provisioning, CORS/cookies feasibility. [17T-13](https://linear.app/17thedev/issue/17T-13/w1-public-cloud-preflight-frontend-managed-db).

**Shared/cloud:** validate live tier limits, billing warnings and expected usage. Confirm tool permissions, least-privilege rules and staging plan.

**Exit:** test deployment runbooks with rollback and redaction checklist; local build/tests pass.

### Saturday 17/10 — First live cloud deployment

**Trà:** deploy API hello-world/health on agreed cloud, verify HTTPS, timestamps, logs and redeploy by commit. [17T-12](https://linear.app/17thedev/issue/17T-12/w1-public-cloud-preflight-api-deployment).

**Thư:** deploy web shell with public HTTPS; provision test PostgreSQL if the free plan has been validated; document connection setup without exposing credentials. [17T-13](https://linear.app/17thedev/issue/17T-13/w1-public-cloud-preflight-frontend-managed-db).

**Shared/cloud:** verify web→API connectivity and browser behavior; capture screenshots, public URLs and dashboard usage metrics.

**Exit:** two public test URLs and sanitized step-by-step evidence, or explicit blocker plus mitigation.

### Sunday 18/10 — Cross-training & W1 approval gate

**Trà:** redo frontend deploy or troubleshoot web cloud misconfiguration; review UX/API integration.

**Thư:** redo API deployment or troubleshoot health/log issues; review backend cloud topology.

**Together:** 45–60 minute role-swap practice; check all W1 criteria; record PASS/FAIL and replan if blocked. [17T-14](https://linear.app/17thedev/issue/17T-14/w1-cross-training-and-architecture-stage-gate).

**Exit gate:** architecture and API contract signed off; frontend+backend test endpoints public over HTTPS; deployment evidence and cross-training record completed.

## Planned Linear issue due dates

| Issue | Intended owner | Internal target |
|---|---|---|
| [17T-7](https://linear.app/17thedev/issue/17T-7/w1-phan-tich-yeu-cau-use-cases-va-kien-truc-tong-the) Requirements + architecture | Trà | 14/10 |
| [17T-8](https://linear.app/17thedev/issue/17T-8/w1-api-contract-va-database-design-v01) API contract + DB design | Trà | 15/10 |
| [17T-9](https://linear.app/17thedev/issue/17T-9/w1-ux-flows-wireframes-va-api-mocks) UX + API mocks | Thư | 14/10 |
| [17T-10](https://linear.app/17thedev/issue/17T-10/w1-backend-typescript-scaffold-va-health-endpoint) Backend scaffold | Trà | 16/10 |
| [17T-11](https://linear.app/17thedev/issue/17T-11/w1-frontend-typescript-scaffold-va-ui-shell) Frontend scaffold | Thư | 16/10 |
| [17T-12](https://linear.app/17thedev/issue/17T-12/w1-public-cloud-preflight-api-deployment) API cloud preflight | Trà | 17/10 |
| [17T-13](https://linear.app/17thedev/issue/17T-13/w1-public-cloud-preflight-frontend-managed-db) Frontend + DB cloud | Thư | 17/10 |
| [17T-14](https://linear.app/17thedev/issue/17T-14/w1-cross-training-and-architecture-stage-gate) Review + cross-training | Both | 18/10 |

## Shared development-agent onboarding (added 12/10)

- Read `AGENTS.md` and [the shared skills handbook](../../.agents/README.md); both developers must use the same checked-out Git revision.
- Run `node .agents/scripts/validate-skills.mjs` and record the result; run one contract-change scenario and one cloud handoff scenario in each developer's chosen agent.
- Review whether the agent selects appropriate skills without unnecessary context loading; log mismatches before declaring the pack adopted.
- Track skill-pack adoption in [Linear 17T-15](https://linear.app/17thedev/issue/17T-15/w1-review-and-adopt-shared-development-agent-skills-v01) (internal target 15/10).

## W1 evidence minimum

- Link to signed-off architecture and the contract with resolved/open questions.
- A screenshot or short video of each public HTTP(S) service; `curl` evidence for `/health` and a browser screenshot of frontend.
- A safe screenshot of relevant cloud dashboard settings and logs (secrets obscured).
- One peer review/role-swap record for each person, noting operator, reviewer, environment and result.
- Link each artifact in its Linear issue; do not add sensitive tokens, database URLs or payment details.

## W2–W4 daily planning policy

Work for future weeks remains at the *weekly* resolution in the v0.1 baseline. On each Sunday gate, create the next week’s daily plan based on actual results and blockers instead of fabricating fixed daily commitments four weeks ahead.