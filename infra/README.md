# Infrastructure (planned)

Deployment definitions and operational configuration for Giga.

- `docker/`: optional container definitions if needed by the selected deployment.
- `render/`: **provisional** Render deployment definitions if Render is confirmed.
- `../docs/cloud/runbooks/`: reproducible deployment, verification, monitoring and rollback guides.

**Cloud provider decisions remain pending** the W1 billing/quotas/network preflight. Do not commit secrets, production DB credentials, certificates or billing details. Prefer reviewed configuration changes and capture redacted evidence.
