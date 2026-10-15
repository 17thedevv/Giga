import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ConflictError, NotFoundError } from '../auth/auth-validation.js';
import type { ModelMessage } from '../llm/types.js';
import {
  GENERATION_LIFETIME_MS, MAX_CONTEXT_BYTES, SAFE_GENERATION_ERROR,
  type Admission, type AdmissionInput, type ChatFinishReason, type ChatGeneration,
  type GenerationRepository, type GenerationStatus,
} from './types.js';

interface GenerationRow {
  id: string; conversation_id: string; user_message_id: string;
  assistant_message_id: string | null; model_alias: string; status: GenerationStatus;
  partial_content: string; finish_reason: ChatFinishReason | null; error_code: string | null;
  request_fingerprint: string; created_at: Date; started_at: Date | null; finished_at: Date | null;
}
const iso = (value: Date): string => new Date(value).toISOString();
function map(row: GenerationRow): ChatGeneration {
  return {
    id: row.id, conversationId: row.conversation_id, userMessageId: row.user_message_id,
    ...(row.assistant_message_id ? { assistantMessageId: row.assistant_message_id } : {}),
    modelId: row.model_alias, status: row.status, partialContent: row.partial_content,
    ...(row.finish_reason ? { finishReason: row.finish_reason } : {}),
    ...(row.error_code ? { error: { code: row.error_code, message: SAFE_GENERATION_ERROR } } : {}),
    createdAt: iso(row.created_at),
    ...(row.started_at ? { startedAt: iso(row.started_at) } : {}),
    ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {}),
  };
}

export class PostgresGenerationRepository implements GenerationRepository {
  constructor(private readonly pool: pg.Pool) {}

