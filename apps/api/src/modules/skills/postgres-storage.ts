/**
 * Giga Skills Core v0.1 — PostgreSQL Skill Storage Implementation
 *
 * Implements the SkillStorage interface using parameterized PostgreSQL queries.
 * Enforces ownership isolation, deterministic version selection, immutability,
 * and fail-closed behavior for missing/mismatched versions.
 *
 * Authoritative docs: docs/architecture/GIGA_SKILLS_DATA_MODEL_V0.1.md
 */

import type pg from 'pg';
import type { SkillStorage } from './storage.js';
import {
  type SkillDefinition,
  type SkillVersion,
  type SkillInstallation,
  type WorkspaceSkillDefault,
  type ProductTarget,
  type SkillVisibility,
  SkillValidationError,
  SkillResolutionError,
  SkillConflictError,
} from './types.js';
import {
  MAX_INSTRUCTION_BYTES,
  MAX_DESCRIPTION_LENGTH,
  MIN_DESCRIPTION_LENGTH,
  MAX_SLUG_LENGTH,
  MIN_SLUG_LENGTH,
  getUtf8ByteCount,
} from './parser.js';

export interface CreateSkillParams {
  id?: string;
  ownerId: string | null;
  slug: string;
  title: string;
  description: string;
  visibility: SkillVisibility;
  supportedProducts: ProductTarget[];
}

export interface CreateVersionParams {
  id?: string;
  skillId: string;
  versionNumber: number;
  contentHash: string;
  instructions: string;
}

export interface CreateInstallationParams {
  id?: string;
  userId: string;
  skillId: string;
  selectedVersionId: string;
  enabled?: boolean;
}

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface SkillDefinitionDbRow {
  id: string;
  owner_id: string | null;
  slug: string;
  title: string;
  description: string;
  visibility: string;
  supported_products: string[];
  created_at: Date | string;
}

interface SkillVersionDbRow {
  id: string;
  skill_id: string;
  version_number: number;
  content_hash: string;
  instructions: string;
  created_at: Date | string;
}

interface SkillInstallationDbRow {
  id: string;
  user_id: string;
  skill_id: string;
  selected_version_id: string;
  enabled: boolean;
  installed_at: Date | string;
}

interface WorkspaceSkillDefaultDbRow {
  workspace_id: string;
  owner_id: string;
  skill_id: string;
  position: number;
  enabled: boolean;
}

