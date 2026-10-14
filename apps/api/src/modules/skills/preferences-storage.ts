/**
 * Giga Skills Core v0.1 — User Preferences Storage Implementation
 *
 * Implements versioned User Preferences persistence with optimistic concurrency control (OCC).
 * Supports preferredLanguage, responseLength, responseStyle, and customInstructions.
 * Enforces size bounds: customInstructions <= 2000 chars and <= 4096 bytes.
 *
 * Authoritative docs: docs/architecture/GIGA_SKILLS_DATA_MODEL_V0.1.md
 */

import type pg from 'pg';
import {
  type UserPreferencesSnapshot,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  MAX_CUSTOM_INSTRUCTIONS_BYTES,
  SkillValidationError,
  SkillConflictError,
} from './types.js';
import { getUtf8ByteCount } from './parser.js';

export interface UserPreferencesStorage {
  getPreferences(userId: string): Promise<UserPreferencesSnapshot | null>;
  savePreferences(
    userId: string,
    preferences: UserPreferencesSnapshot,
    expectedRevision?: number
  ): Promise<UserPreferencesSnapshot>;
}

interface UserPreferencesDbRow {
  user_id: string;
  revision: number;
  preferred_language: string | null;
  response_length: 'concise' | 'balanced' | 'detailed' | null;
  response_style: 'professional' | 'casual' | 'technical' | null;
  custom_instructions: string;
  updated_at: Date | string;
}

function mapRowToPreferences(row: UserPreferencesDbRow): UserPreferencesSnapshot {
  return {
    preferredLanguage: row.preferred_language ?? undefined,
    responseLength: row.response_length ?? undefined,
    responseStyle: row.response_style ?? undefined,
    customInstructions: row.custom_instructions ?? '',
    revision: row.revision,
  };
}

export class PostgresUserPreferencesStorage implements UserPreferencesStorage {
  constructor(private readonly pool: pg.Pool) {}

  public async getPreferences(userId: string): Promise<UserPreferencesSnapshot | null> {
    if (!userId || typeof userId !== 'string') {
      throw new SkillValidationError('SKILL_VALIDATION_ERROR', 'User ID is required');
    }

    const query = `
      SELECT user_id, revision, preferred_language, response_length, response_style, custom_instructions, updated_at
      FROM user_preferences
      WHERE user_id = $1
      LIMIT 1;
    `;
    const result = await this.pool.query<UserPreferencesDbRow>(query, [userId]);
    const row = result.rows[0];
    return row ? mapRowToPreferences(row) : null;
  }

  public async savePreferences(
    userId: string,
    preferences: UserPreferencesSnapshot,
    expectedRevision?: number
  ): Promise<UserPreferencesSnapshot> {
    if (!userId || typeof userId !== 'string') {
      throw new SkillValidationError('SKILL_VALIDATION_ERROR', 'User ID is required');
    }

    // 1. Validate customInstructions bounds
    if (preferences.customInstructions !== undefined && preferences.customInstructions !== null) {
      if (typeof preferences.customInstructions !== 'string') {
        throw new SkillValidationError('SKILL_VALIDATION_ERROR', 'Custom instructions must be a string');
      }
      if (preferences.customInstructions.length > MAX_CUSTOM_INSTRUCTIONS_CHARS) {
        throw new SkillValidationError(
          'SKILL_OVERSIZED',
          `Custom instructions exceed maximum allowed limit of ${MAX_CUSTOM_INSTRUCTIONS_CHARS} characters (actual: ${preferences.customInstructions.length} characters)`
        );
      }
      const byteCount = getUtf8ByteCount(preferences.customInstructions);
      if (byteCount > MAX_CUSTOM_INSTRUCTIONS_BYTES) {
        throw new SkillValidationError(
          'SKILL_OVERSIZED',
          `Custom instructions exceed maximum allowed limit of ${MAX_CUSTOM_INSTRUCTIONS_BYTES} bytes (actual: ${byteCount} bytes)`
        );
      }
    }

    // 2. Validate responseLength enum
    if (preferences.responseLength) {
      const allowed = ['concise', 'balanced', 'detailed'];
      if (!allowed.includes(preferences.responseLength)) {
        throw new SkillValidationError(
          'SKILL_VALIDATION_ERROR',
          `Invalid responseLength '${preferences.responseLength}': expected 'concise', 'balanced', or 'detailed'`
        );
      }
    }

    // 3. Validate responseStyle enum
    if (preferences.responseStyle) {
      const allowed = ['professional', 'casual', 'technical'];
      if (!allowed.includes(preferences.responseStyle)) {
        throw new SkillValidationError(
          'SKILL_VALIDATION_ERROR',
          `Invalid responseStyle '${preferences.responseStyle}': expected 'professional', 'casual', or 'technical'`
        );
      }
    }

    const current = await this.getPreferences(userId);

    if (!current) {
      // First time saving preferences: initial revision is 1, caller must specify expectedRevision === 0 (or omit)
      if (expectedRevision !== undefined && expectedRevision !== 0) {
        throw new SkillConflictError(
          `Revision conflict: preferences do not exist yet, expectedRevision must be 0 (received ${expectedRevision})`,
          []
        );
      }

      const insertQuery = `
        INSERT INTO user_preferences (user_id, revision, preferred_language, response_length, response_style, custom_instructions, updated_at)
        VALUES ($1, 1, $2, $3, $4, $5, NOW())
        RETURNING user_id, revision, preferred_language, response_length, response_style, custom_instructions, updated_at;
      `;
      try {
        const result = await this.pool.query<UserPreferencesDbRow>(insertQuery, [
          userId,
          preferences.preferredLanguage ?? null,
          preferences.responseLength ?? null,
          preferences.responseStyle ?? null,
          preferences.customInstructions ?? '',
        ]);
        const row = result.rows[0];
        if (!row) {
          throw new Error('Failed to insert user preferences: no row returned');
        }
        return mapRowToPreferences(row);
      } catch (err: unknown) {
        const pgErr = err as { code?: string; message?: string };
        if (pgErr.code === '23505') {
          throw new SkillConflictError(
            'Concurrent modification conflict: user preferences were initialized by another request',
            []
          );
        }
        throw err;
      }
    }

    // Existing preferences: check optimistic concurrency control revision
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new SkillConflictError(
        `Revision conflict: expected revision ${expectedRevision}, but current revision is ${current.revision}`,
        []
      );
    }

