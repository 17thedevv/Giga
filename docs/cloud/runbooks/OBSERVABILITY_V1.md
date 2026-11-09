# Giga Core local operations

Use this with the [local IaaS runbook](IAAS_LOCAL_DOCKER_V0.1.md). Run commands from the checkout on the Docker host using an operator account and the same Compose project and env file used for startup.

## Logs and trace

The API emits JSON lines to stdout. A request has a server-generated UUID in its `X-Request-ID` response header. Search for that ID in both API and Nginx logs. A valid opaque UUID supplied as `X-Correlation-ID` is hashed and appears only in API logs. The request ID header is additive and available to same-origin clients. API payloads, auth, CSRF and SSE frames retain their existing behavior under the draft API contract.

Request logs carry the UTC timestamp, service, environment, severity, HTTP method, matched route pattern, status, duration in milliseconds and a fixed category for errors. Chat adds a terminal record for each stream on the same request ID. Nginx adds a status and duration in seconds, including proxy errors before the API returns a response. Requests rejected before reaching the API have an empty edge request ID.

Only predefined metadata is serialized. Keep passwords, credentials, cookies, lease tokens, provider responses, URL paths and query strings, prompts and private files out of logs and evidence. Nginx emits only critical native errors. PostgreSQL native logs use fatal/terse output and suppress statement logging. Review startup and native process diagnostics before sharing them. Restrict Docker socket, backup files and operational logs to trusted operators.

Docker rotates each service's logs at 10 MB with at most three files. The collector uses the last five minutes and at most 4,000 lines per selected service. Logs can be dropped under API stdout backpressure. Rotation, backpressure and a capped window can lower the observed counts. Preserve a redacted snapshot and exact SHA for incidents that need longer retention.

## Health checks

| Condition | Public `/health` | Internal `/ready` | Operator action |
| --- | --- | --- | --- |
| Required configuration, runtime role and migration 017 present | 200 | 200 | Run the collector for aggregate signals |
| PostgreSQL unavailable after startup | 200 while the process is up | 503 | Inspect PostgreSQL and runtime connectivity |
| Schema missing migration 017 | Startup may fail | 503 if API is running | Review migration job and compatible image |
| Required configuration invalid | API startup fails | Unreachable | Validate the private env file and role grants |
| Optional Chat or Agent Cloud disabled | 200 | 200 | Review `chatConfigured` and `agentCloud` locally |
| API stopped or restarting | Proxy failure | Unreachable | Inspect Compose state and restart events |
| Collector unavailable | Independently check liveness | Independently check readiness | Verify Docker and the operator's access |

The management listener binds to the API container's `127.0.0.1:3001`. Docker uses `/ready` as the API health check. The separate `/ops` route returns read-only aggregate PostgreSQL, Chat and Agent counts. There is no published management port or proxy to this listener. The existing runtime login supplies the reads. Keep migration, admin, quota and lifecycle credentials scoped to their own jobs.

```sh
docker compose --env-file .env ps --all
curl -fsS http://localhost:8080/health
docker compose --env-file .env exec -T api node -e 'fetch("http://127.0.0.1:3001/ready").then(async r=>{console.log(await r.text()); process.exitCode=r.ok?0:1})'
node infra/docker/monitor.mjs /absolute/private/giga-backups .env
```

The collector prints one JSON sample. Exit 0 means no configured alerts fired and exit 2 means at least one alert or a collection problem. CPU and memory percentages are Docker samples, restart counters come from container metadata, disk percentages come from the PostgreSQL data filesystem and the backup directory, and database bytes come from PostgreSQL. Manually restarting or replacing a container can reset or bypass Docker's automatic restart count. Compare container state and successive samples when diagnosing churn.

## Alerts

Defaults below are starting thresholds for local testing. Tune using the host's observed baseline. Use shell environment variables when invoking the collector. In CI, failures and high resource usage are distinct from a partially collected sample.

