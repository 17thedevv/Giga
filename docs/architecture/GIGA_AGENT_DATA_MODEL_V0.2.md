# GigaAgent — Data Model, Persistence and State v0.2

> **DRAFT / NON-EXECUTABLE SCHEMA PROPOSAL.** No migration is authorized or applied. Reference: [Architecture](GIGA_AGENT_ARCHITECTURE_V0.2.md), [Sandbox Security](GIGA_AGENT_RUNTIME_SECURITY_V0.2.md), [API](../contracts/GIGA_AGENT_API_V0.2.md). Source tables users/sessions currently exist; conversation migration 002 belongs to 17T-21 and is unrelated.

## 1. Separation of concerns

- **PostgreSQL** is authoritative for workspace/run/job state, messages, tool-call records, approvals, event replay metadata and artifact manifests.
- **Durable object/artifact storage** holds immutable workspace snapshots, large tool outputs, screenshots and downloadable ZIPs. Never rely on ephemeral runtime volume for persistence.
- **Sandbox volume** is temporary scratch derived from a versioned snapshot; cannot be accessed directly by other users.
- **External integrations** hold their own permission grants and tokens, not plaintext in generic agent tables.

All rows have owner-scoped authorization. Use UUID primary keys and UTC timestamptz. Enforce access at API and scoped DB repository boundaries; consider defense-in-depth RLS only after correct explicit scope policy.

## 2. Logical entity inventory

| Table | Key fields (candidate) | Important invariants |
|---|---|---|
| agent_workspaces | id, owner_id, name, source_kind ('blank','upload','import'), active_snapshot_id?, revision, created_at, updated_at | User-owned; snapshot owner checked; no GitHub requirement |
| agent_workspace_snapshots | id, workspace_id, parent_snapshot_id?, storage_key, manifest_hash, total_bytes, file_count, created_at | Immutable, storage ref not a public path; optimistic edits |
| agent_runs | id, workspace_id, owner_id, task, mode ('ask','plan','execute'), runtime ('cloud'), public_status, internal_phase, state_version, budget_json, cost_used, created_at, updated_at, terminal_reason? | One authenticated owner; valid transitions; no repository column required |
| agent_messages | id, run_id, role ('user','assistant','tool_summary'), content, sequence, created_at | Ordered messages; tool output redaction and limits |
| agent_steps | id, run_id, sequence, description, status, started_at?, completed_at?, verification_summary? | Plan revisions/versioned ordered steps |
| agent_tool_calls | id, run_id, step_id?, tool_name, schema_version, risk, arguments_ref_or_safe_json, status, effect_key, attempt, started_at, ended_at, result_ref?, error_code? | No raw secrets; explicit idempotency and policy evidence |
| agent_events | run_id, sequence, kind, safe_payload, created_at | Immutable per-run SSE log, UNIQUE(run_id, sequence) |
| agent_jobs | id, run_id, status, priority, scheduled_at, attempts, lease_token, lease_until, cancel_requested, last_error_code? | Durable queue; fenced claims; no duplicate processing effects |
| agent_runtime_sessions | id, run_id, backend_kind, runner_ref, capabilities, status, lease_until, started_at, ended_at | One active writer per workspace; no raw runner credentials |
| agent_artifacts | id, run_id, workspace_id, snapshot_id?, name, mime_type, storage_key, size_bytes, sha256, visibility, created_at, expires_at? | User-scoped, verified checksum and retention; no direct bucket URLs |
| agent_approvals | id, run_id, user_id, effect_type, target_ref, canonical_effect_hash, policy_revision, status, expires_at, decided_at, idempotency_key | One-use, exact scoped external effect; immutable decision record |
| agent_external_effects | id, run_id, approval_id, effect_key, provider, phase, external_id?, receipt_hash?, status, attempts, last_error_code | Reconcile ambiguous results before retry |

Optional later: workspace file index, skill installations, MCP grants, repo imports, browser sessions, agent children/subtasks and project knowledge. **Do not** create unnecessary empty tables as scaffolding.

## 3. Ownership, uniqueness and consistency

Required relational rules:
- agent_workspaces(owner_id) REFERENCES users(id) ON DELETE CASCADE (actual account deletion policy to review).
- agent_runs(workspace_id, owner_id) references an owner-matched workspace; single FK on workspace_id is **not enough** to enforce matching owner. Use composite UNIQUE(id,owner_id) + composite FK or owner-qualified transaction checks.
- agent_events PK (run_id, sequence). Monotonic sequences allocated transactionally; never use wall-clock alone as event order.
- tool_calls unique (run_id, effect_key) for non-repeatable operations, with per-step trace IDs and bounded request size.
- approvals unique effective decision per concrete effect + unique (user_id,idempotency_key) under supported request class.
- artifacts/snapshots cannot be attached to workspace/run with mismatched owner; use composite keys and verified joins.
- workspace snapshot/revision CAS guards concurrent runs. MVP permits at most one writable run per workspace, with a transactional constraint/lease; Ask/Plan may be read-only.
- never delete user content merely because a sandbox expires; retention/deletion is a separate explicit policy.

