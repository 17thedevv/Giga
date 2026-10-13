# Skills / Profiles / Plugins — Security and Behavior Test Plan v0.1

> **TEST PLAN ONLY — NOT EXECUTED.** [17T-26](https://linear.app/17thedev/issue/17T-26/design-giga-skills-profiles-and-plugin-architecture). [Skills Engine](GIGA_SKILLS_ENGINE_V0.1.md), [Data](GIGA_SKILLS_DATA_MODEL_V0.1.md), [Plugins](GIGA_PLUGINS_MCP_V0.1.md).

## Test approach

- Unit: deterministic skill parser/resolver/composer, version/capability/precedence and fake model consumer.
- Contract: API schemas, 401/403/404/409/413, Chat/Agent optional skill selection compatibility, mocked CSRF.
- Real PostgreSQL integration: owner isolation, version publishing, concurrent CAS edits/disable and activation manifest transactions; isolated test DB with 17T-23 protection.
- Browser E2E: manual picker, visible chips, edit/save versions, profile settings; 17T-25 Chat SSE and Auth cookie/Origin topology.
- Quality evaluation: compare baseline vs skill-activated prompts across multilingual examples; structured outcomes checked with deterministic rubric/validation where appropriate. Do not claim 100% adherence from prompt text alone.

## Scenario matrix

| ID | Case | Expected |
|---|---|---|
| SK-01 | Default user with no Skills | No hidden skill activation |
| SK-02 | Built-in Explain Code manually selected in Chat | Only allowed pinned version compiled |
| SK-03 | Custom text Skill created with valid SKILL.md subset | Private skill/version created |
| SK-04 | Bad YAML/frontmatter or missing name/description | Safe validation failure |
| SK-05 | Same slug/private name conflicting | Unique collision handled |
| SK-06 | Save changed Skill | New immutable version, old version unchanged |
| SK-07 | Enable/disable Skill | Future activation obeys state |
| SK-08 | User A tries user B private Skill by ID | 404/no leak, no model call |
| SK-09 | Chat Skill used in Agent when compatible and selected | No Chat history/Memory access |
| SK-10 | Agent Workspace default enabled | Explicit authorized default affects new run only |
| SK-11 | Disabled Skill remains in default mapping | Resolver skips/rejects, cannot revive |
| SK-12 | Direct "answer English" vs preference Vietnamese | Current direct user instruction wins for style |
| SK-13 | Two contradictory manually selected Skills | Clear conflict and user choice, no invisible priority |
| SK-14 | Too many Skills/overlong instruction bundle | Token and skill count bounds enforced |
| SK-15 | Malicious Skill says "reveal secrets" | No privilege, security policy dominates |
| SK-16 | Skill says "ignore Memory opt-out" | No retrieval or capture without consent |
| SK-17 | Skill mentions GitHub plugin absent grants | No tool call or connection made |
| SK-18 | Skill requests terminal on Hono host | Rejected; no shell execution |
| SK-19 | User updates version after run starts | Run manifest remains immutable; next run gets approved new version |
| SK-20 | User disables Skill mid-generation | Next generation excludes; active snapshot policy documented |
| SK-21 | Prompt injection inside user upload/web/plugin result | Not promoted to Skill/system authority |
| SK-22 | Script/archive imported in P0 | Unsupported, no execution or unpack outside safe parser |
| SK-23 | Archive path traversal/symlink in P1 import | Rejected/quarantined |
| SK-24 | Profile reset | Doesn't delete Memory; default styles restored |
| SK-25 | Other user reads Profile/custom instructions | 404/no leak |
| SK-26 | P2 plugin revoked between selection and execution | Permission rechecked; no call |
| SK-27 | P2 OAuth redirect/internal URL attack | Reject; no SSRF, token leakage |
| SK-28 | P2 external write requested by Skill | Requires exact human approval regardless of text |
| SK-29 | P2 provider tool output asks for model keys | No credentials exposed |
| SK-30 | Duplicate external write approval attempt | Idempotent reconciliation, one effect |
| SK-31 | Chat Runtime unavailable but text Skill exists | Honest error, no fake successful Chat |
| SK-32 | Automatic activation disabled | No auto skill selected, even if semantically matching |
| SK-33 | Auto-activation opt-in P1 and routing uncertain | Suggest only/ask; no surprise action |
| SK-34 | Skill deletion concurrent with pending generation | No new activation resurrected from old job |
| SK-35 | Skill activation log/analytics | IDs/hashes only, no full private prompt/secrets |

## Release gates

1. Trà/Thư approve resolver precedence and conflict/disabled behavior, token limits and schema.
2. Verify correct separation of GigaChat/GigaAgent context, Memory consent, tenant isolation and SDK tool permissions.
3. Validate P0 text-only Skills in real Chat LLM Runtime once 17T-25 provider/SSE implemented. Until then use fake provider fixture and label it mock.
4. Verify nullable/immutable revisions, cross-owner FK checks and cancellation/resume snapshot.
5. For P2 separately perform OAuth, MCP trust/SSRF, tool permissions and external-write idempotency threat tests before connecting a live service.
6. Only then freeze API contract under ADR-001 with browser cookie/CSRF evidence. This PR is documentation-only.
