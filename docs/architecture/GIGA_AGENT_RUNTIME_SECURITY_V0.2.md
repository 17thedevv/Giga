# GigaAgent — Sandbox Runtime, Permissions and Operational Safety v0.2

> **PROPOSED, NOT DEPLOYED.** Review against [Agent Architecture](GIGA_AGENT_ARCHITECTURE_V0.2.md), [ADR-003](../decisions/ADR-003-agentic-workspace-and-isolated-runtime.md), and locked [INV-07](INVARIANTS_V0.1.md). No host shell execution is authorized by this design.

## 1. Separation of execution authority

**17T-44 boundary:** the control-plane candidate persists metadata and unavailable outcomes
only. Its execution port has an unavailable adapter; the API never dispatches it. No
sandbox, host command fallback, provider credentials or tool execution is added. The
security gates in this document remain required before any real runner is provisioned.

**Hono Control Plane:** session/Auth/CSRF, policy, budgets, approval decision, LLM orchestration, audited events, DB queries, artifact metadata. It **never executes model-generated shell commands on its process host**, even for local development convenience.

**Cloud Sandbox Runner (first implementation candidate):** separate, isolated environment whose CPU, memory, filesystem, process tree, storage, egress and lifetime are governed by a host/runner service with independent credentials. It may run untrusted dependencies/code inside explicit Workspace mounts, but NEVER gets the Control Plane's production DB credentials, GitHub write token, host Docker socket, Cloud IAM admin keys or blanket filesystem access.

**Local Runner (later):** paired device identity, explicit user-approved folder grants, separate permission/cancel policy and capability reporting. Do not simulate local mode by permitting server access to user device paths.

### Deployment gate

Do not provision free/paid runners before checking actual provider support for nested containers/sandboxes, isolation, quotas, networking, price, persistence and abuse limits. Untrusted code in a shared process or API container is not a valid substitute for isolation. Sandbox worker on the same VM may still be unsafe without a separately reviewed strong boundary.

## 2. Default policy matrix

| Action class | Ask | Plan | Execute | Boundary |
|---|---|---|---|---|
| Read current task and authorized workspace metadata | Allow | Allow | Allow | User-owned scope |
| Read authorized workspace files | Ask/read-only policy | Allow | Allow | Scoped sandbox filesystem only |
| Create/edit/delete ordinary files inside disposable sandbox | Deny | Deny | Allow within workspace | Snapshot/recovery required |
| Run build/test scripts in sandbox | Deny | Deny | Allow within budget/policy | No host shell or privileged mode |
| Install packages / network egress | Deny | Request documented access | Allow only preapproved registries/domains; otherwise request | Egress proxy/allowlist, no secrets |
| Browser access to local preview | Deny | Optional read-only | Allowed in isolated browser when implemented | Authenticated preview proxy |
| Read files outside workspace or user secrets | Deny | Deny | Deny unless independently authorized by scoped runner grant | No global host access |
| Mutate external services, publish PR, deploy, bill, delete external resources | Deny | Deny | Explicit authenticated approval per bounded action | Separate external executor |
| Read another user's workspace or personal GigaChat memory | Deny | Deny | Deny | Never inherited |

Permissions are **server-enforced**, not only button state or system prompt. Human approval is always tied to a concrete action digest (target resource, allowed operations, parameters, potential impact, expiry, budget, actor and policy version). An approval may not be reused for a changed action.

No "Autonomous" toggle grants unlimited filesystem, network, billing, Cloud or remote write access.

## 3. Sandbox technical requirements

- **Root filesystem:** ephemeral and disposable; bind only an allowlisted per-run Workspace directory/snapshot. Prevent symlink escape, hardlink abuse and path traversal, including archive extraction.
- **OS privileges:** unprivileged user, capabilities dropped, no privileged container, no host PID/net namespace or Docker socket; enforce syscall and filesystem constraints as supported.
- **Resource ceilings:** per-run CPU/memory/disk/process count, wall-clock, max tool output bytes, file count and archive size; terminate descendants on timeout.
- **Network:** off or deny-by-default at initial startup; allow vetted package registries/docs via egress restrictions with DNS/IP rebinding/redirect safeguards. Forbid access to link-local metadata/localhost internal services/control plane; no arbitrary port-forward/public listeners.
- **Secrets:** never inject provider/DB/cloud tokens into workspace/container environment. Short-lived runner credentials have only scoped callback/snapshot access and are rotated/revoked.
- **Dependencies/supply chain:** treat package installs and build scripts as arbitrary code; pin base images, constrain registries, scan artifacts and capture dependency manifests; no claim of sandbox safety without adversarial testing.
- **Isolation between users:** unique workspace/run IDs, isolated mounts, scoped object keys, network/process boundaries; negative tests for cross-tenant access, symlink traversal, tar/ZIP slips.
- **Browser preview:** separately scoped proxy with short-lived access and CSP/sandboxing as appropriate; avoid executing untrusted pages in same origin as auth cookies; no blind public exposure.
- **Artifacts:** virus/content checks and safe headers/downloads for user-provided or generated files; avoid rendering untrusted HTML under the authenticated app origin.

