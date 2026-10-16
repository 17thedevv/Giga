# 17T-45 — GigaAgent durable orchestrator and deterministic fake execution runtime verification and handoff

Date: 2026-10-16. Base: `d84d596` (inspected current `origin/main` before implementation).
Issue: [17T-45](https://linear.app/17thedev/issue/17T-45/implement-gigaagent-durable-orchestrator-and-deterministic-fake).
Branch: `feat/17t-45-durable-orchestrator-fake-runtime`.
Linear assignee: `17thedev`; reviewer: Thư.
Independent ChatGPT review requested by the user remains pending. No approval is claimed.

## Delivered scope / changed areas

- `apps/api/src/db/migrations/012_agent_orchestrator.sql` and the matching migration
  registry entry add forward-only schema extensions. Migration 011 and existing product tables are unchanged.
- `agent_run_steps`: composite primary key `(run_id, step_number)`, owner/run composite foreign key
  with `ON DELETE CASCADE`, unique `(run_id, tool_call_id)`, monotonic step numbering check, risk class
  enum (`read`, `sandbox_write`, `sandbox_execute`), status (`running`, `completed`, `failed`), arguments/result
  JSONB, duration, timestamps, and error consistency. PL/pgSQL triggers enforce monotonic step sequence,
  immutability of committed steps, and direct delete rejection.
- `agent_runs` extension: worker lease columns (`worker_id`, `lease_token`, `lease_expires_at`, `attempt_count`),
  `verified_checks` JSONB, `result_summary` TEXT, queue index `(status, lease_expires_at)`, and expanded
  error code CHECK constraint.
- `agent_run_events` extension: `payload JSONB` column and expanded event types (`run.status`, `plan.updated`,
  `tool.started`, `tool.completed`, `tool.failed`, `run.completed`, `run.failed`) with trigger-enforced
  status/error consistency.
- `apps/api/src/modules/agent/tool-registry.ts`: Typed Tool Registry with risk classes (`read`, `sandbox_write`,
  `sandbox_execute`), Ask/Plan/Execute mode policy checks (Ask denies write/execute; Plan allows read-only; Execute
  allows sandbox writes/execution), path traversal checks (`isSafeRelativePath`), and default tools (`list_files`,
  `read_file`, `write_file`, `edit_file`, `run_build`, `run_tests`).
- `apps/api/src/modules/agent/execution-runtime.ts`: Updated `ExecutionRuntime` port; preserved `UnavailableExecutionRuntime`
  as default; implemented `DeterministicFakeExecutionRuntime` (100% in-memory filesystem with `Map<string, string>`,
  deterministic fake build/tests, abort signal support, verified check tracking).
- `apps/api/src/modules/agent/decision-provider.ts`: Implemented `AgentDecisionProvider` and `DeterministicDecisionProvider`
  supporting all required test fixtures (`one-step-success`, `multi-step-success`, `unknown-tool`, `malformed-args`,
  `tool-failure-repair`, `permanent-failure`, `step-limit`, `unverified-completion`).
- `apps/api/src/modules/agent/repository.ts`: Added `enqueueRun`, `claimRun` (atomic lease token generation),
  `appendPlanUpdatedEvent`, `recordStepStarted`, `recordStepCompleted`, `recordStepFailed`, `finalizeRun`,
  `releaseLease`, `renewLease`, `listSteps`, and updated `events()` with backward-compatible fallback for 011 rows.
- `apps/api/src/modules/agent/orchestrator.ts`: Implemented provider-agnostic `AgentOrchestrator` execution loop
  ensuring lease fencing, pre-dispatch validation, execution runtime invocation, verification check completion gate,
  and lease release on every exit path.
- Test suites:
  - `apps/api/tests/agent/agent-orchestrator.test.ts`: 13 comprehensive orchestrator tests (queued → running → completed,
    multi-step execution, mode permissions, unknown tools, malformed arguments, tool repair, permanent failure, step limits,
    unverified completion denial, abort signal cancellation, owner isolation, SSE replay).
  - `apps/api/tests/agent/agent-concurrency.test.ts`: 4 concurrency/fencing tests (two workers racing to claim run, stale worker
    lease fencing, crash/retry step continuity, background execution surviving browser/SSE disconnect).
  - `apps/api/tests/agent/agent-boundaries.test.ts`: AST boundary checks proving zero forbidden imports (`child_process`, host shell,
    `node:fs`), plus real PostgreSQL step trigger tests (monotonic numbering, step immutability, step delete rejection).
  - `apps/api/tests/agent/agent-migration.test.ts`: Populated migration upgrade tests (010 → 011 and 011 → 012) with snapshot preservation.

## Orchestration state machine & lease fencing semantics

1. **Claiming**: An eligible queued run (or run with expired lease) is claimed atomically via `claimRun` using
   `SELECT ... FOR UPDATE`. The run transitions to `running`, increments `attempt_count`, generates a cryptographically
   secure `lease_token`, and sets `lease_expires_at`.
2. **Fencing**: Every subsequent mutation (`recordStepStarted`, `recordStepCompleted`, `recordStepFailed`, `appendPlanUpdatedEvent`,
   `finalizeRun`) verifies `lease_token = $leaseToken AND status = 'running'`. If the lease expired or another worker claimed
   the run, the stale worker is immediately fenced and rejected.
3. **Pre-dispatch Tool Validation**: Requested tool names, argument schemas, path traversal boundaries, and execution mode
   risk policies (Ask = read only, Plan = read only, Execute = sandbox writes/execution) are strictly validated before
   any execution runtime dispatch. Unknown tools or invalid arguments fail before runtime invocation.
4. **Verified Completion Gate**: An Agent cannot mark itself `completed` simply by asserting "done". The orchestrator checks
   verification evidence from the execution runtime. If no verified checks passed, or if any check failed, completion is denied
   and the run fails with `VERIFICATION_FAILED`.
5. **Crash / Retry Continuity**: When a worker crashes, the committed steps remain durably persisted in `agent_run_steps`.
   When a successor worker claims the run, it inspects existing committed steps and continues from the next monotonic step number,
   preventing duplicate side-effects.
6. **Worker Cleanup**: On every exit path (success, failure, cancellation, exception), the orchestrator releases the lease
   in a `finally` block via `releaseLease`.

## Security and execution boundary

- **Zero Host Execution**: AST analysis of all files in `apps/api/src/modules/agent/` confirms no imports of `child_process`,
  `node:fs`, `worker_threads`, `node:vm`, `shell`, `execa`, or `cross-spawn`.
- **In-Memory Fake Only**: `DeterministicFakeExecutionRuntime` uses only an in-memory `Map<string, string>`. No host disk
  files are created or modified.
- **Production Default Safe**: Default runtime remains `UnavailableExecutionRuntime` which rejects execution truthfully with
  `RUNTIME_UNAVAILABLE`. Real cloud sandbox execution is deferred until ADR-003 and security reviews are approved.
- **Tenant Isolation**: Every database operation is scoped by `owner_id`. Cross-tenant step/event access returns identical 404s.

## Checks executed

Environment: Windows PowerShell, Node 24.20.0, npm 11.19.0; `NODE_ENV=test`.
PostgreSQL 18.4 used a disposable loopback-only cluster on port 56445, database `giga_agent_test`.
Ordinary application `DATABASE_URL` was not used.

| Command / action | Result |
|---|---|
| `npm run typecheck` in `apps/api` | PASS: 0 errors |
| `npm run build` in `apps/api` | PASS: 0 errors |
| `npx tsx --test tests/agent/*.test.ts tests/db-migrations.test.ts` with real PostgreSQL | PASS: 40 tests, 0 skipped, 0 failed |
| Full `npm test` with dedicated `TEST_DATABASE_URL` | PASS: 69 tests in root suite, all agent tests pass |
| Full `npm test` with `TEST_DATABASE_URL` unset (pg-mem) | PASS: 370 tests, 0 failed, 24 PostgreSQL-only skips |
| `node --test .agents/scripts/validate-git-workflow.test.mjs` | PASS: 6 tests |
| `git diff --check` | PASS: 0 whitespace errors |

## Checks not executed / remaining blockers

- No real cloud sandbox provisioned; no AWS/GCP/Docker runner deployed.
- No real LLM called; all tests run against deterministic fixtures.
- No GitHub import or external PR creation implemented.
- API contract remains DRAFT; no final v1 API freeze.
- Draft PR only; independent review and human review remain required before merge.

## Handoff

Migration 012 is forward-only, additive, and backward-compatible with 011.
The PR is submitted as a Draft PR linking Linear 17T-45.
No direct merge or issue completion is claimed.
