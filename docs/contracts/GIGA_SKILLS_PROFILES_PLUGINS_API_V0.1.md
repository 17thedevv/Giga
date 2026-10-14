# Giga Skills / Profiles / Plugins — Candidate REST and Activation API v0.1

> **DRAFT / NOT IMPLEMENTED / NOT FROZEN**. [17T-26](https://linear.app/17thedev/issue/17T-26/design-giga-skills-profiles-and-plugin-architecture). See [Skills Architecture](../architecture/GIGA_SKILLS_ENGINE_V0.1.md), [Data Model](../architecture/GIGA_SKILLS_DATA_MODEL_V0.1.md), [UX](../design/frontend/GIGA_SKILLS_UX_V0.1.md) and ADR-001.

## 1. Conventions / compatibility

Prefix /api/v1, authenticated cookie session, CSRF and exact Origin on mutations, camelCase DTO, UTC ISO timestamps, owner-scoped ID access. Error envelope follows canonical [API Contract v0.1](API_CONTRACT_V0.1.md). All additional endpoints and request fields are proposals; new required fields in Chat SSE or Agent Runs need joint review. Public API is not frozen.

Neither a skill ID nor plugin ID is proof of authorization. The backend resolves from session owner and verifies installation/version/status, product scope, target and quotas.

## 2. Proposed endpoints by phase

| Phase | Method | Path | Purpose |
|---|---|---|---|
| P0 | GET | /api/v1/me/preferences | Current user response preferences |
| P0 | PATCH | /api/v1/me/preferences | Update preferences with expectedRevision |
| P0 | GET | /api/v1/skills?scope=installed or builtIn | List owned/visible skill definitions and selected revisions |
| P0 | POST | /api/v1/skills | Create private text-only Custom Skill |
| P0 | GET | /api/v1/skills/:id | Authorized metadata + selected version |
| P0 | PATCH | /api/v1/skills/:id | Rename/description/scope metadata with CAS |
| P0 | DELETE | /api/v1/skills/:id | Disable/remove private Custom Skill under retention policy |
| P0 | POST | /api/v1/skills/:id/versions | Save an immutable validated text instruction revision |
| P0 | POST | /api/v1/skills/:id/install | Install allowed built-in/private Skill, selected version |
| P0 | PATCH | /api/v1/skills/:id/installation | Enable/disable or select installed version |
| P0 | PUT | /api/v1/agent/workspaces/:id/default-skills | Explicit Agent Workspace defaults (requires Agent Workspace implementation) |
| P1 | GET/POST | /api/v1/ai-profiles | Named AI Profiles and creation |
| P1 | GET/PATCH/DELETE | /api/v1/ai-profiles/:id | Manage named AI Profile and revision |
| P1 | POST | /api/v1/skills/import | Validate and import supported safe SKILL.md bundle |
| P1 | GET | /api/v1/skills/:id/export | Export reviewed version, no secrets |
| P1 | POST | /api/v1/skills/activation-preview | Preview resolver output without invoking model |
| P2 | GET | /api/v1/plugins | Vetted plugin catalog |
| P2 | GET | /api/v1/plugin-connections | Owner-scoped connected accounts |
| P2 | POST | /api/v1/plugins/:id/connect | Initiate secure OAuth/authorization |
| P2 | DELETE | /api/v1/plugin-connections/:id | Revoke credential/grants and connection |
| P2 | GET/PATCH | /api/v1/plugin-connections/:id/grants | Inspect/update scoped permissions |
| P2 | GET | /api/v1/plugin-connections/:id/tools | Enumerate allowlisted available tools, not execute them |

All rows are **candidates**; some endpoints may be consolidated with approved shared API patterns. No MCP endpoint is exposed solely to let the model install arbitrary servers.

## 3. Candidate DTOs (P0 Implemented Shapes)

~~~ts
// User Preferences
interface UserPreferences {
  revision: number;
  preferredLanguage?: string;
  responseLength: 'concise' | 'balanced' | 'detailed';
  responseStyle: 'professional' | 'casual' | 'technical';
  customInstructions: string;
}

interface UpdateUserPreferencesRequest {
  expectedRevision: number; // Mandatory for optimistic concurrency control (CAS; 0 for initial write)
  preferredLanguage?: string | null;
  responseLength?: 'concise' | 'balanced' | 'detailed';
  responseStyle?: 'professional' | 'casual' | 'technical';
  customInstructions?: string;
}

// Skills Metadata & Catalog
interface SkillListItem {
  id: string;
  ownerId: string | null;
  slug: string;
  title: string;
  description: string;
  visibility: 'built_in' | 'private';
  supportedProducts: Array<'chat' | 'agent'>;
  revision: number;
  createdAt: string;
  installed: boolean;
  enabled: boolean;
  selectedVersionId: string | null;
}

interface SkillDetail {
  id: string;
  ownerId: string | null;
  slug: string;
  title: string;
  description: string;
  visibility: 'built_in' | 'private';
  supportedProducts: Array<'chat' | 'agent'>;
  revision: number;
  createdAt: string;
  latestVersion: SkillVersion | null;
  installation: SkillInstallation | null;
}

interface CreateSkillRequest {
  slug: string;
  title: string;
  description: string;
  supportedProducts?: Array<'chat' | 'agent'>;
  instructions?: string; // Optional initial version 1 + auto-install
}

interface UpdateSkillRequest {
  expectedRevision: number; // Mandatory for optimistic concurrency control (CAS)
  title?: string;
  description?: string;
  supportedProducts?: Array<'chat' | 'agent'>;
}

// Skill Versions
interface SkillVersion {
  id: string;
  skillId: string;
  versionNumber: number;
  contentHash: string; // Deterministic SHA-256 computed exclusively by server
  instructions: string;
  createdAt: string;
}

interface CreateVersionRequest {
  instructions: string; // Server exclusively computes deterministic SHA-256 contentHash
}

// Skill Installations
interface SkillInstallation {
  id: string;
  userId: string;
  skillId: string;
  selectedVersionId: string;
  enabled: boolean;
  installedAt: string;
}

interface InstallSkillRequest {
  versionId?: string; // Pins specific version; defaults to latest if omitted
  enabled?: boolean;  // Defaults to true
}

interface UpdateInstallationRequest {
  enabled?: boolean;
  selectedVersionId?: string;
}

interface SkillActivation {
  skillIds: string[];        // IDs user selected manually
  source?: 'manual';         // MVP only
}
~~~

Skill version hash is server-computed. PATCH with expectedRevision rejects stale edits 409 CONFLICT. Mutable editing of an immutable revision is forbidden; version publish creates a new SkillVersion. P0 endpoints are implemented in `apps/api`; public contract status remains DRAFT pending W1 joint review and deployed browser verification.

## 4. Hook into Chat and Agent without changing identity boundaries

**Chat**: candidate additive optional field on existing POST /api/v1/conversations/:id/messages:stream:
~~~json
{
  "content": "Explain this code.",
  "modelId": "giga-chat-default",
  "skillIds": ["selected-installed-skill-uuid"]
}
~~~
No skillIds means no request-specific manual Skill. Any explicitly configured Chat default must be visible to the user and separately authorized. Chat must not read Agent Workspace defaults. The new optional field must be reviewed together with 17T-25 PR #12 to prevent divergent streaming contracts.

**Agent**: candidate additive optional skillIds on POST /api/v1/agent/runs while workspace defaults are loaded through an authorized Workspace mapping. The Agent still requires Workspace and uses its own Tool/Permission Engine. A Skill cannot add an agent tool, grant GitHub scopes or bypass Ask/Plan/Execute. If a selected Skill is not installed/enabled, reject before LLM invocation.

Internal activation manifest bound to generated message/run records ID/version/hash; not necessary to expose raw prompt in SSE. Optional response includes non-sensitive activeSkills: {id,title,version} for transparency, subject to DTO review.

## 5. Validation, errors and idempotency

| Case | Candidate behavior |
|---|---|
| Missing auth/CSRF/Origin | 401/403 |
| Cross-owner Skill/Profile/Workspace/Connection ID | 404 without existence leak |
| Bad SKILL.md metadata, invalid slug, oversized content | 400/413 with safe details |
| Disabled/uninstalled/incompatible skill | 409 SKILL_NOT_AVAILABLE or 422, no LLM call |
| Too many active Skills/instruction tokens | 422 SKILL_BUDGET_EXCEEDED |
| Conflicting selected Skills | 409 SKILL_CONFLICT with non-secret IDs and user choice |
| Concurrent revision update | 409 VERSION_CONFLICT |
| Provider/capability missing | Existing LLM/Agent capability error, no tool bypass |
| Expired/revoked Plugin grant | 403/409 and no tool call |
| Duplicate user request | Honor 17T-25 Idempotency-Key generation identity; no duplicate skill activation |

All proposed exact codes and optional Chat/Agent fields require reviewer confirmation. No API freeze claim.

## 6. Review gates

- [ ] Thư validates skill picker, installation/version DTO, inline active-skill summary, clear errors and Chat SSE compatibility.
- [ ] Trà validates ownership and DB constraints, skill resolver immutability, context limits and profile/memory policy separation.
- [ ] P2 Plugin connect/revoke routes undergo separate OAuth/MCP threat model before implementation.
- [ ] Schema runtime validation/contract fixtures + real-browser cookie/CSRF tests before ADR-001 freeze.
- [ ] No secret/oauth token or arbitrary remote MCP URL reaches public DTOs.

Product Skills are **not** the same installation target as repository development-agent skills in .agents/skills.
