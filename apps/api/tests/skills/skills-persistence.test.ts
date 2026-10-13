import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, type TestDbInstance } from '../test-db-helper.js';
import { UserRepository } from '../../src/db/repositories/user-repository.js';
import { runMigrations, getAppliedMigrationVersions } from '../../src/db/migrate.js';
import {
  PostgresSkillStorage,
  PostgresUserPreferencesStorage,
} from '../../src/modules/skills/index.js';
import { SkillResolver } from '../../src/modules/skills/resolver.js';
import {
  SkillConflictError,
  SkillResolutionError,
  SkillValidationError,
} from '../../src/modules/skills/types.js';
import { computeDeterministicHash } from '../../src/modules/skills/parser.js';

describe('Skills PostgreSQL Persistence — Integration Tests', () => {
  let testDb: TestDbInstance;
  let userRepo: UserRepository;
  let skillStorage: PostgresSkillStorage;
  let prefsStorage: PostgresUserPreferencesStorage;

  let userAId: string;
  let userBId: string;

  before(async () => {
    testDb = await createTestDatabase();
    userRepo = new UserRepository(testDb.pool);
    skillStorage = new PostgresSkillStorage(testDb.pool);
    prefsStorage = new PostgresUserPreferencesStorage(testDb.pool);
  });

  beforeEach(async () => {
    await testDb.cleanup();

    const uniqueTag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const userA = await userRepo.createUser({
      email: `user-a-${uniqueTag}@example.com`,
      displayName: 'User A',
      passwordHash: 'hash_a',
    });
    userAId = userA.id;

    const userB = await userRepo.createUser({
      email: `user-b-${uniqueTag}@example.com`,
      displayName: 'User B',
      passwordHash: 'hash_b',
    });
    userBId = userB.id;
  });

  after(async () => {
    await testDb.cleanup();
    await testDb.pool.end();
  });

  it('Migration idempotency: verifies migration 003 is applied and repeatable', async () => {
    const versions = await getAppliedMigrationVersions(testDb.pool);
    assert.ok(versions.has(1), 'Migration 001 applied');
    assert.ok(versions.has(3), 'Migration 003 applied');

    // Second run must be idempotent (0 pending migrations)
    const secondRun = await runMigrations(testDb.pool);
    assert.strictEqual(secondRun.length, 0);
  });

  it('Built-in and Private Skills: persists and enforces tenant isolation on ID lookup', async () => {
    // 1. Create a built-in skill (ownerId: null)
    const builtinSkill = await skillStorage.createSkill({
      ownerId: null,
      slug: 'builtin-explainer',
      title: 'Built-in Explainer',
      description: 'Public built-in explanation skill',
      visibility: 'built_in',
      supportedProducts: ['chat', 'agent'],
    });
    assert.strictEqual(builtinSkill.visibility, 'built_in');
    assert.strictEqual(builtinSkill.ownerId, null);

    // 2. Create a private skill owned by User A
    const privateSkillA = await skillStorage.createSkill({
      ownerId: userAId,
      slug: 'private-qa-runner',
      title: 'Private QA Runner',
      description: 'Private team QA workflow for User A',
      visibility: 'private',
      supportedProducts: ['chat', 'agent'],
    });
    assert.strictEqual(privateSkillA.visibility, 'private');
    assert.strictEqual(privateSkillA.ownerId, userAId);

    // 3. User A can retrieve their own private skill
    const retrievedByA = await skillStorage.getSkill(privateSkillA.id, userAId);
    assert.ok(retrievedByA);
    assert.strictEqual(retrievedByA.id, privateSkillA.id);

    // 4. User B CANNOT retrieve User A's private skill (fails closed to null, no disclosure)
    const retrievedByB = await skillStorage.getSkill(privateSkillA.id, userBId);
    assert.strictEqual(retrievedByB, null);

    // 5. Unauthenticated viewer CANNOT retrieve User A's private skill
    const retrievedAnon = await skillStorage.getSkill(privateSkillA.id);
    assert.strictEqual(retrievedAnon, null);

    // 6. Any user can retrieve built-in skill
    const builtinByA = await skillStorage.getSkill(builtinSkill.id, userAId);
    const builtinByB = await skillStorage.getSkill(builtinSkill.id, userBId);
    assert.ok(builtinByA);
    assert.ok(builtinByB);
    assert.strictEqual(builtinByA.id, builtinSkill.id);
    assert.strictEqual(builtinByB.id, builtinSkill.id);
  });

  it('Slug collision precedence: private skill shadows built-in skill for owner', async () => {
    // Create built-in skill with slug "formatter"
    const builtinFormatter = await skillStorage.createSkill({
      ownerId: null,
      slug: 'formatter',
      title: 'Global Formatter',
      description: 'Default platform code formatter',
      visibility: 'built_in',
      supportedProducts: ['chat', 'agent'],
    });

    // User A creates a private skill with the identical slug "formatter"
    const privateFormatterA = await skillStorage.createSkill({
      ownerId: userAId,
      slug: 'formatter',
      title: "User A's Custom Formatter",
      description: 'Team specific formatting rules',
      visibility: 'private',
      supportedProducts: ['chat', 'agent'],
    });

    // 1. User A queries "formatter": gets their private skill (takes precedence)
    const matchForA = await skillStorage.getSkillBySlug('formatter', userAId);
    assert.ok(matchForA);
    assert.strictEqual(matchForA.id, privateFormatterA.id);
    assert.strictEqual(matchForA.title, "User A's Custom Formatter");

    // 2. User B queries "formatter": gets the built-in skill (User A's private skill is shadowed)
    const matchForB = await skillStorage.getSkillBySlug('formatter', userBId);
    assert.ok(matchForB);
    assert.strictEqual(matchForB.id, builtinFormatter.id);
    assert.strictEqual(matchForB.title, 'Global Formatter');

    // 3. Unauthenticated query: gets built-in skill
    const matchAnon = await skillStorage.getSkillBySlug('formatter');
    assert.ok(matchAnon);
    assert.strictEqual(matchAnon.id, builtinFormatter.id);
  });

  it('Immutable versions: enforces version ordering and rejects duplicate version mutations', async () => {
    const skill = await skillStorage.createSkill({
      ownerId: null,
      slug: 'versioned-skill',
      title: 'Versioned Skill',
      description: 'Testing immutable version history',
      visibility: 'built_in',
      supportedProducts: ['chat', 'agent'],
    });

    const hash1 = computeDeterministicHash('Instructions version 1');
    const v1 = await skillStorage.createVersion({
      skillId: skill.id,
      versionNumber: 1,
      contentHash: hash1,
      instructions: 'Instructions version 1',
    });

    const hash2 = computeDeterministicHash('Instructions version 2');
    const v2 = await skillStorage.createVersion({
      skillId: skill.id,
      versionNumber: 2,
      contentHash: hash2,
      instructions: 'Instructions version 2',
    });

    // getSkillVersion by ID
    const retrievedV1 = await skillStorage.getSkillVersion(v1.id);
    assert.ok(retrievedV1);
    assert.strictEqual(retrievedV1.versionNumber, 1);
    assert.strictEqual(retrievedV1.contentHash, hash1);

    // getLatestSkillVersion returns highest version number
    const latest = await skillStorage.getLatestSkillVersion(skill.id);
    assert.ok(latest);
    assert.strictEqual(latest.id, v2.id);
    assert.strictEqual(latest.versionNumber, 2);

    // Immutability: attempting to insert version 1 again for the same skill throws conflict
    await assert.rejects(
      async () =>
        skillStorage.createVersion({
          skillId: skill.id,
          versionNumber: 1,
          contentHash: hash1,
          instructions: 'Mutated instructions attempt',
        }),
      (err: Error) =>
        err instanceof SkillConflictError &&
        /already exists and is immutable/i.test(err.message)
    );
  });

  it('Foreign key integrity & Version mismatch: rejects installation referencing mismatched version', async () => {
    const skillA = await skillStorage.createSkill({
      ownerId: null,
      slug: 'skill-alpha',
      title: 'Skill Alpha',
      description: 'First skill',
      visibility: 'built_in',
      supportedProducts: ['chat', 'agent'],
    });
    const vA = await skillStorage.createVersion({
      skillId: skillA.id,
      versionNumber: 1,
      contentHash: computeDeterministicHash('Alpha v1'),
      instructions: 'Alpha v1',
    });

    const skillB = await skillStorage.createSkill({
      ownerId: null,
      slug: 'skill-beta',
      title: 'Skill Beta',
      description: 'Second skill',
      visibility: 'built_in',
      supportedProducts: ['chat', 'agent'],
    });
    const vB = await skillStorage.createVersion({
      skillId: skillB.id,
      versionNumber: 1,
      contentHash: computeDeterministicHash('Beta v1'),
      instructions: 'Beta v1',
    });

    // 1. Valid installation of Skill A with Version A
    const installA = await skillStorage.createInstallation({
      userId: userAId,
      skillId: skillA.id,
      selectedVersionId: vA.id,
      enabled: true,
    });
    assert.strictEqual(installA.skillId, skillA.id);
    assert.strictEqual(installA.selectedVersionId, vA.id);

    // 2. Database rejects installing Skill A with Version B (Version B belongs to Skill B!)
    await assert.rejects(
      async () =>
        skillStorage.createInstallation({
          userId: userBId,
          skillId: skillA.id,
          selectedVersionId: vB.id, // Mismatched foreign version!
          enabled: true,
        }),
      (err: Error) =>
        err instanceof SkillResolutionError &&
        err.code === 'SKILL_NOT_FOUND' &&
        /does not belong to skill/i.test(err.message)
    );

    // 3. Database rejects updating installation of Skill A to Version B
    await assert.rejects(
      async () => skillStorage.setInstallationVersion(userAId, skillA.id, vB.id),
      (err: Error) =>
        err instanceof SkillResolutionError &&
        err.code === 'SKILL_NOT_FOUND' &&
        /does not belong to skill/i.test(err.message)
    );
  });

  it('Cross-tenant installation: prevents User B from installing User A private skill', async () => {
    const privateSkillA = await skillStorage.createSkill({
      ownerId: userAId,
      slug: 'internal-secret-workflow',
      title: 'Internal Secret Workflow',
      description: 'Confidential workflow',
      visibility: 'private',
      supportedProducts: ['chat', 'agent'],
    });
    const vA = await skillStorage.createVersion({
      skillId: privateSkillA.id,
      versionNumber: 1,
      contentHash: computeDeterministicHash('Secret instructions'),
      instructions: 'Secret instructions',
    });

    // User B attempts to install User A's private skill
    await assert.rejects(
      async () =>
        skillStorage.createInstallation({
          userId: userBId,
          skillId: privateSkillA.id,
          selectedVersionId: vA.id,
          enabled: true,
        }),
      (err: Error) =>
        err instanceof SkillResolutionError &&
        err.code === 'SKILL_NOT_FOUND' &&
        /was not found/i.test(err.message)
    );
  });

  it('Installation enablement toggle: enables, disables, and checks state', async () => {
    const skill = await skillStorage.createSkill({
      ownerId: null,
      slug: 'toggle-skill',
      title: 'Toggle Skill',
      description: 'Testing enablement toggle',
      visibility: 'built_in',
      supportedProducts: ['chat', 'agent'],
    });
    const ver = await skillStorage.createVersion({
      skillId: skill.id,
      versionNumber: 1,
      contentHash: computeDeterministicHash('Instructions toggle'),
      instructions: 'Instructions toggle',
    });

    await skillStorage.createInstallation({
      userId: userAId,
      skillId: skill.id,
      selectedVersionId: ver.id,
      enabled: true,
    });

    // Disable
    const disabled = await skillStorage.setInstallationEnabled(userAId, skill.id, false);
    assert.ok(disabled);
    assert.strictEqual(disabled.enabled, false);

    const fetchedDisabled = await skillStorage.getInstallation(userAId, skill.id);
    assert.ok(fetchedDisabled);
    assert.strictEqual(fetchedDisabled.enabled, false);

    // Re-enable
    const reEnabled = await skillStorage.setInstallationEnabled(userAId, skill.id, true);
    assert.ok(reEnabled);
    assert.strictEqual(reEnabled.enabled, true);
  });

  it('End-to-end integration: SkillResolver resolves skills from PostgresSkillStorage', async () => {
    const resolver = new SkillResolver(skillStorage);

    const skill = await skillStorage.createSkill({
      ownerId: null,
      slug: 'e2e-pg-skill',
      title: 'E2E Postgres Skill',
      description: 'End-to-end resolution testing with real DB storage',
      visibility: 'built_in',
      supportedProducts: ['chat', 'agent'],
    });
    const ver = await skillStorage.createVersion({
      skillId: skill.id,
      versionNumber: 1,
      contentHash: computeDeterministicHash('Solve problems step by step.'),
      instructions: 'Solve problems step by step.',
    });

    await skillStorage.createInstallation({
      userId: userAId,
      skillId: skill.id,
      selectedVersionId: ver.id,
      enabled: true,
    });

    // 1. Resolve successfully
    const result = await resolver.resolveSkills({
      userId: userAId,
      product: 'chat',
      selectedSkillIds: [skill.id],
    });
    assert.strictEqual(result.skills.length, 1);
    assert.strictEqual(result.skills[0]?.slug, 'e2e-pg-skill');
    assert.strictEqual(result.skills[0]?.versionId, ver.id);
    assert.strictEqual(result.skills[0]?.instructions, 'Solve problems step by step.');

    // 2. Disable skill -> resolution fails closed with SKILL_DISABLED
    await skillStorage.setInstallationEnabled(userAId, skill.id, false);
    await assert.rejects(
      async () =>
        resolver.resolveSkills({
          userId: userAId,
          product: 'chat',
          selectedSkillIds: [skill.id],
        }),
      (err: Error) =>
        err instanceof SkillResolutionError &&
        err.code === 'SKILL_DISABLED'
    );
  });

  it('User preferences: persists preferences with optimistic concurrency control (OCC)', async () => {
    // 1. Initial save creates revision 1
    const initial = await prefsStorage.savePreferences(userAId, {
      preferredLanguage: 'Vietnamese',
      responseLength: 'concise',
      responseStyle: 'technical',
      customInstructions: 'Prefer functional programming examples.',
    });
    assert.strictEqual(initial.revision, 1);
    assert.strictEqual(initial.preferredLanguage, 'Vietnamese');
    assert.strictEqual(initial.responseLength, 'concise');
    assert.strictEqual(initial.responseStyle, 'technical');
    assert.strictEqual(initial.customInstructions, 'Prefer functional programming examples.');

    // 2. Retrieve preferences
    const retrieved = await prefsStorage.getPreferences(userAId);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.revision, 1);
    assert.strictEqual(retrieved.preferredLanguage, 'Vietnamese');

    // 3. Update with expectedRevision = 1 increments revision to 2
    const updated = await prefsStorage.savePreferences(
      userAId,
      {
        preferredLanguage: 'English',
        responseLength: 'detailed',
        responseStyle: 'professional',
        customInstructions: 'Updated instructions.',
      },
      1 // Expected revision matches current
    );
    assert.strictEqual(updated.revision, 2);
    assert.strictEqual(updated.preferredLanguage, 'English');

    // 4. Stale update: attempting update with stale expectedRevision = 1 throws conflict
    await assert.rejects(
      async () =>
        prefsStorage.savePreferences(
          userAId,
          {
            preferredLanguage: 'Japanese',
          },
          1 // Stale revision! Current is 2
        ),
      (err: Error) =>
        err instanceof SkillConflictError &&
        /Revision conflict/i.test(err.message)
    );

    // 5. Validation limits: customInstructions > 2000 chars rejected
    await assert.rejects(
      async () =>
        prefsStorage.savePreferences(userAId, {
          customInstructions: 'X'.repeat(2001),
        }),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_OVERSIZED'
    );

    // 6. Validation limits: invalid responseLength rejected
    await assert.rejects(
      async () =>
        prefsStorage.savePreferences(userAId, {
          responseLength: 'super-long' as any,
        }),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_VALIDATION_ERROR'
    );
  });

  it('Workspace defaults: persists and retrieves agent workspace default activations', async () => {
    const wsId = '00000000-0000-0000-0000-000000000099';

    const skill1 = await skillStorage.createSkill({
      ownerId: null,
      slug: 'ws-skill-1',
      title: 'Workspace Skill 1',
      description: 'First default skill',
      visibility: 'built_in',
      supportedProducts: ['agent'],
    });

    const skill2 = await skillStorage.createSkill({
      ownerId: null,
      slug: 'ws-skill-2',
      title: 'Workspace Skill 2',
      description: 'Second default skill',
      visibility: 'built_in',
      supportedProducts: ['agent'],
    });

    // Set defaults for User A
    await skillStorage.setWorkspaceDefaults(wsId, userAId, [
      { workspaceId: wsId, ownerId: userAId, skillId: skill1.id, position: 1, enabled: true },
      { workspaceId: wsId, ownerId: userAId, skillId: skill2.id, position: 2, enabled: true },
    ]);

    // Query defaults for User A
    const defaultsA = await skillStorage.getWorkspaceDefaults(wsId, userAId);
    assert.strictEqual(defaultsA.length, 2);
    assert.strictEqual(defaultsA[0]?.skillId, skill1.id);
    assert.strictEqual(defaultsA[1]?.skillId, skill2.id);

    // Query defaults for User B on same workspace returns empty (owner-scoped)
    const defaultsB = await skillStorage.getWorkspaceDefaults(wsId, userBId);
    assert.strictEqual(defaultsB.length, 0);
  });
});
