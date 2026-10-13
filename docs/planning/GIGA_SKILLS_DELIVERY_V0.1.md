# Giga Skills, Profiles & Plugins — Delivery Roadmap v0.1

> **PROPOSED MILESTONES; IMPLEMENTATION NOT STARTED BY THIS DOCUMENT.** [17T-26](https://linear.app/17thedev/issue/17T-26/design-giga-skills-profiles-and-plugin-architecture). Backend owner Trà; UX/contract reviewer Thư.

## Phased strategy

| Phase | Backend (Trà) | Frontend (Thư) | Evidence/DoD |
|---|---|---|---|
| D0 Architecture | Skills resolver + Profiles/Plugins separation specs; ADR | Skills UX/API review | Linked PR, no implementation claims |
| P0 Core Text Skills | Ownership/version schema, parser of constrained SKILL.md, manual activation, bounded instruction composer | My Skills list/Editor, Chat picker, active indicator, Personalization settings | Real Chat response with selected skill and pinned version; no tools |
| P0 Agent compatibility | Optional selected text Skills and explicit Workspace defaults, typed manifest | Agent task Skill selection | Agent only consumes skills once Agent Runtime exists; no implicit Chat Memory |
| P1 Imports / Auto | Strict safe import/export, evaluated explicit opt-in resolver | Import preview, versions, suggested skills and override | Measured routing eval; no executing imported scripts |
| P2 Plugin/MCP | Vetted connector registry, scoped OAuth/grants, auditable tool calls, human approval | Integrations, connect/revoke, per-action approval | Real isolated grant/SSRF/revocation tests |
| P3 Marketplace | Publishing/moderation, public catalog, packages and trust | Search/rate/report and publisher workflow | Separate legal, security, abuse and cost review |

Do **not** build Marketplace or arbitrary MCP Server connections before a functioning text-only Skill proof and Chat Runtime exists. P0 can use mock model fixtures for unit tests while 17T-25 is in progress, but cannot claim product behavior worked until tested on real generation. GigaAgent tools remain subject to separately isolated sandbox safety.

## Implementation issue boundaries

1. Profile/preferences persistence and API.
2. Skill metadata/version/import-limited parser, ownership and enablement.
3. Skill Resolver + Instruction Composer + activation manifests.
4. Frontend My Skills, Skill Editor and Chat picker, Personalization.
5. Integration with GigaChat Runtime when 17T-25 implementation contract is accepted.
6. Agent Workspace default Skills after Agent core is live.
7. Separate Plugin Registry, OAuth/MCP and tool permission program after threat-model review.

Each implementation issue gets a distinct feature branch, peer review and tests. 17T-26 is design-only. Do not create arbitrary Cloud resources or migrate DB in documentation PR.

## Remaining technical choices to review

- Actual Skill P0 size/token/concurrency limits and whether Profile default Skill is product global or Chat-only.
- Selection and conflict UI when current direct request disagrees with selected Skill.
- Schema version/format compatibility subset, asset/reference import limits and behavior on unknown manifest keys.
- Exactly how generationId/runId binds to activation manifest before 17T-25 and Agent schema converge.
- Safe retention/deletion of private skill content, historical version references and user account cleanup.
- Provider model validation/rubric for "follows skill" behavior (not just exact phrase matching).
- Plugin provider and OAuth credential vault, permitted MCP servers, approval granularity and per-product grants.

No API, plugin connection, content migration or hosted runner is considered implemented by this roadmap.
