/**
 * Giga Skills & Preferences Service v0.1
 *
 * Implements business logic, validation, tenant isolation, atomic transactions,
 * and error mapping between HTTP handlers and persistent storage.
 *
 * Authoritative docs: docs/contracts/GIGA_SKILLS_PROFILES_PLUGINS_API_V0.1.md
 * Architectural decisions: docs/decisions/ADR-005-skills-personalization-plugin-boundaries.md
 */

import type { PostgresSkillStorage } from './postgres-storage.js';
import type { PostgresUserPreferencesStorage } from './preferences-storage.js';
import {
  type SkillDefinition,
  type SkillVersion,
  type SkillInstallation,
  type UserPreferencesSnapshot,
  type ProductTarget,
  type ListSkillsOptions,
  type PaginatedSkillList,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  MAX_CUSTOM_INSTRUCTIONS_BYTES,
  SkillError,
  SkillValidationError,
  SkillResolutionError,
  SkillConflictError,
} from './types.js';
import {
  MAX_DESCRIPTION_LENGTH,
  MIN_DESCRIPTION_LENGTH,
  MAX_SLUG_LENGTH,
  MIN_SLUG_LENGTH,
  getUtf8ByteCount,
  isValidUuid,
  validateInstructionText,
} from './parser.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  AppError,
} from '../auth/auth-validation.js';

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface CreateSkillDto {
  slug: string;
  title: string;
  description: string;
  supportedProducts?: ProductTarget[];
  instructions?: string;
}

export interface UpdateSkillDto {
  title?: string;
  description?: string;
  supportedProducts?: ProductTarget[];
  expectedRevision: number; // Mandatory for optimistic concurrency control (CAS)
}

export interface CreateVersionDto {
  instructions: string;
}

export interface InstallSkillDto {
  versionId?: string;
  enabled?: boolean;
}

export interface UpdateInstallationDto {
  enabled?: boolean;
  selectedVersionId?: string;
}

export interface UpdatePreferencesDto {
  expectedRevision: number; // Mandatory for optimistic concurrency control (CAS)
  preferredLanguage?: string | null;
  responseLength?: 'concise' | 'balanced' | 'detailed';
  responseStyle?: 'professional' | 'casual' | 'technical';
  customInstructions?: string;
}

export interface SkillDetailResponse {
  id: string;
  ownerId: string | null;
  slug: string;
  title: string;
  description: string;
  visibility: string;
  supportedProducts: ProductTarget[];
  revision: number;
  createdAt: string;
  latestVersion: SkillVersion | null;
  installation: SkillInstallation | null;
}

export class SkillsService {
  constructor(
    private readonly skillStorage: PostgresSkillStorage,
    private readonly preferencesStorage: PostgresUserPreferencesStorage
  ) {}

  // ==========================================
  // User Preferences
  // ==========================================

  public async getPreferences(userId: string): Promise<UserPreferencesSnapshot> {
    try {
      const prefs = await this.preferencesStorage.getPreferences(userId);
      if (!prefs) {
        return {
          revision: 0,
          preferredLanguage: undefined,
          responseLength: 'balanced',
          responseStyle: 'professional',
          customInstructions: '',
        };
      }
      return prefs;
    } catch (err: unknown) {
      this.handleStorageError(err);
    }
  }

