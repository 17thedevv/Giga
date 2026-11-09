# 17T-87 local observability evidence

[Linear 17T-87](https://linear.app/17thedev/issue/17T-87/add-backend-observability-audit-trails-and-sandbox-cost-operations) · [Operations runbook](../cloud/runbooks/OBSERVABILITY_V1.md)

## Review scope

This change uses the Compose stack from Draft [PR #49](https://github.com/17thedevv/Giga/pull/49) at `35321bcd8291b7d234e7a406add7d6fe08135de2`. Review the observability delta against `build/17t-92-local-iaas-compose`. Trà owns the backend scope and received the proposed interface and stack boundary in Linear. Independent review is pending. After an authorized PR #49 merge, coordinate retargeting with the owner and verify that the diff against `main` includes only the 17T-87 changes before rerunning CI.

## Verified source and CI

The implementation was exercised at `4a16202a246e07406e14996794cf3807bf28d764` on Draft [PR #53](https://github.com/17thedevv/Giga/pull/53).

| Check | Outcome |
| --- | --- |
| [Backend CI](https://github.com/17thedevv/Giga/actions/runs/42580500306) | Typecheck and build passed. Real PostgreSQL suite passed 657 tests with zero skips. |
| [Local Docker Compose smoke](https://github.com/17thedevv/Giga/actions/runs/42580500274) | HTTP and HTTPS passed. Verified fresh startup and 016 upgrade, roles, disposable restore, browser, SSE, restart, outage and backup signals. |
| [Validate Git Workflow](https://github.com/17thedevv/Giga/actions/runs/42580500277) | Branch, PR body and commit conventions passed. |

Local typecheck, build, five focused API tests, ten infrastructure tests, six Git policy tests and diff checks passed. The local full suite reported 564 passed, 25 failed and 32 skipped. Loopback restrictions and pg-mem limitations affected the local run. The GitHub run above exercised all 657 tests with real PostgreSQL.

## Coverage

| Scenario | Evidence source |
| --- | --- |
| Secret-bearing error, request-ID propagation, provider failure and bounded records under concurrent requests | API observability test |
| Database failure, pre-017 schema, concurrent probe deadline and optional services disabled | API observability test and disposable Compose smoke |
| Invalid bearer credential and private management listener | Public API rejection and cross-container reachability check in Compose smoke |
| API restart, PostgreSQL outage and failed/complete backup markers | Disposable Compose operations smoke |
| Backup/restore, real auth, fixture SSE, browser, fresh startup and upgrade from 016 | Existing Compose smoke on the exact proposed SHA |
| Stale queued Agent run and disabled provider | Real PostgreSQL test with a synthetic run |
| Cleanup, ambiguous allocation, quota anomalies and collector unavailable | Monitor unit tests with synthetic inputs |

## Resource sample

The [Docker smoke job](https://github.com/17thedevv/Giga/actions/runs/42580500274/job/129037780941) recorded `ops-report.json` on Ubuntu 24.04 after restoring PostgreSQL availability and completing a backup. The collector returned zero alerts with schema 17 and zero pool waiters. See the [sanitized smoke artifact](https://github.com/17thedevv/Giga/actions/runs/42580500274/artifacts/13657515302).

| Signal | Observed |
| --- | --- |
| One collector invocation | 3.270 s wall time and 19 ms CPU in the Node process |
| Smoke process RSS before and after collection | 68,247,552 bytes (65.1 MiB) at both points |
| API / Nginx / PostgreSQL CPU | 0.02% / 0.00% / 6.08% |
| API / Nginx / PostgreSQL memory relative to container limits | 3.24% / 3.48% / 5.55% |
| PostgreSQL data filesystem usage | 42% |

Docker CPU and memory readings are point-in-time service samples. Collector CPU excludes child Docker commands and the RSS readings include the smoke harness. There is no dedicated monitoring container or ongoing host collector process. The sample measures collector cost in CI. An API load baseline and target host capacity measurements remain outstanding.

The scope covers Core/local readiness, aggregate Agent signals, and fake provider scenarios. Production capacity, cloud provider cleanup, off-host recovery and failover require separate evidence.
