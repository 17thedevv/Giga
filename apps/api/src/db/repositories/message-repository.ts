import type pg from 'pg';
import type { Message, MessageRole } from '../../modules/conversations/types.js';
import { CHAT_HISTORY_FROM, CHAT_HISTORY_ORDER, CHAT_HISTORY_VISIBLE } from '../../modules/chat/chat-history.js';

export interface MessageDbRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  created_at: Date;
}

export function mapRowToMessage(row: MessageDbRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
  };
}

export class MessageRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Appends a message to a conversation.
   */
  async create(params: {
    conversationId: string;
    role: MessageRole;
    content: string;
  }): Promise<Message> {
    const query = `
      INSERT INTO messages (conversation_id, role, content)
      VALUES ($1, $2, $3)
      RETURNING id, conversation_id, role, content, created_at;
    `;
    const result = await this.pool.query<MessageDbRow>(query, [
      params.conversationId,
      params.role,
      params.content,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Failed to create message: no row returned');
    }
    return mapRowToMessage(row);
  }

  /**
   * Lists messages in a conversation ordered deterministically by created_at ASC, id ASC.
   */
  async listByConversation(conversationId: string): Promise<Message[]> {
    const query = `
      SELECT m.id, m.conversation_id, m.role, m.content, m.created_at
      ${CHAT_HISTORY_FROM}
      WHERE m.conversation_id = $1 AND ${CHAT_HISTORY_VISIBLE}
      ORDER BY ${CHAT_HISTORY_ORDER};
    `;
    const result = await this.pool.query<MessageDbRow>(query, [conversationId]);
    return result.rows.map(mapRowToMessage);
  }

  /**
   * Deletes all messages in a conversation.
   */
  async deleteByConversation(conversationId: string): Promise<number> {
    const query = `
      DELETE FROM messages
      WHERE conversation_id = $1;
    `;
    const result = await this.pool.query(query, [conversationId]);
    return result.rowCount ?? 0;
  }
}
