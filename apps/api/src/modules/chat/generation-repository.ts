import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ConflictError, NotFoundError } from '../auth/auth-validation.js';
import type { ModelMessage } from '../llm/types.js';
import { CHAT_HISTORY_FROM, CHAT_HISTORY_VISIBLE } from './chat-history.js';
import {
  GENERATION_LIFETIME_MS, MAX_CONTEXT_BYTES, SAFE_GENERATION_ERROR,
  type Admission, type AdmissionInput, type ChatFinishReason, type ChatGeneration,
  type GenerationRepository, type GenerationStatus, type Cancellation, type ChatTurnVariants, type GenerationAction,
} from './types.js';

interface GenerationRow {
  id: string; conversation_id: string; user_message_id: string;
  assistant_message_id: string | null; model_alias: string; status: GenerationStatus;
  partial_content: string; finish_reason: ChatFinishReason | null; error_code: string | null;
  request_fingerprint: string; created_at: Date; started_at: Date | null; finished_at: Date | null;
  cancel_requested_at: Date | null;
  action: GenerationAction;
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
    ...(row.cancel_requested_at ? { cancelRequestedAt: iso(row.cancel_requested_at) } : {}),
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

  private async lockGeneration(client: pg.PoolClient, ownerId: string, conversationId: string, id: string): Promise<GenerationRow> {
    // Same lock order as admission/completion and the conversation-delete FK boundary.
    const owned = await client.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2 FOR UPDATE', [conversationId, ownerId]);
    if (!owned.rows[0]) throw new NotFoundError();
    const result = await client.query<GenerationRow>('SELECT * FROM chat_generations WHERE id = $1 AND conversation_id = $2 AND owner_id = $3 FOR UPDATE', [id, conversationId, ownerId]);
    if (!result.rows[0]) throw new NotFoundError();
    return result.rows[0];
  }

  private async bindKey(client: pg.PoolClient, ownerId: string, id: string, key: string, operation: 'prompt' | 'cancel' | 'retry' | 'regenerate'): Promise<void> {
    await client.query(`INSERT INTO chat_operation_keys (owner_id, idempotency_key, generation_id, operation)
      VALUES ($1, $2, $3, $4) ON CONFLICT (owner_id, idempotency_key) DO NOTHING`, [ownerId, key, id, operation]);
    const binding = await client.query<{ generation_id: string; operation: string }>('SELECT generation_id, operation FROM chat_operation_keys WHERE owner_id = $1 AND idempotency_key = $2', [ownerId, key]);
    if (binding.rows[0]?.generation_id !== id || binding.rows[0]?.operation !== operation) {
      throw new ConflictError('Idempotency key was used for a different operation');
    }
  }

  private async target(client: Pick<pg.PoolClient, 'query'>, conversationId: string, userMessageId: string): Promise<void> {
    const found = await client.query("SELECT id FROM messages WHERE id = $1 AND conversation_id = $2 AND role = 'user'", [userMessageId, conversationId]);
    if (!found.rows[0]) throw new NotFoundError();
  }

  private async latest(client: Pick<pg.PoolClient, 'query'>, conversationId: string, userMessageId: string): Promise<void> {
    const latest = await client.query("SELECT id FROM messages WHERE conversation_id = $1 AND role = 'user' ORDER BY created_at DESC, id DESC LIMIT 1", [conversationId]);
    if (latest.rows[0]?.id !== userMessageId) throw new ConflictError('Only the latest user turn is eligible');
  }

