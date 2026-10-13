# Giga Skills / Profiles / Plugins — Data Model v0.1

> **NON-EXECUTABLE DRAFT. NO MIGRATIONS RUN.** [17T-26](https://linear.app/17thedev/issue/17T-26/design-giga-skills-profiles-and-plugin-architecture). [Skills Engine](GIGA_SKILLS_ENGINE_V0.1.md), [Profiles](GIGA_PROFILES_PERSONALIZATION_V0.1.md), [Plugins](GIGA_PLUGINS_MCP_V0.1.md), [Candidate API](../contracts/GIGA_SKILLS_PROFILES_PLUGINS_API_V0.1.md).

## 1. Persistence boundaries

PostgreSQL stores owner-scoped preferences, skills, immutable revisions, installations/enablement, activation manifests and (later) plugin metadata/grants. It does **not** store raw access/refresh tokens; plugin credentials belong in reviewed secret storage and DB stores only encrypted-safe references. Existing users/sessions is the authority for owner identity. Memory consent/content remains exclusively in 17T-22 Memory schema. Agent Workspace belongs to separate 17T-24 domain. Generation association is dependent on the new Chat Runtime proposed in 17T-25 PR #12: do not create premature foreign keys before actual schema review.

## 2. Candidate logical tables

| Table | Fields (logical candidates) | Rules |
|---|---|---|
| user_preferences | user_id, revision, preferred_language, response_length, response_style, custom_instructions, updated_at | Exactly one current record per user; versioned updates; default empty instructions |
| ai_profiles (P1) | id, owner_id, name, preference_snapshot, revision, created_at, updated_at | Owner-scoped unique normalized name, optional active per product |
| skill_definitions | id, owner_id nullable for built-in, slug, title, description, visibility, supported_products, status, created_at | Built-ins are registry-owned immutable publish action; custom private by default |
| skill_versions | id, skill_id, version_number, content_hash, manifest_json, instruction_content, validation_status, created_at, created_by | Immutable, UNIQUE(skill_id,version_number), hash verified |
| skill_installations | id, user_id, skill_id, selected_version_id, enabled, product_scope, installed_at, disabled_at? | UNIQUE(user_id,skill_id); user cannot select another owner's private skill |
| workspace_skill_defaults | workspace_id, skill_installation_id, position, enabled, updated_at | Only workspace owner can set; no Chat default from Agent workspace |
| skill_activation_manifests | id, user_id, target_type (chat_generation/agent_run), target_id, profile_revision_id?, resolver_version, activated_at, total_tokens | Exactly one target namespace, owner qualified, no unreviewed Chat memory |
| skill_activation_items | manifest_id, skill_version_id, content_hash, source (manual/workspace/auto), position | Immutable ordered snapshotted activation IDs |
| plugin_catalog (P2) | id, publisher, version, capabilities_hash, supported_products, trust_status, approved_domains | Server-owned, vetted descriptors |
| plugin_connections (P2) | id, owner_id, plugin_id, credential_ref, status, scope_revision, expires_at, revoked_at | Never plaintext tokens; unique appropriate owner/account binding |
| plugin_grants (P2) | id, connection_id, tool_name, resource_scope, operation_scope, product_scope, expires_at, revoked_at | Explicit capability and target grants, revocable |
| plugin_tool_audit (P2) | id, owner_id, connection_id, run_id?, generation_id?, tool_schema_version, action_hash, status, created_at | Bounded/redacted safe metadata, separate detailed sensitive logs by policy |

These are **proposed entities**; some may be consolidated once implementation scope/performance is reviewed. Do not add speculative P2 tables to P0 migrations just to match a diagram.

## 3. Integrity / tenant isolation

- User-facing reads/updates always filter owner_id from session, not user-submitted owner IDs.
- skill_versions references parent skill_definition. A custom skill version is editable only through create-new-version transaction; existing version bytes/hash never mutate.
- Cross-owner installation is rejected even if raw skill ID exists; do not disclose another user's private skill metadata.
- skill_installations.selected_version_id must belong to that same skill_definition; enforce with composite key/transaction guard, not a loose FK.
- Activation manifest references immutable skill version IDs and content hashes; it cannot refer to a version disabled before admission.
- Workspace default can reference only an installation owned by the same owner as Workspace. Use composite FK or owner-qualified check verified under lock.
- For optional ai_profiles, active selection and profile snapshots must be from same user. Do not automatically switch profile on another user's run.
- A disabled/deleted/uninstalled skill cannot activate for **new** generations/runs; old activity manifests may retain minimal provenance (IDs/hash) under retention policy. Hard-delete of raw instructions must have documented audit/replay impact.
- Current version publishing uses revision/CAS, so a generation that starts during an edit resolves either old or new fully committed version, never half-written content.
- Plugin grants may never outlive revoked connection or expanded OAuth rights; check connection status/scopes per tool call. SecretRef inaccessible via public APIs.
- P0 deployment migrates profile and text-skill entities separately after inspecting current users/session schema. LLM generation linkage should follow merged 17T-25 implementation.

## 4. Activation snapshot and delete race

Admission transaction: read skill installations and current selected skill_version under owner scope, validate enabled/version/compatible product, create activation manifest with content hashes, then start model call. Any rejected or stale skill activation yields a validation/conflict status; do not silently inject a skill that was disabled. After a completed generation, manifest provides provenance even if the owner later edits a skill.

Disable/edit mid-stream: current model input cannot be retracted retroactively; **future** generations must not include disabled revision. External tool authorization never comes from manifest and must be checked against revocation at invocation time. For queued Agent runs, revalidate available skills before instruction assembly and cancel/reconfigure when needed.

## 5. Migration, retention and index gates

- Scope phase P0 to user_preferences + skill_definitions + skill_versions + skill_installations + skill activation metadata and minimal Agent workspace-default mapping only if that Workspace implementation exists.
- Define skill content max bytes, frontmatter size and token budget, instruction validation, lifecycle and retention/deletion in privacy policy before migration.
- Add indexes for owner skill list, slug/version lookup, installed enabled skills by product, and activation by target. Do not index full private skill text into shared public search.
- Keep plugin P2 tables behind their own reviewed migration. No plaintext credentials, no public arbitrary plugin-server URL field used as outbound request target.
- Integration tests use isolated real PostgreSQL after 17T-23 safeguards; never run destructive test cleanup on application DATABASE_URL.

## 6. Compatibility questions

How to link activation manifests to chat_generations before 17T-25 is merged? What minimal historical audit remains after skill deletion? How are duplicate public built-in IDs/version upgrades treated? Which profile field sources override defaults? Technical answers require Trà/Thư sign-off and should not be silently baked into SQL.
