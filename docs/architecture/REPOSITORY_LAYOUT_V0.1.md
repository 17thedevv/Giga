# Giga — Repository Layout v0.1

> **Status:** Proposed directory layout for the two-person TypeScript-first project. **Directories are scaffolding, not code readiness.** [Linear 17T-19](https://linear.app/17thedev/issue/17T-19/w1-scaffold-giga-monorepo-directory-structure).

## Directory tree

```text
Giga/
├── README.md                       # Giga product introduction only
├── AGENTS.md                       # Instructions for development coding agents
├── .agents/                        # Shared development Agent Skills
├── .github/                        # CI and pull request review
├── apps/
│   ├── api/                        # Backend (Trà primary)
│   │   ├── README.md
│   │   ├── src/
│   │   │   ├── app/                 # Bootstrap, HTTP adapters
│   │   │   ├── modules/
│   │   │   │   ├── auth/
│   │   │   │   ├── conversations/
│   │   │   │   └── agent/
│   │   │   ├── integrations/
│   │   │   │   ├── llm/
│   │   │   │   └── github/
│   │   │   └── db/
│   │   └── tests/
│   └── web/                        # Frontend (Thư primary)
│       ├── README.md
│       ├── public/
│       ├── src/
│       │   ├── app/
│       │   ├── features/
│       │   │   ├── auth/
│       │   │   ├── chat/
│       │   │   └── agent/
│       │   ├── components/
│       │   └── lib/
│       └── tests/
├── packages/
│   └── contracts/                  # Shared public DTOs, events, validation
│       ├── README.md
│       └── src/
├── infra/
│   ├── README.md
│   ├── docker/                      # Conditional on container decision
│   └── render/                      # Conditional on Render preflight
├── scripts/                         # Shared reproducible dev scripts
├── tests/                           # Cross-application E2E tests
│   └── e2e/
└── docs/
    ├── README.md
    ├── architecture/
    ├── contracts/
    ├── decisions/
    ├── engineering/
    ├── planning/
    ├── cloud/
    │   └── runbooks/
    └── evidence/
```

Folders without code use `.gitkeep` placeholders so Git tracks the empty paths. Placeholders should disappear naturally once meaningful files are added.

## Responsibility and dependency rules

| Location | Responsibility | Constraints |
|---|---|---|
| `apps/api` | Backend/agent implementation — Trà primary | API routes, data, auth and tool effects remain server-only |
| `apps/web` | Frontend/UX implementation — Thư primary | Consume typed contracts; never directly import server or DB |
| `packages/contracts` | Shared integration boundary — both | Public DTOs and event schemas; no app-specific logic/imports |
| `infra` | Cloud deployment and configuration — split evenly | Credential-safe, repeatable, jointly understood |
| `docs` | Canonical architecture, cloud evidence and report inputs — both | Update via reviewed PR; README root stays product-only |
| `.agents`, `AGENTS.md` | Repository-specific coding agent instructions — both | Git workflow, contract guard, verification and handoff |

Allowed logical imports once code exists:

```text
apps/web ───────► packages/contracts ◄─────── apps/api
                                                  │
                                            external APIs / DB
```

- No `apps/web → apps/api` or `apps/web → database` source imports.
- Avoid `packages/contracts → apps/*` dependencies and circular imports.
- Integration changes in `packages/contracts` require both developers to review. Consult ADR-001 before changing frozen API behavior.
- **No artificial `shared` utility dump**; add extra packages only for demonstrated cross-application needs.
- Cloud work and deployment runbooks need cross-training even if only one person authors the infrastructure files.

## Decisions deliberately not made by this scaffold

1. React/Vite, Hono/Node, Drizzle ORM and the LLM provider still require W1 architecture confirmation.
2. Render/Neon need verification of quotas, free tiers, billing, region and session/CORS viability.
3. Package manager (npm, pnpm, etc.), workspace manifests, `tsconfig`, lockfiles, test runner and runtime entry points must be chosen **together** before code setup. Directory structure does not force a package manager.
4. Auth/session behavior, DTOs, SSE and agent run lifecycle are DRAFT until documented tests and sign-off.
5. No health endpoint, UI, database migration, LLM agent, Cloud deployment or tests have been implemented by creating directories.

## Acceptance for layout PR

- [ ] All top-level module boundaries and placeholder directories present in Git.
- [ ] No changes to product `README.md` or existing API contract.
- [ ] No third-party packages, server credentials or speculative implementation.
- [ ] Both developers agree folders support independent frontend/backend tasks.
- [ ] Git workflow conventions followed; review PR before merge.

**Reference:** [Project Plan](../01-project-plan-v0.1.md) · [Architecture Invariants](INVARIANTS_V0.1.md) · [Team Workflow](../TEAM-WORKFLOW.md).
