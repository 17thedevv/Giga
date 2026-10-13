/**
 * Giga Skills Core v0.1 — Skill Resolver
 *
 * Resolves manually selected Skills for an authenticated user and target product.
 * Enforces ownership isolation, product compatibility, installation & enablement checks,
 * deterministic ordering, deduplication, and budget bounds.
 *
 * Invariant: Never selects arbitrary installed skills automatically.
 * Authoritative docs: docs/architecture/GIGA_SKILLS_ENGINE_V0.1.md
 */

import { estimateTokenCount, getUtf8ByteCount } from './parser.js';
import type { SkillStorage } from './storage.js';
import {
  type SkillResolutionRequest,
  type ResolvedSkillsResult,
  type ResolvedSkillItem,
  type SkillActivationSource,
  type SkillVersion,
  MAX_TOTAL_INSTRUCTION_BYTES,
  SkillResolutionError,
} from './types.js';

export interface SkillLimits {
  maxActiveSkills: number;
  maxInstructionTokens: number;
  maxInstructionBytes: number;
}

export const DEFAULT_SKILL_LIMITS: SkillLimits = {
  maxActiveSkills: 3,
  maxInstructionTokens: 2000,
  maxInstructionBytes: MAX_TOTAL_INSTRUCTION_BYTES,
};

export class SkillResolver {
  private storage: SkillStorage;
  private limits: SkillLimits;

  constructor(storage: SkillStorage, limits: Partial<SkillLimits> = {}) {
    this.storage = storage;
    this.limits = {
      maxActiveSkills: limits.maxActiveSkills ?? DEFAULT_SKILL_LIMITS.maxActiveSkills,
      maxInstructionTokens: limits.maxInstructionTokens ?? DEFAULT_SKILL_LIMITS.maxInstructionTokens,
      maxInstructionBytes: limits.maxInstructionBytes ?? DEFAULT_SKILL_LIMITS.maxInstructionBytes,
    };
  }

