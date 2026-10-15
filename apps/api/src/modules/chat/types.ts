import type { ModelMessage, ResolvedModelIdentity } from '../llm/types.js';

export type GenerationStatus = 'pending' | 'streaming' | 'completed' | 'failed' | 'interrupted' | 'stopped';
export type ChatFinishReason = 'stop' | 'length' | 'other' | 'cancelled';
export type GenerationAction = 'new_prompt' | 'retry' | 'regenerate';
export interface ChatTurnVariants {
  readonly userMessageId: string;
  readonly selectedGenerationId: string | null;
  readonly items: readonly {
    readonly id: string;
    readonly action: GenerationAction;
    readonly modelId: string;
    readonly status: GenerationStatus;
    readonly assistantMessageId?: string;
    readonly content?: string;
    readonly createdAt: string;
    readonly finishedAt?: string;
  }[];
}
export interface ChatGeneration {
  readonly id: string;
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly assistantMessageId?: string;
  readonly modelId: string;
  readonly status: GenerationStatus;
  readonly partialContent: string;
  readonly finishReason?: ChatFinishReason;
  readonly error?: { readonly code: string; readonly message: string };
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly cancelRequestedAt?: string;
}

export const SAFE_GENERATION_ERROR = 'Generation could not be completed';
export const MAX_OUTPUT_BYTES = 65536;
export const MAX_PROMPT_BYTES = 16384;
export const MAX_CONTEXT_BYTES = 65536;
// Admission also reclaims crashed workers after this bound. All mutations are fenced by status.
export const GENERATION_LIFETIME_MS = 120000;

export type AdmissionInput = {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly modelId: string;
  readonly key: string;
  readonly fingerprint: string;
} & ({ readonly content: string; readonly action?: never; readonly userMessageId?: never }
  | { readonly userMessageId: string; readonly action: 'retry' | 'regenerate'; readonly content?: never });
export type Admission = { readonly generation: ChatGeneration; readonly duplicate: boolean };
export type Cancellation = { readonly generation: ChatGeneration; readonly accepted: boolean };
export interface GenerationRepository {
  authorize(ownerId: string, conversationId: string): Promise<void>;
  admit(input: AdmissionInput): Promise<Admission>;
  get(ownerId: string, conversationId: string, id: string): Promise<ChatGeneration>;
  variants(ownerId: string, conversationId: string, userMessageId: string): Promise<ChatTurnVariants>;
  context(ownerId: string, generation: ChatGeneration): Promise<readonly ModelMessage[]>;
  start(ownerId: string, id: string): Promise<void>;
  recordResolvedModel(ownerId: string, id: string, identity: ResolvedModelIdentity): Promise<void>;
  checkpoint(ownerId: string, id: string, text: string): Promise<void>;
  requestCancel(ownerId: string, conversationId: string, id: string, key: string): Promise<Cancellation>;
  complete(ownerId: string, generation: ChatGeneration, text: string, reason: ChatFinishReason): Promise<ChatGeneration>;
  finalize(ownerId: string, generation: ChatGeneration, text: string, status: 'failed' | 'interrupted', code: string): Promise<ChatGeneration>;
}

export interface ChatEvent {
  readonly event: 'message.started' | 'message.delta' | 'message.completed' | 'stream.error' | 'message.failed' | 'message.stopped';
  readonly data: Readonly<Record<string, unknown>>;
}
export type EventSink = (event: ChatEvent) => Promise<void>;