  public async updatePreferences(
    userId: string,
    dto: UpdatePreferencesDto
  ): Promise<UserPreferencesSnapshot> {
    try {
      // 1. Mandatory CAS check: expectedRevision must be a valid non-negative integer
      if (
        dto.expectedRevision === undefined ||
        dto.expectedRevision === null ||
        typeof dto.expectedRevision !== 'number' ||
        !Number.isInteger(dto.expectedRevision) ||
        dto.expectedRevision < 0
      ) {
        throw new ValidationError(
          'expectedRevision is required and must be a non-negative integer for optimistic concurrency control'
        );
      }

      // 2. Validate preferredLanguage
      if (dto.preferredLanguage !== undefined && dto.preferredLanguage !== null) {
        if (typeof dto.preferredLanguage !== 'string') {
          throw new ValidationError('preferredLanguage must be a string or null');
        }
        if (dto.preferredLanguage.length > 50) {
          throw new ValidationError('preferredLanguage must not exceed 50 characters');
        }
      }

      // 3. Validate responseLength enum
      if (dto.responseLength !== undefined) {
        const allowed = ['concise', 'balanced', 'detailed'];
        if (!allowed.includes(dto.responseLength)) {
          throw new ValidationError(
            `Invalid responseLength '${dto.responseLength}': expected 'concise', 'balanced', or 'detailed'`
          );
        }
      }

      // 4. Validate responseStyle enum
      if (dto.responseStyle !== undefined) {
        const allowed = ['professional', 'casual', 'technical'];
        if (!allowed.includes(dto.responseStyle)) {
          throw new ValidationError(
            `Invalid responseStyle '${dto.responseStyle}': expected 'professional', 'casual', or 'technical'`
          );
        }
      }

      // 5. Validate customInstructions bounds
      if (dto.customInstructions !== undefined && dto.customInstructions !== null) {
        if (typeof dto.customInstructions !== 'string') {
          throw new ValidationError('customInstructions must be a string');
        }
        if (dto.customInstructions.length > MAX_CUSTOM_INSTRUCTIONS_CHARS) {
          throw new AppError(
            'SKILL_OVERSIZED',
            `Custom instructions exceed maximum allowed limit of ${MAX_CUSTOM_INSTRUCTIONS_CHARS} characters`,
            400
          );
        }
        const byteCount = getUtf8ByteCount(dto.customInstructions);
        if (byteCount > MAX_CUSTOM_INSTRUCTIONS_BYTES) {
          throw new AppError(
            'SKILL_OVERSIZED',
            `Custom instructions exceed maximum allowed limit of ${MAX_CUSTOM_INSTRUCTIONS_BYTES} bytes`,
            400
          );
        }
      }

      // 6. Fetch current preferences to verify revision and preserve omitted fields
      const current = await this.preferencesStorage.getPreferences(userId);

      if (!current) {
        if (dto.expectedRevision !== 0) {
          throw new ConflictError(
            `Revision conflict: preferences do not exist yet, expectedRevision must be 0 (received ${dto.expectedRevision})`
          );
        }
      } else {
        if (current.revision !== dto.expectedRevision) {
          throw new ConflictError(
            `Revision conflict: current revision ${current.revision} does not match expectedRevision ${dto.expectedRevision}`
          );
        }
      }

      const merged: UserPreferencesSnapshot = {
        preferredLanguage:
          dto.preferredLanguage !== undefined
            ? (dto.preferredLanguage ?? undefined)
            : current?.preferredLanguage,
        responseLength:
          dto.responseLength !== undefined
            ? dto.responseLength
            : (current?.responseLength ?? 'balanced'),
        responseStyle:
          dto.responseStyle !== undefined
            ? dto.responseStyle
            : (current?.responseStyle ?? 'professional'),
        customInstructions:
          dto.customInstructions !== undefined
            ? dto.customInstructions
            : (current?.customInstructions ?? ''),
      };

      return await this.preferencesStorage.savePreferences(userId, merged, dto.expectedRevision);
    } catch (err: unknown) {
      this.handleStorageError(err);
    }
  }

  // ==========================================
  // Skills CRUD
  // ==========================================

  public async listSkills(
    userId: string,
    options?: ListSkillsOptions
  ): Promise<PaginatedSkillList> {
    if (options?.scope && options.scope !== 'installed' && options.scope !== 'builtIn') {
      throw new ValidationError(
        `Invalid scope '${options.scope}': expected 'installed' or 'builtIn'`
      );
    }
    if (options?.limit !== undefined) {
      if (
        typeof options.limit !== 'number' ||
        !Number.isInteger(options.limit) ||
        options.limit < 1 ||
        options.limit > 100
      ) {
        throw new ValidationError('limit must be an integer between 1 and 100');
      }
    }

    try {
      return await this.skillStorage.listSkills(userId, options);
    } catch (err: unknown) {
      this.handleStorageError(err);
    }
  }

  public async getSkill(userId: string, skillId: string): Promise<SkillDetailResponse> {
    if (!isValidUuid(skillId)) {
      throw new ValidationError('Invalid skill ID: must be a valid UUID');
    }

    try {
      const skill = await this.skillStorage.getSkill(skillId, userId);
      if (!skill) {
        throw new NotFoundError(`Skill '${skillId}' not found`);
      }

      const latestVersion = await this.skillStorage.getLatestSkillVersion(skillId, userId);
      const installation = await this.skillStorage.getInstallation(userId, skillId);

      return {
        id: skill.id,
        ownerId: skill.ownerId,
        slug: skill.slug,
        title: skill.title,
        description: skill.description,
        visibility: skill.visibility,
        supportedProducts: skill.supportedProducts,
        revision: skill.revision ?? 1,
        createdAt: skill.createdAt,
        latestVersion,
        installation,
      };
    } catch (err: unknown) {
      this.handleStorageError(err);
    }
  }

