# Shared LLM Engine v0.1 — Provider-neutral AI capabilities

> **Product direction approved 2026-10-13. Core engine implemented; broader technical design PROPOSED.** [17T-25](https://linear.app/17thedev/issue/17T-25/specify-gigachat-runtime-and-shared-llm-engine-v02). Owner Trà; Frontend consumer reviewer Thư. See [Chat Runtime](GIGACHAT_RUNTIME_V0.2.md), [Memory](AI_MEMORY_RAG_V0.1.md) and [Agent](GIGA_AGENT_ARCHITECTURE_V0.2.md).

## 1. Purpose and trust boundaries

Implementation status: 17T-31 supplies the core registry/engine and test-only FakeProvider;
17T-36 adds the first real Gemini adapter and normal startup bootstrap. See
[ADR-005](../decisions/ADR-005-first-chat-provider.md) for the reviewed candidate selection,
configuration, transport, cost/usage and retry limits. Broader quota/Memory/tool design
below remains proposed. Independent review and public API freeze are not implied.

One internal model access layer for GigaChat, GigaAgent Orchestrator and Memory workers. Engine owns model alias resolution, capability checks, provider integration, normalized model events, latency/usage accounting, server-enforced quotas and safe error classification. It **does not** own Chat conversation storage, Agent tool execution, sandbox privileges, user-memory retrieval consent, agent planning or public SSE framing.

~~~mermaid
flowchart TD
  CHAT[GigaChat Runtime] --> ENGINE[Shared LLM Engine]
  AGENT[GigaAgent Orchestrator] --> ENGINE
  MEMORY[Memory Worker] --> ENGINE
  ENGINE --> REG[Model Registry]
  REG --> BUDGET[Quota and Reservation]
  BUDGET --> ADAPTER[Provider Adapter Interface]
  ADAPTER --> MODEL[Configured model provider]
  ENGINE --> USAGE[(Usage and attempt records)]
~~~

## 2. Capabilities and milestones

| Capability | Client | Milestone |
|---|---|---|
| streamText | GigaChat | **First MVP** |
| generateText | Chat utilities | First provider adapter |
| generateStructured | Memory extraction / Agent planner | After Chat Core; validate against schema |
| embedTexts | Memory RAG | Memory milestone, pinned dimension/model generation |
| streamWithTools | GigaAgent | Agent milestone: model proposes tool calls, **does not execute** |

The Engine must reject a model missing capability before calling the provider; tool-call arguments are assembled/validated before Agent Permission Engine decides whether execution is allowed.

## 3. Internal TypeScript port proposal

~~~ts
type Capability = 'text' | 'streaming' | 'structured' | 'embeddings' | 'tool_calling';
type LLMStreamEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; source: 'provider' | 'estimated' }
  | { type: 'tool.proposed'; callId: string; name: string; arguments: unknown }
  | { type: 'completed'; finishReason: 'stop' | 'length' | 'tool_calls' | 'other' };

interface LLMRequest {
  modelAlias: string;
  messages: readonly ModelMessage[];
  maxOutputTokens: number;
  requestId: string;
  caller: 'chat' | 'agent' | 'memory';
  signal: AbortSignal;
}
interface ProviderAdapter {
  providerId: string;
  capabilities: ReadonlySet<Capability>;
  streamText(req: LLMRequest): AsyncIterable<LLMStreamEvent>;
  generateText(req: LLMRequest): Promise<ModelResult>;
  generateStructured?<T>(req: LLMRequest, schema: unknown): Promise<T>;
  embedTexts?(req: EmbeddingRequest): Promise<EmbeddingResult>;
  streamWithTools?(req: LLMRequest, tools: readonly ToolSchema[]): AsyncIterable<LLMStreamEvent>;
}
~~~

ModelMessage, ModelResult, EmbeddingRequest, EmbeddingResult and ToolSchema are internal validated abstractions to define during implementation; do not copy provider SDK types into public DTOs. Provider failures may throw classified exceptions; no fake completed event on error. Tool argument deltas cannot become executable tool calls before complete JSON and schema validation.