function mapRowToSkillDefinition(row: SkillDefinitionDbRow): SkillDefinition {
  return {
    id: row.id,
    ownerId: row.owner_id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    visibility: row.visibility as SkillVisibility,
    supportedProducts: (row.supported_products ?? []) as ProductTarget[],
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function mapRowToSkillVersion(row: SkillVersionDbRow): SkillVersion {
  return {
    id: row.id,
    skillId: row.skill_id,
    versionNumber: row.version_number,
    contentHash: row.content_hash,
    instructions: row.instructions,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function mapRowToInstallation(row: SkillInstallationDbRow): SkillInstallation {
  return {
    id: row.id,
    userId: row.user_id,
    skillId: row.skill_id,
    selectedVersionId: row.selected_version_id,
    enabled: Boolean(row.enabled),
    installedAt: row.installed_at instanceof Date ? row.installed_at.toISOString() : String(row.installed_at),
  };
}

export class PostgresSkillStorage implements SkillStorage {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Retrieves a skill definition by primary key ID.
   * If viewerUserId is provided and the skill is private, rejects access if viewer is not the owner.
   * If viewerUserId is omitted and the skill is private, fails closed to prevent tenant data disclosure.
   */
  public async getSkill(skillId: string, viewerUserId?: string): Promise<SkillDefinition | null> {
    if (!skillId || typeof skillId !== 'string') {
      return null;
    }

    const query = `
      SELECT id, owner_id, slug, title, description, visibility, supported_products, created_at
      FROM skill_definitions
      WHERE id = $1
      LIMIT 1;
    `;
    const result = await this.pool.query<SkillDefinitionDbRow>(query, [skillId]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    // Owner-scoped tenant isolation: never return another user's private skill
    if (row.visibility === 'private') {
      if (!viewerUserId || row.owner_id !== viewerUserId) {
        return null;
      }
    }

    return mapRowToSkillDefinition(row);
  }

  /**
   * Looks up a skill by slug.
   * Deterministic precedence rule: if the viewer owns a private skill matching the slug,
   * that private skill takes precedence over any built-in skill with the same slug.
   * Never returns another user's private skill data.
   */
  public async getSkillBySlug(slug: string, viewerUserId?: string): Promise<SkillDefinition | null> {
    if (!slug || typeof slug !== 'string') {
      return null;
    }

    if (viewerUserId) {
      const query = `
        SELECT id, owner_id, slug, title, description, visibility, supported_products, created_at
        FROM skill_definitions
        WHERE slug = $1 AND (
          visibility = 'built_in' OR (visibility = 'private' AND owner_id = $2)
        )
        ORDER BY (CASE WHEN visibility = 'private' THEN 1 ELSE 2 END) ASC
        LIMIT 1;
      `;
      const result = await this.pool.query<SkillDefinitionDbRow>(query, [slug, viewerUserId]);
      const row = result.rows[0];
      return row ? mapRowToSkillDefinition(row) : null;
    }

    // Viewer is not specified: only built-in skills are accessible
    const query = `
      SELECT id, owner_id, slug, title, description, visibility, supported_products, created_at
      FROM skill_definitions
      WHERE slug = $1 AND visibility = 'built_in'
      LIMIT 1;
    `;
    const result = await this.pool.query<SkillDefinitionDbRow>(query, [slug]);
    const row = result.rows[0];
    return row ? mapRowToSkillDefinition(row) : null;
  }

  /**
   * Retrieves an immutable skill version by version primary key ID.
   */
  public async getSkillVersion(versionId: string): Promise<SkillVersion | null> {
    if (!versionId || typeof versionId !== 'string') {
      return null;
    }

    const query = `
      SELECT id, skill_id, version_number, content_hash, instructions, created_at
      FROM skill_versions
      WHERE id = $1
      LIMIT 1;
    `;
    const result = await this.pool.query<SkillVersionDbRow>(query, [versionId]);
    const row = result.rows[0];
    return row ? mapRowToSkillVersion(row) : null;
  }

  /**
   * Deterministically retrieves the latest version of a skill (ordered by version_number DESC).
   */
  public async getLatestSkillVersion(skillId: string): Promise<SkillVersion | null> {
    if (!skillId || typeof skillId !== 'string') {
      return null;
    }

    const query = `
      SELECT id, skill_id, version_number, content_hash, instructions, created_at
      FROM skill_versions
      WHERE skill_id = $1
      ORDER BY version_number DESC
      LIMIT 1;
    `;
    const result = await this.pool.query<SkillVersionDbRow>(query, [skillId]);
    const row = result.rows[0];
    return row ? mapRowToSkillVersion(row) : null;
  }

  /**
   * Retrieves an installation record for a specific user and skill.
   */
  public async getInstallation(userId: string, skillId: string): Promise<SkillInstallation | null> {
    if (!userId || !skillId) {
      return null;
    }

    const query = `
      SELECT id, user_id, skill_id, selected_version_id, enabled, installed_at
      FROM skill_installations
      WHERE user_id = $1 AND skill_id = $2
      LIMIT 1;
    `;
    const result = await this.pool.query<SkillInstallationDbRow>(query, [userId, skillId]);
    const row = result.rows[0];
    return row ? mapRowToInstallation(row) : null;
  }

  /**
   * Retrieves agent workspace skill defaults for a workspace and its owner.
   */
  public async getWorkspaceDefaults(workspaceId: string, ownerId: string): Promise<WorkspaceSkillDefault[]> {
    if (!workspaceId || !ownerId) {
      return [];
    }

    const query = `
      SELECT workspace_id, owner_id, skill_id, position, enabled
      FROM workspace_skill_defaults
      WHERE workspace_id = $1 AND owner_id = $2
      ORDER BY position ASC;
    `;
    const result = await this.pool.query<WorkspaceSkillDefaultDbRow>(query, [workspaceId, ownerId]);
    return result.rows.map((row) => ({
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
      skillId: row.skill_id,
      position: row.position,
      enabled: Boolean(row.enabled),
    }));
  }

  /**
   * Persists a new skill definition.
   */
  public async createSkill(params: CreateSkillParams): Promise<SkillDefinition> {
    const slug = params.slug.trim();
    if (slug.length < MIN_SLUG_LENGTH || slug.length > MAX_SLUG_LENGTH || !SLUG_REGEX.test(slug)) {
      throw new SkillValidationError('SKILL_VALIDATION_ERROR', `Invalid skill slug '${slug}'`);
    }

    const description = params.description.trim();
    if (description.length < MIN_DESCRIPTION_LENGTH || description.length > MAX_DESCRIPTION_LENGTH) {
      throw new SkillValidationError('SKILL_VALIDATION_ERROR', 'Invalid skill description length');
    }

    if (params.visibility === 'built_in' && params.ownerId !== null) {
      throw new SkillValidationError('SKILL_VALIDATION_ERROR', 'Built-in skills cannot have an ownerId');
    }
    if (params.visibility === 'private' && (!params.ownerId || typeof params.ownerId !== 'string')) {
      throw new SkillValidationError('SKILL_VALIDATION_ERROR', 'Private skills require an ownerId');
    }

    const query = `
      INSERT INTO skill_definitions (id, owner_id, slug, title, description, visibility, supported_products)
      VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7)
      RETURNING id, owner_id, slug, title, description, visibility, supported_products, created_at;
    `;
    try {
      const result = await this.pool.query<SkillDefinitionDbRow>(query, [
        params.id ?? null,
        params.ownerId,
        slug,
        params.title.trim(),
        description,
        params.visibility,
        params.supportedProducts,
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new Error('Failed to create skill definition: no row returned');
      }
      return mapRowToSkillDefinition(row);
    } catch (err: unknown) {
      const pgErr = err as { code?: string; message?: string };
      if (pgErr.code === '23505') {
        throw new SkillConflictError(`Skill slug '${slug}' already exists in this scope`, [slug]);
      }
      throw err;
    }
  }

  /**
   * Persists an immutable skill version.
   * Versions cannot be updated once created.
   */
  public async createVersion(params: CreateVersionParams): Promise<SkillVersion> {
    if (params.versionNumber < 1) {
      throw new SkillValidationError('SKILL_VALIDATION_ERROR', 'Version number must be >= 1');
    }
    if (params.contentHash.length !== 64) {
      throw new SkillValidationError('SKILL_VALIDATION_ERROR', 'Content hash must be 64 characters SHA-256');
    }
    const bytes = getUtf8ByteCount(params.instructions);
    if (bytes > MAX_INSTRUCTION_BYTES) {
      throw new SkillValidationError('SKILL_OVERSIZED', `Instructions exceed ${MAX_INSTRUCTION_BYTES} bytes`);
    }

    const query = `
      INSERT INTO skill_versions (id, skill_id, version_number, content_hash, instructions)
      VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5)
      RETURNING id, skill_id, version_number, content_hash, instructions, created_at;
    `;
    try {
      const result = await this.pool.query<SkillVersionDbRow>(query, [
        params.id ?? null,
        params.skillId,
        params.versionNumber,
        params.contentHash,
        params.instructions,
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new Error('Failed to create skill version: no row returned');
      }
      return mapRowToSkillVersion(row);
    } catch (err: unknown) {
      const pgErr = err as { code?: string; message?: string };
      if (pgErr.code === '23505') {
        throw new SkillConflictError(
          `Version ${params.versionNumber} for skill '${params.skillId}' already exists and is immutable`,
          [params.skillId]
        );
      }
      throw err;
    }
  }

  /**
   * Installs a skill for a user, pinning a specific version.
   * Rejects installation if the version does not belong to the skill (enforced via DB foreign key).
   * Rejects installation if the skill is another user's private skill.
   */
  public async createInstallation(params: CreateInstallationParams): Promise<SkillInstallation> {
    // 1. Verify skill exists and belongs to user or is built-in
    const skill = await this.getSkill(params.skillId, params.userId);
    if (!skill) {
      throw new SkillResolutionError('SKILL_NOT_FOUND', `Skill '${params.skillId}' was not found`);
    }

    const query = `
      INSERT INTO skill_installations (id, user_id, skill_id, selected_version_id, enabled)
      VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, COALESCE($5, true))
      RETURNING id, user_id, skill_id, selected_version_id, enabled, installed_at;
    `;
    try {
      const result = await this.pool.query<SkillInstallationDbRow>(query, [
        params.id ?? null,
        params.userId,
        params.skillId,
        params.selectedVersionId,
        params.enabled ?? true,
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new Error('Failed to create installation: no row returned');
      }
      return mapRowToInstallation(row);
    } catch (err: unknown) {
      const pgErr = err as { code?: string; message?: string; detail?: string };
      const isFkViolation =
        pgErr.code === '23503' ||
        (typeof pgErr.message === 'string' && pgErr.message.includes('foreign key constraint'));
      if (isFkViolation) {
        throw new SkillResolutionError(
          'SKILL_NOT_FOUND',
          `Selected version '${params.selectedVersionId}' does not belong to skill '${params.skillId}'`
        );
      }
      const isUniqueViolation =
        pgErr.code === '23505' ||
        (typeof pgErr.message === 'string' && pgErr.message.includes('unique constraint'));
      if (isUniqueViolation) {
        throw new SkillConflictError(`Skill '${params.skillId}' is already installed for this user`, [skill.slug]);
      }
      throw err;
    }
  }

  /**
   * Toggles enablement status of an installed skill.
   */
  public async setInstallationEnabled(
    userId: string,
    skillId: string,
    enabled: boolean
  ): Promise<SkillInstallation | null> {
    const query = `
      UPDATE skill_installations
      SET enabled = $3
      WHERE user_id = $1 AND skill_id = $2
      RETURNING id, user_id, skill_id, selected_version_id, enabled, installed_at;
    `;
    const result = await this.pool.query<SkillInstallationDbRow>(query, [userId, skillId, enabled]);
    const row = result.rows[0];
    return row ? mapRowToInstallation(row) : null;
  }

  /**
   * Updates the selected version pinned for an installation.
   * Fails closed if the version does not belong to this skill.
   */
  public async setInstallationVersion(
    userId: string,
    skillId: string,
    selectedVersionId: string
  ): Promise<SkillInstallation | null> {
    const query = `
      UPDATE skill_installations
      SET selected_version_id = $3
      WHERE user_id = $1 AND skill_id = $2
      RETURNING id, user_id, skill_id, selected_version_id, enabled, installed_at;
    `;
    try {
      const result = await this.pool.query<SkillInstallationDbRow>(query, [userId, skillId, selectedVersionId]);
      const row = result.rows[0];
      return row ? mapRowToInstallation(row) : null;
    } catch (err: unknown) {
      const pgErr = err as { code?: string; message?: string };
      const isFkViolation =
        pgErr.code === '23503' ||
        (typeof pgErr.message === 'string' && pgErr.message.includes('foreign key constraint'));
      if (isFkViolation) {
        throw new SkillResolutionError(
          'SKILL_NOT_FOUND',
          `Selected version '${selectedVersionId}' does not belong to skill '${skillId}'`
        );
      }
      throw err;
    }
  }

  /**
   * Sets agent workspace defaults in a single atomic transaction.
   */
  public async setWorkspaceDefaults(
    workspaceId: string,
    ownerId: string,
    defaults: WorkspaceSkillDefault[]
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'DELETE FROM workspace_skill_defaults WHERE workspace_id = $1 AND owner_id = $2;',
        [workspaceId, ownerId]
      );

      for (const item of defaults) {
        await client.query(
          `INSERT INTO workspace_skill_defaults (workspace_id, owner_id, skill_id, position, enabled, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW());`,
          [workspaceId, ownerId, item.skillId, item.position, item.enabled]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
