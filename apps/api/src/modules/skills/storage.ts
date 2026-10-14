/**
 * Giga Skills Core v0.1 — Storage Interface & In-Memory Implementation
 *
 * Defines the contract for fetching skill definitions, versions, and installations.
 * Provides an in-memory implementation for deterministic unit testing and standalone execution.
 *
 * Authoritative docs: docs/architecture/GIGA_SKILLS_DATA_MODEL_V0.1.md
 */

import type {
  SkillDefinition,
  SkillVersion,
  SkillInstallation,
  WorkspaceSkillDefault,
  SkillListItem,
  SkillActorContext,
  ProductTarget,
  ListSkillsOptions,
  PaginatedSkillList,
} from './types.js';

export interface SkillStorage {
  getSkill(skillId: string, viewerUserId?: string): Promise<SkillDefinition | null>;
  getSkillBySlug(slug: string, viewerUserId?: string): Promise<SkillDefinition | null>;
  getSkillVersion(versionId: string, viewerUserId?: string): Promise<SkillVersion | null>;
  getLatestSkillVersion(skillId: string, viewerUserId?: string): Promise<SkillVersion | null>;
  getInstallation(userId: string, skillId: string): Promise<SkillInstallation | null>;
  getWorkspaceDefaults(workspaceId: string, ownerId: string): Promise<WorkspaceSkillDefault[]>;
  listSkills?(viewerUserId: string, options?: ListSkillsOptions): Promise<PaginatedSkillList | SkillListItem[]>;
  updateSkill?(
    skillId: string,
    actor: SkillActorContext,
    updates: {
      title?: string;
      description?: string;
      supportedProducts?: ProductTarget[];
      expectedRevision: number;
    }
  ): Promise<SkillDefinition>;
  deleteSkill?(skillId: string, actor: SkillActorContext): Promise<void>;
  getNextVersionNumber?(skillId: string): Promise<number>;
  updateInstallationAtomic?(
    userId: string,
    skillId: string,
    updates: { enabled?: boolean; selectedVersionId?: string },
    actor: SkillActorContext
  ): Promise<SkillInstallation>;
}

export class InMemorySkillStorage implements SkillStorage {
  private skills = new Map<string, SkillDefinition>();
  private versions = new Map<string, SkillVersion>();
  private installations = new Map<string, SkillInstallation>(); // key: `${userId}:${skillId}`
  private workspaceDefaults = new Map<string, WorkspaceSkillDefault[]>(); // key: `${workspaceId}:${ownerId}`

  public addSkill(skill: SkillDefinition): void {
    this.skills.set(skill.id, { ...skill });
  }

  public addVersion(version: SkillVersion): void {
    this.versions.set(version.id, { ...version });
  }

  public addInstallation(installation: SkillInstallation): void {
    const key = `${installation.userId}:${installation.skillId}`;
    this.installations.set(key, { ...installation });
  }

  public setWorkspaceDefaults(
    workspaceId: string,
    ownerId: string,
    defaults: WorkspaceSkillDefault[]
  ): void {
    const key = `${workspaceId}:${ownerId}`;
    this.workspaceDefaults.set(key, [...defaults]);
  }

  public async getSkill(skillId: string, viewerUserId?: string): Promise<SkillDefinition | null> {
    const skill = this.skills.get(skillId);
    if (!skill) return null;
    if (viewerUserId && skill.visibility === 'private' && skill.ownerId !== viewerUserId) {
      return null;
    }
    return { ...skill };
  }

  public async getSkillBySlug(
    slug: string,
    viewerUserId?: string
  ): Promise<SkillDefinition | null> {
    let privateMatch: SkillDefinition | null = null;
    let builtInMatch: SkillDefinition | null = null;

    for (const skill of this.skills.values()) {
      if (skill.slug === slug) {
        // Private skill owned by the viewer takes highest precedence
        if (viewerUserId && skill.ownerId === viewerUserId && skill.visibility === 'private') {
          privateMatch = skill;
          break;
        }
        // Built-in skill is accessible if no private skill shadows it
        if (skill.visibility === 'built_in' && !builtInMatch) {
          builtInMatch = skill;
        }
      }
    }

    if (privateMatch) {
      return { ...privateMatch };
    }
    if (builtInMatch) {
      return { ...builtInMatch };
    }
    return null;
  }

  public async getSkillVersion(versionId: string, viewerUserId?: string): Promise<SkillVersion | null> {
    const version = this.versions.get(versionId);
    if (!version) return null;
    const skill = this.skills.get(version.skillId);
    if (skill && skill.visibility === 'private') {
      if (!viewerUserId || skill.ownerId !== viewerUserId) {
        return null;
      }
    }
    return { ...version };
  }

  public async getLatestSkillVersion(skillId: string, viewerUserId?: string): Promise<SkillVersion | null> {
    const skill = this.skills.get(skillId);
    if (skill && skill.visibility === 'private') {
      if (!viewerUserId || skill.ownerId !== viewerUserId) {
        return null;
      }
    }
    let latest: SkillVersion | null = null;
    for (const version of this.versions.values()) {
      if (version.skillId === skillId) {
        if (!latest || version.versionNumber > latest.versionNumber) {
          latest = version;
        }
      }
    }
    return latest ? { ...latest } : null;
  }

