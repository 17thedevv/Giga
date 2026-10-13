# ADR-005 — Shared Skills with Separate Profiles, Memory and Plugin Permissions

- **Status: PROPOSED TECHNICAL ADR; PRODUCT DECISIONS ACCEPTED 2026-10-13.**
- **Owner:** Trà. **Reviewer:** Tráng A Thư. **Tracking:** [17T-26](https://linear.app/17thedev/issue/17T-26/design-giga-skills-profiles-and-plugin-architecture).
- **Related:** [Skills Engine](../architecture/GIGA_SKILLS_ENGINE_V0.1.md), [Profiles](../architecture/GIGA_PROFILES_PERSONALIZATION_V0.1.md), [Plugins](../architecture/GIGA_PLUGINS_MCP_V0.1.md), [GigaAgent](../architecture/GIGA_AGENT_ARCHITECTURE_V0.2.md), [GigaChat Memory](../architecture/AI_MEMORY_RAG_V0.1.md), [ADR-001](ADR-001-api-compatibility.md).

## Context

Giga's existing development-only .agents/skills files help Trà/Thư build Giga, but are not user-facing Skills. GigaChat and GigaAgent need a consistent way for users to control how model responses and workflows are conducted. Combining user instructions, personal Memory, tool connections and execution permissions into one prompt creates hidden authority escalation, privacy and UX failures.

## Decision

1. Introduce a **shared Skills Registry / Resolver / Instruction Composer** as a product feature consumed separately by GigaChat and GigaAgent.
2. Built-in and user-created instruction-only Skills are **P0**; use a validated SKILL.md-compatible document subset. Runtime imported packages/scripts are **deferred** and have no automatic execution rights.
3. P0 only **manual activation**, plus explicitly configured GigaAgent Workspace default Skills; optional auto suggestions/activation **P1 opt-in** with visibility and evaluation.
4. **Profiles/Personalization** own reply preferences and user custom instructions; **Memory** owns factual recall under its separate explicit consent; **Plugins/MCP** own authenticated tools/connections under a separate permission engine. These are not synonyms and do not automatically grant each other access.
5. Versioned immutable Skill content + activation manifest is pinned per Chat generation or Agent Run for reproducibility. Skill overrides cannot modify platform/tool/data access policy.
6. GigaChat/Agent products stay context-isolated. A Skill can be selected in either if compatible, but a Chat Skill does not implicitly read Chat Memory into Agent or install GitHub/MCP tools.
7. Tool-enabled Skills only after reviewed Tool Registry, sandbox, authorization and external-action approval; NO arbitrary shell on Hono host.
8. Marketplace, third-party publishing and multi-agent skill delegation deferred.

## Alternatives

| Option | Benefit | Drawback | Decision |
|---|---|---|---|
| Treat Skills as Agent-only | Smaller scope | No Chat response customization | Reject |
| Store everything in system prompt | Simple initial wiring | No ownership, versioning, audit, consent separation | Reject |
| Profile only, no task skills | Fast | Cannot reuse structured task workflows | Reject |
| Shared registry, product-scoped resolver | Reusable and testable with separation | Extra service/schema/UX | **Selected** |
| Execute uploaded scripts immediately | Powerful | Untrusted arbitrary-code risk | Reject P0 |
| Auto-select skills by default | Convenient | Surprise activation/conflict | Defer to opt-in |

## Consequences and approval gates

- New internal schema/API contracts and product UI for Profile, Skill management and active skill indicators.
- Context Builder/Agent Planner must accept bounded, lower-authority skill instructions with provenance; user task request outranks conflicting style instructions.
- No tool/memory permission can be created by Skill text; revocation/opt-out enforced at calls and background jobs.
- P0 adds user-owned configuration and test work but does not require MCP or Agent Cloud sandbox readiness for **Chat text-only Skills**.

- [x] Product scope and priority accepted by user.
- [ ] Trà/Thư review exact DB/REST/activation and conflict semantics.
- [ ] Implement with negative Auth/CSRF, prompt injection, versioning and deterministic fixture tests.
- [ ] API remains DRAFT under ADR-001, no database migration/Cloud provisioning in this PR.
- [ ] Performance and quality evaluation before shipping Automatic Activation.

This ADR **does not** change locked GigaAgent host-shell safety invariants or grant access to user chats, secrets or installed development skills.
