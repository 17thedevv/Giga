# Giga — Architecture Invariants v0.1

> **Policy baseline: 2026-10-12.** Invariants describe rules the implementation must not silently violate. They do **not** claim that the current draft API schemas, framework choices, or cloud vendors are finalized. See [Project Plan](../01-project-plan-v0.1.md) and [ADR-001 API Stability](../decisions/ADR-001-api-compatibility.md).

## 1. Decision categories

- **Locked policy:** breaking it requires an explicit new ADR, peer review, and a planned transition. Changes cannot be made ad hoc in implementation PRs.
- **Pending design gate:** not yet frozen; select jointly during W1 with tests and rationale.
- **Replaceable implementation:** allowed to evolve within locked interfaces, constraints and operational acceptance criteria.

## 2. Locked policies

| ID | Invariant | Enforced by |
|---|---|---|
| INV-01 | TypeScript is the main language for Giga web and backend in v0.1. | TypeScript strict mode, typecheck in CI |
| INV-02 | GitHub is canonical for code/specs/ADRs/runbooks; Linear tracks execution and links to GitHub. The product README only describes Giga, not team/course administration. | PR review, `docs/` structure |
| INV-03 | The supported `/api/v1` contract becomes **backward-compatible-only after sign-off**, with no silent breaking changes; incompatible changes require versioned migration (`/api/v2`). | Contract fixture tests, typed contracts, PR checks; [ADR-001](../decisions/ADR-001-api-compatibility.md) |
| INV-04 | Backend owns business rules and validation. Frontend communicates only via the documented API/shared DTO contract; it cannot depend directly on DB schemas. | Architecture review, typed client, integration tests |
| INV-05 | Production state persists in managed durable storage; data schema changes use reviewed, forward migrations. Never rely on ephemeral host disk for persistent state. | Migration review, persistence restart tests |
| INV-06 | No LLM provider or GitHub secret may be exposed to browser, committed to repository, or printed into public logs. | Server env, secret scanning, test reviews |
| INV-07 | Remote code writes require exact authenticated approval of a reviewed proposal/diff. No arbitrary agent-generated shell/terminal execution on the API host in v0.1. | Approval/state tests, tool permission allowlist |
| INV-08 | Public deployment uses HTTPS, restricted origins, authenticated protected routes, health checks and actionable non-sensitive logs. | Cloud preflight, deployed security/E2E tests |
| INV-09 | All significant architecture/API changes require a documented PR and review. Cloud changes require reproducible evidence, with at least one cross-training rehearsal. | GitHub PR + Linear acceptance checklist |

## 3. Pending decisions — must be closed before API freeze

- Exact endpoint names, request/response JSON shapes, required versus optional fields, error codes and auth/session cookie behavior.
- SSE event names, sequence, termination/error rules, event replay, compatibility strategy for unknown events.
- Database entity/schema details, query contracts, migrations and retention rules.
- Final frontend/backend framework, ORM, LLM provider(s), managed PostgreSQL and cloud vendor(s). These are replaceable implementations as long as the frozen contract and cloud acceptance gates hold.
- Agent status enum, idempotency keys, failure recovery, approval expiry, GitHub permissions and rollback semantics.

## 4. API freeze checklist

1. **Contract review:** backend owner confirms routes, states, validation and security; frontend owner confirms every user flow/error/stream case.
2. **Canonical spec:** `/api/v1` paths, method, status codes, DTOs, optionality, JSON naming, SSE event schemas and auth behavior are documented and reviewed. Generate typed schemas from one agreed source or maintain a single shared contracts package.
3. **Contract tests:** fixtures for normal/error/edge cases, positive + negative authorization, streamed event parsing and frontend compatibility must pass in CI.
4. **Browser integration:** session/cookie/CORS/CSRF behavior must be verified on the actual public cloud topology (same-origin proxy versus cross-site endpoints).
5. **Baseline tag:** publish the approved commit and record it as `API v1.0 — FROZEN` in a new ADR/change-log entry and relevant Linear task. Until then, existing `API_CONTRACT_V0.1.md` remains **DRAFT**.
6. **After freeze:** no renaming/removing endpoints or properties, changing required/optional status, status semantics, error/event types, security semantics or enum behavior without a compatible migration or `/api/v2`.

## 5. Allowed evolution after freeze

- Add a new endpoint without changing old endpoints.
- Add an optional request field that old clients may omit; defaults preserve old behavior.
- Add an optional response field only if clients have explicitly been tested to tolerate unknown response fields.
- Introduce internally different frameworks, LLM providers, SQL implementation or cloud vendors without altering client-observable protocol, security behavior or persistence semantics.
- Change database internals via safe migrations while preserving all existing API behavior.

**Danger:** adding a new enum value, event type, validation rule, auth requirement or changing an error code can be a breaking change even if JSON shape appears the same. Unknown events must have a documented handling policy and be tested; existing mandatory event sequences remain stable.

## 6. Change protocol

1. Create a Linear issue recording user impact, compatibility class (`non-breaking`/`breaking`), rollback and migration plan.
2. Submit PR updating canonical API spec and/or ADR, shared DTOs, contract fixtures, and implementation. Request review by both team members.
3. If breaking and supported clients cannot be migrated safely, create `/api/v2` while v1 remains operational for its documented support interval; never silently repurpose a v1 endpoint.
4. Roll back any deployment that fails v1 compatibility tests; record cloud evidence.

**Tracking:** [Linear W1 contract review](https://linear.app/17thedev/issue/17T-8/w1-api-contract-va-database-design-v01) · [Giga Linear Project](https://linear.app/17thedev/project/giga-cloud-mini-project-0656a578ee3b).