---
name: giga-frontend
description: Implements and reviews Giga React/Vite TypeScript UI and frontend API integration. Use for Chat, Agent workspace, login, history, SSE rendering, diff approval, responsive design and frontend tests.
---

# Frontend implementation workflow

**Ownership:** frontend/UX primary belongs to Thư; Trà reviews integration and performs cloud role-swap. A screen is not complete if critical states are missing.

## Before coding
1. Inspect actual `apps/web` structure, dependencies, UI identity and existing components. Do not assume a framework has been scaffolded.
2. Read the assigned Linear issue, `docs/contracts/API_CONTRACT_V0.1.md` and architecture invariants. The contract is DRAFT until signed off.
3. Identify states: loading, empty, partial streaming, success, error, authentication expiry, permission failure, cancellation, slow cloud cold-start and keyboard access.
4. If a new response field/route/event is needed, propose a contract change and invoke `giga-contract-guardian`; do not silently invent backend behavior.

## Build experience
- Use TypeScript strict and typed API client through `packages/contracts` once available. API clients must not import database entities or private backend modules.
- Develop UI against approved mock fixtures where live API is unfinished; mark mocks explicitly and replace with actual API before the W2 integration gate.
- Stream Chat text progressively using `fetch`/SSE parser for POST; avoid race conditions on rapid submits, aborts or navigating away.
- Agent UI must clearly distinguish **analysis**, **proposed diff**, **awaiting approval**, **applying**, **completed**, and **failed**. Never show a GitHub change as applied before server confirmation.
- Show file-level unified diff and clear approve/reject actions with confirmation. Handle stale proposal/conflict/errors and double-submit gracefully.
- Use consistent spacing, hierarchy, responsive layouts, hover/pressed/focus behavior, semantic markup and keyboard-operable controls. Do not add an unrequested visual framework or unrelated redesign.
- Browser code must not contain server tokens, model keys or GitHub write credentials.

## Testing and review
- Test basic flow, form errors, streaming chunk boundaries, unauthorized/expired sessions, run events, approval UX, keyboard/focus and mobile layout.
- Test actual deployed browser CORS/cookie/CSRF and API connection with backend owner.
- Provide screenshots for meaningful UI states plus build/typecheck/test result; list any mocked/incomplete integrations.

**Related:** `giga-contract-guardian`, `giga-verification`, `giga-task-handoff`.
