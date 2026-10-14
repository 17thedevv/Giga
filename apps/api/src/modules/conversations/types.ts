export type MessageRole = 'user' | 'assistant';

export interface Conversation {
  readonly id: string;
  readonly userId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Message {
  readonly id: string;
  readonly conversationId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: string;
}

export interface ConversationWithMessages {
  readonly conversation: Conversation;
  readonly messages: readonly Message[];
}

export interface ConversationListResponse {
  readonly items: readonly Conversation[];
  readonly nextCursor: string | null;
}

export interface CreateConversationInput {
  readonly title?: string;
}

export interface PaginationCursor {
  readonly updatedAt: string;
  readonly id: string;
}
