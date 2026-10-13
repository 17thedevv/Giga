# Giga Plugin Registry & MCP Integration v0.1

> **PRODUCT DIRECTION APPROVED; TOOL PROVIDERS/PROTOCOL IMPLEMENTATION DEFERRED.** [17T-26](https://linear.app/17thedev/issue/17T-26/design-giga-skills-profiles-and-plugin-architecture). See [Skills Engine](GIGA_SKILLS_ENGINE_V0.1.md), [Agent sandbox & permissions](GIGA_AGENT_RUNTIME_SECURITY_V0.2.md), [API proposal](../contracts/GIGA_SKILLS_PROFILES_PLUGINS_API_V0.1.md).

## 1. Distinct products and terms

- **Plugin Registry**: product catalog of vetted connector adapters, capability descriptors and connection UX.
- **Connection**: a per-user authorized link to an external account/service; may have scopes, expiry, refresh and revocation.
- **Tool**: a schema-defined action the runtime may propose; execution requires a separately authorized policy decision.
- **MCP adapter**: an optional way to discover/call external provider tools. This is not an authorization shortcut, not a general remote URL fetcher, and is **not automatically installed just because a Skill mentions it**.

GigaChat may use read-only, explicitly enabled tools later for answers; GigaAgent may use broader tools with per-run scopes/approval. The tool registry and OAuth/security system can be shared, but Chat and Agent histories/permissions remain product separated.

## 2. Lifecycle

~~~mermaid
flowchart TD
  C[User chooses verified plugin] --> I[Connection initiation]
  I --> O[Consent and OAuth / service auth]
  O --> G[Save scoped grant and secret reference]
  G --> D[Discover vetted capabilities]
  D --> T[LLM proposes tool]
  T --> P[Server capability and user grant checks]
  P -->|Read allowed| X[Execute controlled tool]
  P -->|External write| A[Explicit action approval]
  A --> X
  P -->|Denied| N[No execution]
  X --> LOG[Redacted audit and result]
~~~

No model-authored request can install, authorize or enlarge OAuth scopes. A "tool-enabled skill" can *suggest* using a known tool but cannot force a grant or create credentials.

## 3. Trust and protocol

- OAuth/OIDC where supported: authorization code with PKCE, exact redirect allowlist, CSRF/state/nonce as applicable, user-specific account binding; server stores tokens encrypted in credential vault/managed secret service. Do not put raw OAuth refresh/access token in plugin_connections database row, prompt or browser logs.
- Other service auth must have equivalent scoped identity and encrypted secret handling. No arbitrary pasted token as an untracked universal tool.
- MCP server list for MVP/P2 is vetted/allowlisted, secure transport, authenticated tool discovery and schemas. Reject SSRF/private metadata destinations, DNS rebinding, redirects to internal services, unbounded output, unsafe tool aliases and injected tool descriptions.
- Dynamic MCP tool descriptions and tool results are **untrusted**, cannot change Giga Policy Engine, route model secrets to a different server or create hidden tool permissions.
- Plugin connection can be limited to Chat or Agent, resource allowlist and read/write scope. A user connection never means all tools in that provider are automatically usable in every Workspace.
- Tool call must pass tenant ownership, connection health, capability, mode, current scope/consent, allowed target and quota, even if model already requested it.
- External/destructive writes (PR, deploy, email send, deletion, purchase/charge) require exact bounded explicit approval and idempotency/reconciliation. Credential revocation must stop new calls.

## 4. Plugin metadata

Candidate registry fields: pluginId, immutable version, publisher, verified status, public description, allowed product surfaces, OAuth requirements, approved capabilities, tool schema hashes, output limits, allowed endpoints/domains, current availability and policy revision.

Connection fields: userId, pluginId/version, credentialRef (not token), grantedScopes, productScope, status, expiresAt, revokedAt and audit times. Grants can be separately resource/tool-specific and revoked at any time.

## 5. Milestones

- **P0:** no remote plugin execution required to demonstrate Skills; UI may show "Integrations — coming later" truthfully.
- **P1:** reviewed architecture and connection/grant settings design; no arbitrary MCP server installer.
- **P2:** one read-only vetted connector behind server-side auth, tool schema and cross-user isolation tests; then an explicitly approved write integration.
- **P3:** discovery/marketplace, verification/reputation and arbitrary third-party plugin submissions subject to separate threat model.

The shared Tool Registry is not a mandate to build a plugin marketplace immediately.

## 6. Test gates

- A skill that says "install/connect/use Gmail/GitHub" without a grant causes **no external calls**.
- User B cannot call A's plugin connection; guessed IDs return non-disclosing errors.
- Tool output asking to reveal credentials does not get privileged context.
- Revocation, expired scopes, changed OAuth permissions and redirected SSRF URLs all deny before action.
- Duplicate approval or ambiguous provider timeout does not create duplicate external effects.
- P2 connectors may not run model-generated arbitrary code on the Hono API host.

No plugin connection, MCP server, OAuth credential or paid Cloud service is created by this document.
