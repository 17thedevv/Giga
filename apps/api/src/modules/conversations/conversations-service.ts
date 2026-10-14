import type { ConversationRepository } from '../../db/repositories/conversation-repository.js';
import type { MessageRepository } from '../../db/repositories/message-repository.js';
import { NotFoundError } from './conversations-validation.js';
import type {
  Conversation,
  ConversationListResponse,
  ConversationWithMessages,
  CreateConversationInput,
  Message,
  MessageRole,
  PaginationCursor,
} from './types.js';

export class ConversationsService {
  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: MessageRepository
  ) {}

  /**
   * Creates a new conversation for the authenticated user.
   */
  async createConversation(
    userId: string,
    input: CreateConversationInput
  ): Promise<Conversation> {
    const title = input.title && input.title.trim() ? input.title.trim() : 'New Conversation';
    return this.conversationRepo.create({ userId, title });
  }

  /**
   * Lists conversations for the authenticated user with deterministic keyset pagination.
   */
  async listConversations(
    userId: string,
    params: { limit: number; cursor?: PaginationCursor }
  ): Promise<ConversationListResponse> {
    return this.conversationRepo.listByUser({
      userId,
      limit: params.limit,
      cursor: params.cursor,
    });
  }

  /**
   * Retrieves a conversation along with its full message history.
   * Throws NotFoundError if the conversation does not exist or belongs to another user.
   */
  async getConversationWithMessages(
    conversationId: string,
    userId: string
  ): Promise<ConversationWithMessages> {
    const conversation = await this.conversationRepo.findById(conversationId, userId);
    if (!conversation) {
      throw new NotFoundError('Conversation not found');
    }

    const messages = await this.messageRepo.listByConversation(conversationId);
    return {
      conversation,
      messages,
    };
  }

  /**
   * Deletes a conversation by ID, strictly verifying user ownership.
   * Throws NotFoundError if the conversation does not exist or belongs to another user.
   */
  async deleteConversation(conversationId: string, userId: string): Promise<void> {
    const deleted = await this.conversationRepo.delete(conversationId, userId);
    if (!deleted) {
      throw new NotFoundError('Conversation not found');
    }
  }

  /**
   * Appends a message to a conversation after verifying owner access.
   */
  async addMessage(params: {
    conversationId: string;
    userId: string;
    role: MessageRole;
    content: string;
  }): Promise<Message> {
    const conversation = await this.conversationRepo.findById(
      params.conversationId,
      params.userId
    );
    if (!conversation) {
      throw new NotFoundError('Conversation not found');
    }

    return this.messageRepo.create({
      conversationId: params.conversationId,
      role: params.role,
      content: params.content,
    });
  }
}