  public async createSkill(userId: string, dto: CreateSkillDto): Promise<SkillDetailResponse> {
    // 1. Strict input pre-validation before database access
    if (!dto.slug || typeof dto.slug !== 'string') {
      throw new ValidationError('Skill slug is required and must be a string');
    }
    const slug = dto.slug.trim();
    if (slug.length < MIN_SLUG_LENGTH || slug.length > MAX_SLUG_LENGTH || !SLUG_REGEX.test(slug)) {
      throw new ValidationError(
        `Invalid skill slug '${slug}': must be lowercase alphanumeric with hyphens, between ${MIN_SLUG_LENGTH} and ${MAX_SLUG_LENGTH} characters`
      );
    }

    if (!dto.title || typeof dto.title !== 'string') {
      throw new ValidationError('Skill title is required and must be a string');
    }
    const title = dto.title.trim();
    if (title.length === 0 || title.length > 100) {
      throw new ValidationError('Skill title must be between 1 and 100 characters');
    }

    if (!dto.description || typeof dto.description !== 'string') {
      throw new ValidationError('Skill description is required and must be a string');
    }
    const description = dto.description.trim();
    if (description.length < MIN_DESCRIPTION_LENGTH || description.length > MAX_DESCRIPTION_LENGTH) {
      throw new ValidationError(
        `Skill description must be between ${MIN_DESCRIPTION_LENGTH} and ${MAX_DESCRIPTION_LENGTH} characters`
      );
    }

    let supportedProducts: ProductTarget[] = ['chat', 'agent'];
    if (dto.supportedProducts !== undefined) {
      if (!Array.isArray(dto.supportedProducts) || dto.supportedProducts.length === 0) {
        throw new ValidationError('supportedProducts must be a non-empty array');
      }
      for (const p of dto.supportedProducts) {
        if (p !== 'chat' && p !== 'agent') {
          throw new ValidationError(`Invalid product target '${p}': expected 'chat' or 'agent'`);
        }
      }
      supportedProducts = [...new Set(dto.supportedProducts)];
    }

    // 2. Pre-validate instructions if provided
    let cleanInstructions: string | undefined;
    if (dto.instructions !== undefined) {
      if (typeof dto.instructions !== 'string') {
        throw new ValidationError('Instructions must be a string');
      }
      cleanInstructions = validateInstructionText(dto.instructions);
    }

    const actor = { userId };

    try {
      // 3. If instructions are provided, execute single atomic transaction (Skill + Version 1 + Installation)
      if (cleanInstructions) {
        const { skill, version, installation } =
          await this.skillStorage.createSkillWithInitialVersionAndInstallationAtomic({
            skill: {
              ownerId: userId,
              visibility: 'private',
              slug,
              title,
              description,
              supportedProducts,
              actor,
            },
            instructions: cleanInstructions,
          });

        return {
          id: skill.id,
          ownerId: skill.ownerId,
          slug: skill.slug,
          title: skill.title,
          description: skill.description,
          visibility: skill.visibility,
          supportedProducts: skill.supportedProducts,
          revision: skill.revision ?? 1,
          createdAt: skill.createdAt,
          latestVersion: version,
          installation,
        };
      }

      // 4. Definition-only creation
      const skill = await this.skillStorage.createSkill({
        ownerId: userId,
        visibility: 'private',
        slug,
        title,
        description,
        supportedProducts,
        actor,
      });

      return {
        id: skill.id,
        ownerId: skill.ownerId,
        slug: skill.slug,
        title: skill.title,
        description: skill.description,
        visibility: skill.visibility,
        supportedProducts: skill.supportedProducts,
        revision: skill.revision ?? 1,
        createdAt: skill.createdAt,
        latestVersion: null,
        installation: null,
      };
    } catch (err: unknown) {
      this.handleStorageError(err);
    }
  }

