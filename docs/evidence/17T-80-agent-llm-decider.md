# Verification Evidence — Linear 17T-80: Shared LLM Agent Decision Provider

**Date:** 2026-10-28

**Linear task:** [17T-80](https://linear.app/17thedev/issue/17T-80/integrate-real-agent-llm-decision-provider-with-safe-tool-call)

**Branch:** `feat/17t-80-agent-llm-decider`

**Owner:** Trà (Agent / Backend)

**Peer reviewer:** Tráng A Thư (independent code and security review requested)

**Baseline:** `4436fa1560296f7dba20632fb2220bf7b54bb136` (`origin/main`, includes PRs #41, #42 and #44)

**PR title:** `feat(agent): add bounded shared-LLM decision provider`

**Tested source commit:** `c4629bc122f673e8b2870e722c093f737f826899`
**PR / CI:** pending publication

## Scope and architecture

`LLMBackedAgentDecisionProvider` implements the internal `AgentDecisionProvider` contract on top of the shared `LLMEngine`. Its normalized outcomes are `plan`, `tool_call`, `complete` and `fail`; provider-native fields and unrecognized fields are rejected. The parser also rejects duplicate JSON keys, including conflicting decision keys and escaped-equivalent argument keys. The server creates tool-call IDs and assigns controlled failure codes.

`createAgentLLMDecisionProvider` builds an Agent-only allowlisted model alias, `giga-agent-default`, using the existing Gemini adapter, registry, and platform credential configuration. It does not resolve or reuse user BYOK credentials. This provider factory is not wired into the public Agent runtime in this change; runtime admission remains `RUNTIME_UNAVAILABLE` while 17T-73 is blocked and Cloud execution stays disabled.

## Decision and tool authorization path

1. The provider verifies that the configured alias supports text and the requested normalized reasoning effort.
2. It bounds request construction and provider time, passes cancellation through the shared engine, and applies bounded provider and malformed-response retries.
3. It accepts only a bounded JSON response matching one exact normalized decision shape. A proposed tool call is checked against the server registry, strict argument schema, current mode, canonical workspace-relative paths, and size/depth/list bounds.
4. The orchestrator revalidates the decision, renews the worker lease before persistence and dispatch, enforces decision and repeated-call limits, and dispatches only the registered tool handler through the execution runtime.

There is no model-selected function lookup, dynamic import, host-shell fallback, or provider URL. The `run_command` entry is a fixed registered sandbox tool; no host execution or live Cloud runtime is enabled by this issue.

## Context and prompt-injection boundary

System policy and registered tool descriptions/schemas are sent in a system message. The task, exact-run history, current plan and bounded recent tool observations are serialized separately as user data. Only history whose `runId` matches the current run is included; owner, workspace and run identifiers are not sent as model context. Context overflow prunes old history and observations deterministically, then fails closed if the request still exceeds its byte limit.

Repository text, task text, prior messages and tool results are treated as untrusted data. Tests cover instructions to ignore policy, reveal credentials, change mode/workspace, enable network, expose reasoning, or call unauthorized tools. Secret-looking assignments, credential keys and known token forms are redacted before context construction. Gemini thought parts are suppressed by the existing adapter; the normalized Agent schema never exposes raw reasoning.

## Bounds and credentials

- Model output: 16 KiB; context: 32 KiB; system policy and tool registry: 12 KiB.
- Output token limit: at most 1,024; provider timeout: 30 seconds by default and at most 60 seconds.
- Malformed-response retry: 1 by default, at most 2; transient provider retry: 1 maximum.
- Orchestrator decision limit: 60 by default; identical tool calls: 3 by default; existing step limit remains 30.
- Tool arguments have strict per-field sizes, at most 8 levels of nested JSON, bounded arrays and a 300 KiB aggregate ceiling.
- Credentials come only from platform-controlled configuration. Agent BYOK is deferred; no credentials are copied to model context, Agent messages, tool arguments or sandbox environment.

## Regression coverage

The deterministic provider suite covers all four decisions; malformed, duplicate-key, conflicting, unknown and provider-native outputs; unknown tools; schema and additional-field rejection; Ask/Plan restrictions; path traversal and absolute paths; argument and context bounds; cancellation; timeout and disabled-provider behavior; retry limits; capability and reasoning compatibility; exact-run history; secret redaction; and malicious repository/tool-output instructions. Orchestrator tests cover deterministic fake-runtime regressions, pre-dispatch cancellation, repeated equivalent calls, plan-only loops, and owner isolation. Existing Agent message tests cover cross-owner message/history isolation.

| Check | Result |
|---|---|
| `npm exec -- tsx --test tests/agent/agent-boundaries.test.ts tests/agent/agent-llm-decision-provider.test.ts tests/agent/agent-orchestrator.test.ts` | PASS — 49 passed, 4 skipped (PostgreSQL-only boundary cases) |
| `npm exec -- tsx --test --test-name-pattern="30. redactSensitiveContent" tests/agent/agent-messages.test.ts` | PASS — 1 passed |
| `npm run typecheck` (from `apps/api`) | PASS |
| `npm run build` (from `apps/api`) | PASS |
| `node .agents/scripts/validate-skills.mjs` | PASS |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | PASS — 6 passed |
| `git diff --check` | PASS |
| `npm run test` (from `apps/api`) | FAIL — 606 total, 557 passed, 18 failed, 31 skipped. All 18 failures are in the existing 17T-71 sandbox-session lifecycle tests; `pg-mem` does not implement the PostgreSQL functions `settle_agent_sandbox_allocation` and `claim_agent_sandbox_cleanup`. The two patch-related failures discovered in an earlier run (boundary import assertion and redaction ordering) were fixed and pass in focused checks. |

Before edits, the baseline focused command at `4436fa1560296f7dba20632fb2220bf7b54bb136` was `npm exec -- tsx --test --test-concurrency=1 tests/agent/agent-orchestrator.test.ts tests/agent/agent-messages.test.ts tests/llm/llm-engine.test.ts tests/llm/model-reasoning.test.ts tests/llm/gemini-provider.test.ts` from `apps/api`: 134 passed, 0 failed, 1 PostgreSQL-only test skipped.

The local environment has no `TEST_DATABASE_URL`, `psql`, PostgreSQL server binaries or Docker. PostgreSQL-only tests therefore could not be run locally. The repository's API CI workflow provisions PostgreSQL 16 and runs the complete API suite; final CI status for the PR head is pending.

## Contract, database and Cloud impact

- No public API, DTO, event, authentication or persistence contract changes; API v0.2 remains DRAFT.
- No database migration, frontend change, new dependency or Chat BYOK behavior change.
- No live Gemini request, E2B call, Cloud provisioning, deployment or runtime enablement.
- **Passing LLM/tool-boundary tests does not prove Cloud sandbox isolation.**

## Handoff and remaining gates

The code is prepared for a Draft PR linked to 17T-80. The tested source SHA, final PR head SHA, PR link and exact-head GitHub Actions checks will be added after branch publication. Independent reviewer approval and PostgreSQL CI remain open gates. No merge or deployment is authorized by this evidence.