## 4. Model Registry and configuration

| Server-side alias | Capability | Configuration candidate |
|---|---|---|
| giga-chat-default | streaming text | CHAT_MODEL_ID + primary provider |
| giga-agent-default | text and tool calling | AGENT_MODEL_ID + allowed provider |
| giga-embedding-default | embeddings | EMBEDDING_MODEL_ID + model version/dimensions |

MVP chooses **one real primary provider and one chat model**; no requirement to implement multiple providers now. Agent tool and embedding capability may be developed later using same port. No browser-provided raw model ID, credentials, endpoint base URL, model parameters or arbitrary provider selection. Store actual resolved provider/model ID with usage and generations; aliases may evolve without falsifying history.

At startup validate alias definitions, expected capabilities, credentials presence and allowed limits. In production, missing provider credentials must **not** cause silent fake provider responses; fake provider is only for controlled tests.

## 5. Normalized streaming and error/retry policy

Normalize provider-specific stream events into ordered text.delta, usage and completed events. Chat Runtime maps these into public message.started/delta/completed events; Agent separately maps them to task/tool events.

| Condition | Engine response |
|---|---|
| Missing credentials / unsupported model capability | Reject before remote call, no automatic retry |
| Rate limit 429 | Honor Retry-After and bounded backoff when safe before first token |
| Provider timeout before first token | Bounded retry only when provider semantics/cost allow |
| Provider failure after output | Classify and stop, preserve partial via Chat Runtime; **do not append text from another model** |
| Cancel | Propagate AbortSignal, discard late events; reconcile possible provider-billed usage |
| Invalid structured output | Validate and retry within strict budget; never dispatch malformed tool |
| Embedding unavailable | Chat may continue with authorized recent conversation context |
| Fallback provider | **Deferred**, only after explicit policy/config/measurement |

Use connection, time-to-first-token, idle-token and total request deadlines. Caller controls user-visible stop; Engine does not choose chat persistence status itself.

## 6. Token budgets, usage and reservations

Input budget = selected model context window - output reserve - conservative safety margin. Apply real tokenizer or conservative model-specific estimator and bound instructions, recent turns and retrieval separately. Reject if mandatory context still cannot fit. Avoid guessed universally applicable context windows.

Quota scopes: user/day, generation/run, concurrent active calls, model alias and global ceiling. Before provider call, reserve an estimated maximum budget atomically so concurrent requests cannot both spend the same quota. A failed or aborted provider request may still incur charges.

Proposed llm_usage_events: id, user_id, caller_type, caller_id, request_id, attempt, provider_id, model_alias, resolved_model_id, price_version, input_tokens?, output_tokens?, usage_source (provider/estimated/unknown), estimated_cost_minor_units?, currency, latency_ms, status, sanitized_error_code, timestamp.

Separate reservations must be released/settled consistently. If upstream provides no usage after disconnect, record estimated/unknown, never exact fabricated token/cost values. Price/version are configuration snapshots, not live billing invoices. Keep secret/raw prompts and tokens out of public logs and analytics.

## 7. Data protection

Provider keys remain server-side. Validate incoming model alias, request size, allowed capabilities and user budget. Never expose provider errors with secrets or raw request headers. External web pages, retrieved personal memory, repository content and tool output are untrusted data; LLM Engine never elevates them to privileged instructions or permissions. User-content retention/provider terms, region and pricing must be reviewed when selecting actual provider.

## 8. Gates and ownership

Trà implements Engine/internal provider port and tests; Thư reviews Chat SSE/consumer contract and usage UI. Validate fake adapter first, then one real provider against staging, recorded resolved model/capabilities/tokenization and cancellation. Additional providers are replaceable internals as long as public contract and usage truthfulness remain stable.

**Chat provider candidate:** ADR-005 selects Gemini for 17T-36; independent review remains
pending. Real quotas/cost controls, pricing configuration, browser/cloud proxy behavior
and embedding dimensions remain deferred. Broader architecture is not automatically approved.
