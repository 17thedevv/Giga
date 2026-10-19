# Giga demo deployment and verification on Render

Status: DRAFT runbook; no deployment acceptance.
Issue: [17T-12](https://linear.app/17thedev/issue/17T-12).
Owner: Trà. Intended independent reviewer/cross-trainee: Thư; review not yet recorded.
Baseline source inspected: `f06d46462134f92f7626a515782f93e0c5f7f8e9`.
This runbook adds no API contract or schema change; API v1 remains DRAFT.

## 1. Scope and evidence

Use one deployment task for two separate decisions:

- **GigaChat Demo Acceptance:** hosted UI/API/Postgres, real provider, streamed output, durable history, auth/ownership/secrets and actual browser evidence.
- **Full Giga v0.2 Demo Acceptance:** Chat passes plus empty workspace → files → actual isolated build/test → authorized artifact download/integrity, sandbox limits/isolation/error evidence.

All P0 checks must pass. For each P1/P2 record PASS (demonstrated), FAIL/BLOCKED, NOT RUN or DEFERRED with reason, owner and reviewer decision. Retry/Regenerate/Cancel, model/reasoning and BYOK are P1; Skills/personalization is P2. A P1 defect affecting P0/security blocks Chat acceptance. Do not declare Full when mandatory Agent checks are deferred.

Use the [evidence record](../../evidence/17T-12-demo-deployment.md). Local/fixture checks are separate from hosted/provider-live checks. CI or merged source alone does not grant acceptance.

## 2. Preflight before resource creation

1. Confirm the authorized Render workspace by ID with the user. In this run, the user selected **My Workspace**. Never reuse unrelated services.
2. List existing services and Postgres instances. Record Giga resource IDs only after creation; no guessed public URL.
3. Review workspace instance-hours, bandwidth, pipeline minutes, payment policy and spend limits in Billing. A Free compute plan does not guarantee that bandwidth/build overages are free. Do not add a payment method or upgrade plans.
4. Verify current provider restrictions. Render Free web services idle after 15 minutes and share 750 instance-hours/month per workspace; Free Postgres is limited to one instance, 1 GB, expires after 30 days and has no managed backup. Plan demo timing/data retention accordingly. Recheck these facts before provisioning.
5. Select region for both API and DB (Singapore is a candidate for this team's users), Free plan and PostgreSQL 16 only after account/region support is verified. Existing free services consume the same workspace-hour allowance.
6. Record exact reviewed main SHA and required PR/CI/review evidence. Recheck main before deploying; do not include dirty local work or unmerged Agent branches.
7. Authorize only dedicated demo resources, capped provider tests and their cleanup owner. Keep real Agent execution disabled until its separate security/cost GO gate.
8. Check secret provisioning and topology below before creating an unusable service. The connector does not expose every setting; use the authenticated dashboard where required.

Provider references: [Free limits](https://render.com/docs/free), [monorepos](https://render.com/docs/monorepo-support), [rewrite rules](https://render.com/docs/redirects-rewrites). A separate dashboard browser login may be required even when the connector works.

## 3. Candidate build and routing configuration

Both apps import `packages/contracts`. Keep **Root Directory empty (repository root)** for both services. Setting it to `apps/api` or `apps/web` hides required files outside that root on Render.

| Setting | API web service | Frontend static site |
| --- | --- | --- |
| Repository | Giga repository | Same repository |
| Branch | Reviewed main SHA | Same reviewed main SHA |
| Node | Pin a supported Node 22 version | Same build runtime |
| Root Directory | Empty / repository root | Empty / repository root |
| Build | `npm ci --prefix apps/api --include=dev && npm run build --prefix apps/api` | `npm ci --prefix apps/web --include=dev && npm run build --prefix apps/web` |
| Start / Publish Directory | `npm start --prefix apps/api` | `apps/web/dist` |
| Health | `/health` | Assets, login/chat and deep links |
| Initial autodeploy | Disable during controlled acceptance | Disable during controlled acceptance |

These are candidate settings, not verified cloud configuration. Local builds were run from each package directory; exact Render/prefix commands and Linux/Node 22 must be verified.

The frontend currently constructs `RealApiClient` with an empty base URL. Its `/api` requests are same-origin; Vite's development proxy is not part of the production bundle. Setting `VITE_API_URL` alone has no effect.

A same-origin proxy is a candidate topology. Once the real API URL is known, configure the API route before SPA fallback:

| Source | Candidate destination | Action |
| --- | --- | --- |
| `/api/*` | Actual API HTTPS origin + `/api/*` | Rewrite/proxy, pending live POST/cookie/SSE proof |
| `/*` | `/index.html` | SPA rewrite |

Do not assume Render rewrites preserve POST bodies, streaming timing or session behavior. Test login, secure cookie, CSRF and incremental SSE through the final frontend origin. If that topology fails, pause acceptance and review a scoped client/server routing change; do not silently fall back to mock mode.

Fresh sessions currently default to Mock mode. Explicitly select Real API for live testing and capture evidence of actual network requests.

## 4. Backend secrets and database

Use the backend environment/secret controls. Never paste keys or DB connection strings into chat, source, PRs, logs, screenshots, URLs or frontend variables.

| Variable | Required value/source |
| --- | --- |
| `NODE_ENV` | `production` |
| `NODE_VERSION` | Supported pinned Node 22 release verified for the service |
| `PORT` | Render supplied; verify listening on public host/port |
| `DATABASE_URL` | Dedicated demo Postgres connection secret; validate TLS and pool settings |
| `ALLOWED_ORIGINS` | Exact frontend HTTPS origin(s), no wildcard |
| `COOKIE_SECURE` | `true` |
| `COOKIE_SAME_SITE` | Choose for verified topology; same-origin candidate uses `lax` |
| `CHAT_ENABLED` | `true` only when approved provider/cost configuration is ready; `false` can validate infrastructure but cannot pass Chat acceptance |
| `GEMINI_API_KEY` | Backend-only test credential with approved access/quota/spend control |
| `CHAT_MODEL_ID` | `gemini-3.1-flash-lite` in this source allowlist; account/region access unverified |
| `CHAT_MAX_OUTPUT_TOKENS` | `1024` candidate; allowed source range 1–2048 |
| `CREDENTIAL_ENCRYPTION_KEY` | Dedicated canonical base64 encoding of 32 random bytes for BYOK; backend only |

A per-generation token cap is not a total-spend or rate cap. Verify account/provider limits and test budget before enabling a public platform credential. Missing BYOK encryption configuration disables BYOK; malformed configuration fails startup.

The API auto-applies pending migrations on startup. At the inspected SHA the migration set is 001–013. Review locking, target database identity and retention before first boot. First run must target a dedicated disposable demo DB, never an unrelated production database. Record applied versions without exposing connection details. Application rollback does not reverse migrations.

## 5. Deploy and verify infrastructure

1. Confirm preflight/budget, secret availability and reviewed source. Create only the dedicated Free database, API and static site required for Giga.
2. Record actual resource IDs, region, plan and dashboard URLs. Confirm no unrelated service changed.
3. Configure backend secrets privately; configure frontend proxy and SPA fallback once the API URL is known.
4. Deploy exactly the candidate SHA. Check build logs/runtime version and live deploy metadata separately for UI/API. For autodeploy-on services, do not trigger a duplicate manual deployment.
5. Verify valid public HTTPS, `GET /health` returns 200 JSON and an unknown route returns the documented structured 404. A successful health check does not prove Chat.
6. Verify frontend assets and direct navigation/refresh on login/chat/history routes; `/api` must reach API JSON/SSE rather than SPA HTML.
7. Perform the acceptance matrix with dedicated test accounts A and B and non-sensitive prompts; capture redacted browser screenshots and results.
8. Stop on failed migration, exposed secret, cross-owner data or unexpected billing. Preserve redacted failure evidence and avoid destructive retries.

## 6. Browser acceptance matrix

| ID | Priority/scope | Expected proof |
| --- | --- | --- |
| C01 | P0 Chat | Login works; protected routes reject unauthenticated calls; logout makes the old session unusable |
| C02 | P0 Chat | A cannot read/change/delete B's conversation or credentials; server enforces ownership |
| C03 | P0 Chat | Real provider answers; chunks appear incrementally before completion; no mock fallback |
| C04 | P0 Chat | Prompt/output/status persist after refresh/reopen and a controlled API restart |
| C05 | P0 Chat | Loading, connection/provider errors, quota and cold-start recovery are truthful and do not duplicate data |
| C06 | P0 Chat | No secrets in response, bundle, storage, redacted logs or screenshots |
| C07 | P1 Chat | Retry/Regenerate preserve correct turn/variant; Cancel reconciles server state; late output cannot overwrite a newer state |
| C08 | P1 Chat | Model/reasoning controls expose only supported values |
| C09 | P1 Chat | BYOK add/replace/validate/delete/preferences work with metadata-only response and safe errors |
| C10 | P2 Chat | Demonstrate implemented Skills/personalization; state unintegrated behavior |
| A01 | Mandatory Full | Empty workspace, no repository required; real create-file/build/test sequence |
| A02 | Mandatory Full | Authorized artifact download matches run output/checksum; other user denied |
| A03 | Mandatory Full | Live isolation, resource/time/cost limits, cancellation/cleanup and error recovery |

For quota/network errors prefer a safe fixture or a capped approved live test; label simulated checks as simulated. Never deliberately exhaust a paid account. A synthetic failure does not prove real-provider availability.

## 7. Recovery, rollback and handoff

- Record deploy/startup symptoms, safe logs, failing check and exact SHA before making a corrective change.
- For app rollback, use a previously reviewed compatible deployment; confirm the retained schema is compatible. Free rollback history is limited. If no known-good deployment exists, disable the failing capability and report no rollback baseline.
- Treat migration failure and data recovery separately. Free Render Postgres has no managed backup; do not claim recovery without a tested export/restore strategy. No destructive down migration.
- Repeat only affected checks after a fix; re-run security/contract acceptance when behavior changes.
- Have the peer independently redeploy or diagnose a controlled test incident, record operator/reviewer/timestamp/environment/SHA/outcome and link the evidence to 17T-12 and 17T-14.
- Final human decision records Chat and Full separately. Keep 17T-12 open until its agreed acceptance, evidence and independent review are actually complete.

## 8. Measured topology correction — 2026-10-19

The static frontend and API deployed at main `f06d4646...` successfully. A capped
live provider request returned an answer and HTTP checks passed for auth, A/B
ownership and logout. However, **the static-site proxy did not pass incremental
streaming**:

- Direct API: started at 151 ms, deltas from 2420–2845 ms, 9 transport chunks.
- Static rewrite: all events arrived at 2265 ms, in 2 chunks, including started,
  deltas and completion together. That does not meet the streaming P0.

Use the optional **single Node service** topology for the next demo candidate:

1. Build both apps from the repository root:
   `npm ci --prefix apps/api --include=dev && npm ci --prefix apps/web --include=dev && npm run build --prefix apps/web && npm run build --prefix apps/api`.
2. Start with `npm start --prefix apps/api`, `SERVE_WEB=true`, and `/health`.
3. Set `ALLOWED_ORIGINS` to the actual shared HTTPS origin (retain the static
   origin only while its separate diagnostic site is still used).
4. Use that service's `/login` and `/chat` URL for browser acceptance. No static
   rewrite is involved in Chat requests.
5. The existing static site is diagnostic only until explicitly retired; it has
   not passed streaming acceptance. Do not label it a working streamed demo.
6. Verify the deployed SHA and all affected browser/auth/SSE checks. Deploying an
   unmerged PR branch for controlled demo verification is not review or release approval.

`SERVE_WEB` defaults false and rejects invalid values. Enabling it requires a
built web bundle before DB connection/migrations; missing bundles fail startup.
The adapter serves only known frontend routes plus `/assets/*` and `/giga/*`.
It does not route API paths through SPA fallback.

| Surface | Before | Candidate | Compatibility |
| --- | --- | --- | --- |
| Existing API routes/DTO/errors | Existing API behavior | Same handlers and payloads | Preserved; tests required |
| SSE event schema/order | Existing runtime events | Same runtime at shared origin | Preserved; buffering removed from topology |
| Sessions/CSRF | Secure HttpOnly cookie + exact origins | Same policy, actual shared origin allowlisted | No wildcard or auth bypass |
| UI navigation on API host | JSON 404 | Opt-in known GET/HEAD HTML/assets | Additive, disabled by default |
| Unknown API/asset, unsupported method | Structured 404 | Structured 404 | Preserved |
| DB schema | Migrations 001–013 at baseline | No new migration | Unchanged |

Review questions: confirm the fixed build-output root, supported frontend deep
links, uncached HTML, missing-asset/API JSON errors, direct SSE timing and browser
session behavior. API remains DRAFT.
