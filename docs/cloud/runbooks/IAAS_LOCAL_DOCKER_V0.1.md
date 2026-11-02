# Local IaaS-ready Docker stack

Status: DRAFT; local-only implementation and verification tracked by
[17T-92](https://linear.app/17thedev/issue/17T-92/prepare-local-iaas-ready-docker-compose-infrastructure).
Intended deployment owner: Trà. Intended peer reviewer and cross-trainee: Thư,
from the existing deployment task; no human review or rehearsal is claimed.
See [the evidence record](../../evidence/17T-92-local-iaas.md) for exact tested
SHAs, commands, results and remaining gates.

## Scope and architecture

```text
Browser -> Nginx -> Hono :3000 -> PostgreSQL 16 :5432
                    |                |
                    + React bundle   + named Docker volume
```

Nginx is the only published service. Hono serves the built `apps/web/dist`
bundle with `SERVE_WEB=true`; browser requests use the same origin for `/api`.
The application image builds both apps from the repository root, including
`packages/contracts`, and runs the application as a non-root user. Runtime
images are pinned by immutable digest. PostgreSQL and API readiness checks
control startup order. The database has no host port mapping and uses an
internal network. Service restart policies handle process or host restarts;
they are not a substitute for backup or monitoring.

This work deliberately uses a local named PostgreSQL volume. It persists
through container replacement and `docker compose down`, but does not survive
disk loss or volume deletion. [INV-05](../../architecture/INVARIANTS_V0.1.md)
currently requires managed durable storage for production. A future self-managed
VM deployment needs an explicit reviewed storage-policy decision, durable disk
and off-host backup/recovery plan before production acceptance. This local
runbook does not silently amend that invariant or authorize cloud resources.
The [Render evidence](../../evidence/17T-12-demo-deployment.md) remains historical
evidence for that separate topology.

No Agent execution worker or E2B provider is wired into the application startup
path. Agent capabilities must continue reporting cloud execution unavailable,
including when Chat is explicitly enabled. No sandbox key is required or passed
to this stack. Chat and BYOK are disabled in the generated configuration; no
provider calls are needed for local acceptance.

## Prerequisites

- A Linux Docker engine and Docker Compose **2.30 or newer**; Docker Desktop
  must be configured for Linux containers on Windows/macOS. The local override
  uses Compose `!override` to replace published ports.
- Node.js 22 to run the configuration and smoke tools. Application builds run
  inside the pinned Node 22 build image, independently of host Node.
- Git, access to the source revision, and network access to Docker Hub/npm for
  the first build. Backup/restore examples use Bash; Windows operators can use
  Git Bash with the Docker CLI available.
- Sufficient free disk for images, build cache, the PostgreSQL volume and a
  separate backup. Container memory ceilings are initial guardrails:
  API 768 MiB, PostgreSQL 512 MiB and Nginx 128 MiB; build-time consumption is
  additional. These are configuration limits, not measured minimum VM sizing.
- Run all commands below from the repository root in a dedicated local/test
  checkout. Never use existing production credentials or production data here.

Verify prerequisites without printing secrets:

```bash
git rev-parse HEAD
node --version
docker version
docker compose version
```

## First-time local HTTP configuration

```bash
node infra/docker/configure.mjs --local
docker compose config --quiet
docker compose up -d --build --wait
docker compose ps
curl --fail http://localhost:8080/health
```

The generator creates ignored root `.env` with distinct randomly generated
database credentials and the local-only Compose selection. It refuses to replace
an existing configuration; preserve that file with its data volume. The file
contains `COMPOSE_PATH_SEPARATOR=|` and
`COMPOSE_FILE=compose.yaml|infra/docker/compose.local.yaml`, so subsequent
`docker compose up -d --build` starts the complete configured stack without
extra flags. `.env.example` contains placeholders for manual review only; its
placeholder values must not be used as credentials. Do not run a credential-
revealing `docker compose config` or publish `docker inspect` environment output.

Open `http://localhost:8080/login`. A fresh production bundle defaults to Real
API mode; if an existing browser has saved Mock mode, select Real and verify
network requests go to this origin's `/api/v1` routes. Create only disposable
test accounts. Chat should report unavailable until separately configured;
a simulated answer is not a successful live-provider test.

The local override publishes only `127.0.0.1:8080` and explicitly allows an
insecure cookie for this loopback HTTP origin. `NODE_ENV=production` remains
set, so distinct-login and PostgreSQL role validation still run. The HTTPS
profile uses Secure cookies. Never copy the HTTP override to a public host.

For a different configuration filename:

```bash
node infra/docker/configure.mjs --local --output=.env.local
docker compose --env-file .env.local config --quiet
docker compose --env-file .env.local up -d --build --wait
```

Use the same `--env-file` for every later command against that stack. Do not
reuse the legacy development database password. The existing developer-only
workflow remains separate:

```bash
docker compose -f infra/docker/docker-compose.dev.yml up -d
```

That file publishes PostgreSQL for local tools and has intentionally different
credentials and storage; it is not the deployment profile.

## Database permissions and migration lifecycle

Initialization runs only when the deployment database volume is empty. It
creates the role groups required by existing migrations 015/016 and distinct
logins:

| Login | Purpose and boundary |
| --- | --- |
| `giga_admin` | Cluster bootstrap and backup/recovery; never the API login |
| `giga_migration` | Schema/migration owner; no superuser, createdb or createrole privilege |
| `giga_runtime` | Ordinary API access through `giga_api_runtime`; no quota/lifecycle finalizer or owner membership |
| `giga_lifecycle` | Only `giga_agent_lifecycle_finalizer`; restricted provider-authoritative routines |
| `giga_quota` | Only quota-finalizer access; reserved for that contract and never passed to the HTTP application |

The migration login can administer the precreated group memberships needed by
015/016. The special NOLOGIN quota/lifecycle owner roles can create objects in
the application schema to permit PostgreSQL ownership transfer; they are not
ordinary application identities. The lifecycle finalizer and quota finalizer
must remain separate. The API receives neither the bootstrap nor quota login
password.

Startup validates configuration, runs pending forward migrations with the
migration login, restricts ordinary runtime access to read-only `schema_migrations`, then
uses the existing production startup checks for runtime and lifecycle
connections. No broad table grants are applied after 015/016: doing so would
undo their column/function restrictions. No public API or DTO change is part of
this infrastructure setup; the existing API contract remains DRAFT.

Changing a password in `.env` does **not** change a role password in an existing
volume. A mismatch must fail startup. For a used volume, follow a separately
authorized credential-change procedure; never delete data or bypass role checks
to make startup pass. On a fresh disposable test volume, correct configuration
before retrying. Do not attach the deployment volume to the legacy dev service.

## Proxy, cookies and CSRF

Nginx sends `/api` traffic to Hono before frontend routes and preserves
application JSON 404 responses. Frontend deep links are served by Hono's
reviewed SPA route list. SSE uses HTTP/1.1 upstream, disabled buffering/caching
and a bounded read timeout; gzip must not recombine its events. Request bodies,
connection timeouts and response timeouts are bounded. Authenticated responses
are not cached. Proxy headers are set from the receiving connection rather than
trusting arbitrary client-supplied forwarded headers.

The exact public origin must match the configured allowed origin. Mutation
requests require an allowed `Origin`, or a trusted `Referer` fallback; missing
or foreign origins fail closed. Nginx must not fabricate an Origin header to
make a rejected request pass. Session cookies remain HttpOnly and SameSite=Lax;
the HTTPS profile also requires Secure. Security headers restrict framing,
content sniffing, referrers and browser permissions; validate the deployed
bundle before extending CSP restrictions.

## Operations and safe shutdown

```bash
docker compose ps
docker compose logs --tail=80 api nginx
docker compose restart api
docker compose up -d --wait
docker compose stop --timeout 30
docker compose up -d --wait
docker compose down --timeout 30
```

`stop` preserves containers and the database volume; `down` removes this
project's containers/network while retaining the named volume. Keep the same
Compose project name when restarting, otherwise a different named volume may
look like missing data. Do not use `down -v`, volume pruning or automated data
deletion as normal shutdown. Stop accepting requests and allow in-flight work
to complete before planned maintenance. PostgreSQL receives a clean shutdown;
unexpected host failure is still a recovery scenario.

## Backup and recovery

Backups contain user data and credential ciphertext. Store them outside source
control in access-controlled storage, encrypt off-host copies and record the
source image SHA and maximum migration version alongside them. Back up the
configuration separately through an approved secret store; never attach it to
PRs, CI artifacts or evidence. A backup on the VM's own disk does not cover VM
loss. The backup script uses the PostgreSQL 16 tools already in the database
container and checks errors before declaring success.

```bash
sh infra/docker/backup.sh --local /absolute/private/giga-test.dump
sh infra/docker/restore-disposable.sh --local /absolute/private/giga-test.dump
```

The restore drill must create a new randomly named `giga_restore_test_*`
database and refuse an existing target. It must never drop, overwrite or
restore into the running `giga` database. Ownership/ACLs are preserved with the
same precreated roles in this cluster; verify test-row counts and restricted
privileges on the restored copy. The smoke harness exercises this on disposable
data. A restore drill passing on the same cluster is not evidence of complete
new-host disaster recovery; that also needs role/bootstrap recreation, secret
recovery, off-host backup retrieval and application checks.

The restore script's final output line is the created database name. After
recording and checking that exact name, verify its grants with:

```bash
docker compose exec -T postgres psql -U giga_admin -d "$RESTORE_DB" -v ON_ERROR_STOP=1 < infra/docker/postgres/roles-check.sql
```

Set `RESTORE_DB` to the actual reported name; never use the serving `giga`
database as a restore target. Scripts also accept `--env-file PATH` for a
non-default configuration. They reject an existing backup output file and do
not drop a database on success or failure.

The disposable database is intentionally retained for inspection. Delete it
only after reviewing the exact name and confirming it is the drill database,
using an explicit, reviewed `dropdb` command for that name. Do not generalize a
database-name glob into a cleanup command.

## Application rollback and migration compatibility

Before rebuilding an accepted image, keep an immutable rollback tag and a fresh
backup. For example, replace `accepted-sha` with the exact recorded release SHA:

```bash
docker image tag giga-api:local giga-api:accepted-sha
docker compose up -d --build --wait
```

If only the application needs rollback and that older image is compatible with
the **current** database schema:

```bash
IMAGE_TAG=accepted-sha docker compose up -d --no-build --pull never --wait api
docker compose up -d --no-deps --wait nginx
curl --fail http://localhost:8080/health
```

The API startup runs forward migrations; switching images does not reverse a
migration. Do not edit `schema_migrations`, run unreviewed down SQL or restore
over the serving database. Review migration compatibility before each release:
test the older image against a disposable restored copy of the newer schema,
including auth, queries and role boundaries. If incompatible, stop rollout and
prepare a reviewed forward fix or a separate database recovery/cutover plan.
Keep the original data volume until that decision is approved.

Persist the selected rollback `IMAGE_TAG` in the private `.env` before later
whole-stack commands; a temporary shell override does not edit that file.
The proxy-only command uses `--no-deps` so it cannot select a different API image.

## Verification and acceptance checklist

The current exact-SHA container rehearsal passed on 2026-11-02: commit
`814f9ed71653a111fc693089b9354a2d34105e19`, Docker 28.0.4, Compose 2.38.2,
Node 22.23.4, PostgreSQL 16.15, on an Ubuntu 24.04 GitHub runner. Four guard
tests, 14 HTTP/container checks, and five local-TLS checks passed. The reports
record zero live provider calls. See the [run and redacted artifact](https://github.com/17thedevv/Giga/actions/runs/41408059589)
and the [acceptance/evidence record](../../evidence/17T-92-local-iaas.md).
The first HTTP smoke used Chrome against loopback HTTP. HTTPS auth/cookie checks
used a Node HTTP client with only the ephemeral localhost certificate trusted;
public HTTPS was not tested. The Windows host itself has no Docker/WSL engine.

The exact-SHA sample after the smoke workload was API 19.36 MiB, Nginx
4.387 MiB, and PostgreSQL 48.54 MiB for HTTP; 20.02, 4.605 and 31.41 MiB for
the HTTPS rehearsal. The PostgreSQL fixture database occupied 9,804,823 bytes.
Runtime image sizes were API 249,954,915 bytes, PostgreSQL 435,423,250 bytes,
and Nginx 62,313,481 bytes. These are end-of-smoke samples, not peak-load
measurements or VM-sizing evidence. The full measurement and SSE timing detail
is in the linked evidence record.

For the local HTTP smoke, use a dedicated project; the harness deliberately
creates test rows, restarts containers and temporarily substitutes a fixture
server. It refuses ordinary project names or a missing opt-in. It requires
Linux/Bash and installed Google Chrome; set `CHROME_BIN` if Chrome is at a
different executable path. The Ubuntu CI job supplies these prerequisites.

```bash
node infra/docker/configure.mjs --local
COMPOSE_PROJECT_NAME=giga-smoke-local docker compose up -d --build --wait
COMPOSE_PROJECT_NAME=giga-smoke-local GIGA_DOCKER_SMOKE=1 node infra/docker/tests/smoke.mjs
COMPOSE_PROJECT_NAME=giga-smoke-local docker compose down --timeout 30
```

Use a clean disposable checkout/configuration if `.env` already exists. Keep the
project name for all four commands; do not accidentally point the harness at a
shared database. The harness manages the fixture override and restores normal
startup afterward. Sanitized reports are written to
`artifacts/docker-smoke/report.json` and `artifacts/docker-smoke/summary.md`;
private dumps/configurations are excluded. Its browser checks use the real built
UI and HTTP API, while its provider is a deterministic fixture.

| Gate | Required observation |
| --- | --- |
| Clean build | Both apps compile in a no-cache Node 22 image build; contracts and web bundle import/serve at runtime |
| Startup/health | PostgreSQL is healthy before migration/API startup; API and Nginx healthy; `/health` succeeds |
| Frontend/routing | `/login`, `/chat` and a supported deep link return the built HTML; unknown `/api` stays JSON 404 |
| Authentication | Register/login/me/logout via Nginx; protected route returns 401; old cookie fails after logout |
| CSRF/cookies | Trusted mutation works; missing/foreign Origin rejected; cookie attributes match selected HTTP/HTTPS profile |
| Persistence | Disposable account and conversation remain after database/API container restart |
| Incremental SSE | At least two separated fixture deltas arrive before stream completion through Nginx; record timestamps |
| PostgreSQL boundaries | Restricted direct runtime writes and forbidden function execution fail; dedicated roles retain only required access |
| Backup/restore | Dump and fresh disposable restore preserve test rows, ownership and role restrictions |
| Agent disabled | Capabilities and run admission truthfully reject unavailable cloud execution with Chat off and under fixture Chat |
| Failure paths | Missing/placeholder/duplicate secrets, invalid origin and invalid role credentials fail safely |
| Network | PostgreSQL has no published host port; only intended Nginx ports are published |
| Resources | Record container memory/CPU, image sizes, data volume size and test workload; no sizing inference from limits alone |

The SSE fixture injects a deterministic provider into a test-only server and
mounts test files only for the smoke test. It exercises the actual API storage
and Nginx transport, not Gemini or E2B. Its test-only Chat-on configuration uses
a synthetic key, injects the deterministic engine and blocks external provider
transport; this also verifies that enabling Chat cannot enable Agent execution.
The normal image must not contain the
fixture server. **No live AI streaming, provider quota or sandbox-isolation
claim follows from this test.** Live provider tests require a separately
configured, bounded authorized run and must be identified as live in evidence.

For browser acceptance, use Real mode and inspect requests on the exact tested
origin. Register/login, refresh, navigate directly to a deep link, create and
reopen a conversation, log out, and verify a second tab cannot reuse the old
session. Confirm cookie attributes and foreign-origin mutation rejection. A
human peer must independently repeat startup or a recovery/troubleshooting
exercise before cross-training is accepted. Record NOT RUN when these have not
actually happened.

Resource observation commands (redact host paths and avoid environment dumps):

```bash
docker stats --no-stream
docker image ls giga-api
docker compose exec -T postgres psql -U giga_admin -d giga -Atc 'SELECT pg_size_pretty(pg_database_size(current_database()));'
docker system df
```

## Troubleshooting

| Symptom | Safe diagnosis/action |
| --- | --- |
| `!override` YAML error | Update Compose to the stated minimum; do not publish both HTTP and HTTPS port sets accidentally |
| Nginx will not start in base profile | Check the certificate directory, `fullchain.pem`/`privkey.pem`, file permissions and TLS hostname; use the explicit local override only for loopback HTTP |
| API unhealthy or role-validation failure | Review sanitized API logs and intended login memberships; check correct configuration/data-volume pairing; keep production validation enabled |
| Password authentication failed after editing env | Existing PostgreSQL initialization did not rerun; recover the original config or use an authorized password-change procedure |
| Login cookie does not persist | Check actual origin, Real mode, Secure versus local HTTP and browser storage; do not weaken global cookie/CSRF settings |
| Mutating API returns 403 | Send the exact allowed Origin; inspect browser origin/Referer; do not use wildcard origins |
| `/api` returns HTML or delayed SSE | Check API location precedence, proxy buffering/compression and direct versus proxy timing; preserve same-origin routing |
| App appears empty after restart | Check Compose project/config selection and attached volume before creating new data or deleting anything |
| Backup/restore fails | Preserve original dump, inspect errors, validate free space/tool version/roles; never retry into the serving database |

Logs and health checks are operational evidence, not proof of all application
flows. Review logs before sharing; never publish `.env`, database URLs, cookies,
provider keys, database dumps or certificate private keys.

## Future Ubuntu Droplet preflight — no provisioning in this task

1. Obtain explicit resource/region/size/budget authorization and verify current
   DigitalOcean limits/pricing. No DigitalOcean credential is needed for this
   local stack or its CI.
2. Resolve INV-05 for self-managed PostgreSQL through a reviewed decision. Define
   durable disk, off-host encrypted backup retention, tested recovery objectives,
   monitoring and an owner for PostgreSQL security updates.
3. Harden Ubuntu/SSH, install supported Docker/Compose, plan disk/memory capacity
   from measured workload, and permit only required ingress. PostgreSQL/API
   remain unpublished. Do not expose the Docker socket.
4. Point reviewed DNS to the authorized VM and obtain a valid certificate for
   that hostname. Provide `fullchain.pem` and `privkey.pem` in a private directory
   readable by Nginx, mount read-only, automate renewal and test reload/expiry.
   Certificate issuance/renewal is an operator prerequisite, not an implicit
   cloud or DNS action in this implementation.
5. Generate a separate HTTPS configuration, with no local HTTP override:

   ```bash
   node infra/docker/configure.mjs --origin=https://giga.example --tls-dir=/absolute/private/tls --output=.env.https
   docker compose --env-file .env.https config --quiet
   docker compose --env-file .env.https up -d --build --wait
   ```

   Keep the default loopback binding for rehearsal. Public exposure requires a
   reviewed explicit `GIGA_BIND_IP=0.0.0.0` setting and firewall/TLS checks.
   Validate HTTP redirects to HTTPS, Secure cookies, exact allowed origin,
   forwarded headers and incremental SSE on the final public URL. Never reuse
   local credentials for the VM.
6. Record the deployed immutable image/source SHA, migration version, health,
   resource consumption and independent browser/recovery evidence. Keep Agent
   cloud execution disabled. Enabling Chat is a separate explicit provider
   configuration with budget/token limits and secret handling; it does not
   enable Agent execution.

No public HTTPS, cloud durability, billable resource, production deployment,
secret rotation or human sign-off is asserted by this local runbook.

Implementation references: [Compose readiness ordering](https://docs.docker.com/compose/how-tos/startup-order/),
[Nginx proxy buffering and timeouts](https://nginx.org/en/docs/http/ngx_http_proxy_module.html),
[official PostgreSQL initialization behavior](https://hub.docker.com/_/postgres).
Image digests were resolved from the official Docker registry on 2026-11-02;
updates require rebuilding and repeating this acceptance suite.
