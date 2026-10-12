# ADR-001 — API Contract Stability and Versioning

- **Status:** ACCEPTED AS POLICY; API v1 routes and payloads are **NOT YET FROZEN**.
- **Date:** 2026-10-12.
- **Context:** Giga frontend and backend are developed in parallel. Uncoordinated API changes would cause integration failures and jeopardize the Cloud demo.
- **Related:** [Draft API Contract](../contracts/API_CONTRACT_V0.1.md), [Architecture Invariants](../architecture/INVARIANTS_V0.1.md), [Linear 17T-8](https://linear.app/17thedev/issue/17T-8/w1-api-contract-va-database-design-v01).

## Decision

**Once API v1 is reviewed and frozen, it must remain backward compatible for supported clients.** A rule of literal zero change is rejected because additive capabilities, security fixes and new requirements may need a safe evolution path.

### Guarantees after the freeze

1. Every current v1 endpoint keeps its HTTP method, path and declared behavior.
2. Existing request/response field names, types, nullability and requiredness remain compatible. Never make optional inputs newly required.
3. HTTP status and stable application error code semantics remain compatible.
4. Auth/session security boundaries may be tightened for safety only through a documented rollout with tests and client impact review; no silent contract break.
5. SSE frame/event names and payload meaning stay stable; do not change event ordering or terminal behavior unexpectedly. Client resilience to unknown non-critical events must be tested before introducing any.
6. Adding new methods/routes/optional fields is permitted only if proven safe for existing clients and documented in the same PR.
7. Breaking changes require a new API major version (`/api/v2`), migration plan and explicit notice; never mutate the old v1 endpoint semantics in place.

### Implementation and governance

- Shared TS DTO/schema definitions in `packages/contracts` (planned); backend validates inputs; frontend uses the approved typed contract.
- Contract tests and snapshots run on CI, with a fixture suite for normal/error/stream/authorization flows.
- Both developers review the proposed endpoints during W1 and record unresolved questions. Final `API v1.0 — FROZEN` status is granted only after deployed W2 browser authentication/SSE tests and the compatibility fixture suite pass. Code reviews check every protocol change.
- First approved contract commit will be recorded in an API changelog; until then the current document remains explicitly **DRAFT**.

## Consequences

- **Positive:** parallel implementation, reliable cloud demos, stable client integration, auditable changes.
- **Cost:** contract design and test work are required upfront; planned migrations may need a compatibility layer.
- **Exceptions:** no unilateral waiver. Emergency security fixes still require documented impact/rollback; don't keep a vulnerability open purely for API compatibility.

## Alternatives considered

- **Never change any API in any way:** rejected; blocks bug fixes and harmless additions, and can prevent security remediation.
- **Change freely until deployment:** rejected; makes frontend/backend integration unpredictable.

## Acceptance (not yet complete)

- [ ] Backend review complete.
- [ ] Frontend review complete.
- [ ] SSE/auth/CORS behavior tested in a real deployed browser.
- [ ] Contract fixtures and CI compatibility checks pass.
- [ ] Concrete API v1 routes/types marked FROZEN with a recorded commit.
