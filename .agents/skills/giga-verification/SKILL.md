---
name: giga-verification
description: Verifies Giga changes with TypeScript checks, contract fixtures, frontend/API integration, agent security scenarios and public-cloud evidence. Use before completing any implementation or deployment task or reviewing a PR.
---

# Verification and regression gate

Use this skill **after implementation and before claiming success**. Its output must distinguish executed checks from proposals and unavailable infrastructure.

## Inspection
1. Determine actual changed files and behavior; identify applicable constraints from `AGENTS.md`, contract, invariants and the issue's acceptance criteria.
2. Discover real build/test scripts before running commands; do not invent a `pnpm test` or pretend a runner exists.
3. Run the smallest meaningful focused tests first, then full project checks when available and allowed. Record command, environment, exit code and relevant result.

## Default matrix
| Surface | Minimum meaningful verification |
|---|---|
| TypeScript build | Formatter/lint, `tsc --noEmit` or equivalent, build, focused tests |
| Shared API | Success/error DTO fixtures, route statuses, compatibility with existing clients, auth/CSRF |
| Chat streaming | Incremental chunks, terminal/error events, network abort, refresh persistence, session expiration |
| Frontend | Rendered states, keyboard/focus, responsive layout, mock-to-real API parity, browser/network failure |
| Agent | Invalid tool, repo prompt injection, wrong-owner approval, stale proposal, duplicate apply, quota/cancel, GitHub partial failure |
| Database | Migration forward path, no destructive default, persistence on restart, access boundaries |
| Cloud | Public HTTPS, health, deploy SHA, logs, quota/cost, rollback/redeploy, peer role-swap |

## Behavioral consistency
- Treat regressions in API v1 as blocking after freeze. If contract remains DRAFT, flag unreviewed changes rather than marking frozen compatibility as passed.
- Treat claims such as 'it compiles', 'tests pass', 'the database works' and 'deployed to cloud' as requiring direct evidence.
- For deployed endpoint tests, only use existing approved environments and credentials. No unsolicited billable provisioning or destructive tests.
- Sanitized screenshots, logs and HTTP traces belong in evidence docs, with links from Linear issue.

## Report format
Return a compact test summary with these fields:

```text
Scope:
Environment / commit:
Checks executed: [command or browser action => PASS/FAIL]
Checks not executed: [why]
Contract/security impact:
Remaining risks / blockers:
Evidence links:
```

Never hide failures behind generic `all good`. Do not claim PASS if a dependency was unavailable or the validation was only reasoned about.