  public async updateSkill(
    userId: string,
    skillId: string,
    dto: UpdateSkillDto
  ): Promise<SkillDefinition> {
    if (!isValidUuid(skillId)) {
      throw new ValidationError('Invalid skill ID: must be a valid UUID');
    }

    if (
      dto.title === undefined &&
      dto.description === undefined &&
      dto.supportedProducts === undefined
    ) {
      throw new ValidationError(
        'At least one field to update (title, description, supportedProducts) must be provided'
      );
    }

    if (dto.title !== undefined) {
      if (typeof dto.title !== 'string') {
        throw new ValidationError('title must be a string');
      }
      const trimmed = dto.title.trim();
      if (trimmed.length === 0 || trimmed.length > 100) {
        throw new ValidationError('title must be between 1 and 100 characters');
      }
    }

    if (dto.description !== undefined) {
      if (typeof dto.description !== 'string') {
        throw new ValidationError('description must be a string');
      }
      const trimmed = dto.description.trim();
      if (trimmed.length < MIN_DESCRIPTION_LENGTH || trimmed.length > MAX_DESCRIPTION_LENGTH) {
        throw new ValidationError(
          `description must be between ${MIN_DESCRIPTION_LENGTH} and ${MAX_DESCRIPTION_LENGTH} characters`
        );
      }
    }

    if (dto.supportedProducts !== undefined) {
      if (!Array.isArray(dto.supportedProducts) || dto.supportedProducts.length === 0) {
        throw new ValidationError('supportedProducts must be a non-empty array');
      }
      for (const p of dto.supportedProducts) {
        if (p !== 'chat' && p !== 'agent') {
          throw new ValidationError(`Invalid product target '${p}'`);
        }
      }
    }

    if (
      dto.expectedRevision === undefined ||
      dto.expectedRevision === null ||
      typeof dto.expectedRevision !== 'number' ||
      !Number.isInteger(dto.expectedRevision) ||
      dto.expectedRevision < 1
    ) {
      throw new ValidationError('expectedRevision is required and must be a positive integer (>= 1)');
    }

    const actor = { userId };
    try {
      return await this.skillStorage.updateSkill(skillId, actor, dto);
    } catch (err: unknown) {
      this.handleStorageError(err);
    }
  }

  public async deleteSkill(userId: string, skillId: string): Promise<void> {
    if (!isValidUuid(skillId)) {
      throw new ValidationError('Invalid skill ID: must be a valid UUID');
    }

    const actor = { userId };
    try {
      await this.skillStorage.deleteSkill(skillId, actor);
    } catch (err: unknown) {
      this.handleStorageError(err);
    }
  }

  // ==========================================
  // Skill Versions
  // ==========================================

  public async publishVersion(
    userId: string,
    skillId: string,
    dto: CreateVersionDto
  ): Promise<SkillVersion> {
    if (!isValidUuid(skillId)) {
      throw new ValidationError('Invalid skill ID: must be a valid UUID');
    }
    if (!dto.instructions || typeof dto.instructions !== 'string') {
      throw new ValidationError('instructions are required and must be a string');
    }

    const validatedInstructions = validateInstructionText(dto.instructions);

    const actor = { userId };

    try {
      const skill = await this.skillStorage.getSkill(skillId, userId);
      if (!skill) {
        throw new NotFoundError(`Skill '${skillId}' not found`);
      }
      if (skill.visibility === 'built_in') {
        throw new ForbiddenError('Cannot publish versions for built-in skills');
      }
      if (skill.ownerId !== userId) {
        throw new NotFoundError(`Skill '${skillId}' not found`);
      }

      const nextVersionNumber = await this.skillStorage.getNextVersionNumber(skillId);

      return await this.skillStorage.createVersion({
        skillId,
        versionNumber: nextVersionNumber,
        instructions: validatedInstructions,
        actor,
      });
    } catch (err: unknown) {
      this.handleStorageError(err);
    }
  }

  // ==========================================
  // Skill Installations
  // ==========================================