  public async getInstallation(
    userId: string,
    skillId: string
  ): Promise<SkillInstallation | null> {
    const key = `${userId}:${skillId}`;
    const inst = this.installations.get(key);
    return inst ? { ...inst } : null;
  }

  public async getWorkspaceDefaults(
    workspaceId: string,
    ownerId: string
  ): Promise<WorkspaceSkillDefault[]> {
    const key = `${workspaceId}:${ownerId}`;
    const list = this.workspaceDefaults.get(key);
    return list ? list.map((item) => ({ ...item })) : [];
  }

  public async listSkills(
    viewerUserId: string,
    options?: { scope?: 'installed' | 'builtIn' }
  ): Promise<SkillListItem[]> {
    const results: SkillListItem[] = [];
    const scope = options?.scope;

    for (const skill of this.skills.values()) {
      const isBuiltIn = skill.visibility === 'built_in';
      const isOwner = skill.visibility === 'private' && skill.ownerId === viewerUserId;
      if (!isBuiltIn && !isOwner) {
        continue;
      }

      const instKey = `${viewerUserId}:${skill.id}`;
      const inst = this.installations.get(instKey);
      const installed = Boolean(inst);

      if (scope === 'installed' && !installed) {
        continue;
      }
      if (scope === 'builtIn' && !isBuiltIn) {
        continue;
      }

      results.push({
        id: skill.id,
        ownerId: skill.ownerId,
        slug: skill.slug,
        title: skill.title,
        description: skill.description,
        visibility: skill.visibility,
        supportedProducts: [...skill.supportedProducts],
        revision: skill.revision ?? 1,
        createdAt: skill.createdAt,
        installed,
        enabled: inst ? inst.enabled : false,
        selectedVersionId: inst ? inst.selectedVersionId : null,
      });
    }

    results.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug));
    return results;
  }

  public async updateSkill(
    skillId: string,
    actor: SkillActorContext,
    updates: {
      expectedRevision: number;
      title?: string;
      description?: string;
      supportedProducts?: ProductTarget[];
    }
  ): Promise<SkillDefinition> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill '${skillId}' not found`);
    }
    if (skill.visibility === 'built_in') {
      throw new Error('Built-in skills cannot be modified');
    }
    if (!actor.isAdmin && (!actor.userId || actor.userId !== skill.ownerId)) {
      throw new Error(`Skill '${skillId}' not found`);
    }

    const currentRevision = skill.revision ?? 1;
    if (updates.expectedRevision !== currentRevision) {
      throw new Error(
        `Metadata update conflict: current revision ${currentRevision} does not match expectedRevision ${updates.expectedRevision}`
      );
    }

    if (updates.title !== undefined) skill.title = updates.title;
    if (updates.description !== undefined) skill.description = updates.description;
    if (updates.supportedProducts !== undefined) skill.supportedProducts = [...updates.supportedProducts];
    skill.revision = currentRevision + 1;

    this.skills.set(skillId, { ...skill });
    return { ...skill };
  }

  public async deleteSkill(skillId: string, actor: SkillActorContext): Promise<void> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill '${skillId}' not found`);
    }
    if (skill.visibility === 'built_in') {
      throw new Error('Built-in skills cannot be deleted');
    }
    if (!actor.isAdmin && (!actor.userId || actor.userId !== skill.ownerId)) {
      throw new Error(`Skill '${skillId}' not found`);
    }

    this.skills.delete(skillId);
    for (const [vId, v] of this.versions.entries()) {
      if (v.skillId === skillId) {
        this.versions.delete(vId);
      }
    }
    for (const [k, inst] of this.installations.entries()) {
      if (inst.skillId === skillId) {
        this.installations.delete(k);
      }
    }
  }

  public async getNextVersionNumber(skillId: string): Promise<number> {
    let max = 0;
    for (const v of this.versions.values()) {
      if (v.skillId === skillId && v.versionNumber > max) {
        max = v.versionNumber;
      }
    }
    return max + 1;
  }

  public async updateInstallationAtomic(
    userId: string,
    skillId: string,
    updates: { enabled?: boolean; selectedVersionId?: string },
    actor: SkillActorContext
  ): Promise<SkillInstallation> {
    if (!actor) throw new Error('Actor authorization context is required');
    if (!actor.isAdmin && actor.userId !== userId) throw new Error('Cannot modify installation for another user');

    const key = `${userId}:${skillId}`;
    const inst = this.installations.get(key);
    if (!inst) throw new Error(`Skill installation not found for skill '${skillId}'`);

    if (updates.selectedVersionId !== undefined) {
      const ver = this.versions.get(updates.selectedVersionId);
      if (!ver || ver.skillId !== skillId) {
        throw new Error(`Selected version '${updates.selectedVersionId}' does not belong to skill '${skillId}'`);
      }
      inst.selectedVersionId = updates.selectedVersionId;
    }
    if (updates.enabled !== undefined) {
      inst.enabled = updates.enabled;
    }

    this.installations.set(key, { ...inst });
    return { ...inst };
  }

  public clear(): void {
    this.skills.clear();
    this.versions.clear();
    this.installations.clear();
    this.workspaceDefaults.clear();
  }
}
