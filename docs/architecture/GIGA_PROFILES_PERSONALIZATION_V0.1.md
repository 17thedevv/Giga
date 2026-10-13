# Giga Profiles & Personalization v0.1

> **PRODUCT DIRECTION APPROVED, TECHNICAL DESIGN PROPOSED.** [17T-26](https://linear.app/17thedev/issue/17T-26/design-giga-skills-profiles-and-plugin-architecture). [Skills Engine](GIGA_SKILLS_ENGINE_V0.1.md), [Profiles API](../contracts/GIGA_SKILLS_PROFILES_PLUGINS_API_V0.1.md), [Memory](AI_MEMORY_RAG_V0.1.md).

## 1. Four separate sources of context

- **Auth Account**: user ID, verified email, session, display name and security state. Profile changes must never change credential/session ownership rules.
- **Personalization preferences**: response language, tone, verbosity and custom instructions. Explicit user-supplied settings, not inferred secrets; versioned.
- **Named AI Profiles** (P1): reusable groups of reply preferences, such as Developer, Researcher, Technical Writer; active profile chosen explicitly, scoped to product/session/conversation as reviewed.
- **Personal Memory**: selective factual recall with independent enabled/captureMode/useInChat consent, never silently enabled by profile switch. Profile is *not* a back door for GigaChat memory in Agent.

## 2. Recommended P0 settings

| Field | Type/values | Default |
|---|---|---|
| preferredLanguage | BCP 47 language code, validated | UI locale or user explicit preference |
| responseLength | concise / balanced / detailed | balanced |
| responseStyle | professional / casual / technical | professional |
| customInstructions | bounded UTF-8 text, optional | empty |
| defaultChatSkillIds | array of installed enabled skill identifiers or empty | empty; needs explicit selection |
| memoryEnabled | **separate Memory settings API** | off until consent |

No forced personal demographic fields, personal secrets or inference of sensitive categories. Settings can be viewed, edited and cleared without touching memory content or auth data.

## 3. Precedence and behavior

The current explicit user request may override general language/style preferences (e.g. English response despite Vietnamese default), subject to higher product/safety constraints. Manual selected skill normally outranks default suggested skill but cannot override the current request when contradictory; show conflicts clearly. If user picks a named AI Profile in future, take a snapshot of its revision per generation and pin active skill versions separately.

Agent should not automatically inherit GigaChat response preferences or personal memory: explicit product config may include preferred UI language while Agent's tool, file and security permissions remain independent. Workspace Skills are separate from Chat default Skills.

## 4. UX

Account menu -> **Profile** for user account display name. Settings -> **Personalization** for style/language/length/custom instructions and default text skills. Settings -> **Memory** links to separate Hybrid Memory UI with informed opt-in, editing and deletion controls.

Named AI Profiles (P1) get Create / Rename / Duplicate / Activate / Delete; preview sample answer and show inheritance (global preference vs profile override vs task override), never silently send raw private profile text to unrelated integrations.

## 5. Data/privacy gates

Store preference ownerId and monotonically versioned revisions; enforce owner-qualified writes/reads, CSRF, schema validation, size limits, audit of last changed time without logging raw custom text to analytics. Never store credentials in customInstructions. Delete/clear must prevent use on new calls, including stale queues; old immutable generation manifests retain minimal version hashes subject to explicit retention policy.

High-risk instructions ("ignore security", "send my password", "read another account") cannot be treated as authorization. Persist actual profile version used with each model invocation for reproducibility.

## 6. Acceptance

- Default user has no custom instructions or installed custom skills.
- Changing language/style affects the next Chat response and can be overridden by a direct prompt.
- Users A/B cannot read each other's custom preferences/profiles.
- Clearing preferences doesn't delete Memory; disabling Memory doesn't clear Profile.
- GigaAgent never implicitly retrieves GigaChat Memory and cannot gain command/network privileges from profile text.
