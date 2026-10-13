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
  computeDeterministicHash,
} from './parser.js';

export interface SkillActorContext {
  userId?: string;
  isAdmin?: boolean;
  isSystem?: boolean;
}

export interface CreateSkillParams {
  id?: string;
  ownerId: string | null;
  slug: string;
  title: string;
  description: string;
  visibility: SkillVisibility;
  supportedProducts: ProductTarget[];
  actor: SkillActorContext;
}

export interface CreateVersionParams {
  id?: string;
  skillId: string;
  versionNumber: number;
  contentHash?: string;
  instructions: string;
  actor: SkillActorContext;
}

export interface CreateInstallationParams {
  id?: string;
  userId: string;
  skillId: string;
  selectedVersionId: string;
  enabled?: boolean;
  actor?: SkillActorContext;
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
   * If viewerUserId is provided, ensures private skill versions are only visible to their owner.
   * If viewerUserId is omitted, only versions of built-in skills are returned to prevent private data leakage.
   */
  public async getSkillVersion(versionId: string, viewerUserId?: string): Promise<SkillVersion | null> {
    if (!versionId || typeof versionId !== 'string') {
      return null;
    }

    if (viewerUserId) {
      const query = `
        SELECT v.id, v.skill_id, v.version_number, v.content_hash, v.instructions, v.created_at
        FROM skill_versions v
        JOIN skill_definitions d ON d.id = v.skill_id
        WHERE v.id = $1 AND (
          d.visibility = 'built_in' OR (d.visibility = 'private' AND d.owner_id = $2)
        )
        LIMIT 1;
      `;
      const result = await this.pool.query<SkillVersionDbRow>(query, [versionId, viewerUserId]);
      const row = result.rows[0];
      return row ? mapRowToSkillVersion(row) : null;
    }

    const query = `
      SELECT v.id, v.skill_id, v.version_number, v.content_hash, v.instructions, v.created_at
      FROM skill_versions v
      JOIN skill_definitions d ON d.id = v.skill_id
      WHERE v.id = $1 AND d.visibility = 'built_in'
      LIMIT 1;
    `;
    const result = await this.pool.query<SkillVersionDbRow>(query, [versionId]);
    const row = result.rows[0];
    return row ? mapRowToSkillVersion(row) : null;
  }

