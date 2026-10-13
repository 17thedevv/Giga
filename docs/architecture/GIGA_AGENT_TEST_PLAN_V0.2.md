# GigaAgent — Behavioral, Sandbox, Security & E2E Acceptance Plan v0.2

> **NOT EXECUTED.** [17T-24](https://linear.app/17thedev/issue/17T-24/redesign-gigaagent-as-agentic-workspace-with-sandbox-runtime). Pair with [Runtime Security](GIGA_AGENT_RUNTIME_SECURITY_V0.2.md), [Agent API](../contracts/GIGA_AGENT_API_V0.2.md), [Architecture](GIGA_AGENT_ARCHITECTURE_V0.2.md).

## 1. Test environments and evidence

| Layer | Environment | Evidence |
|---|---|---|
| Unit | Fake runner / LLM / artifact store | Tool schema errors, policies, steps, budgets and state transitions |
| Contract | HTTP fixture runner + typed API client | Request/response/errors, SSE events and unknown-event handling |
| PostgreSQL integration | Dedicated disposable test DB (never application DATABASE_URL) | Migrations, owner queries, atomic events, leases, idempotency |
| Sandbox security | Isolated disposable VM/container environment with measurable boundaries | Escape/secret/egress/CPU/memory attacks blocked |
| Browser E2E | Actual deployed HTTPS topology | Cookie/CSRF, files, SSE replay, approvals, artifact access |
| Cloud operations | Controlled staging with explicit cost approval | Cold start, runner restart, backup/restore, cancellation and rollback |
| Model/tool quality | Deterministic fixture project tasks + allowed model | Real files, shell exit codes, repair and artifacts, not only generated text |

No passing test marks production isolation safe without the provider-specific boundary review.

## 2. Test matrix

| ID | Scenario | Expected |
|---|---|---|
| AG-01 | Create blank workspace without GitHub | 201 workspace, no repo required |
| AG-02 | User B guesses A workspace/run/event/artifact ID | Generic 404, no leaked data |
| AG-03 | New Execute run with valid workspace | queued then running, budget reserved |
| AG-04 | Ask/Plan mode requests write or shell | Deny, no file modification |
| AG-05 | Execute creates/edit files inside sandbox | Changes only authorized workspace |
| AG-06 | Execute asks to read host secret/DB URL | Denied by isolation and policy |
| AG-07 | Tool has unknown name/malformed args | Rejected before execution, safe error |
| AG-08 | Tool output contains prompt-injection | No policy override / unauthorized action |
| AG-09 | Build passes with recorded exit code | Verified check stored and visible |
| AG-10 | Build fails then bounded repair succeeds | Loop at most configured max, record results |
| AG-11 | Build never passes / provider fails | Failed/partial not falsely completed |
| AG-12 | Infinite process / fork / huge output | Runtime resource limit enforced |
| AG-13 | Archive contains ../, symlink or ZIP-slip | Rejected, no write outside workspace |
| AG-14 | SSRF/internal metadata URL / DNS redirect | Network denied under policy |
| AG-15 | Sandbox tries Cloud IAM/host socket access | No credentials/capability available |
| AG-16 | User cancels running build | Process tree stopped, state durable |
| AG-17 | User closes browser during run | Worker continues safely, events replay |
| AG-18 | SSE reconnect with Last-Event-ID | Missing persisted events replay, no duplicate action |
| AG-19 | Unknown SSE event | Client ignores safely; no crash |
| AG-20 | Two workers claim same run | Lease fencing prevents double effects |
| AG-21 | Tool execution timeout ambiguous | Reconcile effect key before retries |
| AG-22 | Crash between artifact upload and DB commit | Consistent status, orphan cleanup |
| AG-23 | Simultaneous writable runs for workspace | Version lock/409/queue policy, no overwrite |
| AG-24 | Approve untrusted/external write without grant | Rejected |
| AG-25 | Approval hash/target expired or altered | 409, no remote action |
| AG-26 | Duplicate approval/idempotency key retry | Exactly one durable decision/effect |
| AG-27 | Cancel after external commit | Honest partial/irreversible disclosure |
| AG-28 | Freeform task generates PR? | PR optional, not automatic on all tasks |
| AG-29 | Source ZIP download | Authorized owner only, hash matches manifest |
| AG-30 | Preview HTML on app authenticated origin | Blocked; isolate preview origin |
| AG-31 | Workspace deleted while runner active | Stop/deny writes, retention cleanup policy enforced |
| AG-32 | GigaChat personal Memory present | Agent cannot read it implicitly |
| AG-33 | Upstream LLM/token budget exceeded | Terminated with actual budget and safe error |
| AG-34 | No sandbox runtime provisioned | Clear unavailable state, no execution on API host |
| AG-35 | User instructions after terminal run | New run required (unless reviewed resume extension) |

## 3. MVP golden E2E (must pass before claiming "Agent works")

- Authenticated user creates blank workspace; no repository/GitHub credentials connected.
- Run in Execute asks to create responsive React task manager.
- Runner creates actual files in isolated filesystem and executes build/test.
- Observe real tool outputs, optional bounded repair and verification.
- Persist snapshot and ZIP to durable store; verify hash and authorized download.
- Refresh/reconnect UI during run; replay events without restarting tools.
- Cancel a second run and confirm subprocess is stopped.
- User B denied access to all artifacts/run events.
- Include shell command, exit code, runtime ID (non-sensitive), artifact checksum and model usage in redacted evidence. If code cannot be run, report this as an unpassed E2E.

## 4. Contract and security freeze gates

1. Trà/Thư approve new workspace-centric routes and remove legacy required repository assumption from actual Frontend.
2. Secure runner provider, isolation boundary and egress policy pass independent review.
3. Use disposable DB tests compliant with 17T-23 safeguards, no silent pg-mem substitution when real PostgreSQL is required.
4. Browser on actual HTTPS deploy passes session cookie/CSRF/SSE/approval and download tests.
5. Cost/quotas, retention, destroy/restart, Cloud provider billing reviewed; no unauthorized provisioning.
6. Tests and artifacts recorded as evidence; only then consider freezing accepted API under ADR-001.

No tests in this plan are marked passed merely because the PR changes Markdown.
