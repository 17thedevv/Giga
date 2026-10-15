import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, type TestDbInstance } from '../test-db-helper.js';
import { UserRepository } from '../../src/db/repositories/user-repository.js';
import { runMigrations, getAppliedMigrationVersions, MIGRATIONS, type Migration } from '../../src/db/migrate.js';
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
      actor: { isAdmin: true },
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
      actor: { userId: userAId },
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
      actor: { isAdmin: true },
    });

    // User A creates a private skill with the identical slug "formatter"
    const privateFormatterA = await skillStorage.createSkill({
      ownerId: userAId,
      slug: 'formatter',
      title: "User A's Custom Formatter",
      description: 'Team specific formatting rules',
      visibility: 'private',
      supportedProducts: ['chat', 'agent'],
      actor: { userId: userAId },
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
      actor: { isAdmin: true },
    });

    const hash1 = computeDeterministicHash('Instructions version 1');
    const v1 = await skillStorage.createVersion({
      skillId: skill.id,
      versionNumber: 1,
      contentHash: hash1,
      instructions: 'Instructions version 1',
      actor: { isAdmin: true },
    });

    const hash2 = computeDeterministicHash('Instructions version 2');
    const v2 = await skillStorage.createVersion({
      skillId: skill.id,
      versionNumber: 2,
      contentHash: hash2,
      instructions: 'Instructions version 2',
      actor: { isAdmin: true },
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
          instructions: 'Mutated instructions attempt',
          actor: { isAdmin: true },
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
      actor: { isAdmin: true },
    });
    const vA = await skillStorage.createVersion({
      skillId: skillA.id,
      versionNumber: 1,
      contentHash: computeDeterministicHash('Alpha v1'),
      instructions: 'Alpha v1',
      actor: { isAdmin: true },
    });

    const skillB = await skillStorage.createSkill({
      ownerId: null,
      slug: 'skill-beta',
      title: 'Skill Beta',
      description: 'Second skill',
      visibility: 'built_in',
      supportedProducts: ['chat', 'agent'],
      actor: { isAdmin: true },
    });
    const vB = await skillStorage.createVersion({
      skillId: skillB.id,
      versionNumber: 1,
      contentHash: computeDeterministicHash('Beta v1'),
      instructions: 'Beta v1',
      actor: { isAdmin: true },
    });

    // 1. Valid installation of Skill A with Version A
    const installA = await skillStorage.createInstallation({
      userId: userAId,
      skillId: skillA.id,
      selectedVersionId: vA.id,
      enabled: true,
      actor: { userId: userAId },
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
          actor: { userId: userBId },
        }),
      (err: Error) =>
        err instanceof SkillResolutionError &&
        err.code === 'SKILL_NOT_FOUND' &&
        /does not belong to skill/i.test(err.message)
    );

    // 3. Database rejects updating installation of Skill A to Version B
    await assert.rejects(
      async () => skillStorage.setInstallationVersion(userAId, skillA.id, vB.id, { userId: userAId }),
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
      actor: { userId: userAId },
    });
    const vA = await skillStorage.createVersion({
      skillId: privateSkillA.id,
      versionNumber: 1,
      contentHash: computeDeterministicHash('Secret instructions'),
      instructions: 'Secret instructions',
      actor: { userId: userAId },
    });

    // User B attempts to install User A's private skill
    await assert.rejects(
      async () =>
        skillStorage.createInstallation({
          userId: userBId,
          skillId: privateSkillA.id,
          selectedVersionId: vA.id,
          enabled: true,
          actor: { userId: userBId },
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
      actor: { isAdmin: true },
    });
    const ver = await skillStorage.createVersion({
      skillId: skill.id,
      versionNumber: 1,
      contentHash: computeDeterministicHash('Instructions toggle'),
      instructions: 'Instructions toggle',
      actor: { isAdmin: true },
    });

    await skillStorage.createInstallation({
      userId: userAId,
      skillId: skill.id,
      selectedVersionId: ver.id,
      enabled: true,
      actor: { userId: userAId },
    });

    // Disable
    const disabled = await skillStorage.setInstallationEnabled(userAId, skill.id, false, { userId: userAId });
    assert.ok(disabled);
    assert.strictEqual(disabled.enabled, false);

    const fetchedDisabled = await skillStorage.getInstallation(userAId, skill.id);
    assert.ok(fetchedDisabled);
    assert.strictEqual(fetchedDisabled.enabled, false);

    // Re-enable
    const reEnabled = await skillStorage.setInstallationEnabled(userAId, skill.id, true, { userId: userAId });
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
      actor: { isAdmin: true },
    });
    const ver = await skillStorage.createVersion({
      skillId: skill.id,
      versionNumber: 1,
      contentHash: computeDeterministicHash('Solve problems step by step.'),
      instructions: 'Solve problems step by step.',
      actor: { isAdmin: true },
    });

    await skillStorage.createInstallation({
      userId: userAId,
      skillId: skill.id,
      selectedVersionId: ver.id,
      enabled: true,
      actor: { userId: userAId },
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
    await skillStorage.setInstallationEnabled(userAId, skill.id, false, { userId: userAId });
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

  it('Workspace defaults: validates deferral until 17T-24 Agent Workspace schema is implemented', async () => {
    const wsId = '00000000-0000-0000-0000-000000000099';

    // 1. Querying workspace defaults returns empty array without error
    const defaults = await skillStorage.getWorkspaceDefaults(wsId, userAId);
    assert.deepStrictEqual(defaults, []);

    // 2. Attempting to set defaults explicitly throws deferral error rather than accepting dangling workspace IDs
    await assert.rejects(
      async () =>
        skillStorage.setWorkspaceDefaults(wsId, userAId, [
          { workspaceId: wsId, ownerId: userAId, skillId: '00000000-0000-0000-0000-000000000001', position: 1, enabled: true },
        ]),
      (err: Error) =>
        /deferred until 17T-24 Agent Workspace/i.test(err.message)
    );
  });

  it('Database-level Immutability: directly rejects SQL UPDATE on skill_versions', async () => {
    const skill = await skillStorage.createSkill({
      ownerId: null,
      slug: 'immutable-sql-test',
      title: 'Immutable SQL Test',
      description: 'Testing trigger/DB immutability',
      visibility: 'built_in',
      supportedProducts: ['chat', 'agent'],
      actor: { isAdmin: true },
    });

    const originalInstructions = 'Strictly original instruction text';
    const version = await skillStorage.createVersion({
      skillId: skill.id,
      versionNumber: 1,
      instructions: originalInstructions,
      actor: { isAdmin: true },
    });

    // Attempt direct SQL UPDATE on skill_versions
    await assert.rejects(
      async () =>
        testDb.pool.query(
          'UPDATE skill_versions SET instructions = $1 WHERE id = $2;',
          ['Maliciously updated instruction text', version.id]
        ),
      (err: Error) =>
        /immutable|cannot be updated/i.test(err.message)
    );

    // Verify row was NOT mutated
    const currentVersion = await skillStorage.getSkillVersion(version.id);
    assert.ok(currentVersion);
    assert.strictEqual(currentVersion.instructions, originalInstructions);
  });

  it('Content Hash Verification: enforces that contentHash matches deterministic instruction hash', async () => {
    const skill = await skillStorage.createSkill({
      ownerId: null,
      slug: 'hash-verification-test',
      title: 'Hash Verification Test',
      description: 'Testing content hash validation',
      visibility: 'built_in',
      supportedProducts: ['chat', 'agent'],
      actor: { isAdmin: true },
    });

    const instructions = 'Instructions for deterministic hash test';
    const expectedHash = computeDeterministicHash(instructions);
    const forgedHash = 'e'.repeat(64);

    // 1. Rejects mismatched forged content hash
    await assert.rejects(
      async () =>
        skillStorage.createVersion({
          skillId: skill.id,
          versionNumber: 1,
          contentHash: forgedHash,
          instructions,
          actor: { isAdmin: true },
        }),
      (err: Error) =>
        err instanceof SkillValidationError &&
        /does not match deterministic instruction hash/i.test(err.message)
    );

    // 2. Succeeds when contentHash matches expectedHash
    const validWithHash = await skillStorage.createVersion({
      skillId: skill.id,
      versionNumber: 1,
      contentHash: expectedHash,
      instructions,
      actor: { isAdmin: true },
    });
    assert.strictEqual(validWithHash.contentHash, expectedHash);

    // 3. Automatically computes deterministic hash when contentHash is omitted
    const instructionsV2 = 'Instructions version 2';
    const validOmittedHash = await skillStorage.createVersion({
      skillId: skill.id,
      versionNumber: 2,
      instructions: instructionsV2,
      actor: { isAdmin: true },
    });
    assert.strictEqual(validOmittedHash.contentHash, computeDeterministicHash(instructionsV2));
  });

  it('Publication Authorization: enforces boundaries for built-in and private skills', async () => {
    // 0a. Missing actor rejects createSkill with SKILL_UNAUTHORIZED
    await assert.rejects(
      async () =>
        // @ts-expect-error Testing missing actor runtime validation
        skillStorage.createSkill({
          ownerId: null,
          slug: 'unauthorized-no-actor',
          title: 'Unauthorized No Actor',
          description: 'Testing missing actor context',
          visibility: 'built_in',
          supportedProducts: ['chat'],
        }),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_UNAUTHORIZED' &&
        /Actor authorization context is required to create a skill/i.test(err.message)
    );

    // 1. Non-admin user cannot create built-in skill
    await assert.rejects(
      async () =>
        skillStorage.createSkill({
          ownerId: null,
          slug: 'unauthorized-builtin',
          title: 'Unauthorized Built-in',
          description: 'Ordinary user trying to publish built-in skill',
          visibility: 'built_in',
          supportedProducts: ['chat'],
          actor: { userId: userAId, isAdmin: false },
        }),
      (err: Error) =>
        err instanceof SkillValidationError &&
        /Only system administrators can publish built-in skills/i.test(err.message)
    );

    // 2. System/admin CAN create built-in skill
    const adminBuiltin = await skillStorage.createSkill({
      ownerId: null,
      slug: 'authorized-admin-builtin',
      title: 'Authorized Admin Built-in',
      description: 'Admin published built-in skill',
      visibility: 'built_in',
      supportedProducts: ['chat'],
      actor: { isAdmin: true },
    });
    assert.strictEqual(adminBuiltin.visibility, 'built_in');

    // 3. User cannot create private skill for another owner
    await assert.rejects(
      async () =>
        skillStorage.createSkill({
          ownerId: userBId, // attempting to create for userB
          slug: 'forged-owner-skill',
          title: 'Forged Owner Skill',
          description: 'User A attempting to create skill owned by User B',
          visibility: 'private',
          supportedProducts: ['chat'],
          actor: { userId: userAId, isAdmin: false },
        }),
      (err: Error) =>
        err instanceof SkillValidationError &&
        /Cannot create a private skill for another owner/i.test(err.message)
    );

    // 4. User A can create private skill for themselves
    const privateSkillA = await skillStorage.createSkill({
      ownerId: userAId,
      slug: 'my-private-auth-skill',
      title: 'User A Private Skill',
      description: 'Owned by User A',
      visibility: 'private',
      supportedProducts: ['chat'],
      actor: { userId: userAId },
    });
    assert.strictEqual(privateSkillA.ownerId, userAId);

    // 5a. Missing actor rejects createVersion with SKILL_UNAUTHORIZED
    await assert.rejects(
      async () =>
        // @ts-expect-error Testing missing actor runtime validation
        skillStorage.createVersion({
          skillId: privateSkillA.id,
          versionNumber: 1,
          instructions: 'Testing missing actor on version',
        }),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_UNAUTHORIZED' &&
        /Actor authorization context is required to publish a skill version/i.test(err.message)
    );

    // 5b. User B CANNOT publish new version for User A's private skill
    await assert.rejects(
      async () =>
        skillStorage.createVersion({
          skillId: privateSkillA.id,
          versionNumber: 1,
          instructions: 'Attacker trying to add version to another user skill',
          actor: { userId: userBId, isAdmin: false },
        }),
      (err: Error) =>
        err instanceof SkillValidationError &&
        /Only the skill owner can publish versions/i.test(err.message)
    );

    // 6. User A CAN publish version for their own private skill
    const versionA = await skillStorage.createVersion({
      skillId: privateSkillA.id,
      versionNumber: 1,
      instructions: 'Owner User A version 1',
      actor: { userId: userAId },
    });
    assert.strictEqual(versionA.versionNumber, 1);

    // 7a. Missing actor on createInstallation rejects with SKILL_UNAUTHORIZED
    await assert.rejects(
      async () =>
        // @ts-expect-error Testing missing actor runtime validation
        skillStorage.createInstallation({
          userId: userAId,
          skillId: privateSkillA.id,
          selectedVersionId: versionA.id,
        }),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_UNAUTHORIZED' &&
        /Actor authorization context is required to install a skill/i.test(err.message)
    );

    // 7b. Forged actor on createInstallation rejects
    await assert.rejects(
      async () =>
        skillStorage.createInstallation({
          userId: userAId,
          skillId: privateSkillA.id,
          selectedVersionId: versionA.id,
          actor: { userId: userBId, isAdmin: false },
        }),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_UNAUTHORIZED' &&
        /Cannot install skill for another user/i.test(err.message)
    );

    // Valid installation for User A
    const validInstallA = await skillStorage.createInstallation({
      userId: userAId,
      skillId: privateSkillA.id,
      selectedVersionId: versionA.id,
      actor: { userId: userAId },
    });
    assert.strictEqual(validInstallA.userId, userAId);

    // 7c. Missing actor on setInstallationEnabled rejects
    await assert.rejects(
      async () =>
        // @ts-expect-error Testing missing actor runtime validation
        skillStorage.setInstallationEnabled(userAId, privateSkillA.id, false),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_UNAUTHORIZED' &&
        /Actor authorization context is required to modify an installation/i.test(err.message)
    );

    // 7d. Forged actor on setInstallationEnabled rejects
    await assert.rejects(
      async () =>
        skillStorage.setInstallationEnabled(userAId, privateSkillA.id, false, { userId: userBId, isAdmin: false }),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_UNAUTHORIZED' &&
        /Cannot modify installation for another user/i.test(err.message)
    );

    // 7e. Missing actor on setInstallationVersion rejects
    await assert.rejects(
      async () =>
        // @ts-expect-error Testing missing actor runtime validation
        skillStorage.setInstallationVersion(userAId, privateSkillA.id, versionA.id),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_UNAUTHORIZED' &&
        /Actor authorization context is required to modify an installation/i.test(err.message)
    );

    // 7f. Forged actor on setInstallationVersion rejects
    await assert.rejects(
      async () =>
        skillStorage.setInstallationVersion(userAId, privateSkillA.id, versionA.id, { userId: userBId, isAdmin: false }),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_UNAUTHORIZED' &&
        /Cannot modify installation for another user/i.test(err.message)
    );

    // 7g. Admin CAN update installation for another user
    const adminToggled = await skillStorage.setInstallationEnabled(userAId, privateSkillA.id, false, { isAdmin: true });
    assert.ok(adminToggled);
    assert.strictEqual(adminToggled.enabled, false);
  });

  it('Version Tenant Isolation: getSkillVersion and getLatestSkillVersion enforce viewer authorization', async () => {
    // 1. Create a private skill with versions owned by User A
    const privateSkill = await skillStorage.createSkill({
      ownerId: userAId,
      slug: 'version-isolation-skill',
      title: 'Version Isolation Skill',
      description: 'Testing version viewer scoping',
      visibility: 'private',
      supportedProducts: ['chat', 'agent'],
      actor: { userId: userAId },
    });

    const v1 = await skillStorage.createVersion({
      skillId: privateSkill.id,
      versionNumber: 1,
      instructions: 'Private instructions v1',
      actor: { userId: userAId },
    });
    const v2 = await skillStorage.createVersion({
      skillId: privateSkill.id,
      versionNumber: 2,
      instructions: 'Private instructions v2',
      actor: { userId: userAId },
    });

    // 2. Owner User A can access specific version and latest version
    const retrievedByOwner = await skillStorage.getSkillVersion(v1.id, userAId);
    assert.ok(retrievedByOwner);
    assert.strictEqual(retrievedByOwner.id, v1.id);

    const latestByOwner = await skillStorage.getLatestSkillVersion(privateSkill.id, userAId);
    assert.ok(latestByOwner);
    assert.strictEqual(latestByOwner.id, v2.id);

    // 3. User B (cross-tenant) CANNOT access User A's private versions (fails closed to null)
    const retrievedByAttacker = await skillStorage.getSkillVersion(v1.id, userBId);
    assert.strictEqual(retrievedByAttacker, null);

    const latestByAttacker = await skillStorage.getLatestSkillVersion(privateSkill.id, userBId);
    assert.strictEqual(latestByAttacker, null);

    // 4. Unauthenticated viewer CANNOT access User A's private versions
    const retrievedAnon = await skillStorage.getSkillVersion(v1.id);
    assert.strictEqual(retrievedAnon, null);

    const latestAnon = await skillStorage.getLatestSkillVersion(privateSkill.id);
    assert.strictEqual(latestAnon, null);
  });

  it('Migration coordination: safely handles simulated out-of-order migration 002 runner registration', async () => {
    // Exercise late registration without leaving later migrations' foreign keys detached.
    const migration002Conversations: Migration = {
      version: 2,
      name: '002_conversations_and_messages',
      sql: `
        CREATE TABLE IF NOT EXISTS conversations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title VARCHAR(255) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations (user_id);

        CREATE TABLE IF NOT EXISTS messages (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            role VARCHAR(50) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
            content TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages (conversation_id);
      `,
    };

    const mig1 = MIGRATIONS.find((m) => m.version === 1);
    const mig3 = MIGRATIONS.find((m) => m.version === 3);
    const mig4 = MIGRATIONS.find((m) => m.version === 4);
    assert.ok(mig1 && mig3 && mig4, 'Canonical migrations 1, 3, and 4 must exist');

    const testSkill = await skillStorage.createSkill({
      ownerId: userAId,
      slug: 'coord-test-skill',
      title: 'Coordination Test Skill',
      description: 'Testing migration coordination',
      visibility: 'private',
      supportedProducts: ['chat'],
      actor: { userId: userAId },
    });

    // 0. Ensure version 2 is unapplied initially to simulate late arrival after 1 and 3
    await testDb.pool.query('DROP TABLE IF EXISTS chat_turn_selections;');
    await testDb.pool.query('DROP TABLE IF EXISTS chat_generations;');
    if (testDb.isMemory) {
      // pg-mem leaves index names behind after DROP TABLE.
      await testDb.pool.query('DROP INDEX IF EXISTS chat_generations_pkey;');
      await testDb.pool.query('DROP INDEX IF EXISTS uq_chat_owner_key;');
    }
    await testDb.pool.query('DELETE FROM schema_migrations WHERE version = 5;');
    await testDb.pool.query('DELETE FROM schema_migrations WHERE version = 6;');
    await testDb.pool.query('DELETE FROM schema_migrations WHERE version = 7;');
    await testDb.pool.query('DELETE FROM schema_migrations WHERE version = 8;');
    await testDb.pool.query('DROP TABLE IF EXISTS messages CASCADE;');
    await testDb.pool.query('DROP TABLE IF EXISTS conversations CASCADE;');
    if (testDb.isMemory) {
      // pg-mem retains indexes introduced by 007 after their tables are dropped.
      for (const index of ['chat_turn_selections_pkey', 'uq_generation_selection_scope', 'idx_chat_turn_attempts', 'uq_conversation_owner', 'uq_message_turn_scope']) {
        await testDb.pool.query(`DROP INDEX IF EXISTS ${index}`);
      }
    }
    try {
      await testDb.pool.query('DROP INDEX IF EXISTS messages_pkey;');
      await testDb.pool.query('DROP INDEX IF EXISTS conversations_pkey;');
    } catch {
      // Ignore index drop in real Postgres where CASCADE already removed it
    }
    await testDb.pool.query('DELETE FROM schema_migrations WHERE version = 2;');

    try {
      // 1. Run migrations with version 2 registered between versions 1 and 3
      const applied = await runMigrations(testDb.pool, [
        mig1, // version 1 (already applied)
        migration002Conversations, // version 2 (newly registered late arrival)
        mig3, // version 3 (already applied)
        mig4, // version 4 (already applied)
      ]);

      // Exactly version 2 should be applied; versions 1, 3, and 4 are safely skipped
      assert.strictEqual(applied.length, 1);
      assert.strictEqual(applied[0], '002_conversations_and_messages');

      // 2. Verify schema_migrations now records version 2 alongside 1, 3, and 4
      const checkVersions = await testDb.pool.query<{ version: number }>(
        'SELECT version FROM schema_migrations ORDER BY version ASC;'
      );
      const versionNumbers = checkVersions.rows.map((r) => r.version);
      assert.deepStrictEqual(versionNumbers, [1, 2, 3, 4]);

      // 3. Verify conversation and message tables function correctly with foreign keys to users(id)
      const convRes = await testDb.pool.query(
        'INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id;',
        [userAId, 'Test Out-of-Order Conversation']
      );
      const convId = convRes.rows[0]?.id;
      assert.ok(convId);

      const msgRes = await testDb.pool.query(
        'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING id;',
        [convId, 'user', 'Hello from migration 002!']
      );
      assert.ok(msgRes.rows[0]?.id);

      // 4. Verify skills tables from migration 3 remain completely intact and functional
      const skillCheck = await skillStorage.getSkillBySlug('coord-test-skill', userAId);
      assert.ok(skillCheck);
      assert.strictEqual(skillCheck.id, testSkill.id);

      // 5. Verify rerun is fully idempotent
      const rerun = await runMigrations(testDb.pool, [
        mig1,
        migration002Conversations,
        mig3,
        mig4,
      ]);
      assert.strictEqual(rerun.length, 0);
    } finally {
      // Clean up simulated 17T-21 migration tables and schema_migrations entry
      await testDb.pool.query('DROP TABLE IF EXISTS messages CASCADE;');
      await testDb.pool.query('DROP TABLE IF EXISTS conversations CASCADE;');
      try {
        await testDb.pool.query('DROP INDEX IF EXISTS messages_pkey;');
        await testDb.pool.query('DROP INDEX IF EXISTS conversations_pkey;');
      } catch {
        // Ignore index drop in real Postgres
      }
      await testDb.pool.query('DELETE FROM schema_migrations WHERE version = 2;');
      await runMigrations(testDb.pool);
    }
  });
});
