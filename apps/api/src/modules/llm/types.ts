/**
 * Shared LLM Engine v0.1 — Domain Types
 * Provider-neutral domain models and request/event contracts.
 */

export type Capability =
  | 'text'
  | 'streaming'
  | 'structured'
  | 'embeddings'
  | 'tool_calling';

export type LLMCaller = 'chat' | 'agent' | 'memory';

export type ModelMessageRole = 'system' | 'user' | 'assistant';

export interface ModelMessage {
  readonly role: ModelMessageRole;
  readonly content: string;
  readonly name?: string;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'other';

export type TokenUsageSource = 'provider' | 'estimated';

export interface LLMUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly source: TokenUsageSource;
}

export type LLMStreamEvent =
  | { readonly type: 'text.delta'; readonly text: string }
  | {
      readonly type: 'usage';
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly source: TokenUsageSource;
    }
  | {
      readonly type: 'tool.proposed';
      readonly callId: string;
      readonly name: string;
      readonly arguments: unknown;
    }
  | {
      readonly type: 'completed';
      readonly finishReason: FinishReason;
    };

export interface LLMRequest {
  readonly modelAlias: string;
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens: number;
  readonly requestId: string;
  readonly caller: LLMCaller;
  readonly signal: AbortSignal;
}

export interface ResolvedLLMRequest extends LLMRequest {
  readonly providerId: string;
  readonly modelId: string;
}

export interface ModelResult {
  readonly text: string;
  readonly finishReason: FinishReason;
  readonly usage?: LLMUsage;
}

export interface ModelAliasConfig {
  readonly alias: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly requiredCapabilities: readonly Capability[];
  readonly maxOutputTokensLimit?: number;
}

export interface ToolSchema {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
}

export interface EmbeddingRequest {
  readonly modelAlias: string;
  readonly texts: readonly string[];
  readonly requestId: string;
  readonly caller: LLMCaller;
  readonly signal: AbortSignal;
}

export interface EmbeddingResult {
  readonly embeddings: readonly number[][];
  readonly dimensions: number;
  readonly usage?: LLMUsage;
}