## 4. State model and durable events

**Public run_status:** queued / running / awaiting_approval / applying / completed / failed / cancelled (existing draft enum, preserved for initial compatibility discussion).

**Internal phase when running:** planning / executing / observing / verifying / waiting_runtime. External effect phases: preparing / dispatched / reconciling / confirmed / failed. These are **internal fields**, not new public enum values by default.

Legal high-level transitions:
- queued -> running, failed, cancelled
- running -> awaiting_approval, completed, failed, cancelled
- awaiting_approval -> running (approved and performing safe internal next work), applying (external action begins), cancelled (rejected/cancel), failed (expired)
- applying -> running (if approved side effect completed but task continues), completed, failed; cancel only if safe and remote action reconciled
- completed/failed/cancelled terminal, except explicit new run or reviewed resume protocol

**Never mark completed** before result artifact/snapshot persisted and checks reported. A run may complete without any approval or external integration.

Event taxonomy draft: run.status, run.phase, plan.updated, tool.started, tool.completed, tool.failed, approval.required, approval.decided, artifact.ready, run.completed, run.failed, heartbeat. Existing v0.1 events are preserved as a compatibility starting point; additions and payload shape require joint contract review, unknown-event tolerance, ordering tests. Persisted event payload excludes secrets, entire private tool outputs and model chain-of-thought.

## 5. Transactional patterns

~~~sql
-- Illustrative pseudo-SQL; requires concrete schema and constraints.
-- Claim a job, avoid multi-worker double execution.
WITH ready AS (
  SELECT id
  FROM agent_jobs
  WHERE status = 'queued'
    AND scheduled_at <= now()
  ORDER BY priority DESC, scheduled_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE agent_jobs j
SET status = 'running', attempts = attempts + 1,
    lease_until = now() + interval '2 minutes'
FROM ready
WHERE j.id = ready.id
RETURNING j.id, j.run_id, j.attempts;
~~~

Actual implementation must include an unguessable fencing/lease generation, crash reclaim, transaction boundaries, max attempts, timeout and worker heartbeat. Never hold a DB transaction open during model, command or network calls.

On run creation, atomically persist run + job + run.status event. On tool dispatch, persist policy authorization and a stable tool_call/effect ID before the RPC; on completion verify attempt generation, append result and event. For external writes, first commit approval and external effect intent, then perform one controlled external call, reconcile result on ambiguous timeout.

Workspace snapshot publish: verify archived bytes/chunks and hash before transaction marking snapshot current (CAS on workspace revision). If upload succeeds but transaction fails, orphan cleanup job is required. Avoid exposing uncommitted files as "saved".

## 6. API relationships and example types

~~~ts
type AgentRunStatus =
  | 'queued' | 'running' | 'awaiting_approval'
  | 'applying' | 'completed' | 'failed' | 'cancelled';
type AgentMode = 'ask' | 'plan' | 'execute';

interface AgentRun {
  id: string; workspaceId: string; task: string;
  mode: AgentMode; runtime: 'cloud'; status: AgentRunStatus;
  phase?: 'planning' | 'executing' | 'observing' | 'verifying' | 'waiting_runtime';
  createdAt: string; updatedAt: string;
  result?: { artifactIds: string[]; summary: string; verifiedChecks: string[] };
}
~~~

The example is not frozen; full route payloads and error cases are in [GigaAgent API v0.2](../contracts/GIGA_AGENT_API_V0.2.md). No required repository field. Optional GitHub source grants should be a separate integration table later.

## 7. Migration and retention gate

1. Verify actual current schema and migration registry at implementation time; do not assume migration 002 exists until 17T-21 merges.
2. Settle one canonical forward-only migration process; current auth implementation has a runner/SQL-file divergence to resolve before new migrations.
3. Use dedicated test database with real PostgreSQL, never production DATABASE_URL; honor completed 17T-23 safeguards.
4. Define account/workspace deletion cascade, artifact/snapshot retention, audit preservation, encrypted storage keys and backup recovery policy.
5. Implement owner-scoped negative tests, crash/replay/idempotency, artifact integrity and migration repeatability.
6. Plan safe data migration from any future v0.1 Agent demos; current GitHub-only frontend MOCK records are **fixtures**, not real data needing schema migration.

**No DDL was run, no migrations were applied and no user data was changed by this document.**