  /**
   * Resolves permitted skills for an authenticated user and target product.
   */
  public async resolveSkills(request: SkillResolutionRequest): Promise<ResolvedSkillsResult> {
    const { userId, product, selectedSkillIds = [], workspaceId } = request;

    if (!userId || typeof userId !== 'string') {
      throw new SkillResolutionError('SKILL_UNAUTHORIZED', 'Authenticated user ID is required');
    }
    if (product !== 'chat' && product !== 'agent') {
      throw new SkillResolutionError(
        'SKILL_INCOMPATIBLE_PRODUCT',
        `Invalid product target: '${product}'. Only 'chat' and 'agent' are supported.`
      );
    }

    // 1. Gather candidate skills with source provenance
    interface CandidateSkill {
      skillId: string;
      source: SkillActivationSource;
    }

    const candidateList: CandidateSkill[] = [];
    const seenSkillIds = new Set<string>();

    // Manual selections first
    for (const id of selectedSkillIds) {
      if (!id || typeof id !== 'string') continue;
      const trimmedId = id.trim();
      if (!trimmedId) continue;

      if (!seenSkillIds.has(trimmedId)) {
        seenSkillIds.add(trimmedId);
        candidateList.push({ skillId: trimmedId, source: 'manual' });
      }
    }

    // Agent workspace defaults (strictly for 'agent' product only, never for 'chat')
    if (product === 'agent' && workspaceId) {
      const workspaceDefaults = await this.storage.getWorkspaceDefaults(workspaceId, userId);
      // Sort by configured position
      const sortedDefaults = [...workspaceDefaults].sort((a, b) => a.position - b.position);

      for (const def of sortedDefaults) {
        if (!def.enabled) continue;
        if (!seenSkillIds.has(def.skillId)) {
          seenSkillIds.add(def.skillId);
          candidateList.push({ skillId: def.skillId, source: 'workspace' });
        }
      }
    }

    // If no skills requested and no defaults, return empty result immediately (NO automatic activation)
    if (candidateList.length === 0) {
      return {
        skills: [],
        totalEstimatedTokens: 0,
        product,
        userId,
        workspaceId,
      };
    }

    // 2. Validate max active skills limit
    if (candidateList.length > this.limits.maxActiveSkills) {
      throw new SkillResolutionError(
        'SKILL_BUDGET_EXCEEDED',
        `Maximum ${this.limits.maxActiveSkills} active skills allowed (requested: ${candidateList.length})`
      );
    }

    // 3. Resolve each candidate skill definition, installation, and immutable version
    const resolvedItems: ResolvedSkillItem[] = [];
    let totalEstimatedTokens = 0;
    let totalInstructionBytes = 0;

    for (const candidate of candidateList) {
      // Lookup skill definition by ID with viewer tenant scoping
      let skill = await this.storage.getSkill(candidate.skillId, userId);
      if (!skill) {
        // Fallback: try by slug ONLY within user's own skills or built-in skills (prevents tenant leakage)
        skill = await this.storage.getSkillBySlug(candidate.skillId, userId);
      }

      if (!skill) {
        throw new SkillResolutionError(
          'SKILL_NOT_FOUND',
          `Skill '${candidate.skillId}' was not found`
        );
      }

      // Ownership & Tenant Isolation:
      // If private, owner must match current user. Reject without leaking private existence.
      if (skill.visibility === 'private' && skill.ownerId !== userId) {
        throw new SkillResolutionError(
          'SKILL_NOT_FOUND',
          `Skill '${candidate.skillId}' was not found`
        );
      }

      // Product Compatibility check
      if (!skill.supportedProducts.includes(product)) {
        throw new SkillResolutionError(
          'SKILL_INCOMPATIBLE_PRODUCT',
          `Skill '${skill.slug}' does not support product '${product}' (supported: ${skill.supportedProducts.join(', ')})`
        );
      }

      // Installation & Enablement check
      const installation = await this.storage.getInstallation(userId, skill.id);
      if (!installation) {
        throw new SkillResolutionError(
          'SKILL_NOT_INSTALLED',
          `Skill '${skill.slug}' is not installed for this user`
        );
      }
      if (!installation.enabled) {
        throw new SkillResolutionError(
          'SKILL_DISABLED',
          `Skill '${skill.slug}' is disabled and cannot be activated`
        );
      }

      // Immutable Version selection with strict integrity checks (fail closed, no silent fallback)
      let version: SkillVersion | null = null;
      if (installation.selectedVersionId) {
        version = await this.storage.getSkillVersion(installation.selectedVersionId, userId);
        if (!version || version.skillId !== skill.id) {
          throw new SkillResolutionError(
            'SKILL_NOT_FOUND',
            `Selected version '${installation.selectedVersionId}' for skill '${skill.slug}' is missing or does not belong to this skill`
          );
        }
      } else {
        version = await this.storage.getLatestSkillVersion(skill.id, userId);
        if (!version || version.skillId !== skill.id) {
          throw new SkillResolutionError(
            'SKILL_NOT_FOUND',
            `No valid version found for skill '${skill.slug}'`
          );
        }
      }

      const tokens = estimateTokenCount(version.instructions);
      const bytes = getUtf8ByteCount(version.instructions);

      totalEstimatedTokens += tokens;
      totalInstructionBytes += bytes;

      resolvedItems.push({
        skillId: skill.id,
        slug: skill.slug,
        title: skill.title,
        versionId: version.id,
        versionNumber: version.versionNumber,
        contentHash: version.contentHash,
        instructions: version.instructions,
        source: candidate.source,
        supportedProducts: skill.supportedProducts,
        estimatedTokens: tokens,
      });
    }

    // 4. Validate total instruction size bounds (hard byte limit and approximate token budget)
    if (totalInstructionBytes > this.limits.maxInstructionBytes) {
      throw new SkillResolutionError(
        'SKILL_BUDGET_EXCEEDED',
        `Total skill instruction size (${totalInstructionBytes} bytes) exceeds limit of ${this.limits.maxInstructionBytes} bytes`
      );
    }

    if (totalEstimatedTokens > this.limits.maxInstructionTokens) {
      throw new SkillResolutionError(
        'SKILL_BUDGET_EXCEEDED',
        `Total skill instruction budget exceeded: approximately ${totalEstimatedTokens} tokens exceeds limit of ${this.limits.maxInstructionTokens} tokens`
      );
    }

    return {
      skills: resolvedItems,
      totalEstimatedTokens,
      product,
      userId,
      workspaceId,
    };
  }
}
