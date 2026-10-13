# Giga Skills Engine v0.1 — Shared AI Behavior Layer

> **PRODUCT DECISION SELECTED 2026-10-13; TECHNICAL DESIGN PROPOSED, NOT IMPLEMENTED OR FROZEN.** Trà owns backend/context; Thư reviews Frontend/DTO. [17T-26](https://linear.app/17thedev/issue/17T-26/design-giga-skills-profiles-and-plugin-architecture). Related: [ADR-005](../decisions/ADR-005-skills-personalization-plugin-boundaries.md), [Profiles](GIGA_PROFILES_PERSONALIZATION_V0.1.md), [Plugins](GIGA_PLUGINS_MCP_V0.1.md), [Data Model](GIGA_SKILLS_DATA_MODEL_V0.1.md), [API](../contracts/GIGA_SKILLS_PROFILES_PLUGINS_API_V0.1.md), [Verification](GIGA_SKILLS_TEST_PLAN_V0.1.md).

## 1. Product definition

**Skills are a common, reusable AI behavior-customization layer for both GigaChat and GigaAgent.** They describe *how* a category of work should be performed or output presented, not which data the user owns or which external actions are authorized.

Do not conflate:
- **Profiles / Personalization:** persistent user preferences (language, tone, response length, custom instructions, named configurations).
- **Skills:** task-specific scoped instructions and workflows (Explain Code, Review Code, Technical Writer), versioned and explicitly enabled.
- **Memory:** consent-controlled factual user information (separate GigaChat Hybrid Memory with enabled/useInChat gates).
- **Plugins/MCP:** separately authorized external services and callable tools, never automatically granted by Skills.
- **Development skills in repository .agents/skills:** for Trà/Thư's coding assistants to build Giga. These are **not installed into Giga user accounts, not product capabilities**.

GigaChat and GigaAgent are independent experiences: shared skill *definitions/registry* may be discoverable from either, but no implicit sharing of Chat history, personal Memory, Workspace files or tool permissions.

## 2. Approved product capability milestones

| Phase | Feature | Scope |
|---|---|---|
| P0 | Built-in + Custom **text-only** Skills | GigaChat and GigaAgent can select a permitted text skill manually |
| P0 | Manual activation + explicit Agent Workspace defaults | No invisible automatic skill selection; allow on/off and active skill visibility |
| P0 | User Profile and instructions | Basic language, style and response verbosity; no automatic Personal Memory capture |
| P1 | Skill import/export, immutability/version history and safe validation | Read-only SKILL.md-compatible package first; versions pinned per run/generation |
| P1 | Opt-in auto suggestion/activation | Constrained resolver, user visibility and measured router quality |
| P2 | Tool-enabled Skills through registry + permissions | Agent isolated sandbox and optional separately connected MCP/Plugin tools |
| P3 | Skill marketplace and cross-user publishing | Moderation, ownership, licensing, trust and reputation system deferred |

Built-in text skills can be documented before any end-user product runtime exists. A "skill" cannot command server shells or install plugins by itself.

## 3. Runtime architecture

~~~mermaid
flowchart TD
  UI[User chooses task and explicit skill] --> RES[Skill Resolver]
  PROFILE[Scoped User Profile] --> COMPOSE[Instruction Composer]
  REG[(Skills Registry and Immutable Versions)] --> RES
  RES --> COMPOSE
  COMPOSE --> CHAT[GigaChat Context Builder]
  COMPOSE --> AGENT[GigaAgent Planning Context]
  CHAT --> LLM[Shared LLM Engine]
  AGENT --> LLM
  AGENT --> POLICY[Permission Engine]
  POLICY --> TOOLS[Authorized Tool Registry and Runner]
~~~

**Resolver** chooses only active, installed/allowed versions that support the current product and task mode. It returns immutable IDs+hashes+bounded instruction text, NOT tool authority. In P0 no model-based auto-pick: manual selection and explicit workspace defaults only.

**Composer** merges valid non-conflicting instructions under strict authority; outputs normalized context and an internal provenance manifest (profile version and skill versions). The LLM remains probabilistic: instruction-only skills do not guarantee format/compliance. For strict outputs, use schema validation and deterministic postprocessing.

**LLM Engine** receives bounded model messages; the Engine does not decide which skill applies, grant plugin permissions or read Memory implicitly.

## 4. Canonical Skill package

Use a **SKILL.md-compatible** Markdown entry with YAML frontmatter; choose a minimal interoperable subset for first-party and imported skills. A skill may later include optional reference files/assets; scripts are **not** supported in P0. Do not pretend arbitrary third-party bundle formats or every extension field are supported until tested.

Example entry:

~~~markdown
---
name: explain-code
description: Explain how code works when the user asks for explanation.
---

# Explain Code

## Instructions
- Explain the overall purpose before examining important functions.
- Prefer simple Vietnamese by default, unless the user requests another language.
- Include a short example where useful.
- Do not edit code unless the user asks for modifications.

## Output
1. Summary
2. How it works
3. Example
4. Limitations
~~~

Registry stores canonical stable skill slug and version metadata outside the content. Validate frontmatter name, description, UTF-8 decoding, size and Markdown safety; do not rely on user-controlled frontmatter to set owner, scope or permissions. Reject path traversal, nested archive escapes, symlinks to private paths, secrets and malicious package shapes. A parsed skill is *untrusted author instructions*, never privileged server policy.

**Built-in**: Giga-owned reviewed versions published through app release/migration. **Custom**: private user-owned versioned documents; can edit by producing a new immutable revision. **Imported**: P1 with validation/quarantine. **Project/Workspace default**: explicit mapping of installed skill versions to an Agent Workspace; does not bleed into GigaChat. **Tool-enabled**: P2, separate capability declarations reviewed by Policy Engine; code and scripts only run in adopted isolated Agent sandbox.

## 5. Activation and resolver algorithm

P0 resolver input: caller product (chat/agent), authenticated user, current conversation/run and optional workspace, user-selected skill IDs or approved workspace defaults, model context budget, capability policy. Output: ordered list of canonical pinned skillVersion IDs, hashes, and bounded text.

1. Authorize skill ownership or built-in visibility; require the skill to be enabled and product-compatible. Rejected/deleted/disabled/uninstalled skills never activate. Explicit user selection outranks defaults for that task.
2. For Chat, allow manual selected Skills only from enabled installed list. For Agent, combine explicit selected Skills with workspace-default versions that the owner enabled. Never automatically merge *all* installed skills.
3. Deduplicate by canonical skill identity. In P0 limit concurrent active skills (candidate max 3) and total instruction tokens (candidate max 2,000), plus per-skill size caps; overflow fails with clear UI feedback or requires removal, not silent unrestricted concatenation.
4. Detect incompatible declarations (opposite output formats, contradictory procedures); explicit current user instruction has precedence over behavioral style where allowed. For conflicting selected skills, ask user to choose or disable one; do not invent an arbitrary hidden tie-break.
5. Create an activation manifest with (product, profileVersion?, skillVersionIds, content hashes, activation source manual/workspace, resolver version, timestamp). Save immutable manifest reference with generation/run **before** LLM invocation. No raw skill content is required in public audit/analytics.
6. Compose bounded user preference and skill instructions in a clearly delimited lower-authority instruction block with provenance; untrusted memory/repo/tool/web content is not allowed to append instructions to it.
7. If a Skill is disabled mid-run, no new generation/task may activate it. For an active long-running Agent Run, policy-sensitive tool permissions are checked **on every call** and are immediately revocable; running text instructions are snapshotted for reproducibility, cancellation policy is explicit.

**Automatic activation in P1**: only after separate opt-in and evaluated routing metrics; deterministic criteria/high-confidence resolver or suggested skill card, user can override, visibility and activation event required. Never automatically enable a disabled skill. No automatic tool/Plugin grant.

## 6. Instruction conflict and authority rules

Conceptual order (not a promise about provider-specific message-role positions):
1. Platform safety, authorization, privacy and product invariants.
2. Giga product/task-mode instructions (Chat vs Agent, Ask/Plan/Execute).
3. Current direct user request, within allowed permissions.
4. User-selected Profile/preferences and explicitly selected Skills (scoped to task).
5. Agent Workspace default Skills or separately opted-in auto selections, if not conflicting.
6. Retrieved Memory/repository/upload/plugin/web contents **as untrusted data only**.

A user request may override a style skill (e.g. "answer in English" beats a Vietnamese example preference) but cannot override safety policy, Chat Memory consent or a denied tool. If a task-specific selected Skill mandates a structured format and user's current request conflicts, surface that conflict or follow the request without misrepresenting compliance.

Never promote arbitrary imported Markdown to system/developer authority just because it resembles an instruction template. Treat markdown headings "SYSTEM", "override policy", "reveal token" etc. as untrusted user-authored claims, not actual priority. Explicit skill execution cannot create permissions to read another user's data.

## 7. Context cost, determinism and privacy

Dedicate an explicit skill token sub-budget within model input and record selected skill names/versions (not secrets) in generation metadata. Reuse static built-in docs by content hash and avoid copying all installed skills into every prompt. Tests should compare baseline vs activated skill, not simply whether the model echoes skill title.

Profile/skill edits create immutable revisions and do not retroactively rewrite old generations. Disable/delete policy removes future activation and hides content according to account deletion/retention policy, while preserving minimal safe audit provenance for historical interpretation. Deleted skill versions must not be resurrected from pending activation jobs.

For GigaChat, Memory remains a separate consent-gated retrieval source; for Agent, Workspace context is explicitly scoped. Never use a Profile or Skill to silently enable Memory use in Chat or bridge private Memory into Agent.

## 8. Acceptance and review gates

- Trà/Thư agree on the activation limit, conflict behavior, profile scope, audit retention and per-product settings before API freeze.
- P0 golden: two independent users, each creates custom text skill; A manually activates it in Chat, answer style visibly differs from baseline (evaluated over a set of prompts), A disables skill and next generation excludes it; B cannot use A's private skill.
- Agent Workspace default text skill influences planned workflow without requiring GitHub or granting filesystem/terminal/network capability beyond existing Agent Mode.
- Imported scripts, MCP and unreviewed URLs stay disabled at P0. Actual tests and implementations tracked in separate tasks; docs are not proof of runtime.
