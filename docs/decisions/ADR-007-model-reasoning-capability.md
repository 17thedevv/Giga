# ADR-007 — Provider-agnostic model reasoning capability for GigaChat

Status: implementation candidate for 17T-41; independent Thư review pending.
Date: 2026-10-15. Owner: Trà. API v1 remains **DRAFT**.

## Decision

Reasoning effort is defined as a provider-agnostic, model-declared capability rather
than a Gemini- or provider-specific flag. Giga's normalized product contract is:

```ts
type ReasoningEffort = 'low' | 'medium' | 'high';
```

Provider and model adapters own translation of normalized effort to native provider APIs.
Adding future providers (e.g., OpenAI, Anthropic, xAI) will not require changing the public
Chat request shape, Chat DTOs, or database schema.

### 1. Normalized Product Contract & Information Hiding

- Public and runtime input accepts only `'low' | 'medium' | 'high'`.
- Provider-native fields (e.g., `thinkingLevel`, `thinkingBudget`, `reasoning.effort`,
  `output_config.effort`, raw token budgets, provider URLs) must never be accepted via
  public DTOs or exposed in public responses. Any unknown request fields are rejected
  with `400 VALIDATION_ERROR`.
- When `reasoningEffort` is absent: **no explicit user reasoning override is requested.
  The registered model/adapter default policy applies.**
  For the currently integrated Gemini model, Giga's legacy adapter policy selects
  `MINIMAL` thinkingLevel to preserve backward compatibility. Future providers
  (e.g., OpenAI, Anthropic) may specify their own default policies without altering
  the public contract.
- Raw internal reasoning / chain-of-thought is never exposed to clients. Deliberately
  suppressed at the adapter layer (`includeThoughts: false`, skipping thought parts).

### 2. Capability-Driven Model Registry

Model capabilities are declared per model alias in the trusted model registry, not globally
per provider:

```ts
interface ModelReasoningConfig {
  readonly supported: boolean;
  readonly efforts: readonly ReasoningEffort[];
}

interface ModelMetadata {
  readonly id: string;
  readonly capabilities: readonly Capability[];
  readonly reasoning: ModelReasoningConfig;
}
```

- Clients discover authoritative model capabilities via `GET /api/v1/models`.
- Requests specifying `reasoningEffort` on a model that does not support reasoning or
  specifying an effort level not advertised by that model are rejected with `400 VALIDATION_ERROR`
  prior to database admission and provider transport.
- The system never silently downgrades or invents an unreviewed mapping.
- The Core LLM Engine fail-fast preflights alias claims against underlying adapter
  capabilities at startup.
- Alias declarations cannot claim unsupported adapter levels, including adapters without a
  reasoning capability hook. Contradictory, duplicate or native-only effort declarations
  fail validation. Registry copies isolate trusted policy from metadata/caller mutation.
- Chat discovers streaming aliases from the registry and admits those aliases without
  provider branches. Stream-only legacy test doubles default to no controllable reasoning.

### 3. Core Engine Provider Agnosticism & Adapter-Owned Mapping

- The Core LLM Engine contains **zero** provider names, provider heuristics, or provider-native
  reasoning branches. It validates the normalized enum and forwards `reasoningEffort`
  unmodified to resolved requests.
- Adapter implementations own the translation hook:
  * Gemini adapter: maps `low -> LOW`, `medium -> MEDIUM`, `high -> HIGH`, and absent -> `MINIMAL`.
    Always sets `includeThoughts: false`.
  * Future adapters: implement and test a reviewed native effort/thinking policy per model.
    Native request shape and extra native modes remain adapter concerns.
- Models with no controllable reasoning advertise `{ supported: false, efforts: [] }`.

The initial model's reviewed native levels and minimal default are documented in Google's
[Gemini 3 developer guide](https://ai.google.dev/gemini-api/docs/gemini-3) and
[thinking configuration reference](https://ai.google.dev/gemini-api/docs/generate-content/thinking).
This is model-specific evidence, not a provider-wide capability guarantee. Live transport
verification remains separate from the deterministic adapter fixtures.

### 4. Persistence & Generation Semantics

- Migration **010** adds `reasoning_effort VARCHAR(10) NULL` to `chat_generations` with a CHECK constraint
  `CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('low', 'medium', 'high'))` and a PostgreSQL
  immutability trigger preventing row update tampering.
- Historical generations (migrations 001–009) remain `null`, cleanly preserving legacy records.
- Each generation snapshots normalized requested/effective `reasoning_effort`.
- Explicit requested effort is the effective normalized policy because adapters cannot
  downgrade it. Omission leaves the snapshot null/unspecified; native defaults are not
  reverse-mapped into invented normalized values. One nullable column serves all adapters.
- New message (`POST /messages:stream`), Retry, and Regenerate (`POST /generations:stream`) each
  independently validate and snapshot reasoning effort against the model selected for that generation.
- Durable Stop (`POST /generations/:id/cancel`) remains race-safe and aborts provider streams
  regardless of reasoning effort.
- Credential source (platform vs. BYOK via ADR-006) produces identical reasoning semantics and request shape.

## Compatibility & Migration

- Existing clients that omit `reasoningEffort` continue to function identically with zero changes.
- Omission preserves pre-upgrade prompt/variant idempotency fingerprints; an explicit
  effort becomes part of the request identity and cannot change under the same key.
- The `GET /api/v1/models` route is purely additive and requires authenticated session access.
- `ChatGeneration` and `ChatTurnVariants.items` DTOs include optional `reasoningEffort`.
- Database migration 010 is additive and nullable. PostgreSQL ALTER TABLE takes a table
  lock; assess migration duration on the target data volume before deployment. Roll back
  application code while retaining the added column rather than dropping historical snapshots.

## Review Questions for Thư

1. Does the shape `{ models: [{ id, capabilities, reasoning: { supported, efforts } }] }`
   satisfy the frontend model selector and reasoning control requirements?
2. Does omitting `reasoningEffort` when the user has not chosen an override align with the UI expectation
   of "model default"?
