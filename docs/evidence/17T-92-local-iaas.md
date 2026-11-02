# Local IaaS Docker evidence — 17T-92

Tracking: [17T-92](https://linear.app/17thedev/issue/17T-92/prepare-local-iaas-ready-docker-compose-infrastructure).
Runbook: [Local IaaS-ready Docker stack](../cloud/runbooks/IAAS_LOCAL_DOCKER_V0.1.md).
Date: 2026-11-02, Asia/Bangkok (+07:00).

## Scope and source

- Scope: local Nginx, co-hosted Hono/React, PostgreSQL 16, role separation,
  backup/recovery and deterministic Docker smoke CI. No cloud resources,
  deployment, external credential change or live provider/sandbox call.
- Base inspected: `463646a44244b1aabfc0c597612f2c102d67f5b9` (latest `main`
  observed at preflight). The original checkout was on a different Agent feature
  branch with six unrelated frontend edits. Work was isolated in separate
  checkouts; those edits were excluded.
- Exact implementation SHA tested in containers: `2cf199975100c4cde96ad704ea9fb5e43c59394e`.
  Both the HTTP and HTTPS smoke reports identify this SHA; the subsequent PR
  head change records this evidence only.
- [Draft PR #49](https://github.com/17thedevv/Giga/pull/49), [successful Docker run #10](https://github.com/17thedevv/Giga/actions/runs/41409878121), [redacted run artifact](https://github.com/17thedevv/Giga/actions/runs/41409878121/artifacts/13124649078), [Git workflow validation](https://github.com/17thedevv/Giga/actions/runs/41409878127).
- Intended owner: Trà; intended reviewer/cross-trainee: Thư, from the parent
  deployment task. Agent work is not attributed to either human. Review and
  cross-training are **NOT RUN**.

## Local execution limitation

Preflight on the Windows host found no `docker`, Podman/containerd CLI, Docker
installation/service/daemon, or installed WSL distribution. `wsl --status` and
`wsl --list --verbose` reported WSL is not installed. Host Node was 24.20.0,
not the target Node 22 runtime. No software was installed and no service state
was changed to work around this. Actual Docker acceptance is therefore blocked
on this host. Actual container acceptance was run by the PR's Ubuntu 24.04 CI
job with Docker; the Windows limitation does not imply that the container tests
were skipped.

## Acceptance matrix

Local checks executed on Windows / Node 24.20.0 before publication:

| Command | Observed result |
| --- | --- |
| `npm ci --prefix apps/api --no-audit --no-fund` and equivalent `apps/web` command | PASS; lockfiles unchanged; host npm reported install-script policy warnings |
| `npm run typecheck --prefix apps/api` and `npm run build --prefix apps/api` | PASS, exit 0 |
| `npm run build --prefix apps/web` | PASS, exit 0; includes TypeScript check and Vite production bundle |
| API `npx tsx --test --test-concurrency=1 tests/config.test.ts tests/server.test.ts tests/web-ui.test.ts tests/health.test.ts tests/csrf.test.ts tests/auth-negative.test.ts tests/agent/agent-contract.test.ts tests/agent/agent-boundaries.test.ts` | 51 PASS, 4 PostgreSQL-specific SKIP, 0 FAIL; exit 0; in-process/pg-mem and local socket, not container evidence |
| `node --test infra/docker/tests/config.test.mjs` | 4 PASS, 0 SKIP, exit 0; validates HTTP/TLS profiles, credential separation and disabled Agent guards |
| `node --check` on infrastructure JavaScript; Git Bash `bash -n` on shell scripts | PASS, exit 0 |
| `node infra/docker/configure.mjs --local` | PASS; generated ignored credentials, no secret values recorded |
| `git diff --check` | PASS |

The exact-SHA Ubuntu run completed with a successful clean image build, Compose
startup, 14 HTTP smoke checks and 5 HTTPS rehearsal checks. The artifact is
redacted and retained until 2026-11-16.
The reports were captured at 2026-11-02T08:02:10.026Z (HTTP) and
2026-11-02T08:02:35.612Z (HTTPS), or 15:02 Asia/Bangkok.

| ID | Check | Provider/data | Result | Evidence |
| --- | --- | --- | --- | --- |
| D01 | No-cache Node 22 multi-stage image build, contracts and runtime Web bundle | No provider | PASS | [Run #41409878121](https://github.com/17thedevv/Giga/actions/runs/41409878121) |
| D02 | Compose startup, PostgreSQL/API readiness and `/health` | Real PostgreSQL containers | PASS | [Run #41409878121](https://github.com/17thedevv/Giga/actions/runs/41409878121) |
| D03 | Frontend assets and deep links; API-first JSON routing | Built production bundle | PASS | [Run #41409878121](https://github.com/17thedevv/Giga/actions/runs/41409878121) |
| D04 | Register/login/me/logout, old-session rejection and protected routes | Disposable accounts | PASS | [Chrome + HTTP smoke](https://github.com/17thedevv/Giga/actions/runs/41409878121/artifacts/13124649078) |
| D05 | CSRF missing/foreign Origin rejection and HTTP/HTTPS cookie attributes | HTTP and TLS profiles | PASS | [HTTP/HTTPS reports](https://github.com/17thedevv/Giga/actions/runs/41409878121/artifacts/13124649078) |
| D06 | Account/conversation/session persistence after database/API restart | Disposable PostgreSQL data | PASS | [HTTP smoke](https://github.com/17thedevv/Giga/actions/runs/41409878121/artifacts/13124649078) |
| D07 | Separated SSE deltas arrive before completion through Nginx | Deterministic injected provider; **not live AI** | PASS | Started 1 ms; deltas 610/1,213/1,815 ms; completed 1,819 ms; [report](https://github.com/17thedevv/Giga/actions/runs/41409878121/artifacts/13124649078) |
| D08 | Restricted quota/lifecycle writes and finalizer access denied to runtime | Real PostgreSQL role logins/grants | PASS | [Role check](https://github.com/17thedevv/Giga/actions/runs/41409878121/artifacts/13124649078) |
| D09 | Backup and new disposable restore preserve rows, ownership and grants | Real PostgreSQL dump/restore | PASS | [HTTP smoke](https://github.com/17thedevv/Giga/actions/runs/41409878121/artifacts/13124649078) |
| D10 | Agent/cloud execution unavailable with Chat disabled and explicit Chat-on fixture | No E2B allocation; external provider transport blocked | PASS | [HTTP smoke](https://github.com/17thedevv/Giga/actions/runs/41409878121/artifacts/13124649078) |
| D11 | Missing/invalid credentials and origin fail safely; production role validation stays active | Negative config and role fixtures | PASS | [Run #41409878121](https://github.com/17thedevv/Giga/actions/runs/41409878121) |
| D12 | PostgreSQL/API have no host-published ports; internal DB network verified | Docker container/network inspection | PASS | [HTTP smoke](https://github.com/17thedevv/Giga/actions/runs/41409878121/artifacts/13124649078) |
| D13 | Container memory, CPU, image sizes and database size measured | Smoke workload; idle snapshot | PASS | Values below and in [reports](https://github.com/17thedevv/Giga/actions/runs/41409878121/artifacts/13124649078) |
| D14 | Real browser login, refresh, protected deep link and logout; HTTPS client cookie/CSRF checks | Chrome on local HTTP; Node HTTPS client on disposable TLS | PASS | [HTTP/HTTPS reports](https://github.com/17thedevv/Giga/actions/runs/41409878121/artifacts/13124649078) |
| D15 | Unknown `Host` rejected on HTTP and verified HTTPS ingress before proxying/redirecting | Explicit raw HTTP/HTTPS Host headers | PASS | [HTTP/HTTPS reports](https://github.com/17thedevv/Giga/actions/runs/41409878121/artifacts/13124649078) |
| D16 | Independent peer startup/recovery exercise | Human cross-training | NOT RUN | Reviewer exercise remains open |

Infrastructure guard tests: 4 PASS on Node 22.23.4. Local API/Web checks above
remain separately reported: 51 API tests passed, 4 real-PostgreSQL tests were
skipped on Windows, and the infrastructure guard had 4 PASS.

Run #7 initially stopped at the Host rejection assertion: Node's Fetch API
ignored the supplied `Host` header, so the test did not send the intended
negative request. The harness was changed to use `node:http`; run #8 passed the
HTTP and HTTPS Host rejection checks. Run #9 then reached Chrome profile cleanup
but failed when a child process held the temporary directory open (`ENOTEMPTY`).
The browser runner now stops Chrome's Linux process group and retries profile
removal; run #10 passed the complete HTTP and HTTPS suites on the exact SHA above.

## Evidence capture rules

Record ISO-8601 timestamps, exact source SHA, Docker/Compose/Node/PostgreSQL
versions, command exit codes and assertion/timing summaries. CI artifacts may
contain the sanitized smoke report and resource measurements. They must not
contain generated `.env` files, cookies, raw request bodies with passwords,
database URLs, database dumps, TLS keys, provider keys or environment dumps.
Use test account aliases, not personal data. A successful fixture stream proves
transport behavior only; label any future live Gemini test separately.

## Measured resources and outstanding gates

- Host inventory observed by preflight: 12 logical CPUs and approximately
  16 GiB memory; this is not a measured stack requirement.
- Run time (2026-11-02 15:02 Asia/Bangkok): Docker 28.0.4, Compose 2.38.2,
  Node 22.23.4, PostgreSQL 16.15,
  Chrome 156.0.8078.47. No-cache multi-stage build, PostgreSQL 16.15 migration,
  role, auth, HTTPS, and restore checks completed.
- End-of-run Docker samples: HTTP API 18.64 MiB / 0.00% CPU, Nginx 4.402 MiB /
  0.00%, PostgreSQL 48.39 MiB / 0.02%; HTTPS API 19.92 MiB / 0.00%, Nginx
  5.023 MiB / 0.00%, PostgreSQL 31.62 MiB / 0.03%. Container memory limits are
  API 768 MiB, Nginx 128 MiB, PostgreSQL 512 MiB. These are brief smoke-test
  samples, not peak-load or VM-sizing results.
- Image sizes: API 249,954,915 bytes, PostgreSQL 435,423,250 bytes, Nginx
  62,313,481 bytes. Smoke database size: 9,804,823 bytes.
- No live provider requests were made. SSE exercised a deterministic adapter
  through the real PostgreSQL/API/Nginx container path. The HTTP test used
  Chrome; HTTPS auth/cookie checks used a Node HTTP client trusting only the
  ephemeral localhost test certificate. No public certificate or hostname was
  tested.
- No DigitalOcean provisioning, public HTTPS test, live AI call, E2B allocation,
  external secret change, default-branch write or merge was performed.
- INV-05 production managed-storage policy needs a reviewed decision before
  future self-managed VM acceptance. Local named-volume persistence does not
  prove host-loss recovery.
- Render's existing deployment evidence/security follow-ups remain historical
  and unchanged; this task does not resolve its credential incident.
- The API v0.1 contract remains DRAFT. Human peer review, browser acceptance,
  complete new-host recovery and cloud preflight remain open.
