import type { ModelMessage } from '../llm/types.js';

export type GenerationStatus = 'pending' | 'streaming' | 'completed' | 'failed' | 'interrupted';
export type ChatFinishReason = 'stop' | 'length' | 'other';
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
}

export const SAFE_GENERATION_ERROR = 'Generation could not be completed';
export const MAX_OUTPUT_BYTES = 65536;
export const MAX_PROMPT_BYTES = 16384;
export const MAX_CONTEXT_BYTES = 65536;
// Admission also reclaims crashed workers after this bound. All mutations are fenced by status.
export const GENERATION_LIFETIME_MS = 120000;

export interface AdmissionInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly content: string;
  readonly modelId: string;
  readonly key: string;
  readonly fingerprint: string;
}
export type Admission = { readonly generation: ChatGeneration; readonly duplicate: boolean };
export interface GenerationRepository {
  authorize(ownerId: string, conversationId: string): Promise<void>;
  admit(input: AdmissionInput): Promise<Admission>;
  get(ownerId: string, conversationId: string, id: string): Promise<ChatGeneration>;
  context(ownerId: string, generation: ChatGeneration): Promise<readonly ModelMessage[]>;
  start(ownerId: string, id: string): Promise<void>;
  checkpoint(ownerId: string, id: string, text: string): Promise<void>;
  complete(ownerId: string, generation: ChatGeneration, text: string, reason: ChatFinishReason): Promise<ChatGeneration>;
  fail(ownerId: string, id: string, text: string, status: 'failed' | 'interrupted', code: string): Promise<void>;
}

export interface ChatEvent {
  readonly event: 'message.started' | 'message.delta' | 'message.completed' | 'stream.error' | 'message.failed';
  readonly data: Readonly<Record<string, unknown>>;
}
export type EventSink = (event: ChatEvent) => Promise<void>;
