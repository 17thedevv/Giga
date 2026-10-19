# Verification Evidence — Linear 17T-69: Implement E2B Cloud Sandbox provider client behind disabled feature gate

**Date:** 2026-10-19<br>
**Linear Task:** [17T-69](https://linear.app/17thedev/issue/17T-69/implement-e2b-cloud-sandbox-provider-client-behind-disabled-feature)<br>
**Branch:** `feat/17t-69-e2b-provider-adapter`<br>
**PR Title:** `feat(agent): implement e2b cloud sandbox provider client behind disabled feature gate`<br>
**Owner:** Trà (Agent / Backend)<br>
**Peer Reviewer:** Tráng A Thư (Frontend / UX)<br>
**Independent Reviewer:** ChatGPT<br>
**Status:** DRAFT / PENDING REVIEW (Feature Gate Disabled by Default, 0 Billable Cloud Operations)

---

## 1. Executive Summary & Purpose

This task implements the **E2B Cloud Sandbox provider client** (`E2bCloudSandboxProviderClient`) conforming to the standardized typed `CloudSandboxProviderClient` interface established in 17T-47.

**Strict Feature Gate Invariant:**
The E2B Cloud Sandbox provider client is **strictly disabled by default**:
- Zero live cloud sandbox sessions are provisioned on application startup or runtime execution.
- No live network requests to `https://api.e2b.dev` are performed by default or during automated test runs.
- The provider client cannot be auto-enabled merely by having an `E2B_API_KEY` present; it strictly requires `GIGA_AGENT_E2B_ENABLED=true` (or explicit `enabled: true`).
- Fails closed on missing or invalid configuration.
- Fails closed when network egress policy demands isolation or allowlisting without proof of enterprise VPC / egress firewall guarantees.
- Invariant **INV-07** is strictly maintained: no model-generated shell commands are ever executed on the Hono/API host, and no fallback to host shell or local Docker exists.
- Capability discovery (`GET /api/v1/agent/capabilities`) truthfully advertises that `cloudRuntime` and `runExecution` are disabled (`{ available: false, reason: 'runtime_unavailable' }`).
- E2B-specific types and internal details are strictly isolated in `apps/api/src/modules/agent/e2b-provider.ts` and never leaked into public API contracts or DTOs.

---

## 2. Architecture & Abstraction Mapping

### Architecture Topology

```
[ Giga API Host (Hono Control Plane) ]
       │
       │  (Strict INV-07: ZERO child_process / host terminal execution)
       ▼
[ ExecutionRuntime Interface ]
       │
       ▼
[ IsolatedCloudSandboxAdapter ]
       │
       │  Wraps any CloudSandboxProviderClient with:
       │  - Server-side Mode Gate (Ask / Plan deny writes & commands)
       │  - Path Traversal Fencing (isSafeRelativePath)
       │  - Secret Fencing (drops host process.env; injects only GIGA_SANDBOX, GIGA_WORKSPACE_ID, etc.)
       │  - Post-Allocation Abort Fencing
       │  - 64 KiB Output Truncation & Credential Redaction
       │  - Independent Adapter-Level Wall-Clock Timeout
       │  - Late Result Fencing (late RPC completions discarded from verifiedChecks)
       │  - Cleanup Failure Tracking & Reconciliation
       │
       ▼
[ E2bCloudSandboxProviderClient ] (implements CloudSandboxProviderClient)
       ├── Feature Gate Validation (enabled: boolean, default: false)
       ├── Credential & Config Validation (fails closed on newline, bad timeout, malformed template/domain)
       ├── Network Isolation Policy Gate (fails closed if isolation is demanded without VPC guarantee)
       ├── Forbidden Secret Variable Gate (rejects DATABASE_URL, JWT_SECRET, GEMINI_API_KEY, GITHUB_TOKEN)
       ├── Output Bounding & Sanitization (Buffer.byteLength <= maxOutputBytes, redaction of e2b_*, Bearer, etc.)
       ├── Session Tracking & Destruction Idempotency (handles repeated destroy safely)
       │
       ▼
[ Pluggable E2bTransport Interface ]
       ├── MockE2bTransport (used in test suite: 100% in-memory, 0 network, 0 costs)
       └── Real E2B SDK / API Transport (dynamically imported when package 'e2b' is installed)
```

### Abstraction Method Mapping

| `CloudSandboxProviderClient` Interface | `E2bCloudSandboxProviderClient` Implementation | E2B SDK / Wire Protocol Mapping |
|---|---|---|
| `readonly providerName: string` | `'e2b'` | Fixed provider identifier |
| `createSandbox(params)` | `createSandbox(params)` | `transport.createSandbox(options)` -> `Sandbox.create(template, options)` |
| `executeCommand(sandboxId, params)` | `executeCommand(sandboxId, params)` | `sandbox.commands.run(command, { timeoutMs, cwd, envs, signal })` |
| `readFile(sandboxId, path)` | `readFile(sandboxId, path)` | `sandbox.files.read(path)` |
| `writeFile(sandboxId, path, content)` | `writeFile(sandboxId, path, content)` | `sandbox.files.write(path, content)` |
| `listFiles(sandboxId, pathPrefix?)` | `listFiles(sandboxId, pathPrefix?)` | `sandbox.files.list(path)` (returns array of `E2bEntryInfo`) |
| `createSnapshot(sandboxId)` | `createSnapshot(sandboxId)` | Iterates `listFiles`, reads file bytes, computes SHA-256 digests |
| `destroySandbox(sandboxId)` | `destroySandbox(sandboxId)` | `sandbox.kill()` (idempotent, safe on duplicate calls) |
| *(Inspection helper)* | `getSandboxStatus(sandboxId)` | Returns `'active' \| 'destroyed' \| 'unknown'` |
| *(Inspection helper)* | `activeSandboxCount` | Returns active non-destroyed sandbox count |

---

## 3. E2B SDK Version & Technology Analysis

- **Target SDK Package:** Pinned official `e2b: "2.56.0"` in `apps/api/package.json` and lockfile.
- **Core Abstractions & Mapping:**
  - `Sandbox.create(template?, options)`: Provisions Firecracker MicroVM on AWS bare metal (KVM).
  - `sandbox.commands.run(command, options)`: Bounded process execution returning `{ exitCode, stdout, stderr, error }`.
  - `sandbox.files.read(path)` / `sandbox.files.write(path, content)`: Filesystem RPC.
  - `sandbox.files.list(path)`: Returns `EntryInfo[]` (`{ name, path, type: 'file' | 'directory' | 'symlink', size }`).
  - `sandbox.kill()`: Immediate VM teardown.
- **Transport Architecture & Testability:**
  - Real transport `createRealE2bTransport(sdkSeam?: E2bSdkSeam)` connects to the official `e2b` SDK.
  - When `transport` is omitted in `E2bCloudSandboxProviderClient`, it defaults to `createRealE2bTransport()`.
  - An injected seam `E2bSdkSeam` allows 100% deterministic test coverage of the real SDK mapping without making live network calls.
  - `MockE2bTransport` is preserved for deterministic in-memory regression tests with zero external network access, zero child processes, and zero billing impact.

---

## 4. Security Guarantees & Verification Matrix

### Verified Guarantees (Proven in Automated Test Suite)

| # | Security Scenario | Status | Evidence / Verification Method |
|---|---|---|---|
| 1 | **Feature Gate Disabled by Default** | **VERIFIED** | Calling `createSandbox` with `enabled: false` immediately throws `FEATURE_GATE_DISABLED`; transport `createdCount` remains 0; adapter returns `RUNTIME_UNAVAILABLE`. |
| 2 | **Missing API Key Fail-Closed** | **VERIFIED** | Missing/empty `apiKey` with `enabled: true` throws `MISSING_API_KEY` before transport. |
| 3 | **Invalid Config & Security Fencing** | **VERIFIED** | Rejects plain HTTP endpoints and untrusted hosts with `SECURITY_VIOLATION`; requires `networkIsolationProof` when `networkIsolationGuaranteed: true` (`INVALID_CONFIG`); fails closed on newlines or invalid timeouts. |
| 4 | **Network Isolation Policy Gate** | **VERIFIED** | `loadE2bConfigFromEnv` rejects raw boolean without auditable VPC proof (`E2B_VPC_GATEWAY_ID` + `E2B_EGRESS_FIREWALL_VERIFIED === 'true'`); provider fails closed with `NETWORK_ISOLATION_UNSUPPORTED` when egress policy demands isolation without proof. |
| 5 | **Strict Invariant INV-07 (No Host Shell)** | **VERIFIED** | `child_process.exec`, `spawn`, `execSync` spied on; zero child processes spawned on success, failure, timeout, or abort. |
| 6 | **Create Session Lifecycle** | **VERIFIED** | Verifies metadata forwarding (`workspaceId`, `ownerId`), safe env injection, and tracking of active sessions. |
| 7 | **Execute Mocked Command** | **VERIFIED** | Returns bounded exit code, stdout, stderr, and duration; properly handles non-zero exit codes. |
| 8 | **Read/Write/List & Traversal Fencing** | **VERIFIED** | Verifies file operations; path traversal attacks (`../`, `/etc/shadow`, `C:\`, null bytes) throw `SECURITY_VIOLATION`. |
| 9 | **Stop / Cancel Responsiveness** | **VERIFIED** | Aborted `AbortSignal` immediately halts execution with `EXECUTION_ABORTED`. |
| 10 | **Destroy Session** | **VERIFIED** | Calling `destroySandbox` terminates handle and removes session from active map. |
| 11 | **Duplicate Destroy Idempotency & Cleanup Retry** | **VERIFIED** | Repeated destroy is a safe no-op. Failed `kill()` preserves entry and status so retry can succeed without false success (Blocker 2). |
| 12 | **Timeout Bounding** | **VERIFIED** | Commands exceeding `timeoutMs` throw `EXECUTION_TIMEOUT`; adapter cleanly returns `errorCode: 'TIMEOUT'`. |
| 13 | **Pre-Allocation Abort Fencing** | **VERIFIED** | Signal aborted before allocation completes cancels sandbox creation. |
| 14 | **Provider Disconnect Handling** | **VERIFIED** | Connection resets / network errors fail closed with `PROVIDER_ERROR` without unhandled rejections. |
| 15 | **Late Response Fencing** | **VERIFIED** | Late provider responses resolving after timeout do not mutate `verifiedChecks`. |
| 16 | **Lease Expiration Fencing** | **VERIFIED** | Orchestrator halts with `status: 'fenced'` if worker lease expires before or during turn. |
| 17 | **Shared Output Budget & Truncation** | **VERIFIED** | Enforces a single shared UTF-8 byte budget across both `stdout` and `stderr` combined (default 64 KiB), inclusive of truncation markers; redaction preserved after truncation (Blocker 4). |
| 18 | **Secret Redaction** | **VERIFIED** | `e2b_` API keys, Bearer tokens, passwords, and sensitive envs are redacted to `[REDACTED_KEY]` or `[REDACTED]`. |
| 19 | **Public DTO & Capability Hygiene** | **VERIFIED** | `getAgentCapabilities()` contains zero provider secrets or lease tokens; `cloudRuntime.available` is `false`. |
| 20 | **Cross-Owner Access Denial** | **VERIFIED** | Prohibits passing host secrets (`DATABASE_URL`, `JWT_SECRET`); rejects tenant mismatches on duplicate prepare (`TENANT_MISMATCH`). |
| 21 | **Adapter Signature / SDK Drift** | **VERIFIED** | `E2bCloudSandboxProviderClient` strictly satisfies `CloudSandboxProviderClient` interface. |
| 22 | **Real E2B SDK Transport Mapping** | **VERIFIED** | `createRealE2bTransport` maps lifecycle, commands, files, and kill to injected `E2bSdkSeam`; provider defaults to real transport when omitted (Blocker 1). |

### Unverified Provider Guarantees (Flagged as Blockers for Live Testing)

1. **Hardware Egress Allowlisting on Standard E2B:**
   - Standard public E2B microVMs have full outbound internet access by default.
   - Granular egress domain allowlisting (e.g. restricting outbound traffic exclusively to `registry.npmjs.org`) requires an E2B Enterprise VPC or custom iptables/eBPF routing.
   - **Status:** Fail-closed at adapter boundary (`NETWORK_ISOLATION_UNSUPPORTED`).
2. **Metadata Endpoint SSRF Protection in Custom Templates:**
   - Default E2B instances block link-local metadata addresses (`169.254.169.254`). Custom user-provided templates must be vetted before deployment.
3. **Cold-Start Latency SLA under High Load:**
   - Sub-250ms cold starts are documented by E2B, but sustained concurrency under burst traffic requires cloud load testing before production enablement.

---

### 5. Automated Test Evidence

### A. Dedicated E2B Provider Suite (`apps/api/tests/agent/agent-e2b-provider.test.ts`)

```text
▶ E2B Cloud Sandbox Provider Client (17T-69)
  ▶ 1. Feature gate disabled → không dispatch
    ✔ createSandbox fails closed when enabled is false or omitted (1.6801ms)
    ✔ executeCommand fails closed when enabled is false (0.3366ms)
    ✔ loadE2bConfigFromEnv defaults to disabled even if E2B_API_KEY is present (0.1451ms)
    ✔ IsolatedCloudSandboxAdapter with disabled E2B provider fails prepare closed with RUNTIME_UNAVAILABLE (1.2042ms)
  ✔ 1. Feature gate disabled → không dispatch (4.2471ms)
  ▶ 2. Missing API key → fail closed
    ✔ fails closed when enabled is true but apiKey is missing or empty (0.4034ms)
  ✔ 2. Missing API key → fail closed (0.4882ms)
  ▶ 3. Invalid provider configuration → fail closed
    ✔ fails closed on newline characters in apiKey (0.1236ms)
    ✔ fails closed on non-positive defaultTimeoutMs (0.1107ms)
    ✔ fails closed on invalid maxOutputBytes (0.1186ms)
    ✔ fails closed on invalid template name containing disallowed characters (0.1258ms)
    ✔ fails closed on plain HTTP or unapproved endpoint domains (Blocker 3) (0.2933ms)
    ✔ fails closed when networkIsolationGuaranteed is true but networkIsolationProof is missing (Blocker 3) (0.1071ms)
  ✔ 3. Invalid provider configuration → fail closed (1.1068ms)
  ▶ 4. Missing network/isolation guarantee → fail closed
    ✔ loadE2bConfigFromEnv does not trust raw boolean without auditable VPC proof (Blocker 3) (0.0954ms)
    ✔ fails closed when egressEnabled is false and networkIsolationGuaranteed is not true (0.2409ms)
    ✔ fails closed when allowlist is specified and networkIsolationGuaranteed is not true (0.127ms)
    ✔ succeeds when networkIsolationGuaranteed is true (0.8401ms)
  ✔ 4. Missing network/isolation guarantee → fail closed (1.4384ms)
  ▶ 5. Strict Invariant: No host-shell fallback (INV-07)
    ✔ never calls child_process on provider creation, execution, timeout, or failure (0.4589ms)
  ✔ 5. Strict Invariant: No host-shell fallback (INV-07) (0.5346ms)
  ▶ 6. Create session lifecycle
    ✔ creates session, passes metadata, and tracks active status (0.2889ms)
  ✔ 6. Create session lifecycle (0.3466ms)
  ▶ 7. Execute mocked command
    ✔ executes command and returns bounded exit code, stdout, stderr and duration (0.2053ms)
  ✔ 7. Execute mocked command (0.3183ms)
  ▶ 8. Read/write/list mocked files
    ✔ performs isolated file operations and prevents path traversal (0.9768ms)
    ✔ captures immutable snapshot with exact file hashes (7.2668ms)
  ✔ 8. Read/write/list mocked files (8.3608ms)
  ▶ 9. Stop/cancel
    ✔ aborts in-flight execution when signal is aborted (0.2684ms)
  ✔ 9. Stop/cancel (0.3345ms)
  ▶ 10. Destroy
    ✔ kills sandbox and removes from active registry (0.1937ms)
  ✔ 10. Destroy (0.2549ms)
  ▶ 11. Duplicate destroy idempotency
    ✔ safely handles repeated destroySandbox calls without error or duplicate transport kills (0.1708ms)
    ✔ failed destroy retains sandbox entry and status so retry can successfully destroy without false success (Blocker 2) (0.3287ms)
  ✔ 11. Duplicate destroy idempotency (0.5694ms)
  ▶ 12. Timeout
    ✔ throws EXECUTION_TIMEOUT when command exceeds effective timeout (52.6736ms)
  ✔ 12. Timeout (53.2471ms)
  ▶ 13. Abort
    ✔ aborts allocation when signal is aborted before createSandbox completes (0.3774ms)
  ✔ 13. Abort (0.4721ms)
  ▶ 14. Provider disconnect
    ✔ fails closed with PROVIDER_ERROR when provider connection is lost (0.2286ms)
  ✔ 14. Provider disconnect (0.2808ms)
  ▶ 15. Late response fencing
    ✔ late provider execution after adapter timeout does not mutate verification evidence (140.1252ms)
  ✔ 15. Late response fencing (140.3254ms)
  ▶ 16. Lease expiration fencing
    ✔ orchestrator rejects run progression when worker lease expires (0.8477ms)
  ✔ 16. Lease expiration fencing (0.9125ms)
  ▶ 17. Output truncation/bounds
    ✔ strictly truncates output exceeding maxOutputBytes with truncation marker (0.3661ms)
    ✔ enforces one shared UTF-8 byte budget across both stdout and stderr combined in executeCommand (Blocker 4) (2935.3631ms)
    ✔ boundCombinedOutput allocates shared budget fairly and redacts secrets after truncation (Blocker 4) (3.2028ms)
  ✔ 17. Output truncation/bounds (2939.0512ms)
  ▶ 18. Secret redaction
    ✔ redacts E2B API keys, Bearer tokens, and sensitive env variables in outputs and errors (0.2024ms)
  ✔ 18. Secret redaction (0.2823ms)
  ▶ 19. Public DTO không có provider secret/lease token
    ✔ capabilities discovery response contains no provider secrets or credentials and reflects disabled runtime (0.5633ms)
  ✔ 19. Public DTO không có provider secret/lease token (0.6911ms)
  ▶ 20. Cross-owner access denial
    ✔ rejects attempt to pass sensitive environment variables into E2B sandbox (0.2703ms)
    ✔ rejects duplicate prepare on active session with mismatched tenant or mode (0.1593ms)
  ✔ 20. Cross-owner access denial (0.4954ms)
  ▶ 21. Adapter signature/SDK drift detection
    ✔ verifies E2bCloudSandboxProviderClient strictly satisfies CloudSandboxProviderClient interface (0.0717ms)
  ✔ 21. Adapter signature/SDK drift detection (0.1055ms)
  ▶ 22. Real E2B SDK transport mapping (Blocker 1)
    ✔ createRealE2bTransport correctly maps lifecycle, commands, files, and kill to injected SDK seam (0.8925ms)
    ✔ E2bCloudSandboxProviderClient defaults to createRealE2bTransport when transport is omitted (0.0649ms)
  ✔ 22. Real E2B SDK transport mapping (Blocker 1) (1.0139ms)
✔ E2B Cloud Sandbox Provider Client (17T-69) (3156.2013ms)
ℹ tests 39
ℹ suites 23
ℹ pass 39
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3544.2889
```

### B. Sandbox Adapter Regression Suite (`apps/api/tests/agent/agent-sandbox.test.ts`)

- **Tests:** 35 / 35 PASS (0 failures, 0 skipped).

### C. Capability Contract Regression Suite (`apps/api/tests/agent/agent-contract.test.ts`)

- **Tests:** 11 / 11 PASS (0 failures, 0 skipped).

### D. Full Backend Test Suite (`apps/api`)

- **Tests:** 518 total tests (493 PASS, 0 FAIL, 0 cancelled, 25 skipped for TEST_DATABASE_URL).
- **Duration:** 40.53s.

### E. Frontend Test Suite (`apps/web`)

- **Test Files:** 11 / 11 passed.
- **Tests:** 139 / 139 passed (0 failures).

### F. TypeScript Compilation & Git Workflow

- `apps/api`: `npm run typecheck` (`tsc --noEmit`) -> **PASS (0 errors)**.
- `apps/api`: `npm run build` (`tsc -p tsconfig.build.json`) -> **PASS (0 errors)**.
- `apps/web`: `npm run typecheck` (`tsc --noEmit`) -> **PASS (0 errors)**.
- Root: `node .agents/scripts/validate-skills.mjs` -> **PASS (all 8 skills)**.
- Root: `node --test .agents/scripts/validate-git-workflow.test.mjs` -> **PASS (6 tests)**.
- Root: `git diff --check apps/api/` -> **PASS (clean whitespace, 0 errors)**.

---

## 6. Known Risks, Blockers & GO/NO-GO Recommendation

### Known Risks
1. **Network Egress Isolation on Public E2B:**
   - Standard E2B sandbox instances allow internet egress. Running untrusted model-generated code without an enterprise VPC egress gateway could allow data exfiltration to unauthorized endpoints.
   - **Mitigation:** The provider client explicitly fails closed when `egressEnabled: false` or domain allowlists are requested, unless `networkIsolationGuaranteed: true` is configured.
2. **Third-party Provider Dependency & Outage:**
   - E2B API outages or network degradation could cause sandbox allocation failures.
   - **Mitigation:** Comprehensive fail-closed error handling (`PROVIDER_ERROR`, `EXECUTION_TIMEOUT`), zero host fallback, and session cleanup reconciliation.

### Blockers for Live Production Sandboxes
1. ADR-003 is still proposed for joint review and has not yet been formally adopted.
2. E2B Enterprise VPC / network isolation architecture has not been provisioned or vetted with actual cloud security penetration tests.
3. Billing and cost ceilings for live sandbox runs require authorization before provisioning paid cloud resources.

### Recommendation
- **E2B Provider Adapter Code:** **GO** (Ready for peer review and merge behind disabled feature gate).
- **Live Cloud Sandbox Execution:** **NO-GO** (Must remain disabled by default until ADR-003 adoption, network egress isolation infrastructure, and billing gates are approved).

---

## 7. Delivery Metadata & Next Steps

- **Branch:** `feat/17t-69-e2b-provider-adapter`
- **Draft PR URL:** [https://github.com/17thedevv/Giga/pull/41](https://github.com/17thedevv/Giga/pull/41)
- **Tracking Linear Issue:** [17T-69](https://linear.app/17thedev/issue/17T-69/implement-e2b-cloud-sandbox-provider-client-behind-disabled-feature)
- **Peer Reviewer:** Tráng A Thư (Frontend / UX)
- **Independent Reviewer:** ChatGPT

### Logical Next Backend Tasks
1. **Durable Background Execution Worker / Queue Polling:**
   - Bridge run admission to durable execution: implement a background worker that polls/claims queued runs from PostgreSQL via `AgentRepository.claimRun()` with lease heartbeat, and orchestrates execution steps using `AgentOrchestrator`.
2. **Workspace Run Cancellation Endpoint (`POST /api/v1/agent/runs/:id/cancel`):**
   - Implement durable user-initiated cancellation route that updates run state to `cancel_requested` and signals active worker/adapter sessions to abort gracefully.
3. **Artifact Storage & Checksummed ZIP Export Engine:**
   - Implement durable storage adapter for immutable snapshot ZIP files with SHA-256 checksums, enabling workspace exports without requiring GitHub repository integration.
