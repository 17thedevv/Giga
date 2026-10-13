import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySkillStorage } from '../../src/modules/skills/storage.js';
import { SkillResolver } from '../../src/modules/skills/resolver.js';
import { SkillResolutionError } from '../../src/modules/skills/types.js';

describe('Skills Core — Resolver', () => {
  let storage: InMemorySkillStorage;
  let resolver: SkillResolver;

  const userA = 'user-uuid-1111';
  const userB = 'user-uuid-2222';

  beforeEach(() => {
    storage = new InMemorySkillStorage();
    resolver = new SkillResolver(storage);

    // Setup Fixtures:
    // 1. Built-in skill: explain-code
    storage.addSkill({
      id: 'skill-builtin-1',
      ownerId: null,
      slug: 'explain-code',
      title: 'Explain Code',
      description: 'Built-in code explainer',
      visibility: 'built_in',
      supportedProducts: ['chat', 'agent'],
      createdAt: '2026-10-13T00:00:00Z',
    });
    storage.addVersion({
      id: 'version-builtin-v1',
      skillId: 'skill-builtin-1',
      versionNumber: 1,
      contentHash: 'hash-v1',
      instructions: 'Explain code step by step in simple terms.',
      createdAt: '2026-10-13T00:00:00Z',
    });
    storage.addVersion({
      id: 'version-builtin-v2',
      skillId: 'skill-builtin-1',
      versionNumber: 2,
      contentHash: 'hash-v2',
      instructions: 'Explain code with architectural context and diagrams.',
      createdAt: '2026-10-13T01:00:00Z',
    });

    // 2. Private skill owned by User A: custom-qa
    storage.addSkill({
      id: 'skill-custom-userA',
      ownerId: userA,
      slug: 'custom-qa',
      title: 'Custom QA Process',
      description: 'Private QA workflow for User A',
      visibility: 'private',
      supportedProducts: ['chat', 'agent'],
      createdAt: '2026-10-13T00:00:00Z',
    });
    storage.addVersion({
      id: 'version-custom-v1',
      skillId: 'skill-custom-userA',
      versionNumber: 1,
      contentHash: 'hash-custom-v1',
      instructions: 'Follow internal team test conventions.',
      createdAt: '2026-10-13T00:00:00Z',
    });

    // 3. Chat-only skill: chat-humor
    storage.addSkill({
      id: 'skill-chat-only',
      ownerId: null,
      slug: 'chat-humor',
      title: 'Chat Humor',
      description: 'Lighthearted chat replies',
      visibility: 'built_in',
      supportedProducts: ['chat'],
      createdAt: '2026-10-13T00:00:00Z',
    });
    storage.addVersion({
      id: 'version-chat-only-v1',
      skillId: 'skill-chat-only',
      versionNumber: 1,
      contentHash: 'hash-chat-v1',
      instructions: 'Use friendly humor in responses.',
      createdAt: '2026-10-13T00:00:00Z',
    });
  });

  it('Scenario 7: resolves permitted built-in Skill manually selected', async () => {
    // Install for User A
    storage.addInstallation({
      id: 'inst-1',
      userId: userA,
      skillId: 'skill-builtin-1',
      selectedVersionId: 'version-builtin-v1',
      enabled: true,
      installedAt: '2026-10-13T00:00:00Z',
    });

    const result = await resolver.resolveSkills({
      userId: userA,
      product: 'chat',
      selectedSkillIds: ['skill-builtin-1'],
    });

    assert.strictEqual(result.skills.length, 1);
    assert.strictEqual(result.skills[0]?.slug, 'explain-code');
    assert.strictEqual(result.skills[0]?.versionId, 'version-builtin-v1');
    assert.strictEqual(result.skills[0]?.source, 'manual');
    assert.strictEqual(result.product, 'chat');
    assert.ok(result.totalEstimatedTokens > 0);
  });

  it("Scenario 8: isolates private Skill ownership (User B cannot resolve User A's private skill)", async () => {
    // User A installs their private skill
    storage.addInstallation({
      id: 'inst-A',
      userId: userA,
      skillId: 'skill-custom-userA',
      selectedVersionId: 'version-custom-v1',
      enabled: true,
      installedAt: '2026-10-13T00:00:00Z',
    });

    // User B tries to activate User A's private skill
    await assert.rejects(
      async () =>
        resolver.resolveSkills({
          userId: userB,
          product: 'chat',
          selectedSkillIds: ['skill-custom-userA'],
        }),
      (err: Error) =>
        err instanceof SkillResolutionError &&
        err.code === 'SKILL_NOT_FOUND' &&
        /not found/i.test(err.message)
    );
  });

  it('Scenario 9: rejects disabled Skill', async () => {
    // Installed but enabled = false
    storage.addInstallation({
      id: 'inst-disabled',
      userId: userA,
      skillId: 'skill-builtin-1',
      selectedVersionId: 'version-builtin-v1',
      enabled: false,
      installedAt: '2026-10-13T00:00:00Z',
    });

    await assert.rejects(
      async () =>
        resolver.resolveSkills({
          userId: userA,
          product: 'chat',
          selectedSkillIds: ['skill-builtin-1'],
        }),
      (err: Error) =>
        err instanceof SkillResolutionError &&
        err.code === 'SKILL_DISABLED' &&
        /is disabled/i.test(err.message)
    );
  });

  it('Scenario 10: rejects uninstalled Skill', async () => {
    // User A has NOT installed skill-builtin-1
    await assert.rejects(
      async () =>
        resolver.resolveSkills({
          userId: userA,
          product: 'chat',
          selectedSkillIds: ['skill-builtin-1'],
        }),
      (err: Error) =>
        err instanceof SkillResolutionError &&
        err.code === 'SKILL_NOT_INSTALLED' &&
        /is not installed/i.test(err.message)
    );
  });

  it('Scenario 11: rejects wrong product compatibility', async () => {
    // chat-humor is supported only on 'chat', user tries to use on 'agent'
    storage.addInstallation({
      id: 'inst-chat-only',
      userId: userA,
      skillId: 'skill-chat-only',
      selectedVersionId: 'version-chat-only-v1',
      enabled: true,
      installedAt: '2026-10-13T00:00:00Z',
    });

    await assert.rejects(
      async () =>
        resolver.resolveSkills({
          userId: userA,
          product: 'agent',
          selectedSkillIds: ['skill-chat-only'],
        }),
      (err: Error) =>
        err instanceof SkillResolutionError &&
        err.code === 'SKILL_INCOMPATIBLE_PRODUCT' &&
        /does not support product 'agent'/i.test(err.message)
    );
  });

  it('Scenario 12: deduplicates duplicate Skill selection', async () => {
    storage.addInstallation({
      id: 'inst-1',
      userId: userA,
      skillId: 'skill-builtin-1',
      selectedVersionId: 'version-builtin-v1',
      enabled: true,
      installedAt: '2026-10-13T00:00:00Z',
    });

    // User provides skill-builtin-1 multiple times
    const result = await resolver.resolveSkills({
      userId: userA,
      product: 'chat',
      selectedSkillIds: ['skill-builtin-1', 'skill-builtin-1', 'skill-builtin-1'],
    });

    assert.strictEqual(result.skills.length, 1);
    assert.strictEqual(result.skills[0]?.slug, 'explain-code');
  });

  it('Scenario 13: pins immutable version selection', async () => {
    // User A specifically selected version-builtin-v1 even though v2 exists
    storage.addInstallation({
      id: 'inst-1',
      userId: userA,
      skillId: 'skill-builtin-1',
      selectedVersionId: 'version-builtin-v1',
      enabled: true,
      installedAt: '2026-10-13T00:00:00Z',
    });

    const result = await resolver.resolveSkills({
      userId: userA,
      product: 'chat',
      selectedSkillIds: ['skill-builtin-1'],
    });

    assert.strictEqual(result.skills[0]?.versionId, 'version-builtin-v1');
    assert.strictEqual(result.skills[0]?.versionNumber, 1);
    assert.strictEqual(result.skills[0]?.contentHash, 'hash-v1');
    assert.strictEqual(result.skills[0]?.instructions, 'Explain code step by step in simple terms.');
  });

  it('Scenario 14: combines Agent Workspace defaults with manual activations respecting precedence', async () => {
    // User A installs both skills
    storage.addInstallation({
      id: 'inst-1',
      userId: userA,
      skillId: 'skill-builtin-1',
      selectedVersionId: 'version-builtin-v1',
      enabled: true,
      installedAt: '2026-10-13T00:00:00Z',
    });
    storage.addInstallation({
      id: 'inst-2',
      userId: userA,
      skillId: 'skill-custom-userA',
      selectedVersionId: 'version-custom-v1',
      enabled: true,
      installedAt: '2026-10-13T00:00:00Z',
    });

    // Configure workspace defaults: custom-qa as default
    storage.setWorkspaceDefaults('ws-1', userA, [
      { workspaceId: 'ws-1', ownerId: userA, skillId: 'skill-custom-userA', position: 1, enabled: true },
    ]);

    // User explicitly selects explain-code manually in Agent Run
    const result = await resolver.resolveSkills({
      userId: userA,
      product: 'agent',
      workspaceId: 'ws-1',
      selectedSkillIds: ['skill-builtin-1'],
    });

    assert.strictEqual(result.skills.length, 2);
    // Manual selection comes first
    assert.strictEqual(result.skills[0]?.slug, 'explain-code');
    assert.strictEqual(result.skills[0]?.source, 'manual');
    // Workspace default comes second
    assert.strictEqual(result.skills[1]?.slug, 'custom-qa');
    assert.strictEqual(result.skills[1]?.source, 'workspace');

    // Chat product strictly ignores Agent Workspace defaults
    const chatResult = await resolver.resolveSkills({
      userId: userA,
      product: 'chat',
      workspaceId: 'ws-1',
      selectedSkillIds: ['skill-builtin-1'],
    });
    assert.strictEqual(chatResult.skills.length, 1);
    assert.strictEqual(chatResult.skills[0]?.slug, 'explain-code');
  });

  it('Scenario 15: enforces maximum active Skill count and instruction token budget', async () => {
    // Add 4 skills
    for (let i = 1; i <= 4; i++) {
      const id = `skill-batch-${i}`;
      storage.addSkill({
        id,
        ownerId: null,
        slug: `skill-${i}`,
        title: `Skill ${i}`,
        description: `Description ${i}`,
        visibility: 'built_in',
        supportedProducts: ['chat'],
        createdAt: '2026-10-13T00:00:00Z',
      });
      storage.addVersion({
        id: `version-batch-${i}`,
        skillId: id,
        versionNumber: 1,
        contentHash: `hash-${i}`,
        instructions: `Instruction for skill ${i}`,
        createdAt: '2026-10-13T00:00:00Z',
      });
      storage.addInstallation({
        id: `inst-batch-${i}`,
        userId: userA,
        skillId: id,
        selectedVersionId: `version-batch-${i}`,
        enabled: true,
        installedAt: '2026-10-13T00:00:00Z',
      });
    }

    // Attempting 4 active skills (> max 3) throws SKILL_BUDGET_EXCEEDED
    await assert.rejects(
      async () =>
        resolver.resolveSkills({
          userId: userA,
          product: 'chat',
          selectedSkillIds: ['skill-batch-1', 'skill-batch-2', 'skill-batch-3', 'skill-batch-4'],
        }),
      (err: Error) =>
        err instanceof SkillResolutionError &&
        err.code === 'SKILL_BUDGET_EXCEEDED' &&
        /Maximum 3 active skills allowed/i.test(err.message)
    );

    // Test token budget limit (> 2000 tokens)
    const bigInstructions = 'Word '.repeat(2500); // ~12,500 chars -> > 3000 tokens
    storage.addSkill({
      id: 'skill-oversized-tokens',
      ownerId: null,
      slug: 'oversized-tokens',
      title: 'Oversized Tokens',
      description: 'Desc',
      visibility: 'built_in',
      supportedProducts: ['chat'],
      createdAt: '2026-10-13T00:00:00Z',
    });
    storage.addVersion({
      id: 'version-oversized-tokens',
      skillId: 'skill-oversized-tokens',
      versionNumber: 1,
      contentHash: 'hash-big',
      instructions: bigInstructions,
      createdAt: '2026-10-13T00:00:00Z',
    });
    storage.addInstallation({
      id: 'inst-oversized',
      userId: userA,
      skillId: 'skill-oversized-tokens',
      selectedVersionId: 'version-oversized-tokens',
      enabled: true,
      installedAt: '2026-10-13T00:00:00Z',
    });

    await assert.rejects(
      async () =>
        resolver.resolveSkills({
          userId: userA,
          product: 'chat',
          selectedSkillIds: ['skill-oversized-tokens'],
        }),
      (err: Error) =>
        err instanceof SkillResolutionError &&
        err.code === 'SKILL_BUDGET_EXCEEDED' &&
        /Total skill instruction budget exceeded/i.test(err.message)
    );
  });

  it('Scenario 20: no automatic activation without explicit configuration', async () => {
    // User has installed skills, but passes empty selectedSkillIds and no workspace defaults
    storage.addInstallation({
      id: 'inst-1',
      userId: userA,
      skillId: 'skill-builtin-1',
      selectedVersionId: 'version-builtin-v1',
      enabled: true,
      installedAt: '2026-10-13T00:00:00Z',
    });

    const result = await resolver.resolveSkills({
      userId: userA,
      product: 'chat',
      selectedSkillIds: [],
    });

    assert.strictEqual(result.skills.length, 0);
    assert.strictEqual(result.totalEstimatedTokens, 0);
  });
});
