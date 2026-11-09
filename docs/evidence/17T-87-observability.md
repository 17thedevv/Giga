# 17T-87 local observability evidence

[Linear 17T-87](https://linear.app/17thedev/issue/17T-87/add-backend-observability-audit-trails-and-sandbox-cost-operations) · [Operations runbook](../cloud/runbooks/OBSERVABILITY_V1.md)

## Review scope

This change uses the Compose stack from Draft [PR #49](https://github.com/17thedevv/Giga/pull/49) at `35321bcd8291b7d234e7a406add7d6fe08135de2`. Review the observability delta against `build/17t-92-local-iaas-compose`. Trà owns the backend scope and received the proposed interface and stack boundary in Linear. Independent review is pending. After an authorized PR #49 merge, coordinate retargeting with the owner and verify that the diff against `main` includes only the 17T-87 changes before rerunning CI.

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

The Docker workflow writes sanitized JSON and summaries to its smoke artifact. `ops-report.json` records the exact commit, one collector sample, elapsed wall time, collector process CPU time and smoke process RSS before and after collection. Docker CPU and memory readings are point-in-time service samples. Collector process CPU excludes child Docker commands. The RSS readings include the smoke harness. There is no dedicated monitoring container or ongoing host collector process. Reproduce capacity measurements on the intended host before setting production limits.

The scope covers Core/local readiness, aggregate Agent signals, and fake provider scenarios. Production capacity, cloud provider cleanup, off-host recovery and failover require separate evidence.
