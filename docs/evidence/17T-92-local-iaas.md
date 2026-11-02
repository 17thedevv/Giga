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
- Exact implementation SHA tested in containers: **NOT RUN / pending CI**.
  The base SHA above is not an implementation-test claim. The smoke workflow
  must check out and record the exact PR head SHA rather than an implicit merge
  ref. Update this field with the observed run artifact before claiming PASS.
- Draft PR/run URL/artifact: pending publication and execution.
- Intended owner: Trà; intended reviewer/cross-trainee: Thư, from the parent
  deployment task. Agent work is not attributed to either human. Review and
  cross-training are **NOT RUN**.

## Local execution limitation

Preflight on the Windows host found no `docker`, Podman/containerd CLI, Docker
installation/service/daemon, or installed WSL distribution. `wsl --status` and
`wsl --list --verbose` reported WSL is not installed. Host Node was 24.20.0,
not the target Node 22 runtime. No software was installed and no service state
was changed to work around this. Actual Docker acceptance is therefore blocked
on this host and must come from an observed Ubuntu CI run or a second developer
with Linux containers available.

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

All rows below require observed container evidence. The committed test harness
and workflow are procedures until an actual run result is attached.

| ID | Check | Provider/data | Result | Evidence |
| --- | --- | --- | --- | --- |
| D01 | No-cache Node 22 multi-stage image build, contracts and runtime Web bundle | No provider | NOT RUN | Pending Docker CI |
| D02 | Configured Compose startup, PostgreSQL/API readiness and `/health` | Real PostgreSQL containers | NOT RUN | Pending Docker CI |
| D03 | Frontend assets and deep links; API-first JSON routing | Built production bundle | NOT RUN | Pending Docker CI |
| D04 | Register/login/me/logout, old-session rejection and protected routes | Disposable accounts | NOT RUN | Pending Docker CI |
| D05 | CSRF missing/foreign Origin rejection and cookie attributes | HTTP profile; HTTPS separate | NOT RUN | Pending Docker CI |
| D06 | Account/conversation persistence after database/API restart | Disposable PostgreSQL data | NOT RUN | Pending Docker CI |
| D07 | Separated SSE deltas arrive before completion through Nginx | Deterministic injected provider; **not live AI** | NOT RUN | Pending Docker CI timing |
| D08 | Runtime cannot perform restricted quota/lifecycle writes or use finalizer authority | Real role logins and PostgreSQL grants | NOT RUN | Pending Docker CI |
| D09 | Backup and fresh disposable restore preserve test data and permissions | Real PostgreSQL dump/restore | NOT RUN | Pending Docker CI |
| D10 | Agent/cloud execution remains unavailable with Chat off and fixture Chat | No E2B/Agent allocation | NOT RUN | Pending Docker CI |
| D11 | Missing/invalid/placeholder/duplicate config fails safely; production role checks active | Negative configuration fixtures | NOT RUN | Pending Docker CI |
| D12 | No host-published PostgreSQL/API port | Docker port bindings | NOT RUN | Pending Docker CI |
| D13 | Actual memory/CPU/image/data size measured | Smoke workload only | NOT RUN | Pending Docker CI metrics |
| D14 | Browser Real-mode login, refresh, deep link, logout and cookie/CSRF checks | Actual target origin | NOT RUN | Peer/browser acceptance open |
| D15 | Independent peer startup/recovery exercise | Human cross-training | NOT RUN | Reviewer sign-off open |

## Evidence capture rules

Record ISO-8601 timestamps, exact source SHA, Docker/Compose/Node/PostgreSQL
versions, command exit codes and assertion/timing summaries. CI artifacts may
contain the sanitized smoke report and resource measurements. They must not
contain generated `.env` files, cookies, raw request bodies with passwords,
database URLs, database dumps, TLS keys, provider keys or environment dumps.
Use test account aliases, not personal data. A successful fixture stream proves
transport behavior only; label any future live Gemini test separately.

## Resources and outstanding gates

- Host inventory observed by preflight: 12 logical CPUs and approximately
  16 GiB memory; this is not a measured stack requirement.
- Application resource consumption: **NOT MEASURED** on this host. Proposed
  container memory ceilings are not load-test results or a Droplet size claim.
- No DigitalOcean provisioning, public HTTPS test, live AI call, E2B allocation,
  external secret change, default-branch write or merge was performed.
- INV-05 production managed-storage policy needs a reviewed decision before
  future self-managed VM acceptance. Local named-volume persistence does not
  prove host-loss recovery.
- Render's existing deployment evidence/security follow-ups remain historical
  and unchanged; this task does not resolve its credential incident.
- The API v0.1 contract remains DRAFT. Human peer review, browser acceptance,
  complete new-host recovery and cloud preflight remain open.