    const targetRevision = expectedRevision ?? current.revision;
    const updateQuery = `
      UPDATE user_preferences
      SET revision = revision + 1,
          preferred_language = $2,
          response_length = $3,
          response_style = $4,
          custom_instructions = $5,
          updated_at = NOW()
      WHERE user_id = $1 AND revision = $6
      RETURNING user_id, revision, preferred_language, response_length, response_style, custom_instructions, updated_at;
    `;
    const result = await this.pool.query<UserPreferencesDbRow>(updateQuery, [
      userId,
      preferences.preferredLanguage ?? null,
      preferences.responseLength ?? null,
      preferences.responseStyle ?? null,
      preferences.customInstructions ?? '',
      targetRevision,
    ]);

    if (result.rowCount === 0) {
      // Concurrent race condition update happened!
      throw new SkillConflictError(
        'Concurrent modification conflict: user preferences were modified by another transaction',
        []
      );
    }

    const row = result.rows[0];
    if (!row) {
      throw new Error('Failed to update user preferences: no row returned');
    }
    return mapRowToPreferences(row);
  }
}

export class InMemoryUserPreferencesStorage implements UserPreferencesStorage {
  private prefs = new Map<string, UserPreferencesSnapshot>();

  public async getPreferences(userId: string): Promise<UserPreferencesSnapshot | null> {
    const val = this.prefs.get(userId);
    return val ? { ...val } : null;
  }

  public async savePreferences(
    userId: string,
    preferences: UserPreferencesSnapshot,
    expectedRevision?: number
  ): Promise<UserPreferencesSnapshot> {
    if (preferences.customInstructions && preferences.customInstructions.length > MAX_CUSTOM_INSTRUCTIONS_CHARS) {
      throw new SkillValidationError('SKILL_OVERSIZED', 'Custom instructions exceed maximum limit');
    }

    const current = this.prefs.get(userId);
    if (!current) {
      if (expectedRevision !== undefined && expectedRevision !== 0) {
        throw new SkillConflictError(
          `Revision conflict: preferences do not exist yet, expectedRevision must be 0 (received ${expectedRevision})`,
          []
        );
      }
      const record: UserPreferencesSnapshot = {
        ...preferences,
        revision: 1,
      };
      this.prefs.set(userId, record);
      return { ...record };
    }

    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new SkillConflictError(`Revision conflict: expected ${expectedRevision}, got ${current.revision}`, []);
    }

    const updated: UserPreferencesSnapshot = {
      ...preferences,
      revision: (current.revision ?? 1) + 1,
    };
    this.prefs.set(userId, updated);
    return { ...updated };
  }

  public clear(): void {
    this.prefs.clear();
  }
}
