# Shared Contracts (planned)

**Purpose:** one authoritative type/schema boundary used by `apps/api` and `apps/web`, preventing parallel agents from independently redefining public API DTOs.

Planned exports after joint review:
- Auth/session, conversation, message and agent-run DTOs.
- Runtime input/output validation schemas when the selected stack supports them.
- Stable API error names and SSE/agent-event envelopes.
- Contract compatibility fixtures and tests.

**Rules:**
1. The **current API contract is DRAFT**: `docs/contracts/API_CONTRACT_V0.1.md`.
2. Freeze exact `/api/v1` behavior only after the recorded contract gate; afterward retain backward compatibility per ADR-001.
3. This package must **not** import UI, backend infrastructure, database ORM internals, cloud SDKs or secrets.
4. Any public change requires review by both backend and frontend owners.

Do not publish an npm package or generate code before the framework/package-management decision is approved.
