/**
 * Shared LLM Engine v0.1 — Provider Adapter Interface
 *
 * Provider adapters encapsulate integration with specific LLM providers
 * (e.g. OpenAI, Anthropic, FakeProvider). They operate on resolved requests
 * and return normalized events or results.
 */

import type {
  Capability,
  EmbeddingRequest,
  EmbeddingResult,
  LLMStreamEvent,
  ModelResult,
  ResolvedLLMRequest,
  ToolSchema,
} from './types.js';
import type { ProviderCredential } from './provider-credential.js';

export interface ProviderAdapter {
  readonly providerId: string;
  readonly capabilities: ReadonlySet<Capability>;

  /**
   * Streams text generation tokens and usage events.
   *
   * Must yield exactly one terminal event { type: 'completed', finishReason: ... }
   * when generation completes cleanly. If the stream terminates without emitting
   * a completed event, the engine classifies it as a premature truncation failure.
   */
  streamText(req: ResolvedLLMRequest, credential?: ProviderCredential): AsyncIterable<LLMStreamEvent>;

  /**
   * Generates a single complete text completion.
   */
  generateText(req: ResolvedLLMRequest, credential?: ProviderCredential): Promise<ModelResult>;

  /**
   * Generates structured output conforming to a schema (future milestone).
   */
  generateStructured?<T>(req: ResolvedLLMRequest, schema: unknown): Promise<T>;

  /**
   * Generates embeddings for input texts (future milestone).
   */
  embedTexts?(req: EmbeddingRequest): Promise<EmbeddingResult>;

  /**
   * Streams generation with tool-calling proposals (future milestone).
   */
  streamWithTools?(req: ResolvedLLMRequest, tools: readonly ToolSchema[]): AsyncIterable<LLMStreamEvent>;
}
