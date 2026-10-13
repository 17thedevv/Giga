import type pg from 'pg';

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
}

interface SessionDbRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
  revoked_at: Date | null;
}

function mapRowToSession(row: SessionDbRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export class SessionRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Creates a new session record.
   */
  async createSession(params: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<SessionRecord> {
    const query = `
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES ($1, $2, $3)
      RETURNING id, user_id, token_hash, expires_at, created_at, revoked_at;
    `;
    const values = [params.userId, params.tokenHash, params.expiresAt];

    const result = await this.pool.query<SessionDbRow>(query, values);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Failed to create session: no row returned');
    }
    return mapRowToSession(row);
  }

  /**
   * Retrieves an active session by token hash.
   * A session is active if revoked_at IS NULL AND expires_at > NOW().
   */
  async findActiveSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const query = `
      SELECT id, user_id, token_hash, expires_at, created_at, revoked_at
      FROM sessions
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > NOW()
      LIMIT 1;
    `;
    const result = await this.pool.query<SessionDbRow>(query, [tokenHash]);
    const row = result.rows[0];
    return row ? mapRowToSession(row) : null;
  }

  /**
   * Revokes an active session by token hash.
   * Returns true if a session was revoked, false if not found or already revoked.
   */
  async revokeSessionByTokenHash(tokenHash: string): Promise<boolean> {
    const query = `
      UPDATE sessions
      SET revoked_at = NOW()
      WHERE token_hash = $1
        AND revoked_at IS NULL
      RETURNING id;
    `;
    const result = await this.pool.query<SessionDbRow>(query, [tokenHash]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Revokes all active sessions for a user (useful for password resets or security logout).
   */
  async revokeAllUserSessions(userId: string): Promise<number> {
    const query = `
      UPDATE sessions
      SET revoked_at = NOW()
      WHERE user_id = $1
        AND revoked_at IS NULL;
    `;
    const result = await this.pool.query(query, [userId]);
    return result.rowCount ?? 0;
  }
}