  /**
   * Deterministically retrieves the latest version of a skill (ordered by version_number DESC).
   * If viewerUserId is provided, ensures private skill versions are only visible to their owner.
   * If viewerUserId is omitted, only versions of built-in skills are returned.
   */
  public async getLatestSkillVersion(skillId: string, viewerUserId?: string): Promise<SkillVersion | null> {
    if (!skillId || typeof skillId !== 'string') {
      return null;
    }

    if (viewerUserId) {
      const query = `
        SELECT v.id, v.skill_id, v.version_number, v.content_hash, v.instructions, v.created_at
        FROM skill_versions v
        JOIN skill_definitions d ON d.id = v.skill_id
        WHERE v.skill_id = $1 AND (
          d.visibility = 'built_in' OR (d.visibility = 'private' AND d.owner_id = $2)
        )
        ORDER BY v.version_number DESC
        LIMIT 1;
      `;
      const result = await this.pool.query<SkillVersionDbRow>(query, [skillId, viewerUserId]);
      const row = result.rows[0];
      return row ? mapRowToSkillVersion(row) : null;
    }

    const query = `
      SELECT v.id, v.skill_id, v.version_number, v.content_hash, v.instructions, v.created_at
      FROM skill_versions v
      JOIN skill_definitions d ON d.id = v.skill_id
      WHERE v.skill_id = $1 AND d.visibility = 'built_in'
      ORDER BY v.version_number DESC
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
   * Retrieves agent workspace skill defaults.
   * Deferred until 17T-24 Agent Workspace schema is implemented.
   */
  public async getWorkspaceDefaults(_workspaceId: string, _ownerId: string): Promise<WorkspaceSkillDefault[]> {
    return [];
  }

  /**
   * Persists a new skill definition.
   * Enforces actor authorization for built-in and private skills.
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

    if (!params.actor) {
      throw new SkillValidationError('SKILL_UNAUTHORIZED', 'Actor authorization context is required to create a skill');
    }

    if (params.visibility === 'built_in') {
      if (params.ownerId !== null) {
        throw new SkillValidationError('SKILL_VALIDATION_ERROR', 'Built-in skills cannot have an ownerId');
      }
      if (!params.actor.isAdmin && !params.actor.isSystem) {
        throw new SkillValidationError('SKILL_UNAUTHORIZED', 'Only system administrators can publish built-in skills');
      }
    }
    if (params.visibility === 'private') {
      if (!params.ownerId || typeof params.ownerId !== 'string') {
        throw new SkillValidationError('SKILL_VALIDATION_ERROR', 'Private skills require an ownerId');
      }
      if (!params.actor.isAdmin && (!params.actor.userId || params.actor.userId !== params.ownerId)) {
        throw new SkillValidationError('SKILL_UNAUTHORIZED', 'Cannot create a private skill for another owner');
      }
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
   * Validates parent skill existence, caller authorization, and content hash integrity.
   */
  public async createVersion(params: CreateVersionParams): Promise<SkillVersion> {
    if (params.versionNumber < 1) {
      throw new SkillValidationError('SKILL_VALIDATION_ERROR', 'Version number must be >= 1');
    }

    if (!params.actor) {
      throw new SkillValidationError('SKILL_UNAUTHORIZED', 'Actor authorization context is required to publish a skill version');
    }

    // 1. Verify parent skill exists and enforce publication authorization
    const queryParent = `
      SELECT id, owner_id, slug, title, description, visibility, supported_products, created_at
      FROM skill_definitions
      WHERE id = $1
      LIMIT 1;
    `;
    const parentRes = await this.pool.query<SkillDefinitionDbRow>(queryParent, [params.skillId]);
    const parentRow = parentRes.rows[0];
    if (!parentRow) {
      throw new SkillResolutionError('SKILL_NOT_FOUND', `Parent skill '${params.skillId}' not found`);
    }
    const parentSkill = mapRowToSkillDefinition(parentRow);

    if (parentSkill.visibility === 'built_in') {
      if (!params.actor.isAdmin && !params.actor.isSystem) {
        throw new SkillValidationError('SKILL_UNAUTHORIZED', 'Only system administrators can publish versions for built-in skills');
      }
    } else if (parentSkill.visibility === 'private') {
      if (!params.actor.isAdmin && (!params.actor.userId || params.actor.userId !== parentSkill.ownerId)) {
        throw new SkillValidationError('SKILL_UNAUTHORIZED', 'Only the skill owner can publish versions for a private skill');
      }
    }

    // 2. Validate instructions size
    const bytes = getUtf8ByteCount(params.instructions);
    if (bytes > MAX_INSTRUCTION_BYTES) {
      throw new SkillValidationError('SKILL_OVERSIZED', `Instructions exceed ${MAX_INSTRUCTION_BYTES} bytes`);
    }

    // 3. Compute deterministic hash and verify against caller-provided hash if given
    const expectedHash = computeDeterministicHash(params.instructions);
    if (params.contentHash && params.contentHash !== expectedHash) {
      throw new SkillValidationError(
        'SKILL_VALIDATION_ERROR',
        `Provided content hash '${params.contentHash}' does not match deterministic instruction hash '${expectedHash}'`
      );
    }
    const finalContentHash = expectedHash;

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
        finalContentHash,
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
    if (params.actor && !params.actor.isAdmin && params.actor.userId !== params.userId) {
      throw new SkillValidationError('SKILL_UNAUTHORIZED', 'Cannot install skill for another user');
    }

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
   * Sets agent workspace defaults.
   * Deferred until 17T-24 Agent Workspace schema is implemented.
   */
  public async setWorkspaceDefaults(
    _workspaceId: string,
    _ownerId: string,
    _defaults: WorkspaceSkillDefault[]
  ): Promise<void> {
    throw new Error(
      'Agent Workspace defaults persistence is deferred until 17T-24 Agent Workspace schema is implemented'
    );
  }
}
