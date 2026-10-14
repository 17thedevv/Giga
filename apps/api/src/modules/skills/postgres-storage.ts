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
  type SkillListItem,
  type SkillActorContext,
  type ListSkillsOptions,
  type PaginatedSkillList,
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

export type { SkillActorContext };

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
  actor: SkillActorContext;
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
  revision?: number;
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

interface SkillListDbRow {
  id: string;
  owner_id: string | null;
  slug: string;
  title: string;
  description: string;
  visibility: string;
  supported_products: string[];
  revision?: number;
  created_at: Date | string;
  exact_created_at?: string;
  installed: boolean;
  enabled: boolean | null;
  selected_version_id: string | null;
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
    revision: Number(row.revision ?? 1),
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
      SELECT id, owner_id, slug, title, description, visibility, supported_products, revision, created_at
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
        SELECT id, owner_id, slug, title, description, visibility, supported_products, revision, created_at
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
      SELECT id, owner_id, slug, title, description, visibility, supported_products, revision, created_at
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
      RETURNING id, owner_id, slug, title, description, visibility, supported_products, revision, created_at;
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
      SELECT id, owner_id, slug, title, description, visibility, supported_products, revision, created_at
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
   * Requires trusted actor authorization context matching the target user or system administrator.
   */
  public async createInstallation(params: CreateInstallationParams): Promise<SkillInstallation> {
    if (!params.actor) {
      throw new SkillValidationError('SKILL_UNAUTHORIZED', 'Actor authorization context is required to install a skill');
    }
    if (!params.actor.isAdmin && params.actor.userId !== params.userId) {
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
   * Requires trusted actor authorization context matching the target user or system administrator.
   */
  public async setInstallationEnabled(
    userId: string,
    skillId: string,
    enabled: boolean,
    actor: SkillActorContext
  ): Promise<SkillInstallation | null> {
    if (!actor) {
      throw new SkillValidationError(
        'SKILL_UNAUTHORIZED',
        'Actor authorization context is required to modify an installation'
      );
    }
    if (!actor.isAdmin && actor.userId !== userId) {
      throw new SkillValidationError('SKILL_UNAUTHORIZED', 'Cannot modify installation for another user');
    }

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
   * Requires trusted actor authorization context matching the target user or system administrator.
   */
  public async setInstallationVersion(
    userId: string,
    skillId: string,
    selectedVersionId: string,
    actor: SkillActorContext
  ): Promise<SkillInstallation | null> {
    if (!actor) {
      throw new SkillValidationError(
        'SKILL_UNAUTHORIZED',
        'Actor authorization context is required to modify an installation'
      );
    }
    if (!actor.isAdmin && actor.userId !== userId) {
      throw new SkillValidationError('SKILL_UNAUTHORIZED', 'Cannot modify installation for another user');
    }

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
   * Atomically updates an installation's enabled flag and/or selected version in a single SQL query.
   * Prevents inconsistent partial states.
   */
  public async updateInstallationAtomic(
    userId: string,
    skillId: string,
    updates: { enabled?: boolean; selectedVersionId?: string },
    actor: SkillActorContext
  ): Promise<SkillInstallation> {
    if (!actor) {
      throw new SkillValidationError(
        'SKILL_UNAUTHORIZED',
        'Actor authorization context is required to modify an installation'
      );
    }
    if (!actor.isAdmin && actor.userId !== userId) {
      throw new SkillValidationError('SKILL_UNAUTHORIZED', 'Cannot modify installation for another user');
    }

    if (updates.enabled === undefined && updates.selectedVersionId === undefined) {
      const current = await this.getInstallation(userId, skillId);
      if (!current) {
        throw new SkillResolutionError('SKILL_NOT_FOUND', `Skill installation not found for skill '${skillId}'`);
      }
      return current;
    }

    const query = `
      UPDATE skill_installations
      SET
        enabled = COALESCE($3, enabled),
        selected_version_id = COALESCE($4, selected_version_id)
      WHERE user_id = $1 AND skill_id = $2
      RETURNING id, user_id, skill_id, selected_version_id, enabled, installed_at;
    `;

    try {
      const result = await this.pool.query<SkillInstallationDbRow>(query, [
        userId,
        skillId,
        updates.enabled !== undefined ? updates.enabled : null,
        updates.selectedVersionId !== undefined ? updates.selectedVersionId : null,
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new SkillResolutionError('SKILL_NOT_FOUND', `Skill installation not found for skill '${skillId}'`);
      }
      return mapRowToInstallation(row);
    } catch (err: unknown) {
      const pgErr = err as { code?: string; message?: string };
      const isFkViolation =
        pgErr.code === '23503' ||
        (typeof pgErr.message === 'string' && pgErr.message.includes('foreign key constraint'));
      if (isFkViolation) {
        throw new SkillResolutionError(
          'SKILL_NOT_FOUND',
          `Selected version '${updates.selectedVersionId}' does not belong to skill '${skillId}'`
        );
      }
      throw err;
    }
  }

  /**
   * Atomically creates a skill definition, initial immutable version 1, and user installation in a single transaction.
   * If any step fails, the entire transaction rolls back cleanly leaving no orphaned skill.
   */
  public async createSkillWithInitialVersionAndInstallationAtomic(params: {
    skill: CreateSkillParams;
    instructions: string;
    contentHash?: string;
  }): Promise<{ skill: SkillDefinition; version: SkillVersion; installation: SkillInstallation }> {
    const slug = params.skill.slug.trim();
    if (slug.length < MIN_SLUG_LENGTH || slug.length > MAX_SLUG_LENGTH || !SLUG_REGEX.test(slug)) {
      throw new SkillValidationError('SKILL_VALIDATION_ERROR', `Invalid skill slug '${slug}'`);
    }

    const description = params.skill.description.trim();
    if (description.length < MIN_DESCRIPTION_LENGTH || description.length > MAX_DESCRIPTION_LENGTH) {
      throw new SkillValidationError('SKILL_VALIDATION_ERROR', 'Invalid skill description length');
    }

    if (!params.skill.actor) {
      throw new SkillValidationError('SKILL_UNAUTHORIZED', 'Actor authorization context is required to create a skill');
    }

    if (!params.skill.actor.isAdmin && (!params.skill.actor.userId || params.skill.actor.userId !== params.skill.ownerId)) {
      throw new SkillValidationError('SKILL_UNAUTHORIZED', 'Cannot create a private skill for another owner');
    }

    const bytes = getUtf8ByteCount(params.instructions);
    if (bytes > MAX_INSTRUCTION_BYTES) {
      throw new SkillValidationError('SKILL_OVERSIZED', `Instructions exceed ${MAX_INSTRUCTION_BYTES} bytes`);
    }

    const expectedHash = computeDeterministicHash(params.instructions);
    if (params.contentHash && params.contentHash !== expectedHash) {
      throw new SkillValidationError(
        'SKILL_VALIDATION_ERROR',
        `Provided content hash '${params.contentHash}' does not match deterministic instruction hash '${expectedHash}'`
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const insertSkillQuery = `
        INSERT INTO skill_definitions (id, owner_id, slug, title, description, visibility, supported_products)
        VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7)
        RETURNING id, owner_id, slug, title, description, visibility, supported_products, revision, created_at;
      `;
      const skillRes = await client.query<SkillDefinitionDbRow>(insertSkillQuery, [
        params.skill.id ?? null,
        params.skill.ownerId,
        slug,
        params.skill.title.trim(),
        description,
        params.skill.visibility,
        params.skill.supportedProducts,
      ]);
      const skillRow = skillRes.rows[0];
      if (!skillRow) throw new Error('Failed to insert skill: no row returned');
      const skill = mapRowToSkillDefinition(skillRow);

      const insertVersionQuery = `
        INSERT INTO skill_versions (id, skill_id, version_number, content_hash, instructions)
        VALUES (gen_random_uuid(), $1, 1, $2, $3)
        RETURNING id, skill_id, version_number, content_hash, instructions, created_at;
      `;
      const versionRes = await client.query<SkillVersionDbRow>(insertVersionQuery, [
        skill.id,
        expectedHash,
        params.instructions,
      ]);
      const versionRow = versionRes.rows[0];
      if (!versionRow) throw new Error('Failed to insert initial version: no row returned');
      const version = mapRowToSkillVersion(versionRow);

      const insertInstQuery = `
        INSERT INTO skill_installations (id, user_id, skill_id, selected_version_id, enabled)
        VALUES (gen_random_uuid(), $1, $2, $3, true)
        RETURNING id, user_id, skill_id, selected_version_id, enabled, installed_at;
      `;
      const instRes = await client.query<SkillInstallationDbRow>(insertInstQuery, [
        params.skill.ownerId,
        skill.id,
        version.id,
      ]);
      const instRow = instRes.rows[0];
      if (!instRow) throw new Error('Failed to insert initial installation: no row returned');
      const installation = mapRowToInstallation(instRow);

      await client.query('COMMIT');
      return { skill, version, installation };
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      const pgErr = err as { code?: string; message?: string };
      if (pgErr.code === '23505') {
        throw new SkillConflictError(`Skill slug '${slug}' already exists in this scope`, [slug]);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Lists skills accessible to the viewer with strict scope validation and bounded deterministic pagination.
   */
  public async listSkills(
    viewerUserId: string,
    options?: ListSkillsOptions
  ): Promise<PaginatedSkillList> {
    if (!viewerUserId || typeof viewerUserId !== 'string') {
      throw new SkillValidationError('SKILL_UNAUTHORIZED', 'Viewer user ID is required to list skills');
    }

    const scope = options?.scope;
    if (scope && scope !== 'installed' && scope !== 'builtIn') {
      throw new SkillValidationError(
        'SKILL_VALIDATION_ERROR',
        `Invalid scope '${scope}': expected 'installed' or 'builtIn'`
      );
    }

    const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100);

    let whereClause = `(d.visibility = 'built_in' OR (d.visibility = 'private' AND d.owner_id = $1))`;
    if (scope === 'installed') {
      whereClause = `i.id IS NOT NULL AND (d.visibility = 'built_in' OR (d.visibility = 'private' AND d.owner_id = $1))`;
    } else if (scope === 'builtIn') {
      whereClause = `d.visibility = 'built_in'`;
    }

    const queryParams: unknown[] = [viewerUserId];

    if (options?.cursor !== undefined) {
      if (typeof options.cursor !== 'string' || options.cursor.trim() === '') {
        throw new SkillValidationError('SKILL_VALIDATION_ERROR', 'Invalid pagination cursor: cursor cannot be empty');
      }
      let decoded: string;
      try {
        decoded = Buffer.from(options.cursor, 'base64url').toString('utf8');
      } catch {
        throw new SkillValidationError(
          'SKILL_VALIDATION_ERROR',
          'Invalid pagination cursor: malformed base64url encoding'
        );
      }
      const parts = decoded.split('::');
      if (parts.length !== 2) {
        throw new SkillValidationError(
          'SKILL_VALIDATION_ERROR',
          'Invalid pagination cursor format: expected timestamp::uuid'
        );
      }
      const [cursorDate, cursorId] = parts;
      if (!cursorDate || isNaN(Date.parse(cursorDate))) {
        throw new SkillValidationError('SKILL_VALIDATION_ERROR', 'Invalid pagination cursor: invalid timestamp');
      }
      const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!cursorId || !UUID_REGEX.test(cursorId)) {
        throw new SkillValidationError('SKILL_VALIDATION_ERROR', 'Invalid pagination cursor: invalid UUID');
      }
      queryParams.push(cursorDate, cursorId);
      whereClause += ` AND (d.created_at > $${queryParams.length - 1} OR (d.created_at = $${queryParams.length - 1} AND d.id > $${queryParams.length}))`;
    }

    queryParams.push(limit + 1);

    const query = `
      SELECT
        d.id,
        d.owner_id,
        d.slug,
        d.title,
        d.description,
        d.visibility,
        d.supported_products,
        d.revision,
        d.created_at,
        to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_created_at,
        (i.id IS NOT NULL) AS installed,
        COALESCE(i.enabled, false) AS enabled,
        i.selected_version_id
      FROM skill_definitions d
      LEFT JOIN skill_installations i ON i.skill_id = d.id AND i.user_id = $1
      WHERE ${whereClause}
      ORDER BY d.created_at ASC, d.id ASC
      LIMIT $${queryParams.length};
    `;

    const result = await this.pool.query<SkillListDbRow>(query, queryParams);
    const hasMore = result.rows.length > limit;
    const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows;

    const items: SkillListItem[] = pageRows.map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      visibility: row.visibility as SkillVisibility,
      supportedProducts: (row.supported_products ?? []) as ProductTarget[],
      revision: Number(row.revision ?? 1),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      installed: Boolean(row.installed),
      enabled: Boolean(row.enabled),
      selectedVersionId: row.selected_version_id ?? null,
    }));

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const lastRow = pageRows[pageRows.length - 1];
      if (lastRow) {
        const exactTimestamp =
          lastRow.exact_created_at ||
          (lastRow.created_at instanceof Date ? lastRow.created_at.toISOString() : String(lastRow.created_at));
        nextCursor = Buffer.from(`${exactTimestamp}::${lastRow.id}`).toString('base64url');
      }
    }

    return { items, nextCursor };
  }

  /**
   * Updates metadata (title, description, supportedProducts) of a private skill.
   * Built-in skills cannot be updated.
   * Cross-tenant access is rejected with SKILL_NOT_FOUND to prevent information disclosure.
   * Enforces optimistic concurrency control (CAS) via expectedRevision.
   */
  public async updateSkill(
    skillId: string,
    actor: SkillActorContext,
    updates: {
      title?: string;
      description?: string;
      supportedProducts?: ProductTarget[];
      expectedRevision: number;
    }
  ): Promise<SkillDefinition> {
    if (!actor) {
      throw new SkillValidationError('SKILL_UNAUTHORIZED', 'Actor authorization context is required');
    }

    if (
      updates.expectedRevision === undefined ||
      updates.expectedRevision === null ||
      typeof updates.expectedRevision !== 'number' ||
      !Number.isInteger(updates.expectedRevision) ||
      updates.expectedRevision < 1
    ) {
      throw new SkillValidationError(
        'SKILL_VALIDATION_ERROR',
        'expectedRevision is required and must be a positive integer (>= 1)'
      );
    }

    const queryExisting = `
      SELECT id, owner_id, slug, title, description, visibility, supported_products, revision, created_at
      FROM skill_definitions
      WHERE id = $1
      LIMIT 1;
    `;
    const existingRes = await this.pool.query<SkillDefinitionDbRow>(queryExisting, [skillId]);
    const existingRow = existingRes.rows[0];
    if (!existingRow) {
      throw new SkillResolutionError('SKILL_NOT_FOUND', `Skill '${skillId}' not found`);
    }
    const existingSkill = mapRowToSkillDefinition(existingRow);

    if (existingSkill.visibility === 'built_in') {
      throw new SkillValidationError('SKILL_UNAUTHORIZED', 'Built-in skills cannot be modified');
    }

    if (!actor.isAdmin && (!actor.userId || actor.userId !== existingSkill.ownerId)) {
      throw new SkillResolutionError('SKILL_NOT_FOUND', `Skill '${skillId}' not found`);
    }

    let titleToSet = existingSkill.title;
    if (updates.title !== undefined) {
      const trimmedTitle = updates.title.trim();
      if (trimmedTitle.length === 0 || trimmedTitle.length > 100) {
        throw new SkillValidationError('SKILL_VALIDATION_ERROR', 'Title must be between 1 and 100 characters');
      }
      titleToSet = trimmedTitle;
    }

    let descToSet = existingSkill.description;
    if (updates.description !== undefined) {
      const trimmedDesc = updates.description.trim();
      if (trimmedDesc.length < MIN_DESCRIPTION_LENGTH || trimmedDesc.length > MAX_DESCRIPTION_LENGTH) {
        throw new SkillValidationError(
          'SKILL_VALIDATION_ERROR',
          `Description must be between ${MIN_DESCRIPTION_LENGTH} and ${MAX_DESCRIPTION_LENGTH} characters`
        );
      }
      descToSet = trimmedDesc;
    }

    let prodsToSet = existingSkill.supportedProducts;
    if (updates.supportedProducts !== undefined) {
      if (!Array.isArray(updates.supportedProducts) || updates.supportedProducts.length === 0) {
        throw new SkillValidationError('SKILL_VALIDATION_ERROR', 'supportedProducts must be a non-empty array');
      }
      for (const p of updates.supportedProducts) {
        if (p !== 'chat' && p !== 'agent') {
          throw new SkillValidationError('SKILL_VALIDATION_ERROR', `Invalid product target '${p}'`);
        }
      }
      prodsToSet = [...new Set(updates.supportedProducts)];
    }

    // Atomic CAS update: matches expectedRevision and increments revision by 1
    const updateQuery = `
      UPDATE skill_definitions
      SET title = $2, description = $3, supported_products = $4, revision = revision + 1
      WHERE id = $1 AND revision = $5
      RETURNING id, owner_id, slug, title, description, visibility, supported_products, revision, created_at;
    `;
    const res = await this.pool.query<SkillDefinitionDbRow>(updateQuery, [
      skillId,
      titleToSet,
      descToSet,
      prodsToSet,
      updates.expectedRevision,
    ]);
    const updatedRow = res.rows[0];
    if (!updatedRow) {
      const checkRes = await this.pool.query<{ revision: number }>(
        'SELECT revision FROM skill_definitions WHERE id = $1',
        [skillId]
      );
      if (checkRes.rows.length === 0) {
        throw new SkillResolutionError('SKILL_NOT_FOUND', `Skill '${skillId}' not found`);
      }
      const currentRev = checkRes.rows[0]?.revision ?? 1;
      throw new SkillConflictError(
        `Metadata update conflict: expectedRevision ${updates.expectedRevision} does not match current revision ${currentRev}`,
        [existingSkill.slug]
      );
    }
    return mapRowToSkillDefinition(updatedRow);
  }

  /**
   * Deletes a private skill definition.
   * Built-in skills cannot be deleted.
   * Versions and installations cascade delete due to database constraints.
   */
  public async deleteSkill(skillId: string, actor: SkillActorContext): Promise<void> {
    if (!actor) {
      throw new SkillValidationError('SKILL_UNAUTHORIZED', 'Actor authorization context is required');
    }

    const queryExisting = `
      SELECT id, owner_id, slug, title, description, visibility, supported_products, revision, created_at
      FROM skill_definitions
      WHERE id = $1
      LIMIT 1;
    `;
    const existingRes = await this.pool.query<SkillDefinitionDbRow>(queryExisting, [skillId]);
    const existingRow = existingRes.rows[0];
    if (!existingRow) {
      throw new SkillResolutionError('SKILL_NOT_FOUND', `Skill '${skillId}' not found`);
    }
    const existingSkill = mapRowToSkillDefinition(existingRow);

    if (existingSkill.visibility === 'built_in') {
      throw new SkillValidationError('SKILL_UNAUTHORIZED', 'Built-in skills cannot be deleted');
    }

    if (!actor.isAdmin && (!actor.userId || actor.userId !== existingSkill.ownerId)) {
      throw new SkillResolutionError('SKILL_NOT_FOUND', `Skill '${skillId}' not found`);
    }

    await this.pool.query('DELETE FROM skill_definitions WHERE id = $1;', [skillId]);
  }

  /**
   * Gets the next sequential version number for a skill.
   */
  public async getNextVersionNumber(skillId: string): Promise<number> {
    const query = `
      SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
      FROM skill_versions
      WHERE skill_id = $1;
    `;
    const res = await this.pool.query<{ next_version: string | number }>(query, [skillId]);
    const row = res.rows[0];
    return Number(row?.next_version ?? 1);
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
