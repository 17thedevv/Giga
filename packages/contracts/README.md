# Shared Contracts (DRAFT)

`agent.d.ts` is the shared public Workspace/Run/Message and capability type boundary.
`agent.js` provides dependency-free runtime response schemas and a fail-closed capability
reader. API types re-export these DTOs; the web `agent-contract.ts` boundary re-exports
the same definitions without changing its historical GitHub demo types. Fixtures in
`fixtures/agent.json` are checked against real API output and the web consumer.

This private source module is not published or generated. Keep `packages/contracts`
beside `apps` when running the API from source or `apps/api/dist`: both use the same
relative imports. Shared changes trigger both backend and frontend CI.

Server requests remain strictly validated in `apps/api/src/modules/agent/validation.ts`.
Response schemas validate required known fields, project public fields and accept
unknown additive fields. `agentCapabilitiesSchema` requires complete coherent metadata;
`readAgentCapabilities` disables missing, malformed or unknown features. Neither grants
server-side authority. Contract remains NOT FROZEN pending Trà/Thư review and browser checks.

**Purpose:** one authoritative type/schema boundary used by `apps/api` and `apps/web`, preventing parallel agents from independently redefining public API DTOs.

Other planned exports after joint review:
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
