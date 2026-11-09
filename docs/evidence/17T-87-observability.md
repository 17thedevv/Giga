# 17T-87 local observability evidence

[Linear 17T-87](https://linear.app/17thedev/issue/17T-87/add-backend-observability-audit-trails-and-sandbox-cost-operations) · [Operations runbook](../cloud/runbooks/OBSERVABILITY_V1.md)

## Review scope

Draft [PR #53](https://github.com/17thedevv/Giga/pull/53) uses the Compose stack from Draft [PR #49](https://github.com/17thedevv/Giga/pull/49) at `35321bcd8291b7d234e7a406add7d6fe08135de2`. Review the observability delta against `build/17t-92-local-iaas-compose`. Trà owns the backend scope, with Thư as peer reviewer and independent code/security review pending. After independent approval and merge of #49, coordinate rebasing and retargeting #53 to `main`, verify the diff contains only 17T-87 changes, and rerun all three checks on the new HEAD.

## Verified source and CI

The Core observability implementation commit is `4a16202a246e07406e14996794cf3807bf28d764`. The exact reviewed PR HEAD tested by the three runs below is `385ae419ec2f5dad9a57bf3bf0a3832e91419b91`. That reviewed revision predates the readiness ACL fix. Use the [PR checks](https://github.com/17thedevv/Giga/pull/53/checks) and the `testedCommit` in the corresponding Docker artifact to verify the current HEAD.

| Check | Outcome |
| --- | --- |
| [Backend CI](https://github.com/17thedevv/Giga/actions/runs/42581651140) | Typecheck and build passed. Real PostgreSQL suite passed 657 tests with zero skips. |
| [Local Docker Compose smoke](https://github.com/17thedevv/Giga/actions/runs/42581651174) | HTTP and HTTPS passed. Verified fresh startup and 016 upgrade, roles, disposable restore, browser, SSE, restart, outage and backup signals. |
| [Validate Git Workflow](https://github.com/17thedevv/Giga/actions/runs/42581651129) | Branch, PR body and commit conventions passed. |

Local typecheck, build, five focused API tests, ten infrastructure tests, six Git policy tests and diff checks passed. The local full suite reported 564 passed, 25 failed and 32 skipped. Loopback restrictions and pg-mem limitations affected the local run. The GitHub run above exercised all 657 tests with real PostgreSQL.

## Coverage

| Scenario | Evidence source |
| --- | --- |
| Secret-bearing error, request-ID propagation, provider failure and bounded records under concurrent requests | API observability test |
| Database failure, pre-017 schema, concurrent probe deadline and optional services disabled | API observability test and disposable Compose smoke |
| Revoked and restored `SELECT`, `INSERT`, `UPDATE`, `DELETE` and database `CONNECT` after API startup | Disposable Compose operations smoke against real PostgreSQL. Each revocation returns generic readiness 503 with liveness 200. Each grant restores readiness without restarting the API. |
| Invalid bearer credential and private management listener | Public API rejection and cross-container reachability check in Compose smoke |
| API restart, PostgreSQL outage and failed/complete backup markers | Disposable Compose operations smoke |
| Backup/restore, real auth, fixture SSE, browser, fresh startup and upgrade from 016 | Existing Compose smoke on the exact proposed SHA |
| Stale queued Agent run and disabled provider | Real PostgreSQL test with a synthetic run |
| Cleanup, ambiguous allocation, quota anomalies and collector unavailable | Monitor unit tests with synthetic inputs |

## Resource sample

The [Docker smoke job](https://github.com/17thedevv/Giga/actions/runs/42581651174/job/129041543337) recorded `ops-report.json` on the GitHub Actions Ubuntu 24.04 runner for the reviewed HEAD above. The collector returned zero alerts with schema 17 and zero pool waiters after PostgreSQL recovered and a backup completed. See the [sanitized smoke artifact](https://github.com/17thedevv/Giga/actions/runs/42581651174/artifacts/13656963874).

| Signal | Observed |
| --- | --- |
| One collector invocation | 3.245 s wall time and 20 ms CPU in the Node process |
| Smoke process RSS before and after collection | 75,677,696 bytes (72.2 MiB) at both points |
| API / Nginx / PostgreSQL CPU | 0.01% / 0.00% / 0.02% |
| API / Nginx / PostgreSQL memory relative to container limits | 3.16% / 3.52% / 5.47% |
| PostgreSQL data filesystem usage | 42% |

Docker CPU and memory readings are point-in-time service samples. Collector CPU excludes child Docker commands and the RSS readings include the smoke harness. The collector runs on demand. All measurements describe the disposable CI stack. DigitalOcean capacity and API load overhead require measurement on the intended host.

## Linear acceptance scope

| Requirement | Status in #53 |
| --- | --- |
| Safe tracing and local operations | Implemented for request IDs, HTTP and Chat SSE categories, Compose readiness, database and backup signals, alerts and incident guidance. The management listener is loopback-only. |
| Agent worker, lifecycle and quota visibility | Implemented as aggregate reads of existing durable state for admission, cancellation, stuck runs, lease expiry, cleanup, ambiguous allocation and quota anomalies. Tested with local fixtures and simulated faults. Dedicated queue/tool latency and retry metrics, optional memory/plugin metrics, and an end-to-end worker-loss or over-budget operations exercise remain open. |
| Durable audit and operator actions | Deferred. Existing run and lifecycle state supports monitoring, while audit events for permissions, approvals, configuration and cleanup attempts require an explicit event schema, retention and access review. Role-gated reporting and idempotent operator retry/kill actions require authorization and fencing tests. |
| Sandbox cost operations | Deferred pending approval of provider access, budget controls and a reconciliation policy. Quota anomaly counts and simulated provider faults cover local behavior. Live billed usage, invoice matching and orphan recovery remain unverified. |

**Proposed follow-up for product-owner approval.** Specify an append-only, redacted operations audit trail with actor, action, target and outcome, a retention policy, role-gated access, and isolated tests for denied access, duplicates and worker/cleanup failures. Define idempotent retry and kill actions against the existing fencing rules. For cost reconciliation, first compare synthetic usage and charge fixtures with documented tolerances and a mismatch workflow. Treat read-only live provider reconciliation as a separate approval gate with scoped access and an agreed cost limit. Keep the existing Linear criteria open until the owner approves the split.
