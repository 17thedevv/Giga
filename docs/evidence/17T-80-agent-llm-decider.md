# Verification Evidence — Linear 17T-80: Shared LLM Agent Decision Provider

**Date:** 2026-10-28

**Linear task:** [17T-80](https://linear.app/17thedev/issue/17T-80/integrate-real-agent-llm-decision-provider-with-safe-tool-call)

**Branch:** `feat/17t-80-agent-llm-decider`

**Owner:** Trà (Agent / Backend)

**Peer reviewer:** Tráng A Thư (independent code and security review requested)

**Baseline:** `4436fa1560296f7dba20632fb2220bf7b54bb136` (`origin/main`, includes PRs #41, #42 and #44)

**PR title:** `feat(agent): add bounded shared-LLM decision provider`

**Verified implementation commit:** `24193b3f46bff1e7743f459b74dfd08e3e3ec330`

**Draft PR:** [17thedevv/Giga#45](https://github.com/17thedevv/Giga/pull/45)

**Current PR head and checks:** [PR #45](https://github.com/17thedevv/Giga/pull/45), [checks](https://github.com/17thedevv/Giga/pull/45/checks)

This document records the source commit that contains the security fix and payload tests. The evidence synchronization itself is a documentation-only follow-up commit; GitHub's PR page and PR description carry the exact current branch HEAD and its checks.

## Scope and architecture

`LLMBackedAgentDecisionProvider` implements the internal `AgentDecisionProvider` contract on top of the shared `LLMEngine`. Its normalized outcomes are `plan`, `tool_call`, `complete` and `fail`; provider-native fields and unrecognized fields are rejected. The parser rejects duplicate JSON keys, including conflicting decision keys and escaped-equivalent argument keys. The server creates tool-call IDs and assigns controlled failure codes.

`createAgentLLMDecisionProvider` builds an Agent-only allowlisted model alias, `giga-agent-default`, using the existing Gemini adapter, registry and platform credential configuration. It does not resolve or reuse user BYOK credentials. The provider factory is not wired into the public Agent runtime in this change; runtime admission remains `RUNTIME_UNAVAILABLE` while 17T-73 is blocked and Cloud execution stays disabled.

## Decision and tool authorization path

1. The provider verifies that the configured alias supports text and the requested normalized reasoning effort.
2. It bounds request construction and provider time, passes cancellation through the shared engine, and applies bounded provider and malformed-response retries.
3. It accepts only a bounded JSON response matching one exact normalized decision shape. Proposed tool calls are checked against the server registry, strict argument schema, current mode, canonical workspace-relative paths and size/depth/list bounds.
4. The orchestrator revalidates the decision, renews the worker lease before persistence and dispatch, enforces decision and repeated-call limits, and dispatches only the registered tool handler through the execution runtime.

There is no model-selected function lookup, dynamic import, host-shell fallback or provider URL. The `run_command` entry is a fixed registered sandbox tool; no host execution or live Cloud runtime is enabled by this issue.

## Context and prompt-injection boundary

System policy and registered tool descriptions/schemas are sent in a system message. The task, exact-run history, current plan and bounded recent tool observations are serialized separately as user data. Only history whose `runId` matches the current run is included; owner, workspace and run identifiers are not sent as model context. Context overflow prunes old history and observations deterministically, then fails closed if the request still exceeds its byte limit.

Every model-context string uses the shared Agent `sanitizeBoundedModelContext` path. It scans only a UTF-8 prefix up to the field limit before pattern work, reserves room for a truncation marker, applies the shared redaction policy, then enforces the final byte limit. This avoids copying and regex-scanning an arbitrarily large source string. An unmatched PEM `BEGIN ... PRIVATE KEY` marker redacts the remainder of the bounded scan, so an END marker beyond the field limit cannot expose key bytes. Assignment and structured-object redaction share normalized `isSensitiveKey` recognition, including `secretkey`, `accesskey`, `apikey`, token, password, private key, database URL, connection string, credentials and encryption-key suffixes. The provider has no separate weaker secret regex.

Repository text, task text, prior messages and tool results are untrusted data. Tests cover attempts to ignore policy, reveal credentials, change mode/workspace, enable network, expose reasoning or call unauthorized tools. Parsing/sanitization failures return a generic controlled failure and do not log the original context. Gemini thought parts are suppressed by the existing adapter; the normalized Agent schema never exposes raw reasoning.

## Bounds and credentials

- Model output: 16 KiB; context: 32 KiB; system policy and tool registry: 12 KiB.
- Task field: 16 KiB; history message: 4 KiB; tool observation strings: 4 KiB; history count: 12; recent observations: 6.
- Output token limit: at most 1,024; provider timeout: 30 seconds by default and at most 60 seconds.
- Malformed-response retry: 1 by default, at most 2; transient provider retry: 1 maximum.
- Orchestrator decision limit: 60 by default; identical tool calls: 3 by default; existing step limit remains 30.
- Tool arguments have strict per-field sizes, at most 8 levels of nested JSON, bounded arrays and a 300 KiB aggregate ceiling.
- Credentials come only from platform-controlled configuration. Agent BYOK is deferred; no credentials are copied to model context, Agent messages, tool arguments or sandbox environment.

## Regression coverage

Payload-level tests inspect the exact messages captured by the fake shared LLM provider. Separate cases cover task text, conversation history, completed-step results and `lastStepResult` / latest observations. Every case checks unique values for `AWS_SECRET_ACCESS_KEY`, `STRIPE_SECRET_KEY`, `SECRET_KEY`, `GEMINI_API_KEY`, both Agent finalizer database URLs, `E2B_API_KEY`, `GITHUB_TOKEN` and `WORKER_LEASE_TOKEN`; structured objects and JSON strings are covered. An oversized PEM test places the END marker beyond the per-field limit and proves the BEGIN marker and body are absent from the provider payload. The performance regression feeds 250,000 repeated credential fields (about 11.5 MB) and checks completion under two seconds with bounded model context.

The deterministic provider suite also covers all four decisions; malformed, duplicate-key, conflicting, unknown and provider-native outputs; tool schema/additional-field rejection; Ask/Plan restrictions; path traversal and absolute paths; cancellation; timeout and disabled-provider behavior; retry limits; capability/reasoning compatibility; exact-run history; and malicious repository/tool-output instructions. Orchestrator tests cover pre-dispatch cancellation, repeated equivalent calls, plan-only loops, owner isolation and DTO lease-token exclusion.

| Check | Result |
|---|---|
| `npm exec -- tsx --test tests/agent/agent-boundaries.test.ts tests/agent/agent-llm-decision-provider.test.ts tests/agent/agent-orchestrator.test.ts` | PASS — 60 tests, 56 passed, 0 failed, 4 PostgreSQL-only skipped |
| Message regression `30. redactSensitiveContent` | PASS — 1 passed |
| Message regression `31. JSON credential leakage prevention` | PASS — 1 passed |
| Message regression `32. generic opaque tokens and custom header keys` | PASS — 1 passed |
| Sandbox regression `sanitizeSandboxOutput redacts` | PASS — 1 passed |
| `npm run typecheck` (from `apps/api`) | PASS |
| `npm run build` (from `apps/api`) | PASS |
| `node .agents/scripts/validate-skills.mjs` | PASS |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | PASS — 6 passed |
| `node .agents/scripts/validate-git-workflow.mjs` with PR metadata and exact base/head SHAs | PASS |
| `git diff --check` | PASS |
| `npm run test` (from `apps/api`) | FAIL locally — 613 total, 564 passed, 18 failed, 31 skipped. All 18 failures are in the existing 17T-71 sandbox-session lifecycle tests because `pg-mem` lacks PostgreSQL functions `settle_agent_sandbox_allocation` and `claim_agent_sandbox_cleanup`. All Agent message/redaction tests pass. |

The local environment has no `TEST_DATABASE_URL`, `psql`, PostgreSQL server binaries or Docker. PostgreSQL-only tests therefore could not be run locally. Backend CI provisions PostgreSQL 16 and runs the complete API suite.

## Exact-head CI

**Source commit:** `24193b3f46bff1e7743f459b74dfd08e3e3ec330`

- Git Workflow: [run 40696560568](https://github.com/17thedevv/Giga/actions/runs/40696560568/job/122844774669) — passed on the exact source commit.
- Backend CI with PostgreSQL 16: [run 40696560435](https://github.com/17thedevv/Giga/actions/runs/40696560435/job/122844773828) — passed on the exact source commit.

## Contract, database and Cloud impact

- No public API, DTO, event, authentication or persistence contract changes; API v0.2 remains DRAFT.
- No database migration, frontend change, new dependency or Chat BYOK behavior change.
- No live Gemini request, E2B call, Cloud provisioning, deployment or runtime enablement.
- **Passing LLM/tool-boundary tests does not prove Cloud sandbox isolation.**

## Handoff and remaining gates

The Draft PR is linked to 17T-80. A formal GitHub review request for the assigned peer reviewer was attempted; GitHub rejected it with HTTP 422 because the account is not a repository collaborator. No independent human review is claimed; reviewer access/request remains open. No merge or deployment is authorized by this evidence.