The cloud runner must use a **supported** sandbox mechanism. Container isolation alone is not assumed sufficient for adversarial arbitrary-code execution; threat model and provider-specific capabilities require review.

## 4. Control budget and cancellation

Starting **configuration candidates**, not tested production defaults:

| Limit | Candidate |
|---|---:|
| Active runs per user | 1 |
| Tool calls/run | 30 |
| Wall-clock/run | 15 minutes |
| Automatic build-fix loops | 3 |
| Sandbox concurrency/workspace | 1 writable session |
| Output bytes/tool | 64 KiB (truncate with marker) |
| Max upload/archive | Provider quota dependent; confirm before implementation |
| LLM tokens/cost | Server-configured per-run and per-user hard caps |

The server keeps counters (reserved budget + actual usage), aborts provider/runner calls when limits are exceeded, and persists a truthful terminal status. Tool name/arguments validated before costs are incurred; retries count towards budget. A completed external charge cannot be rolled back by cancelling a run.

Cancellation:
1. Mark cancel_requested and stop issuing new tool calls.
2. Send cancel to runner, terminate process tree with grace/kill limits; persist partial files safely when policy permits.
3. Avoid retrying unknown-completion tool calls. Reconcile using effect IDs and tool idempotency.
4. If external action already occurred, report it and persist metadata rather than falsely claiming rollback.

## 5. Approvals and external effect protocol

Inside isolated disposable workspace, routine edits/build commands allowed for Execute without per-file approval, subject to sandbox restrictions. Before external writes:
- Build canonical effect specification: operation, target, exact arguments, content hash/manifest if file bytes affected, approved scope, rollback possibilities, expiry, user ID/run ID.
- Store approval pending and block that effect, not unrelated safe work (if orchestrator concurrency permits).
- Authorized user accepts/rejects via CSRF-protected endpoint; compare policy version and current permission grants; ensure one-time/retry-safe decision.
- Executor must recheck latest remote state, target identity and approval hash before action; a stale or newly expanded action needs reapproval.
- Persist checkpointed external effects and reconcile after ambiguous timeouts. No blind duplicate PRs/deploys/charges/deletions.

For a GitHub PR flow, approval of a particular diff/branch/repository may be necessary; **it is not required for ordinary sandbox file edits**. Never push directly to default branch without separate explicit policy; no autonomous destructive remote writes.

## 6. Agent prompt injection and abuse defenses

- Repo README, code comments, web pages, task attachments and tool logs are **data**, not policy. Do not let them override permission engine, reveal secrets or redefine tool schema.
- LLM-generated commands are untrusted. Validate commands and tool arguments; run only through sandbox with limits. No string-concatenated host shell injection.
- Reject private-IP/metadata destinations when fetching URLs; follow redirects through the same network policy. Use content/size/time limits.
- Enforce per-user abuse quotas. Public signup + free expensive runtime needs additional account verification/rate controls.
- Logs: event IDs, safe tool type, truncated sanitized output and cost/latency, no password/token/provider keys or raw private source in public analytics.
- Sensitive artifact retention/deletion must apply to snapshots, object storage, cache, job payloads and preview sessions, not just Postgres row deletion.
- GigaChat Memory must not be used as tool authority or automatically injected into Agent planning.

## 7. Reliability: leases, crash recovery and replay

- Persist run/job state and an event in one transaction before dispatch to runner; use a DB outbox/durable queue to bridge state and RPC.
- Lease agent jobs with attempt/fencing token and bounded renewals. A stale worker may not commit state after another takes over.
- Tool call has stable ID, schema name/version, risk class and idempotency/effect key. Read-only calls may retry safely; side-effect calls require reconciliation or verified idempotency.
- SSE clients replay persisted per-run sequence after Last-Event-ID and then receive live events. Never use SSE connection lifetime as the agent runner lifetime.
- An ephemeral sandbox may vanish; rehydrate from latest verified immutable snapshot or report failed recoverability. Do not silently restart an unsafe external write.
- Store evidence that artifact upload completed and checksum matches before marking "completed".

## 8. Test gates (required before any live user untrusted command)

1. Host isolation: attempts to read API secrets, host filesystem, DB socket, Docker socket and metadata endpoints fail.
2. Workspace isolation: user A cannot read/edit user B snapshot, artifacts or runs even when guessing IDs.
3. Archive/path attacks: ../ traversal, symlink/ZIP-slip and malicious tar entries rejected.
4. Network: restricted egress, redirects, DNS rebinding and internal IP attempts denied according to policy.
5. Resource limits: process forks, disk fill, infinite loops and huge stdout terminate safely.
6. Cancellation and server/worker crash: no zombie jobs, stale leases, duplicate external effects or false successes.
7. Permission escalation: prompt/tool output requests external writes without approval; runner denies and logs safe audit metadata.
8. Artifact preview/access: authenticated user-only downloads, no execution on privileged web origin.
9. Honest evidence: claimed build/test success matches observed exit code, saved log and artifact digest.
10. Cloud quota/billing preflight and restore/resume demonstration recorded before deployment.

**This is a security acceptance plan, not evidence any particular sandbox provider satisfies it.**
