# Giga Skills / Profiles / Integrations — UX v0.1

> **DRAFT PRODUCT UX, NOT IMPLEMENTED.** [17T-26](https://linear.app/17thedev/issue/17T-26/design-giga-skills-profiles-and-plugin-architecture). Designer/frontend reviewer Thư; backend owner Trà. [Skills Engine](../../architecture/GIGA_SKILLS_ENGINE_V0.1.md), [API](../../contracts/GIGA_SKILLS_PROFILES_PLUGINS_API_V0.1.md).

## 1. Navigation

GigaChat and GigaAgent remain independent top-level destinations. Settings navigation:
- **Profile**: account name and identity metadata, not skill instruction text.
- **Personalization**: language, style, verbosity, optional custom instructions and selected default text skill indicators.
- **My Skills**: built-in and private skills, installed/enabled state, detail, create/edit/version.
- **Memory**: separate user-controlled Hybrid Memory settings and items; never falsely present as "skills".
- **Integrations** (P2): vetted available plugins/MCP connections, scopes, revoke and audit access.

Avoid a single "magic prompt" settings text box blending private facts and execution rights.

## 2. GigaChat composer behavior

Skill picker near model selector: shows installed, enabled, Chat-compatible Skills with name/description and version, search and an explicit selection checkbox. MVP Manual: default no hidden auto selection. Selected skills appear as removable chips **before Send** and as read-only "Used Skills" metadata on completed generation.

UX rules:
- Selecting an incompatible/disabled Skill produces clear explanation and no silent fallback to another.
- Limit of selected Skills visible to user; style/format conflict surfaces simple "choose one" prompt.
- One-off explicit user request may override style preference without globally editing Profile; direct instruction in current prompt still takes priority where allowed.
- Preview optional: render a short example of how skill changes a sample answer, labeled "example" and subject to normal token budget.
- Chat cannot gain tools or read Agent Workspace through skill picker. If a skill refers to plugin not installed, show "Requires integration" but never auto-connect.

## 3. Skill Library & Editor

Skill card: title, short description, Built-in/Custom, compatible products Chat/Agent, active/disabled state and version. Built-in Skills are read-only, can be installed/enabled/disabled, not overwritten. Custom Skill editor uses validated form (name, description, Markdown instructions), live metadata/errors, Save as New Version, revision history, test prompt/preview (P1). Unsaved changes prompt before leaving.

Import/export P1: show provenance, package manifest preview, size, script/assets warning and privacy/security checks. A downloaded SKILL.md from internet is not trusted merely because it uses the expected filename. P0 editor refuses scripts or references it cannot safely support.

## 4. GigaAgent Workspace UX

On new Agent Task, show optional text Skills picker. Workspace settings may explicitly select default Skills for that workspace. The UI separates **workflow guidance** (Skills) from **tool permissions** (Agent mode, sandbox capabilities, external approvals). No button "Enable Skill" should imply permission to run shell or external APIs.

Agent Run detail can show pinned skill versions used by a run; changing settings cannot silently rewrite an active run's prompt. A fresh run gets newly selected versions. No GitHub/repository is needed to use a text-only skill.

## 5. Profiles UI

Personalization form offers preferredLanguage, responseLength, responseStyle, customInstructions, reset and save with revision conflict handling. Explicit Memory toggle stays in separate Memory screen. Named AI Profiles (P1) are optional groups with clear active indicator; they never alter user account email or login security.

Indicate scope: applies to Chat responses by default, with any Agent support opt-in and documented. A profile changed during a generation applies only to future model calls, not already generated text.

## 6. Plugin/MCP UX (P2)

Integrations page shows vetted catalog, publisher, connection status and exact requested scopes. Connect flow leaves app through approved OAuth and returns to explicit grant summary. Revoke is always accessible. Permission prompt for external write shows target/action/cost/expiry and allows reject. Never show a generic "always allow everything" default.

Plugin settings must visibly separate installed connector, connected account, allowed tool scopes and last authorized tool event. Do not expose access/refresh tokens.

## 7. UI acceptance

- User can manually select Explain Code before sending a Chat prompt; result records version and active skill indicator.
- User can disable the Skill for the next generation without clearing Personal Memory.
- User A's private skill is absent from user B's list and cannot be applied using guessed IDs.
- Profile language vs direct current instruction conflict is resolved predictably and explained when needed.
- Error/reconnect and loading states do not misrepresent selected or disabled skills as applied.
- Agent Workspace default skill never creates shell/plugin privileges, and GitHub is optional.
- Settings are usable via keyboard/screen reader and mobile layout, without relying on color alone.

This is a UX contract proposal, **not** proof that current frontend mock implements Skills, Plugins or named Profiles.