  public async installSkill(
    userId: string,
    skillId: string,
    dto: InstallSkillDto
  ): Promise<SkillInstallation> {
    if (!isValidUuid(skillId)) {
      throw new ValidationError('Invalid skill ID: must be a valid UUID');
    }

    if (dto.versionId !== undefined) {
      if (!isValidUuid(dto.versionId)) {
        throw new ValidationError('versionId must be a valid UUID');
      }
    }

    if (dto.enabled !== undefined && typeof dto.enabled !== 'boolean') {
      throw new ValidationError('enabled must be a boolean');
    }

    const actor = { userId };

    try {
      const skill = await this.skillStorage.getSkill(skillId, userId);
      if (!skill) {
        throw new NotFoundError(`Skill '${skillId}' not found`);
      }

      let selectedVersionId = dto.versionId;
      if (!selectedVersionId) {
        const latest = await this.skillStorage.getLatestSkillVersion(skillId, userId);
        if (!latest) {
          throw new ValidationError('Skill has no published versions to install');
        }
        selectedVersionId = latest.id;
      } else {
        const version = await this.skillStorage.getSkillVersion(selectedVersionId, userId);
        if (!version || version.skillId !== skillId) {
          throw new NotFoundError(
            `Selected version '${selectedVersionId}' does not belong to skill '${skillId}'`
          );
        }
      }

      const existing = await this.skillStorage.getInstallation(userId, skillId);
      if (existing) {
        throw new ConflictError(`Skill '${skillId}' is already installed for this user`);
      }

      return await this.skillStorage.createInstallation({
        userId,
        skillId,
        selectedVersionId,
        enabled: dto.enabled ?? true,
        actor,
      });
    } catch (err: unknown) {
      this.handleStorageError(err);
    }
  }

  public async updateInstallation(
    userId: string,
    skillId: string,
    dto: UpdateInstallationDto
  ): Promise<SkillInstallation> {
    if (!isValidUuid(skillId)) {
      throw new ValidationError('Invalid skill ID: must be a valid UUID');
    }

    if (dto.enabled === undefined && dto.selectedVersionId === undefined) {
      throw new ValidationError('At least one of enabled or selectedVersionId must be provided');
    }

    if (dto.enabled !== undefined && typeof dto.enabled !== 'boolean') {
      throw new ValidationError('enabled must be a boolean');
    }

    if (dto.selectedVersionId !== undefined) {
      if (!isValidUuid(dto.selectedVersionId)) {
        throw new ValidationError('selectedVersionId must be a valid UUID');
      }
    }

    const actor = { userId };

    try {
      const installation = await this.skillStorage.getInstallation(userId, skillId);
      if (!installation) {
        throw new NotFoundError(`Skill installation not found for skill '${skillId}'`);
      }

      if (dto.selectedVersionId !== undefined) {
        const version = await this.skillStorage.getSkillVersion(dto.selectedVersionId, userId);
        if (!version || version.skillId !== skillId) {
          throw new NotFoundError(
            `Selected version '${dto.selectedVersionId}' does not belong to skill '${skillId}'`
          );
        }
      }

      // Execute atomic update in a single SQL operation
      return await this.skillStorage.updateInstallationAtomic(
        userId,
        skillId,
        { enabled: dto.enabled, selectedVersionId: dto.selectedVersionId },
        actor
      );
    } catch (err: unknown) {
      this.handleStorageError(err);
    }
  }

  // ==========================================
  // Error Mapping Helper
  // ==========================================

  private handleStorageError(err: unknown): never {
    if (err instanceof AppError) {
      throw err;
    }

    if (err instanceof SkillConflictError) {
      throw new ConflictError(err.message);
    }

    if (err instanceof SkillResolutionError) {
      if (err.code === 'SKILL_NOT_FOUND') {
        throw new NotFoundError(err.message);
      }
      throw new ValidationError(err.message);
    }

    if (err instanceof SkillValidationError) {
      if (err.code === 'SKILL_UNAUTHORIZED') {
        throw new ForbiddenError(err.message);
      }
      if (err.code === 'SKILL_OVERSIZED') {
        throw new AppError('SKILL_OVERSIZED', err.message, 400);
      }
      if (err.code === 'SKILL_UNSAFE_CONTENT') {
        throw new AppError('SKILL_UNSAFE_CONTENT', err.message, 400);
      }
      throw new ValidationError(err.message);
    }

    if (err instanceof SkillError) {
      if (err.code === 'SKILL_NOT_FOUND') {
        throw new NotFoundError(err.message);
      }
      if (err.code === 'SKILL_UNAUTHORIZED') {
        throw new ForbiddenError(err.message);
      }
      if (err.code === 'SKILL_CONFLICT') {
        throw new ConflictError(err.message);
      }
      throw new ValidationError(err.message);
    }

    throw err;
  }
}
