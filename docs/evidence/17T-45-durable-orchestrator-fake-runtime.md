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
- `apps/api/src/modules/agent/types.ts`: Separated public `AgentRun` DTO from internal `ClaimedRun` and
  `WorkerLease`. Sensitive lease tokens, worker IDs, lease expiration timestamps, and internal attempt counts
  are strictly omitted from `AgentRun`. Browser and public consumers never receive internal fencing credentials.
- `apps/api/src/modules/agent/repository.ts`:
  - `run()` mapper strictly projects public fields only.
  - `assertActiveLease(row, leaseToken)` enforces `row.status === 'running'`, `row.lease_token === leaseToken`,
    and `new Date(row.lease_expires_at).getTime() > Date.now()` on every state mutation.
  - Wired active lease validation into `appendPlanUpdatedEvent`, `recordStepStarted`, `recordStepCompleted`,
    `recordStepFailed`, and `finalizeRun`.
  - `renewLease` enforces `lease_expires_at > NOW()`.
- `apps/api/src/modules/agent/orchestrator.ts`:
  - Implemented `validateDecision` to validate and bound decision provider outputs before persistence
    (plan step length <= 256 chars, 1..20 steps, `toolCallId` <= 64 chars matching alphanumeric/dash/underscore,
    summary <= 2048 chars, failure code <= 40 chars, message <= 1024 chars).
  - Proactive lease renewal before decision provider call and before execution runtime invocation.
  - Added background heartbeat timer running at `Math.floor(leaseDurationMs / 3)` that renews the lease
    and aborts the local execution runtime signal if renewal fails.
  - Ask and Plan mode completion: `ask` and `plan` modes complete cleanly with summary and `verifiedChecks: []`,
    while `execute` mode retains strict positive verification evidence gate from sandbox build/tests.
- Test suites:
  - `apps/api/tests/agent/agent-orchestrator.test.ts`: 16 comprehensive orchestrator tests (queued → running → completed,
    multi-step execution, mode permissions, unknown tools, malformed arguments, tool repair, permanent failure, step limits,
    unverified completion denial, abort signal cancellation, owner isolation, SSE replay, Ask/Plan clean completion,
    decision provider output bounding, public `AgentRun` DTO privacy).
  - `apps/api/tests/agent/agent-concurrency.test.ts`: 6 concurrency/fencing tests (two workers racing to claim run, stale worker
    lease fencing, crash/retry step continuity, background execution surviving browser/SSE disconnect, worker with expired lease
    fenced before takeover, long invoke + takeover race preventing duplicate effects).
  - `apps/api/tests/agent/agent-boundaries.test.ts`: AST boundary checks proving zero forbidden imports (`child_process`, host shell,
    `node:fs`), plus real PostgreSQL step trigger tests (monotonic numbering, step immutability, step delete rejection).
  - `apps/api/tests/agent/agent-migration.test.ts`: Populated migration upgrade tests (010 → 011 and 011 → 012) with snapshot preservation.

## Orchestration state machine & lease fencing semantics

1. **Claiming**: An eligible queued run (or run with expired lease) is claimed atomically via `claimRun` using
   `SELECT ... FOR UPDATE`. The run transitions to `running`, increments `attempt_count`, generates a cryptographically
   secure `lease_token`, and sets `lease_expires_at`.
2. **Active Lease Expiration & Fencing**: Every subsequent mutation (`recordStepStarted`, `recordStepCompleted`, `recordStepFailed`,
   `appendPlanUpdatedEvent`, `finalizeRun`) row-locks the run and strictly validates both `lease_token = $leaseToken` AND
   `lease_expires_at > NOW()`. If a worker's lease expires—even if no successor has claimed the run yet—any further mutation
   attempt is immediately fenced and rejected.
3. **Heartbeat & In-Flight Abort**: The orchestrator maintains an active lease renewal heartbeat. If a renewal fails
   or an abort signal fires, the local `AbortController` triggers, signaling the execution runtime to stop immediately
   and preventing stale side-effects.
4. **Pre-dispatch Tool Validation & Output Bounding**: Requested tool names, argument schemas, path traversal boundaries,
   and execution mode policies (Ask = read only, Plan = read only, Execute = sandbox writes/execution) are validated before
   runtime dispatch. Decision provider outputs are checked for bounded sizes before hitting the database.
5. **Verified Completion Gate**:
   - `execute` mode requires positive verification evidence from the runtime (e.g. `run_tests` passed). Unverified completion
     is rejected with `VERIFICATION_FAILED`.
   - `ask` and `plan` modes complete cleanly with the decision summary and `verifiedChecks: []`.
6. **Crash / Retry Continuity**: When a worker crashes, committed steps remain durably persisted in `agent_run_steps`.
   When a successor worker claims the run, it inspects existing committed steps and continues from the next monotonic step number,
   preventing duplicate side-effects.
7. **Worker Cleanup**: On every exit path (success, failure, cancellation, exception), the orchestrator stops its heartbeat
   and releases the lease in a `finally` block via `releaseLease`.

## Security and execution boundary

- **Zero Host Execution**: AST analysis of all files in `apps/api/src/modules/agent/` confirms no imports of `child_process`,
  `node:fs`, `worker_threads`, `node:vm`, `shell`, `execa`, or `cross-spawn`.
- **In-Memory Fake Only**: `DeterministicFakeExecutionRuntime` uses only an in-memory `Map<string, string>`. No host disk
  files are created or modified.
- **Production Default Safe**: Default runtime remains `UnavailableExecutionRuntime` which rejects execution truthfully with
  `RUNTIME_UNAVAILABLE`. Real cloud sandbox execution is deferred until ADR-003 and security reviews are approved.
- **DTO Credential Privacy**: Internal fencing tokens (`leaseToken`), `workerId`, `leaseExpiresAt`, and `attemptCount` are
  isolated to internal runtime types and never returned to browser clients or public HTTP endpoints.
- **Tenant Isolation**: Every database operation is scoped by `owner_id`. Cross-tenant step/event access returns identical 404s.

## Checks executed

Environment: Windows PowerShell, Node 24.20.0, npm 11.19.0; `NODE_ENV=test`.
PostgreSQL 18.4 used a disposable loopback-only cluster on port 56445, database `giga_agent_test`.
Ordinary application `DATABASE_URL` was not used.

| Command / action | Result |
|---|---|
| `npm run typecheck` in `apps/api` | PASS: 0 errors |
| `npm run typecheck` in `apps/web` | PASS: 0 errors |
| `npm run build` in `apps/api` | PASS: 0 errors |
| `npx tsx --test tests/agent/*.test.ts tests/db-migrations.test.ts` with real PostgreSQL | PASS: 45 tests, 0 skipped, 0 failed |
| Full `npm test` with dedicated `TEST_DATABASE_URL` (real PostgreSQL 18) | PASS: 399 tests, 54 suites, 0 failed, 0 skipped |
| Full `npm test` with `TEST_DATABASE_URL` unset (pg-mem) | PASS: 375 tests, 54 suites, 0 failed, 24 PostgreSQL-only skips |
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
