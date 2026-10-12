# Giga API (planned)

**Purpose:** Giga's authenticated TypeScript backend for conversations, streaming AI Chat, coding-agent orchestration, persistence and cloud health/operations.

This is a **directory scaffold**, not a running service. Node.js/Hono remain candidate implementations until the W1 architecture gate.

## Suggested boundaries

- `src/app/`: application bootstrap, middleware, HTTP entry points.
- `src/modules/auth/`: authentication/session logic and account policy.
- `src/modules/conversations/`: conversation and message operations.
- `src/modules/agent/`: bounded agent run lifecycle and approvals.
- `src/integrations/llm/`: remote model/provider adapters.
- `src/integrations/github/`: GitHub API tools with least-privilege access.
- `src/db/`: persistence adapter and future reviewed migrations.
- `tests/`: API, service, integration and authorization tests.

**Contract:** Only expose approved DTOs/events from `packages/contracts`. Treat `docs/contracts/API_CONTRACT_V0.1.md` as a **draft** until the joint contract freeze gate.

**Security:** Never expose provider tokens to frontend or perform arbitrary agent-generated shell commands in the API process.
