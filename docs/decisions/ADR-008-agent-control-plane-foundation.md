# ADR-008 — Durable Agent control-plane foundation

Status: DRAFT implementation candidate for [17T-44](https://linear.app/17thedev/issue/17T-44);
independent review pending. Date: 2026-10-16. Intended owner: Trà; reviewer: Thư.
API v1 remains DRAFT. ADR-003 remains proposed and INV-07 is unchanged.

## Decision

Implement only durable blank Workspace metadata, Run admission/history and replayable
events behind existing session/CSRF boundaries. Migration 011 adds `agent_workspaces`,
`agent_runs`, `agent_run_events`. It does not alter existing tables or migrations.
Composite owner/workspace and owner/run FKs prevent mismatched ownership; indexes cover
owner histories, workspace-filtered run history and owner-scoped sequence replay.

There is no execution runner. Valid admission commits a queued `run.status` event and
terminal `run.failed` event with `RUNTIME_UNAVAILABLE` alongside a failed run. New creation
returns 201; exact idempotent replay returns 200. This gives durable, inspectable failure
without leaving an unbounded queue or fabricating successful execution. A DB failure
rolls back both state and events. A retry requires a new key/new run; reconnect is a read.

An owner-scoped unique key and normalized request fingerprint arbitrate admission.
Workspace ownership is checked before key lookup. PostgreSQL uniqueness also handles
same-owner/key races across different owned workspaces. No key namespace is shared with Chat.

Event IDs are positive per-run integers allocated on the run row inside the transaction.
Primary keys, row locking and insertion triggers reject gaps, duplicates, mismatched
event/current-run state and owner mismatches. Terminal run and event updates are fenced
by triggers. Repository operations commit state and event together; these triggers do
not replace a future worker's lease, attempt fencing or outbox protocol.

SSE is a bounded database observer: strict greater-than replay, at most 100 events per
read, committed high-water mark before terminal close, 500 ms polling, 15-second ID-less
unpersisted heartbeat, 60-second observation lifetime and backpressure-aware delivery.
Connection lifetime never owns run lifetime. No in-memory broadcaster is authoritative.
Future event types require server schema/DTO review; clients must ignore unknown types.

The `ExecutionRuntime.prepare` port describes an owner/run/workspace/mode-scoped future
session preparation boundary. The only adapter returns unavailable and has no effects.
Admission never calls the port: dispatch belongs in a future durable worker after the
ADR-003 isolation/cost/security gates. No command string or provider secret is accepted
as runtime authority. The fixed `giga-agent-default` alias is not a configured provider.

## Scope and consequences

- Seven proposed public statuses are retained; only queued admission and failed unavailable
  events are emitted by this implementation. Defaults are Ask and Cloud.
- Workspace metadata is real, but no physical workspace directory/snapshot is created.
- No shell execution, cloud resource, worker, GitHub, upload, artifact, approval, preview
  or local runner is implemented. No new dependency is needed.
- The migration is additive; PostgreSQL migration locks still apply. Application rollback
  leaves the Agent tables intact. No destructive down migration or production migration
  is performed by this task.
- Real sandbox work remains blocked on adopted ADR-003, independently reviewed isolation,
  budgets/egress policy, approved costs, durable dispatch/fencing and verified output storage.

## Compatibility evidence / remaining review

See the [implemented DRAFT contract subset](../contracts/GIGA_AGENT_API_V0.2.md#implementation-candidate--17t-44)
and [verification record](../evidence/17T-44-agent-control-plane.md).
Auth/Chat contracts are unchanged. Existing frontend Agent fixtures are still mocks;
Thư must independently review DTO/SSE behavior before merge. Hosted browser and real
sandbox acceptance are not established by the backend tests.
