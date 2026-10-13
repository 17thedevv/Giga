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
} from './types.js';

export interface SkillStorage {
  getSkill(skillId: string, viewerUserId?: string): Promise<SkillDefinition | null>;
  getSkillBySlug(slug: string, viewerUserId?: string): Promise<SkillDefinition | null>;
  getSkillVersion(versionId: string, viewerUserId?: string): Promise<SkillVersion | null>;
  getLatestSkillVersion(skillId: string, viewerUserId?: string): Promise<SkillVersion | null>;
  getInstallation(userId: string, skillId: string): Promise<SkillInstallation | null>;
  getWorkspaceDefaults(workspaceId: string, ownerId: string): Promise<WorkspaceSkillDefault[]>;
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

  public clear(): void {
    this.skills.clear();
    this.versions.clear();
    this.installations.clear();
    this.workspaceDefaults.clear();
  }
}