  async variants(ownerId: string, conversationId: string, userMessageId: string): Promise<ChatTurnVariants> {
    return this.transaction(async (client) => {
      // Same conversation lock as new prompts, completion and deletion: coherent list + selection.
      const owned = await client.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2 FOR UPDATE', [conversationId, ownerId]);
      if (!owned.rows[0]) throw new NotFoundError();
      await this.target(client, conversationId, userMessageId);
      await this.latest(client, conversationId, userMessageId);
      const attempts = await client.query<GenerationRow>('SELECT * FROM chat_generations WHERE owner_id = $1 AND conversation_id = $2 AND user_message_id = $3 ORDER BY created_at ASC, id ASC', [ownerId, conversationId, userMessageId]);
      const selection = await client.query<{ selected_generation_id: string }>('SELECT selected_generation_id FROM chat_turn_selections WHERE owner_id = $1 AND conversation_id = $2 AND user_message_id = $3', [ownerId, conversationId, userMessageId]);
      return {
        userMessageId, selectedGenerationId: selection.rows[0]?.selected_generation_id ?? null,
        items: attempts.rows.map((row) => ({
          id: row.id, action: row.action, modelId: row.model_alias, status: row.status,
          ...(row.status === 'completed' ? { assistantMessageId: row.assistant_message_id!, content: row.partial_content } : {}),
          createdAt: iso(row.created_at), ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {}),
        })),
      };
    });
  }

  async requestCancel(ownerId: string, conversationId: string, id: string, key: string): Promise<Cancellation> {
    return this.transaction(async (client) => {
      const row = await this.lockGeneration(client, ownerId, conversationId, id);
      await this.bindKey(client, ownerId, id, key, 'cancel');
      if (row.status !== 'pending' && row.status !== 'streaming') return { generation: map(row), accepted: false };
      if (row.cancel_requested_at) return { generation: map(row), accepted: true };
      const result = await client.query<GenerationRow>(`UPDATE chat_generations SET cancel_requested_at = NOW()
        WHERE id = $1 AND owner_id = $2 AND status IN ('pending', 'streaming') RETURNING *`, [id, ownerId]);
      return { generation: map(result.rows[0]!), accepted: true };
    });
  }

  async admit(input: AdmissionInput): Promise<Admission> {
    try {
      return await this.transaction(async (client) => {
        // Serializes admission with other workers and conversation deletion. No provider I/O here.
        const owned = await client.query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2 FOR UPDATE', [input.conversationId, input.ownerId]);
        if (!owned.rows[0]) throw new NotFoundError();
        if (input.userMessageId) await this.target(client, input.conversationId, input.userMessageId);
        const existing = await client.query<GenerationRow>('SELECT * FROM chat_generations WHERE owner_id = $1 AND idempotency_key = $2', [input.ownerId, input.key]);
        if (existing.rows[0]) {
          if (existing.rows[0].request_fingerprint !== input.fingerprint) throw new ConflictError('Idempotency key was used for a different request');
          return { generation: map(existing.rows[0]), duplicate: true };
        }
        await client.query(`UPDATE chat_generations SET
          status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'stopped' ELSE 'interrupted' END,
          finish_reason = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE NULL END,
          error_code = CASE WHEN cancel_requested_at IS NOT NULL THEN NULL ELSE 'INTERRUPTED' END, finished_at = NOW()
          WHERE conversation_id = $1 AND owner_id = $2 AND status IN ('pending', 'streaming') AND created_at < $3`,
        [input.conversationId, input.ownerId, new Date(Date.now() - GENERATION_LIFETIME_MS)]);
        const active = await client.query("SELECT id FROM chat_generations WHERE conversation_id = $1 AND status IN ('pending', 'streaming')", [input.conversationId]);
        if (active.rows[0]) throw new ConflictError('Conversation already has an active generation');
        const userMessageId = input.userMessageId ?? randomUUID();
        if (input.action) {
          await this.latest(client, input.conversationId, userMessageId);
          const attempts = await client.query<GenerationRow>('SELECT * FROM chat_generations WHERE owner_id = $1 AND conversation_id = $2 AND user_message_id = $3 ORDER BY created_at DESC, id DESC', [input.ownerId, input.conversationId, userMessageId]);
          if (input.action === 'retry' && !['failed', 'stopped', 'interrupted'].includes(attempts.rows[0]?.status ?? '')) {
            throw new ConflictError('Retry requires a failed, stopped or interrupted latest attempt');
          }
          if (input.action === 'regenerate' && !attempts.rows.some((row) => row.status === 'completed')) {
            throw new ConflictError('Regenerate requires a completed variant');
          }
        } else {
          await client.query("INSERT INTO messages (id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)", [userMessageId, input.conversationId, input.content]);
        }
        const result = await client.query<GenerationRow>(`INSERT INTO chat_generations
          (owner_id, conversation_id, user_message_id, model_alias, status, idempotency_key, request_fingerprint, action)
          VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7) RETURNING *`,
        [input.ownerId, input.conversationId, userMessageId, input.modelId, input.key, input.fingerprint, input.action ?? 'new_prompt']);
        await this.bindKey(client, input.ownerId, result.rows[0]!.id, input.key, input.action ?? 'prompt');
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
    // Select whole prior turns once; exclude the target's old selected answer entirely.
    const prompt = await this.pool.query<{ id: string; content: string }>(`SELECT m.id, m.content
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND m.conversation_id = $2 AND c.user_id = $3 AND m.role = 'user'`,
    [generation.userMessageId, generation.conversationId, ownerId]);
    const current = prompt.rows[0];
    if (!current) throw new NotFoundError();
    const result = await this.pool.query<{ id: string; role: 'user' | 'assistant'; content: string }>(`
      SELECT m.id, m.role, m.content ${CHAT_HISTORY_FROM}
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = $1 AND c.user_id = $2
        AND ${CHAT_HISTORY_VISIBLE}
        AND (attempts.user_message_id IS NULL OR user_selection.selected_generation_id IS NOT NULL)
        AND m.id <> $3 AND (assistant_generation.id IS NULL OR assistant_generation.user_message_id <> $3)
      ORDER BY COALESCE(turn_user.created_at, m.created_at) DESC,
        COALESCE(turn_user.id, m.id) DESC, CASE WHEN m.role = 'user' THEN 0 ELSE 1 END DESC LIMIT 41`,
    [generation.conversationId, ownerId, generation.userMessageId]);
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
    const result = await this.pool.query("UPDATE chat_generations SET status = 'streaming', started_at = NOW() WHERE id = $1 AND owner_id = $2 AND status = 'pending' AND cancel_requested_at IS NULL RETURNING id", [id, ownerId]);
    if (!result.rows[0]) throw new ConflictError('Generation is no longer pending');
  }

  async checkpoint(ownerId: string, id: string, text: string): Promise<void> {
    const result = await this.pool.query("UPDATE chat_generations SET partial_content = $3 WHERE id = $1 AND owner_id = $2 AND status = 'streaming' AND cancel_requested_at IS NULL RETURNING id", [id, ownerId, text]);
    if (!result.rows[0]) throw new ConflictError('Generation is no longer streaming');
  }

  // Protected transaction step permits deterministic rollback fault injection without patching pg internals.
  protected async insertAssistant(client: pg.PoolClient, generation: ChatGeneration, text: string): Promise<void> {
    await client.query("INSERT INTO messages (id, conversation_id, role, content) VALUES ($1, $2, 'assistant', $3)", [generation.id, generation.conversationId, text]);
  }

  async complete(ownerId: string, generation: ChatGeneration, text: string, reason: ChatFinishReason): Promise<ChatGeneration> {
    return this.transaction(async (client) => {
      const active = await this.lockGeneration(client, ownerId, generation.conversationId, generation.id);
      if (active.status !== 'streaming' || active.cancel_requested_at) throw new ConflictError('Generation is no longer eligible for completion');
      await this.insertAssistant(client, generation, text);
      const result = await client.query<GenerationRow>(`UPDATE chat_generations SET status = 'completed', assistant_message_id = $1,
        partial_content = $3, finish_reason = $4, finished_at = NOW() WHERE id = $1 AND owner_id = $2 AND status = 'streaming' AND cancel_requested_at IS NULL RETURNING *`, [generation.id, ownerId, text, reason]);
      await client.query(`INSERT INTO chat_turn_selections (owner_id, conversation_id, user_message_id, selected_generation_id)
        VALUES ($1, $2, $3, $4) ON CONFLICT (user_message_id) DO UPDATE SET selected_generation_id = EXCLUDED.selected_generation_id`,
      [ownerId, generation.conversationId, generation.userMessageId, generation.id]);
      await client.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1 AND user_id = $2', [generation.conversationId, ownerId]);
      return map(result.rows[0]!);
    });
  }

  async finalize(ownerId: string, generation: ChatGeneration, text: string, status: 'failed' | 'interrupted', code: string): Promise<ChatGeneration> {
    return this.transaction(async (client) => {
      const row = await this.lockGeneration(client, ownerId, generation.conversationId, generation.id);
      if (row.status !== 'pending' && row.status !== 'streaming') return map(row);
      const stopped = row.cancel_requested_at !== null;
      const result = await client.query<GenerationRow>(`UPDATE chat_generations SET status = $3, partial_content = $4,
        error_code = $5, finish_reason = $6, finished_at = NOW()
        WHERE id = $1 AND owner_id = $2 AND status IN ('pending', 'streaming') RETURNING *`,
      [generation.id, ownerId, stopped ? 'stopped' : status, text, stopped ? null : code, stopped ? 'cancelled' : null]);
      return map(result.rows[0]!);
    });
  }
}
