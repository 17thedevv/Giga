# Giga Web (planned)

**Purpose:** browser UI for Giga AI Chat, conversations and Coding Agent task/progress/diff approvals.

This is a **directory scaffold**, not a running app. React/Vite are candidate choices pending the W1 architecture gate.

## Suggested boundaries

- `src/app/`: app entry and routing.
- `src/features/auth/`: login and session UX.
- `src/features/chat/`: conversations, streaming messages and history.
- `src/features/agent/`: coding tasks, event timeline, diff and approval.
- `src/components/`: shared presentation components.
- `src/lib/`: typed API client, SSE helpers and browser utilities.
- `public/`: static assets.
- `tests/`: component and browser-facing tests.

The frontend must consume **approved shared contracts**, not directly import backend internals or database entities. Backend remains responsible for authorization and validation.

Include loading, empty, error, denied, streaming interrupted and successful states. Never place LLM or GitHub write tokens in browser code.
