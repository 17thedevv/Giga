import type pg from 'pg';

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface UserDbRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
}

function mapRowToUser(row: UserDbRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class UserRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Persists a new user record in the database.
   * Email is stored normalized lowercase.
   */
  async createUser(params: {
    email: string;
    displayName: string;
    passwordHash: string;
  }): Promise<UserRecord> {
    const query = `
      INSERT INTO users (email, display_name, password_hash)
      VALUES (LOWER($1), $2, $3)
      RETURNING id, email, display_name, password_hash, created_at, updated_at;
    `;
    const values = [params.email.trim(), params.displayName.trim(), params.passwordHash];

    const result = await this.pool.query<UserDbRow>(query, values);
    const row = result.rows[0];
    if (!row) {
      throw new Error('Failed to create user: no row returned');
    }
    return mapRowToUser(row);
  }

  /**
   * Finds a user by email (case-insensitive lookup).
   */
  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const query = `
      SELECT id, email, display_name, password_hash, created_at, updated_at
      FROM users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1;
    `;
    const result = await this.pool.query<UserDbRow>(query, [email.trim()]);
    const row = result.rows[0];
    return row ? mapRowToUser(row) : null;
  }

  /**
   * Finds a user by primary key ID.
   */
  async findUserById(id: string): Promise<UserRecord | null> {
    const query = `
      SELECT id, email, display_name, password_hash, created_at, updated_at
      FROM users
      WHERE id = $1
      LIMIT 1;
    `;
    const result = await this.pool.query<UserDbRow>(query, [id]);
    const row = result.rows[0];
    return row ? mapRowToUser(row) : null;
  }
}
