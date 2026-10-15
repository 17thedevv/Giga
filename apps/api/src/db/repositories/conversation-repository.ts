import type pg from 'pg';
import type { Conversation, PaginationCursor } from '../../modules/conversations/types.js';
import { encodeCursor } from '../../modules/conversations/conversations-validation.js';

export interface ConversationDbRow {
  id: string;
  user_id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
  cursor_updated_at?: string;
}

export function mapRowToConversation(row: ConversationDbRow): Conversation {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
    updatedAt: (row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at)).toISOString(),
  };
}

export class ConversationRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Creates a new conversation for the authenticated user.
   */
  async create(params: {
    userId: string;
    title: string;
  }): Promise<Conversation> {
    const query = `
      INSERT INTO conversations (user_id, title)
      VALUES ($1, $2)
      RETURNING id, user_id, title, created_at, updated_at;
    `;
    const values = [params.userId, params.title];
    const result = await this.pool.query<ConversationDbRow>(query, values);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Failed to create conversation: no row returned');
    }
    return mapRowToConversation(row);
  }

  /**
   * Finds a conversation by ID, strictly scoped to the owner user ID.
   */
  async findById(id: string, userId: string): Promise<Conversation | null> {
    const query = `
      SELECT id, user_id, title, created_at, updated_at
      FROM conversations
      WHERE id = $1 AND user_id = $2;
    `;
    const result = await this.pool.query<ConversationDbRow>(query, [id, userId]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return mapRowToConversation(row);
  }

  /**
   * Lists conversations for a user using deterministic keyset pagination.
   * Ordered by updated_at DESC, id DESC.
   */
  async listByUser(params: {
    userId: string;
    limit: number;
    cursor?: PaginationCursor;
  }): Promise<{ items: Conversation[]; nextCursor: string | null }> {
    let query: string;
    let values: unknown[];

    if (params.cursor) {
      query = `
        SELECT id, user_id, title, created_at, updated_at,
          to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at
        FROM conversations
        WHERE user_id = $1
          AND (
            updated_at < $2
            OR (updated_at = $2 AND id < $3)
          )
        ORDER BY updated_at DESC, id DESC
        LIMIT $4;
      `;
      values = [params.userId, params.cursor.updatedAt, params.cursor.id, params.limit + 1];
    } else {
      query = `
        SELECT id, user_id, title, created_at, updated_at,
          to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at
        FROM conversations
        WHERE user_id = $1
        ORDER BY updated_at DESC, id DESC
        LIMIT $2;
      `;
      values = [params.userId, params.limit + 1];
    }

    const result = await this.pool.query<ConversationDbRow>(query, values);
    const hasMore = result.rows.length > params.limit;
    const rows = hasMore ? result.rows.slice(0, params.limit) : result.rows;
    const items = rows.map(mapRowToConversation);

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const lastItem = items[items.length - 1];
      if (lastItem) {
        nextCursor = encodeCursor({
          // pg Date parsing truncates microseconds. Keep DB precision in opaque cursors.
          updatedAt: rows[rows.length - 1]!.cursor_updated_at ?? lastItem.updatedAt,
          id: lastItem.id,
        });
      }
    }

    return { items, nextCursor };
  }

  /**
   * Deletes a conversation by ID, strictly scoped to the owner user ID.
   * Returns true if a row was deleted, false otherwise.
   */
  async delete(id: string, userId: string): Promise<boolean> {
    const query = `
      DELETE FROM conversations
      WHERE id = $1 AND user_id = $2;
    `;
    const result = await this.pool.query(query, [id, userId]);
    return (result.rowCount ?? 0) > 0;
  }
}
