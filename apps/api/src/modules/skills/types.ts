/**
 * Giga Skills Core v0.1 — Domain Types and Interfaces
 *
 * Authoritative docs: docs/architecture/GIGA_SKILLS_ENGINE_V0.1.md
 * Architectural decisions: docs/decisions/ADR-005-skills-personalization-plugin-boundaries.md
 */

export type ProductTarget = 'chat' | 'agent';
export type SkillVisibility = 'built_in' | 'private';
export type SkillActivationSource = 'manual' | 'workspace';

export interface ParsedSkill {
  slug: string;
  title: string;
  description: string;
  supportedProducts: ProductTarget[];
  instructions: string;
  contentHash: string;
  rawContent: string;
  estimatedTokens: number;
}

export interface SkillDefinition {
  id: string;
  ownerId: string | null; // null for built_in
  slug: string;
  title: string;
  description: string;
  visibility: SkillVisibility;
  supportedProducts: ProductTarget[];
  createdAt: string;
}

export interface SkillVersion {
  id: string;
  skillId: string;
  versionNumber: number;
  contentHash: string;
  instructions: string;
  createdAt: string;
}

export interface SkillInstallation {
  id: string;
  userId: string;
  skillId: string;
  selectedVersionId: string;
  enabled: boolean;
  installedAt: string;
}

export interface WorkspaceSkillDefault {
  workspaceId: string;
  ownerId: string;
  skillId: string;
  position: number;
  enabled: boolean;
}

export interface UserPreferencesSnapshot {
  preferredLanguage?: string;
  responseLength?: 'concise' | 'balanced' | 'detailed';
  responseStyle?: 'professional' | 'casual' | 'technical';
  customInstructions?: string;
  revision?: number;
}

export interface SkillResolutionRequest {
  userId: string;
  product: ProductTarget;
  selectedSkillIds?: string[];
  workspaceId?: string;
}

export interface ResolvedSkillItem {
  skillId: string;
  slug: string;
  title: string;
  versionId: string;
  versionNumber: number;
  contentHash: string;
  instructions: string;
  source: SkillActivationSource;
  supportedProducts: ProductTarget[];
  estimatedTokens: number;
}

export interface ResolvedSkillsResult {
  skills: ResolvedSkillItem[];
  totalEstimatedTokens: number;
  product: ProductTarget;
  userId: string;
  workspaceId?: string;
}

export interface SkillActivationManifestItem {
  skillId: string;
  versionId: string;
  contentHash: string;
  source: SkillActivationSource;
  position: number;
}

export interface SkillActivationManifest {
  manifestId: string;
  userId: string;
  targetProduct: ProductTarget;
  resolverVersion: 'v0.1';
  activatedAt: string;
  skills: SkillActivationManifestItem[];
  totalEstimatedTokens: number;
  preferencesRevision?: number;
}

export interface ComposeInstructionsRequest {
  resolvedSkills: ResolvedSkillItem[];
  product: ProductTarget;
  userId: string;
  userPrompt?: string;
  userPreferences?: UserPreferencesSnapshot;
}

export interface ComposedInstructionSegment {
  content: string;
  manifest: SkillActivationManifest;
  appliedSkillsCount: number;
  totalEstimatedTokens: number;
}

export type SkillErrorCode =
  | 'SKILL_PARSE_ERROR'
  | 'SKILL_VALIDATION_ERROR'
  | 'SKILL_OVERSIZED'
  | 'SKILL_UNSAFE_CONTENT'
  | 'SKILL_NOT_FOUND'
  | 'SKILL_UNAUTHORIZED'
  | 'SKILL_DISABLED'
  | 'SKILL_NOT_INSTALLED'
  | 'SKILL_INCOMPATIBLE_PRODUCT'
  | 'SKILL_BUDGET_EXCEEDED'
  | 'SKILL_CONFLICT';

export class SkillError extends Error {
  public readonly code: SkillErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: SkillErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SkillError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SkillValidationError extends SkillError {
  constructor(code: SkillErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = 'SkillValidationError';
  }
}

export class SkillResolutionError extends SkillError {
  constructor(code: SkillErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = 'SkillResolutionError';
  }
}

export class SkillConflictError extends SkillError {
  public readonly conflictingSkillSlugs: string[];

  constructor(message: string, conflictingSkillSlugs: string[], details?: Record<string, unknown>) {
    super('SKILL_CONFLICT', message, { ...details, conflictingSkillSlugs });
    this.name = 'SkillConflictError';
    this.conflictingSkillSlugs = conflictingSkillSlugs;
  }
}
