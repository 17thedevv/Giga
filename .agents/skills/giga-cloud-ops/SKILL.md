---
name: giga-cloud-ops
description: Deploys and operates Giga cloud components: frontend/API services, managed PostgreSQL, Docker, CI/CD, HTTPS/CORS, secrets, monitoring, rollback and cost controls. Use for all public-cloud tasks and peer cross-training.
---

# Public Cloud implementation and operations

Cloud deployment is a **core course deliverable**, not an afterthought. This skill applies to either developer regardless of who wrote the application module.

## Preconditions
1. Read `docs/01-project-plan-v0.1.md`, `docs/TEAM-WORKFLOW.md`, assigned Linear acceptance, actual `infra/` and environment configuration.
2. Treat Render + Neon and the exact free tiers as **proposed** until the team performs vendor, limits, pricing and billing preflight. Verify current provider docs before provisioning.
3. Never create billable resources, add a credit card, rotate/delete secrets, delete data, or deploy an irreversible change without explicit human authorization.
4. Record environment and SHA. Do not mix local/staging/demo credentials. Prefer staging for incident and cross-training drills.

## Deployment workflow
- Produce minimal reproducible build/start configuration for frontend and API; package with Docker only where it solves real deployment requirements.
- Plan app layout: static frontend, backend web service with HTTPS, and managed PostgreSQL. Decide whether same-origin proxy is needed for session/cookies/CSRF.
- Separate compile/build environment from runtime; pin relevant tool versions; validate config at startup and keep `.env.example` free of real secrets.
- Provision managed database safely; ensure DB connection credentials are backend-only, connection limits/pooling are compatible with cloud plan, schema migrations are non-destructive and backups/restore limitations are documented.
- Configure hostname, TLS, CORS, cookies and CSRF based on tested browser deployment topology. Do not assume a local origin behaves like production.
- Attach GitHub CI/CD to build/test before deployment; record the deployed git SHA and health probe. Ensure frontend SPA route fallback works.
- Verify actual behavior with curl **and a browser**: public HTTPS reachability, `/health`, frontend navigation, API fetch, streamed chat (when implemented), persistence after restart.

## Observability and failure exercises
- Capture health, logs, error paths, deploy history and basic resource/API cost utilization within available plan.
- Set bounded LLM token/step/time and rate budgets before public demo. Follow quota/idle behavior without assuming unlimited free usage.
- Write runbooks that permit **either** member to reproduce deployment, verify it and diagnose a failure without exposing secrets.
- Perform one negative scenario (bad environment variable or disconnected test DB), then recover; record timestamp, symptoms, logs, change and PASS/FAIL.
- Plan reversible rollback for application deployment and **separately** for database migrations; never conflate redeploy with DB restore.

## Cross-training deliverable
- Primary owner demonstrates; secondary member independently performs the cloud operation on test environment and explains what they verified.
- Require an evidence record: issue ID, operator, reviewer, environment, commit SHA, URLs, redacted screenshots/logs, checks and outcome.
- Use `giga-task-handoff` to link the runbook/evidence to Linear and PR. Fail the gate if peer cannot reproduce or if the resource has not actually been deployed.

**Do not claim cloud deployment, uptime, HTTPS, cost or PASS from documentation alone.**
