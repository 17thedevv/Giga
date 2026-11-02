# Infrastructure

Deployment definitions and operational configuration for Giga.

The root `compose.yaml` provides the local IaaS-ready Nginx/Web/API/PostgreSQL
stack. Follow the [local Docker runbook](../docs/cloud/runbooks/IAAS_LOCAL_DOCKER_V0.1.md)
for generated configuration, role separation, startup and recovery. The existing
developer database below remains a separate workflow.

- `docker/`: container definitions and local developer environments.
  - `docker-compose.dev.yml`: local isolated PostgreSQL 16 container for development and testing.
- `render/`: **provisional** Render deployment definitions if Render is confirmed.
- `../docs/cloud/runbooks/`: reproducible deployment, verification, monitoring and rollback guides.

**Cloud provider decisions remain pending** the W1 billing/quotas/network preflight. Do not commit secrets, production DB credentials, certificates or billing details. Prefer reviewed configuration changes and capture redacted evidence.
