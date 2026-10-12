# Giga

AI Chat & Coding Agent — a two-person cloud computing mini-project built primarily with TypeScript.

**Project status:** v0.1 planning baseline. Development has not started.

## Canonical links

- **[Project Plan v0.1](docs/01-project-plan-v0.1.md)** — scope, ownership, architecture, roadmap, report and acceptance gates.
- **[Team workflow](docs/TEAM-WORKFLOW.md)** — GitHub + Linear usage and cross-training.
- **[Linear project board](https://linear.app/17thedev/project/giga-cloud-mini-project-0656a578ee3b)** — issues, status and milestones.

## Roles

- **Trà:** Backend and Coding Agent; primary for API cloud deploy, CI/CD, logs and rollback.
- **Thư:** Frontend and UX; primary for web cloud deploy, managed database, HTTPS/CORS and usage monitoring.
- **Both:** cloud verification, cross-training, report and demo.

## Intended architecture (to validate in W1)

React + Vite frontend → TypeScript/Node API → managed PostgreSQL, LLM API and GitHub API; frontend/backend hosted on public cloud with HTTPS.

Do not treat a listed service or framework as provisioned until W1 preflight and the architecture review have passed.

## Source of truth

Engineering documents, decisions and code live in GitHub and change via reviewed pull requests. Linear links to them and tracks delivery; avoid copying canonical documents into Linear as separately maintained versions.