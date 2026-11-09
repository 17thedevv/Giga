# Local IaaS Docker evidence — 17T-92

Tracking: [17T-92](https://linear.app/17thedev/issue/17T-92/prepare-local-iaas-ready-docker-compose-infrastructure) · [Draft PR #49](https://github.com/17thedevv/Giga/pull/49) · [Local runbook](../cloud/runbooks/IAAS_LOCAL_DOCKER_V0.1.md)

## Verified revision

- Implementation SHA: `01c21d242614120dfcf9ec90b12429817fbdd2a7`. The smoke artifact records this SHA in both reports.
- Environment: Ubuntu 24.04 GitHub runner, Docker 28.0.4, Compose 2.38.2, Node 22.23.4, PostgreSQL 16.15 and Chrome 156.0.8078.79.
- Reports captured on 2026-11-09 at 08:27:35 (HTTP) and 08:28:02 (HTTPS) Asia/Bangkok. UTC timestamps: `2026-11-09T01:27:35.417Z` and `2026-11-09T01:28:02.138Z`.
- This document records the tested implementation revision. See the [PR checks](https://github.com/17thedevv/Giga/pull/49/checks) for the status of subsequent documentation commits.

| Workflow | Result | Evidence |
| --- | --- | --- |
| Backend CI | PASS. 652 tests with real PostgreSQL, 0 skipped | [Backend run](https://github.com/17thedevv/Giga/actions/runs/42545472226) |
| Local Docker Compose smoke | PASS. Clean image build, 6 config checks, 17 HTTP/container checks, 5 HTTPS checks | [Docker run](https://github.com/17thedevv/Giga/actions/runs/42545472255) · [Redacted reports](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| Validate Git Workflow | PASS on the tested implementation revision | [Git workflow run](https://github.com/17thedevv/Giga/actions/runs/42545804222) |

The artifact contains the sanitized HTTP and HTTPS reports and expires on
2026-11-23. Fixture SSE made zero live provider calls. The Chrome tests used
loopback HTTP. The HTTPS client verified a disposable localhost certificate
using explicit trust. Public HTTPS, live provider acceptance and cloud recovery
remain separate release gates.

## Migration 017 and review fixes

- Migration 015 retains its original SQL. Forward migration 017 repairs legacy
  grants in the shared runner used by production auto-migrate and the one-shot
  Compose migration service. The API container receives the runtime credential
  alone. Migration history is readable and runtime writes are denied.
- Migration 017 limits future-table defaults and removes sequence `UPDATE`
  while preserving `USAGE` and `SELECT`. Restricted quota and lifecycle grants
  remain in place. Startup checks each required CRUD privilege on the ordinary
  application tables.
- Each environment file selects its own Nginx allowlist. `--from` creates a new
  env file for the selected origin and profile while preserving all five
  PostgreSQL credentials. The smoke switches the existing volume to HTTPS and
  verifies that the HTTP conversation is still present.

## Acceptance matrix

| ID | Check | Result | Evidence |
| --- | --- | --- | --- |
| D01 | Clean Node 22 image build with API, web bundle and contracts | PASS | [Build step](https://github.com/17thedevv/Giga/actions/runs/42545472255) |
| D02 | Fresh Compose config, migration job, readiness and `/health` | PASS | [Compose run](https://github.com/17thedevv/Giga/actions/runs/42545472255) |
| D03 | Frontend assets and deep links, API JSON routing | PASS | [HTTP report](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| D04 | Register, login, authenticated routes and logout, including rejected old session | PASS | [HTTP report](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| D05 | Missing/foreign Origin rejected and cookie attributes match HTTP/HTTPS profile | PASS | [HTTP and HTTPS reports](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| D06 | Account, conversation and session data survive restart | PASS | [HTTP report](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| D07 | Incremental SSE through Nginx using a deterministic fixture | PASS | [SSE timing](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| D08 | Real role logins, denied privileged writes and finalizer access | PASS | [HTTP report](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| D09 | Backup and restore preserve fixture rows, ownership and grants in a fresh disposable database | PASS | [HTTP report](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| D10 | Agent cloud execution stays unavailable with Chat disabled and with fixture Chat enabled | PASS | [HTTP report](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| D11 | Invalid configuration, missing migrations and excessive role membership fail closed | PASS | [HTTP report](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| D12 | PostgreSQL and API have no host-published ports | PASS | [HTTP report](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| D13 | Record container resources, image size and database size | PASS | [Reports](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| D14 | Chrome protected deep link, login, reload and logout. TLS verified separately | PASS | [Reports](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| D15 | Unknown `Host` rejected at HTTP and HTTPS ingress | PASS | [Reports](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| D16 | Independent peer starts the stack and restores a backup into a disposable database. The other peer verifies the result | PENDING | [D16 procedure](../cloud/runbooks/IAAS_LOCAL_DOCKER_V0.1.md#d16-independent-startup-and-restore) |
| D17 | Migration job exits successfully and API restarts with only runtime credentials | PASS | [HTTP report](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| D18 | New tables require an explicit runtime grant | PASS | [Role checks](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| D19 | Legacy sequence ACLs repaired. New sequence defaults deny `UPDATE` and allow `USAGE, SELECT` | PASS | [Role and upgrade checks](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| D20 | Production auto startup applies 017 on empty PostgreSQL and upgrades a populated 016 database with legacy ACLs. Rerun applies no migrations | PASS | [Migration regression](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| D21 | Each missing `SELECT`, `INSERT`, `UPDATE` or `DELETE` grant independently blocks startup | PASS | [Migration regression](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739) |
| D22 | Two origins get distinct allowlists and the source env and all database credentials survive reconfiguration | PASS | [Config checks](https://github.com/17thedevv/Giga/actions/runs/42545472255) |
| D23 | HTTP volume starts under the HTTPS profile with the existing credentials and still contains the HTTP fixture conversation | PASS | [HTTPS switch step](https://github.com/17thedevv/Giga/actions/runs/42545472255) |

## Measurements

The fixture stream started at 1 ms, delivered deltas at 612, 1,214 and 1,817 ms,
and completed at 1,821 ms. These timings demonstrate delivery through the
proxy using a deterministic adapter.

| Profile | API memory / CPU | Nginx memory / CPU | PostgreSQL memory / CPU |
| --- | --- | --- | --- |
| Loopback HTTP | 18.93 MiB / 0.04% | 4.25 MiB / 0.00% | 66.29 MiB / 0.04% |
| Loopback HTTPS | 20.22 MiB / 0.00% | 4.656 MiB / 0.00% | 27.09 MiB / 0.03% |

These snapshots were taken after the smoke workload. The memory limits are
768 MiB for API, 128 MiB for Nginx and 512 MiB for PostgreSQL. The image sizes
were 249,963,108 bytes (API and migration service share one image),
435,423,250 bytes (PostgreSQL), and 62,313,481 bytes (Nginx). The HTTP smoke
database size was 9,829,399 bytes. Peak load and minimum VM size require
separate measurement. [Resource reports](https://github.com/17thedevv/Giga/actions/runs/42545472255/artifacts/13643176739)

## Local checks for the implementation revision

Windows / Node 24.20.0: API typecheck passed. The focused API config, server
and migration suite passed 19 tests with 2 real-PostgreSQL tests skipped.
The 6 infrastructure config tests and JavaScript syntax checks passed.
The container runs above used the Ubuntu CI runner because the Windows
checkout had no Docker engine.

## Open M0 gates

The automated local infrastructure gate passed on the verified revision.
Independent GitHub approval and D16 are pending. The authorized reviewer and
operators record their own evidence. Merge and issue closure follow the
release roadmap after approval, D16 and current PR checks pass. PR #49 is
Draft and 17T-92 is In Progress as of 2026-11-09.
