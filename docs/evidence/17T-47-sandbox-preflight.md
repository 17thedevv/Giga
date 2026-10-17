# Verification Evidence — Linear 17T-47: Prepare GigaAgent isolated sandbox adapter & Cloud security gate

**Date:** 2026-10-17<br>
**Linear Task:** [17T-47](https://linear.app/17thedev/issue/17T-47/prepare-gigaagent-isolated-sandbox-adapter-and-cloud-security-gate)<br>
**Branch:** `feat/17t-47-sandbox-preflight`<br>
**PR Title:** `feat(agent): prepare isolated sandbox runtime`<br>
**Owner:** Trà (Agent / Backend)<br>
**Reviewer:** Tráng A Thư (Frontend / UX)<br>
**Review Status:** Addressed Peer Review (Review ID: 5558125416). Ready for Re-Review (Draft PR, unmerged)

---

## 1. Executive Summary

This task prepares the **isolated execution plane** for GigaAgent without making the API host a runtime for AI-generated code. It implements the security preflight gates outlined in [ADR-003](../decisions/ADR-003-agentic-workspace-and-isolated-runtime.md), [GIGA_AGENT_RUNTIME_SECURITY_V0.2](../architecture/GIGA_AGENT_RUNTIME_SECURITY_V0.2.md), and locked architecture invariant **INV-07** (*no model-generated shell execution on the Hono/API host*).

### Resolutions to Peer Review (Review ID: 5558125416):

1. **P1 — Unified Canonical Secret Redaction (`redaction.ts`):**
   - Replaced weak regex in sandbox adapter with shared canonical `redactSensitiveContent()` and `boundUtf8()` extracted to [`apps/api/src/modules/agent/redaction.ts`](../../apps/api/src/modules/agent/redaction.ts).
   - Fixes the `$1` replacement bug where raw credentials were leaked.
   - Tested and verified against unquoted key assignments (`api_key=...`, `token: ...`), standalone `Bearer` schemes, quoted JSON structures, and UTF-8 multi-byte emojis.

2. **P1 — Cancellation, Timeout & Cleanup Failure Fencing (`sandbox-adapter.ts`):**
   - **Post-Allocation Abort Fencing:** If the caller aborts while sandbox allocation is in-flight, `prepare()` immediately destroys the newly allocated remote sandbox via `destroySandbox()` to eliminate cloud zombie/leak risks and fails closed (`RUNTIME_UNAVAILABLE`).
   - **Independent Adapter-Level Timeout:** Implemented an independent wall-clock timeout race using `Promise.race()` and `AbortController`. If a remote provider RPC hangs indefinitely, the adapter terminates at `effectiveTimeoutMs` and returns `errorCode: 'TIMEOUT'`.
   - **Cleanup Failure Tracking & Reconciliation:** `stop()` tracks `destroyStatus` (`'active' | 'destroying' | 'destroyed' | 'destroy_failed'`), `destroyError`, and `destroyAttempts`. `cleanup()` does NOT delete the session from memory if destruction failed, retaining it in `getPendingDestructions()` so ops/reconciliation workers can call `retryDestroy()`.

3. **P1 — Network Egress Policy & Honest Security Status:**
   - Adapter enforces a fail-closed default `egressEnabled: false` and forwards explicit `egressAllowlist` to `providerClient.createSandbox`.
   - **Honest Security Acceptance:** Gate 4 (Network & Egress Boundary) is explicitly classified as **PENDING LIVE CLOUD VALIDATION**. Simulation verifies the adapter contract and policy forwarding, but live cloud network isolation (blocking SSRF `169.254.169.254` and outbound domains) cannot be asserted as verified until live cloud fixtures are run.

4. **P2 — Accurate E2B Official Pricing & Quota:**
   - Corrected pricing estimate to official rates: **\$0.000028/sec for 2 vCPU** + **\$0.000009/sec for 2 GiB RAM** = **\$0.000037/sec (~ \$0.1332/hour)**.
   - Initial \$100 credit on Hobby tier provides ~750 active compute hours.

5. **CI Environment & Test Count Accuracy:**
   - Accurately reports GitHub Actions CI environment: **PostgreSQL 16.15 on Alpine Linux** container with Node.js 22.
   - Full CI test suite: **452/452 PASS, 0 failures, 0 skipped**.

---

## 2. Cloud Sandbox Evaluation (Feasibility Study & Security Matrix)

### A. Side-by-Side Comparison Matrix

| Evaluation Criteria | Option 1: E2B Sandbox (Firecracker MicroVM) | Option 2: Fly.io Machines (Sprig / MicroVM) | Option 3: Docker / gVisor (Container Runtime) |
|---|---|---|---|
| **Underlying Technology** | Firecracker MicroVM on AWS bare metal (KVM) | Firecracker MicroVM on Fly.io edge hardware | OCI container with gVisor `runsc` ptrace/KVM sandbox |
| **Isolation Boundary** | Hardware virtualization (independent Linux kernel per sandbox) | Hardware virtualization (independent Linux kernel per machine) | User-space kernel interception (`runsc`) on shared host |
| **Control Plane Boundary** | Completely isolated from Giga API host; zero access to host sockets or secrets | Separate machines; API token required; zero access to Giga host | Runs on same host daemon unless separate cluster provisioned |
| **Filesystem Isolation** | Ephemeral, disposable rootfs; built-in snapshotting and file sync | Ephemeral rootfs; optional attached NVMe volumes; manual sync | Ephemeral overlayfs; volume bind mounts; risk of host leakage |
| **CPU / RAM Ceilings** | Configurable per template (e.g. 2 vCPU, 2-4 GB RAM) | Granular (256 MB to 32 GB RAM, 1-8 CPUs) | Configurable via cgroups v2 (`cpu.max`, `memory.max`) |
| **Cold Start / Provisioning** | **150ms – 250ms** | 1.5s – 3.5s | 500ms – 2s |
| **Network Egress Controls** | Configurable internet access; can enforce egress domain allowlists or isolate entirely; blocks AWS 169.254.169.254 metadata | Full internet by default; egress firewalling requires manual iptables/eBPF rules or proxy setup | Host-controlled bridge/iptables; risk of container SSRF to host |
| **Cancellation & Abort** | Programmatic instant kill (`sandbox.kill()`); terminates entire VM in < 100ms | REST API `machines.stop()` / `machines.destroy()`; takes 1-3s | `docker kill` / `docker rm -f`; requires host daemon access |
| **Official Pricing & Cost** | 2 vCPU: \$0.000028/s, 2 GB RAM: \$0.000009/s (**~ \$0.1332/hr**); Free tier: \$100 credit (~750 hrs) | Pay per active second (~\$0.0000022/s for 1 shared CPU / 256MB); \$2-\$5/month base per machine | Self-hosted compute cost (EC2/Hetzner VM base price \$10-\$40/mo) |
| **Operational Complexity** | **Very Low** (Managed SDK `@e2b/code-interpreter` / `@e2b/sandbox`, zero infra to maintain) | **High** (Must manage machine pool, orchestrate warm-ups, handle region placement and network policies) | **High** (Must manage Docker/gVisor security patches, daemon socket protection, disk pruning) |
| **Giga 2-Person Feasibility** | **High** (Immediate plug-and-play, clean TypeScript API) | **Medium** (High maintenance overhead for MVP) | **Low** (Violates managed cloud simplicity; security attack surface) |
| **Verdict** | **GO (Primary Candidate for MVP Runner)** | **NO-GO for MVP (Viable secondary runner later)** | **NO-GO (Reject for Cloud MVP)** |

### B. Detailed Candidate Evaluation

#### 1. Candidate 1: E2B (Code Interpreters & MicroVM Sandboxes)
- **Primary Source:** [E2B Documentation](https://e2b.dev/docs), [E2B Pricing](https://e2b.dev/pricing), [E2B Security & Architecture](https://github.com/e2b-dev/E2B), [Firecracker MicroVM Whitepaper](https://firecracker-microvm.github.io/).
- **Architecture:** E2B uses AWS Firecracker microVMs launched on bare metal instances. Each sandbox runs an independent Linux kernel in user-space KVM. There is zero kernel sharing between concurrent sandboxes or between sandboxes and the Giga API host.
- **Cost Calculation (Official Rates):**
  - 2 vCPU: \$0.000028 / second (\$0.1008 / hour)
  - 2 GiB RAM: \$0.000009 / second (\$0.0324 / hour)
  - Total compute cost: **\$0.000037 / second (~ \$0.1332 / hour)**
  - Billed strictly per second of running microVM.
  - A typical 2-minute build-and-test agent run costs **\$0.0044** (~0.44 cents).
  - 1,000 full runs cost ~$4.44.
  - The \$100 initial Hobby credit covers ~750 active hours, providing ample headroom for coursework and testing without cloud costs.
- **Strengths:**
  - Startup time < 200ms allows on-demand sandbox provisioning per agent run without keeping costly idle machines running.
  - Native filesystem RPC: `filesystem.read()`, `filesystem.write()`, `filesystem.list()`.
  - Native process execution with output streaming and deterministic timeouts.
  - Snapshotting support: allows capturing workspace diffs and snapshots for artifact generation.
- **Verdict: GO.** Recommended as primary MVP Cloud Runner candidate.

#### 2. Candidate 2: Fly.io Machines
- **Primary Source:** [Fly.io Machines Documentation](https://fly.io/docs/machines/), [Fly.io Security Model](https://fly.io/docs/reference/security/).
- **Architecture:** Fly.io Machines are Firecracker microVMs managed via a REST API. Machines boot in 1–3 seconds from OCI container images.
- **Weaknesses:**
  - Higher cold-start latency (1.5s - 3.5s) compared to E2B.
  - Requires writing and maintaining custom guest agent software inside the machine to expose filesystem RPCs, command execution, and status reporting.
  - Network egress is unrestricted by default; securing against SSRF and private VPC destinations requires custom egress proxy configuration.
  - Significant operational overhead for a 2-person project team.
- **Verdict: NO-GO for MVP.** Can be re-evaluated as a secondary self-hosted runner post-MVP if cost at scale requires owning machine infrastructure.

#### 3. Candidate 3: Docker / gVisor on API Host VM
- **Primary Source:** [gVisor Documentation](https://gvisor.dev/docs/).
- **Weaknesses:**
  - Running Docker on the API host creates a hazardous failure domain: a compromised container or Docker socket escape compromises the control plane and PostgreSQL credentials.
  - Violates the Control Plane / Execution Plane separation demanded by ADR-003 and INV-07.
  - Disk management overhead: untrusted build scripts can quickly fill the API host disk with npm caches and dangling images.
- **Verdict: NO-GO.** Rejected as insecure and operationally fragile.

---

## 3. Architecture & Adapter Design

### ExecutionRuntime Standardization

```
[ Control Plane: Hono API Server ]
       |
       |  (Strict INV-07: NO node:child_process on host)
       v
[ ExecutionRuntime Adapter Interface ]
  ├── prepare(request) -> sessionId
  ├── invoke(sessionId, toolCall, signal) -> BoundedToolResult
  ├── createSnapshot(sessionId) -> SandboxSnapshot
  ├── getVerificationEvidence(sessionId) -> VerifiedCheck[]
  ├── stop(sessionId) -> void
  └── cleanup(sessionId) -> void
       |
       +-------------------------------+
       |                               |
       v                               v
[ DeterministicFakeExecutionRuntime ]  [ IsolatedCloudSandboxAdapter ]
  - Pure in-memory Map storage           - Pluggable CloudSandboxProviderClient
  - Server-side Mode Gate                - Zero host shell execution
  - Path Traversal Fencing               - Drops host process.env
  - Secret Fencing                       - 64 KiB Output Truncation
  - SHA-256 Snapshots                    - Wall-clock Timeouts & Aborts
                                         - Post-Allocation Abort Fencing
                                         - Independent Wall-Clock Timeout Race
                                         - Cleanup Failure Fencing & Retry
                                         - Network Egress Policy Forwarding
                                               |
                                               v (Isolated RPC / HTTPS)
                                      [ Remote MicroVM (E2B) ]
                                        - Disposable Rootfs
                                        - Scoped Workspace Mount
                                        - No Giga API DB / JWT secrets
```

---

## 4. Security Gate Preflight Checklist (against `GIGA_AGENT_RUNTIME_SECURITY_V0.2.md` Section 8)

| # | Security Acceptance Gate | Status | Implementation Evidence |
|---|---|---|---|
| 1 | **Host Isolation** | **VERIFIED** | Invariant INV-07 enforced; zero child_process calls on API host; secrets dropped from sandbox env; verified by test 3.1 & 3.2. |
| 2 | **Workspace Isolation** | **VERIFIED** | Sessions strictly bound to `(ownerId, workspaceId, runId)`; cross-tenant access rejected; verified by test 5.1. |
| 3 | **Archive & Path Traversal Attacks** | **VERIFIED** | `isSafeRelativePath` rejects `../`, absolute paths, UNC paths, and null bytes with `SECURITY_VIOLATION`; verified by test 4.1 & 4.2. |
| 4 | **Network & Egress Boundary** | **PENDING LIVE CLOUD VALIDATION** | Adapter enforces fail-closed policy (`egressEnabled: false`, `allowlist`) and forwards to provider client. E2B MicroVM SSRF protection evaluated. Full live network egress isolation pending live cloud runner deployment. |
| 5 | **Resource Ceilings & Timeouts** | **VERIFIED** | 64 KiB tool output truncation enforced; independent adapter-level wall-clock timeout races hanging RPCs; verified by test 6.2, 8.3 & 8.7. |
| 6 | **Cancellation & Server Recovery** | **VERIFIED** | Post-allocation abort fencing immediately destroys orphaned sandboxes; cleanup failure tracking prevents lost resources and supports `retryDestroy`; verified by test 8.6 & 8.8. |
| 7 | **Permission Escalation Prevention** | **VERIFIED** | Dual-layer mode enforcement denies writes/exec in Ask and Plan modes; prompt injection cannot bypass server gate; verified by test 2.1 & 2.2. |
| 8 | **Artifact & Snapshot Verification** | **VERIFIED** | `createSnapshot` captures exact file listings, byte sizes, and SHA-256 digests; verified by test 1.2 & 8.1. |
| 9 | **Honest Verification Evidence** | **VERIFIED** | `getVerificationEvidence` records true exit codes (`passed` / `failed`); verified completion gate requires passing checks in Execute mode; verified by test 8.2. |
| 10 | **Cloud Quota & Billing Preflight** | **PREFLIGHT VERIFIED** | Feasibility study completed with official E2B pricing (\$0.1332/hr compute); zero paid cloud resources provisioned during automated test runs. |

---

## 5. Automated Test Evidence

### A. Focused Sandbox & Security Gate Test Suite (`apps/api/tests/agent/agent-sandbox.test.ts`)

```text
▶ GigaAgent Isolated Sandbox Adapter & Cloud Security Gate (17T-47)
  ▶ 1. Standardized ExecutionRuntime Interface & Lifecycle
    ✔ initializes session with active status, metadata, and isolated environment (1.9469ms)
    ✔ captures immutable snapshot with exact file sizes and SHA-256 digests (9.2011ms)
    ✔ stop marks session inactive; subsequent invocations fail-closed with SESSION_NOT_FOUND (0.2882ms)
    ✔ cleanup frees resources safely without throwing (0.1944ms)
  ✔ 1. Standardized ExecutionRuntime Interface & Lifecycle (12.605ms)
  ▶ 2. Server-side Mode Security Gate (Ask / Plan / Execute)
    ✔ Ask mode: permits read tools but denies write and execution tools at adapter boundary (0.4233ms)
    ✔ Plan mode: permits read tools but denies write and execution tools at adapter boundary (0.3068ms)
    ✔ Execute mode: permits read, write, and sandbox execution tools (0.2701ms)
  ✔ 2. Server-side Mode Security Gate (Ask / Plan / Execute) (1.2255ms)
  ▶ 3. Strict Invariant: No Host Shell Execution (INV-07)
    ✔ run_command in fake runtime executes strictly in-memory without spawning child processes (0.3998ms)
    ✔ ToolRegistry validates run_command arguments and limits length to 512 chars (0.3148ms)
  ✔ 3. Strict Invariant: No Host Shell Execution (INV-07) (0.88ms)
  ▶ 4. Path Traversal & Host Boundary Escape Prevention
    ✔ isSafeRelativePath rejects traversal, absolute paths, null bytes, and Windows drive letters (0.1965ms)
    ✔ runtime adapter rejects path traversal attempts with SECURITY_VIOLATION before fs access (1.0604ms)
  ✔ 4. Path Traversal & Host Boundary Escape Prevention (1.3638ms)
  ▶ 5. Tenant Isolation & Lease Fencing
    ✔ assertTenantAccess verifies caller owner and workspace match session (0.1936ms)
  ✔ 5. Tenant Isolation & Lease Fencing (0.2601ms)
  ▶ 6. Timeout & Cancellation Handling
    ✔ aborts execution when signal is already aborted (0.1101ms)
    ✔ returns TIMEOUT when tool latency exceeds configured timeoutMs (19.8824ms)
  ✔ 6. Timeout & Cancellation Handling (20.2712ms)
  ▶ 7. Fail-Closed Behavior & Unavailable Runtimes
    ✔ UnavailableExecutionRuntime cleanly returns RUNTIME_UNAVAILABLE without crashing (1.417ms)
    ✔ IsolatedCloudSandboxAdapter without provider client returns RUNTIME_UNAVAILABLE (0.2678ms)
  ✔ 7. Fail-Closed Behavior & Unavailable Runtimes (1.7969ms)
  ▶ 8. Isolated Cloud Sandbox Adapter with Simulated Remote MicroVM
    ✔ runs end-to-end sandbox lifecycle: create -> write -> read -> build -> test -> snapshot -> destroy (2.4652ms)
    ✔ cloud build failure records failed check and returns BUILD_FAILED (0.2591ms)
    ✔ cloud remote timeout cleanly produces TIMEOUT error code (0.2007ms)
    ✔ cloud adapter output truncation caps stdout/stderr at maxOutputBytes (64 KiB) (0.4897ms)
    ✔ sanitizeSandboxOutput redacts unquoted tokens, Bearer auth, and structured JSON without leaking secrets (1.1999ms)
    ✔ post-allocation abort fencing: destroys newly allocated sandbox if signal was aborted mid-flight (49.777ms)
    ✔ independent adapter-level timeout races and terminates hanging provider RPCs (45.5622ms)
    ✔ cleanup failure tracking: retains session for reconciliation and supports retryDestroy (1.1937ms)
    ✔ forwards fail-closed network egress policy to provider during sandbox creation (0.4624ms)
    ✔ strict byte budgeting: sanitizeSandboxOutput never exceeds maxBytes regardless of truncation marker or unicode (0.7981ms)
    ✔ late allocation + destroy failure: retains failed sandbox destruction in pending destructions and allows retry (43.2704ms)
    ✔ late RPC completion fencing: late provider execution after timeout or session stop does not mutate verification evidence (123.2011ms)
    ✔ provider error message sanitization: redacts sensitive credentials from allocation reasons and RPC error messages (0.7385ms)
  ✔ 8. Isolated Cloud Sandbox Adapter with Simulated Remote MicroVM (270.2459ms)
✔ GigaAgent Isolated Sandbox Adapter & Cloud Security Gate (17T-47) (309.5246ms)
ℹ tests 29
ℹ suites 9
ℹ pass 29
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 850.07
```

### B. Full Backend CI Test Evidence (GitHub Actions & Real PostgreSQL 16.15)

```text
ℹ tests 457
ℹ suites 64
ℹ pass 457
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```
- Total tests: 457 / 457 PASS
- Zero failures, zero skipped in GitHub Actions CI container.
- Environment: PostgreSQL 16.15 on Alpine Linux (`image: postgres:16-alpine`), Node.js 22.

### C. Typecheck & Build Status

- `npm run typecheck` (`tsc --noEmit`): **PASS (0 errors)**
- `npm run build` (`tsc -p tsconfig.build.json`): **PASS (0 errors)**

---

## 6. Handoff & Governance Checklist

- [x] Evaluated 3 Cloud Sandbox solutions with authentic sources and documented official pricing (\$0.1332/hr compute).
- [x] Recommends **E2B** (GO) and documents reasons for **Fly.io** (NO-GO for MVP).
- [x] Standardized `ExecutionRuntime` adapter contract without breaking merged 17T-45 and 17T-46 contracts.
- [x] Dual-layer mode permission enforcement: Ask and Plan deny write and execution; Execute permits bounded sandbox actions.
- [x] Enforces strict invariant INV-07: zero host shell executions on API server.
- [x] Canonical secret redaction: extracted to `redaction.ts` and verified with regression tests.
- [x] Post-allocation abort fencing & reconciliation: failed destructions recorded in `this.sessions` with `destroyStatus: 'destroy_failed'` and recoverable via `retryDestroy()`.
- [x] Independent adapter-level wall-clock timeout & late RPC fencing: late provider completions after timeout or stop are fenced from mutating `session.verifiedChecks`.
- [x] Provider error sanitization: all allocation reasons and command error messages are sanitized and bounded.
- [x] Strict byte budget: `sanitizeSandboxOutput` guarantees `byteLength <= maxBytes` accounting for truncation marker.
- [x] Network egress policy enforced fail-closed at adapter boundary and honestly labeled as pending live cloud validation.
- [x] 29/29 sandbox tests passing; 457/457 total backend tests passing.
- [x] Zero billable cloud resources provisioned during development or testing.
- [x] Evidence document updated at `docs/evidence/17T-47-sandbox-preflight.md`.
- [x] Ready to push updated commit to Draft PR #33 for Thư's re-review.