  private async transaction<T>(action: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const result = await action(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally { client.release(); }
  }

  async authorize(ownerId: string, conversationId: string): Promise<void> {
    const result = await this.pool.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, ownerId]);
    if (!result.rows[0]) throw new NotFoundError();
  }

  async get(ownerId: string, conversationId: string, id: string): Promise<ChatGeneration> {
    const result = await this.pool.query<GenerationRow>(`
      SELECT g.* FROM chat_generations g JOIN conversations c ON c.id = g.conversation_id
      WHERE g.id = $1 AND g.conversation_id = $2 AND g.owner_id = $3 AND c.user_id = $3`, [id, conversationId, ownerId]);
    if (!result.rows[0]) throw new NotFoundError();
    return map(result.rows[0]);
  }

  async admit(input: AdmissionInput): Promise<Admission> {
    try {
      return await this.transaction(async (client) => {
        // Serializes admission with other workers and conversation deletion. No provider I/O here.
        const owned = await client.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2 FOR UPDATE', [input.conversationId, input.ownerId]);
        if (!owned.rows[0]) throw new NotFoundError();
        const existing = await client.query<GenerationRow>('SELECT * FROM chat_generations WHERE owner_id = $1 AND idempotency_key = $2', [input.ownerId, input.key]);
        if (existing.rows[0]) {
          if (existing.rows[0].request_fingerprint !== input.fingerprint) throw new ConflictError('Idempotency key was used for a different request');
          return { generation: map(existing.rows[0]), duplicate: true };
        }
        await client.query(`UPDATE chat_generations SET status = 'interrupted', error_code = 'INTERRUPTED', finished_at = NOW()
          WHERE conversation_id = $1 AND owner_id = $2 AND status IN ('pending', 'streaming') AND created_at < $3`,
        [input.conversationId, input.ownerId, new Date(Date.now() - GENERATION_LIFETIME_MS)]);
        const active = await client.query("SELECT id FROM chat_generations WHERE conversation_id = $1 AND status IN ('pending', 'streaming')", [input.conversationId]);
        if (active.rows[0]) throw new ConflictError('Conversation already has an active generation');
        const userMessageId = randomUUID();
        await client.query("INSERT INTO messages (id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)", [userMessageId, input.conversationId, input.content]);
        const result = await client.query<GenerationRow>(`INSERT INTO chat_generations
          (owner_id, conversation_id, user_message_id, model_alias, status, idempotency_key, request_fingerprint)
          VALUES ($1, $2, $3, $4, 'pending', $5, $6) RETURNING *`,
        [input.ownerId, input.conversationId, userMessageId, input.modelId, input.key, input.fingerprint]);
        await client.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1 AND user_id = $2', [input.conversationId, input.ownerId]);
        return { generation: map(result.rows[0]!), duplicate: false };
      });
    } catch (error) {
      // Different conversations can race on the owner/key uniqueness constraint.
      if ((error as { code?: string }).code !== '23505') throw error;
      const existing = await this.pool.query<GenerationRow>('SELECT * FROM chat_generations WHERE owner_id = $1 AND idempotency_key = $2', [input.ownerId, input.key]);
      if (existing.rows[0]?.request_fingerprint === input.fingerprint) return { generation: map(existing.rows[0]), duplicate: true };
      throw new ConflictError('Generation admission conflict');
    }
  }

  async context(ownerId: string, generation: ChatGeneration): Promise<readonly ModelMessage[]> {
    // Exclude failed/interrupted/pending turns and all partial output. Include current persisted prompt.
    const result = await this.pool.query<{ id: string; role: 'user' | 'assistant'; content: string }>(`
      SELECT m.id, m.role, m.content FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN chat_generations g ON g.user_message_id = m.id
      WHERE m.conversation_id = $1 AND c.user_id = $2
        AND (g.id IS NULL OR g.status = 'completed' OR m.id = $3)
      ORDER BY m.created_at DESC, m.id DESC LIMIT 41`, [generation.conversationId, ownerId, generation.userMessageId]);
    const current = result.rows.find((row) => row.id === generation.userMessageId);
    if (!current) throw new NotFoundError();
    const recent: ModelMessage[] = [];
    let bytes = Buffer.byteLength(current.content);
    for (const row of result.rows) {
      if (row.id === current.id) continue;
      bytes += Buffer.byteLength(row.content);
      if (bytes > MAX_CONTEXT_BYTES || recent.length >= 40) break;
      recent.unshift({ role: row.role, content: row.content });
    }
    // Truncation must not retain a detached assistant at the start of context.
    while (recent[0]?.role === 'assistant') recent.shift();
    return [...recent, { role: 'user', content: current.content }];
  }

  async start(ownerId: string, id: string): Promise<void> {
    const result = await this.pool.query("UPDATE chat_generations SET status = 'streaming', started_at = NOW() WHERE id = $1 AND owner_id = $2 AND status = 'pending' RETURNING id", [id, ownerId]);
    if (!result.rows[0]) throw new ConflictError('Generation is no longer pending');
  }

  async checkpoint(ownerId: string, id: string, text: string): Promise<void> {
    const result = await this.pool.query("UPDATE chat_generations SET partial_content = $3 WHERE id = $1 AND owner_id = $2 AND status = 'streaming' RETURNING id", [id, ownerId, text]);
    if (!result.rows[0]) throw new ConflictError('Generation is no longer streaming');
  }

  // Protected transaction step permits deterministic rollback fault injection without patching pg internals.
  protected async insertAssistant(client: pg.PoolClient, generation: ChatGeneration, text: string): Promise<void> {
    await client.query("INSERT INTO messages (id, conversation_id, role, content) VALUES ($1, $2, 'assistant', $3)", [generation.id, generation.conversationId, text]);
  }

  async complete(ownerId: string, generation: ChatGeneration, text: string, reason: ChatFinishReason): Promise<ChatGeneration> {
    return this.transaction(async (client) => {
      const owned = await client.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2 FOR UPDATE', [generation.conversationId, ownerId]);
      if (!owned.rows[0]) throw new NotFoundError();
      const active = await client.query("SELECT id FROM chat_generations WHERE id = $1 AND owner_id = $2 AND status = 'streaming' FOR UPDATE", [generation.id, ownerId]);
      if (!active.rows[0]) throw new ConflictError('Generation is no longer streaming');
      await this.insertAssistant(client, generation, text);
      const result = await client.query<GenerationRow>(`UPDATE chat_generations SET status = 'completed', assistant_message_id = $1,
        partial_content = $3, finish_reason = $4, finished_at = NOW() WHERE id = $1 AND owner_id = $2 AND status = 'streaming' RETURNING *`, [generation.id, ownerId, text, reason]);
      await client.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1 AND user_id = $2', [generation.conversationId, ownerId]);
      return map(result.rows[0]!);
    });
  }

  async fail(ownerId: string, id: string, text: string, status: 'failed' | 'interrupted', code: string): Promise<void> {
    await this.pool.query(`UPDATE chat_generations SET status = $3, partial_content = $4, error_code = $5, finished_at = NOW()
      WHERE id = $1 AND owner_id = $2 AND status IN ('pending', 'streaming')`, [id, ownerId, status, text, code]);
  }
}
