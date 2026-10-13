# Infrastructure

Deployment definitions and operational configuration for Giga.

- `docker/`: container definitions and local developer environments.
  - `docker-compose.dev.yml`: local isolated PostgreSQL 16 container for development and testing.
- `render/`: **provisional** Render deployment definitions if Render is confirmed.
- `../docs/cloud/runbooks/`: reproducible deployment, verification, monitoring and rollback guides.

**Cloud provider decisions remain pending** the W1 billing/quotas/network preflight. Do not commit secrets, production DB credentials, certificates or billing details. Prefer reviewed configuration changes and capture redacted evidence.