| Code | Default trigger | Response |
| --- | --- | --- |
| `api_unavailable`, `nginx_unavailable` | API stopped/unready or Nginx unhealthy | Check Compose state, Nginx/API trace IDs and PostgreSQL readiness. Confirm image SHA and startup guards before restart. |
| `postgres_unavailable`, `migration_failed` | PostgreSQL stopped/unhealthy or migrate exited nonzero | Check volume, free space and role provisioning. Recover PostgreSQL and verify schema migration 017. Inspect migration status before another attempt. |
| `authentication_failures` | 10 login 401s in 5 min, `GIGA_OPS_AUTH_FAILURES` | Check login and CSRF behavior with a fixture account. Correlate requests and investigate repeated failures with the operator. |
| `*_resource_high`, `disk_low` | 85% CPU, memory or disk, `GIGA_OPS_CPU_PERCENT`, `GIGA_OPS_MEMORY_PERCENT`, `GIGA_OPS_DISK_PERCENT` | Compare consecutive samples, restart counts and backup volume usage. Free verified expendable files under the retention policy. Preserve the database volume. |
| `edge_5xx`, `stream_failures` | 5 edge 5xx or 5 unsuccessful SSE terminals in 5 min, `GIGA_OPS_ERRORS`, `GIGA_OPS_STREAM_FAILURES` | Match request IDs to API categories. Check PostgreSQL and then the configured Chat provider. Disconnects can be ordinary client activity. |
| `backup_incomplete`, `backup_stale` | Latest attempt pending/failed or no successful archive within 26 h, `GIGA_OPS_BACKUP_HOURS` | Check the archive job, PostgreSQL and disk. Keep the last verified archive. Rerun to a new path and verify a disposable restore. |
| `postgres_pool_waiting` | 3 waiters at sampling, `GIGA_OPS_WAITING` | Check long transactions and load, then verify readiness. Recheck pool recovery before changing limits. |
| `chat_stuck` | Pending or streaming generation older than 5 min | Compare the stream terminal event and generation age. Check dependency and lease state. Use the reviewed recovery path for the generation. |
| `agent_queue_stuck`, `agent_lease_expired`, `agent_worker_failures` | Queued 15 min, expired active lease, or attempted run failed in the last 24 h | Inspect durable run state with the owner. Verify fencing and cancellation before retrying. |
| `agent_cleanup_failed`, `agent_allocation_ambiguous`, `agent_provider_failures` | Failed/expired cleanup, unresolved ambiguous allocation, or failed/timed-out allocation updated in the last 24 h | Preserve the durable lifecycle record and bring in the Agent owner. Resolve uncertainty before retrying or settling a reservation. |
| `agent_quota_exhausted`, `agent_quota_reconciliation` | Limit event in the last 24 h or reservation needs reconciliation | Check the quota event and reservation ledger with the owner. Preserve fail-closed admission and cost controls. |
| `monitor_unavailable`, `monitor_partial`, `log_window_capped` | Docker collection failed, a source is missing, or log window may be truncated | Check Docker/Compose access and host disk. Verify sources independently and treat partial counts as lower bounds. |

`GIGA_OPS_ANOMALIES` sets the minimum anomaly count for Chat and Agent alerts and defaults to 1. Admission, completion and cancellation counts cover the last 24 hours. Pending-state metrics are sampled when the collector runs. A cleanup failure may remain visible until reviewed recovery clears the durable state. These aggregates contain no owner IDs, prompts, handles or estimated provider spend. Local tests exercise simulated Agent states.

## Backup and incident recovery

Run the backup on a schedule with a unique archive path inside a private directory. The sidecar changes from `pending` to `complete` after a successful nonempty dump, or to `failed` on dump failure. An interruption can leave it pending. Retain or prune archive/sidecar pairs together and keep fewer than 1,000 markers per monitored directory. Backups from before sidecars need a new verified backup to establish freshness.

```sh
sh infra/docker/backup.sh --local --env-file .env /absolute/private/giga-backups/giga-drill.dump
sh infra/docker/restore-disposable.sh --local --env-file .env /absolute/private/giga-backups/giga-drill.dump
```

For the HTTPS profile, omit `--local` and pass the HTTPS env file.

Follow the [disposable restore procedure](IAAS_LOCAL_DOCKER_V0.1.md#backup-and-recovery) to verify fixture data, ownership and runtime grants in the generated `giga_restore_test_*` database. The completion sidecar proves the dump command succeeded. Record the restore check separately. For an outage, record the SHA, timestamps, alert codes and request IDs, then verify liveness, readiness and an authenticated operation after recovery. Restore to an isolated target. Follow the [rollback procedure](IAAS_LOCAL_DOCKER_V0.1.md#application-rollback-and-migration-compatibility) if the image or migration is suspect.

## Future single Droplet

Use the HTTPS profile and a reviewed TLS certificate. Keep ports and runtime roles as specified in the IaaS runbook. Keep the collector on the host and use an operator-owned systemd timer or cron job to run it at intervals that avoid overlapping probes. Store bounded, access-controlled output and route exit 2 to the approved local incident process. Track backup freshness using private storage with an off-host encrypted copy and rehearse restore on an isolated target. Re-measure resource usage and backup/restore time on the selected host before adopting any threshold or recovery objective.
