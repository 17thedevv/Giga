import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app/create-app.js';
import { createTestDatabase, type TestDbInstance } from '../test-db-helper.js';

describe('Skills and Preferences REST API Integration', () => {
  let db: TestDbInstance;
  let app: ReturnType<typeof createApp>;
  const trustedOrigin = 'http://localhost:3000';

  before(async () => {
    db = await createTestDatabase();
    app = createApp({
      pool: db.pool,
      config: {
        allowedOrigins: [trustedOrigin],
      },
    });
  });

  beforeEach(async () => {
    await db.cleanup();
  });

  after(async () => {
    await db.pool.end();
  });

  async function createTestUser(email: string, displayName = 'Test User') {
    const password = 'StrongPassword123!';
    const registerRes = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: trustedOrigin,
      },
      body: JSON.stringify({ email, password, displayName }),
    });
    assert.strictEqual(registerRes.status, 201);
    const registerData = (await registerRes.json()) as { user: { id: string } };
    const userId = registerData.user.id;

    const loginRes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: trustedOrigin,
      },
      body: JSON.stringify({ email, password }),
    });
    assert.strictEqual(loginRes.status, 200);

    const setCookie = loginRes.headers.get('set-cookie');
    assert.ok(setCookie);
    const cookieMatch = setCookie.match(/giga_session=([^;]+)/);
    assert.ok(cookieMatch && cookieMatch[1]);
    const sessionToken = cookieMatch[1];

    return {
      userId,
      token: sessionToken,
      cookie: `giga_session=${sessionToken}`,
    };
  }

  // ==========================================
  // Authentication & Security Guards
  // ==========================================
  describe('Authentication and Security Guards', () => {
    it('rejects unauthenticated requests with 401 UNAUTHENTICATED', async () => {
      const endpoints = [
        { path: '/api/v1/me/preferences', method: 'GET' },
        { path: '/api/v1/me/preferences', method: 'PATCH', body: {} },
        { path: '/api/v1/skills', method: 'GET' },
        { path: '/api/v1/skills', method: 'POST', body: { slug: 'test', title: 'Test', description: 'Description' } },
        { path: '/api/v1/skills/00000000-0000-0000-0000-000000000001', method: 'GET' },
        { path: '/api/v1/skills/00000000-0000-0000-0000-000000000001', method: 'PATCH', body: { title: 'Update' } },
        { path: '/api/v1/skills/00000000-0000-0000-0000-000000000001', method: 'DELETE' },
        { path: '/api/v1/skills/00000000-0000-0000-0000-000000000001/versions', method: 'POST', body: { instructions: '...' } },
        { path: '/api/v1/skills/00000000-0000-0000-0000-000000000001/install', method: 'POST', body: {} },
        { path: '/api/v1/skills/00000000-0000-0000-0000-000000000001/installation', method: 'PATCH', body: { enabled: false } },
      ];

      for (const ep of endpoints) {
        const res = await app.request(ep.path, {
          method: ep.method,
          headers: {
            'Content-Type': 'application/json',
            Origin: trustedOrigin,
          },
          body: ep.body ? JSON.stringify(ep.body) : undefined,
        });

        assert.strictEqual(res.status, 401, `Expected 401 for ${ep.method} ${ep.path}`);
        const data = (await res.json()) as { error: { code: string; message: string } };
        assert.strictEqual(data.error.code, 'UNAUTHENTICATED');
      }
    });

    it('rejects mutations from untrusted origins with 403 FORBIDDEN', async () => {
      const user = await createTestUser('alice@example.com');

      const res = await app.request('/api/v1/skills', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://malicious-site.com',
          Cookie: user.cookie,
        },
        body: JSON.stringify({
          slug: 'test-skill',
          title: 'Test',
          description: 'Valid skill description for CSRF test',
        }),
      });

      assert.strictEqual(res.status, 403);
      const data = (await res.json()) as { error: { code: string } };
      assert.strictEqual(data.error.code, 'FORBIDDEN');
    });
  });

  // ==========================================
  // User Preferences
  // ==========================================
  describe('User Preferences Endpoints', () => {
    it('returns default preferences when not previously configured', async () => {
      const user = await createTestUser('pref-user1@example.com');

      const res = await app.request('/api/v1/me/preferences', {
        method: 'GET',
        headers: {
          Cookie: user.cookie,
        },
      });

      assert.strictEqual(res.status, 200);
      const data = (await res.json()) as { preferences: Record<string, unknown> };
      assert.strictEqual(data.preferences.revision, 0);
      assert.strictEqual(data.preferences.responseLength, 'balanced');
      assert.strictEqual(data.preferences.responseStyle, 'professional');
      assert.strictEqual(data.preferences.customInstructions, '');
    });

    it('creates and updates preferences with optimistic concurrency control', async () => {
      const user = await createTestUser('pref-user2@example.com');

      // 1. Missing expectedRevision is rejected with 400
      const missingCas = await app.request('/api/v1/me/preferences', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: user.cookie,
        },
        body: JSON.stringify({
          preferredLanguage: 'vi',
        }),
      });
      assert.strictEqual(missingCas.status, 400);

      // 2. Non-integer or negative expectedRevision is rejected with 400
      const invalidCas = await app.request('/api/v1/me/preferences', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: user.cookie,
        },
        body: JSON.stringify({
          expectedRevision: -1,
        }),
      });
      assert.strictEqual(invalidCas.status, 400);

      // 3. Unknown or forbidden fields rejected with 400
      const forbiddenFields = await app.request('/api/v1/me/preferences', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: user.cookie,
        },
        body: JSON.stringify({
          expectedRevision: 0,
          userId: '00000000-0000-0000-0000-000000000001',
        }),
      });
      assert.strictEqual(forbiddenFields.status, 400);

      // 4. Initial PATCH to create preferences with expectedRevision: 0
      const patch1 = await app.request('/api/v1/me/preferences', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: user.cookie,
        },
        body: JSON.stringify({
          expectedRevision: 0,
          preferredLanguage: 'vi',
          responseLength: 'concise',
          responseStyle: 'technical',
          customInstructions: 'Trả lời súc tích bằng tiếng Việt.',
        }),
      });

      assert.strictEqual(patch1.status, 200);
      const data1 = (await patch1.json()) as { preferences: { revision: number; preferredLanguage: string; responseLength: string } };
      assert.strictEqual(data1.preferences.revision, 1);
      assert.strictEqual(data1.preferences.preferredLanguage, 'vi');
      assert.strictEqual(data1.preferences.responseLength, 'concise');

      // 5. Partial PATCH: preserves omitted fields with expectedRevision: 1
      const patch2 = await app.request('/api/v1/me/preferences', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: user.cookie,
        },
        body: JSON.stringify({
          expectedRevision: 1,
          responseLength: 'detailed',
        }),
      });

      assert.strictEqual(patch2.status, 200);
      const data2 = (await patch2.json()) as { preferences: { revision: number; preferredLanguage: string; responseLength: string; customInstructions: string } };
      assert.strictEqual(data2.preferences.revision, 2);
      assert.strictEqual(data2.preferences.responseLength, 'detailed');
      assert.strictEqual(data2.preferences.preferredLanguage, 'vi'); // Preserved
      assert.strictEqual(data2.preferences.customInstructions, 'Trả lời súc tích bằng tiếng Việt.'); // Preserved

      // 6. Stale revision conflict: expectedRevision 1 when current is 2 -> 409 CONFLICT
      const patchConflict = await app.request('/api/v1/me/preferences', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: user.cookie,
        },
        body: JSON.stringify({
          expectedRevision: 1, // Stale!
          responseLength: 'balanced',
        }),
      });

      assert.strictEqual(patchConflict.status, 409);
      const conflictData = (await patchConflict.json()) as { error: { code: string } };
      assert.strictEqual(conflictData.error.code, 'CONFLICT');
    });

    it('rejects expectedRevision: 1 when preferences do not exist yet (strictly 0 required)', async () => {
      const user = await createTestUser('pref-nonexistent-strict0@example.com');
      const res = await app.request('/api/v1/me/preferences', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: user.cookie,
        },
        body: JSON.stringify({
          expectedRevision: 1, // Non-existent must be 0!
          preferredLanguage: 'en',
        }),
      });
      assert.strictEqual(res.status, 409);
      const data = (await res.json()) as { error: { code: string } };
      assert.strictEqual(data.error.code, 'CONFLICT');
    });

    it('handles concurrent first-writes with expectedRevision: 0 cleanly (one 200, one 409)', async () => {
      const user = await createTestUser('pref-concurrent@example.com');

      const makeRequest = (lang: string) =>
        app.request('/api/v1/me/preferences', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Origin: trustedOrigin,
            Cookie: user.cookie,
          },
          body: JSON.stringify({
            expectedRevision: 0,
            preferredLanguage: lang,
          }),
        });

      const [res1, res2] = await Promise.all([
        makeRequest('en'),
        makeRequest('vi'),
      ]);

      const statuses = [res1.status, res2.status].sort();
      assert.deepStrictEqual(statuses, [200, 409], 'Exactly one request should succeed (200) and the other conflict (409)');
    });

    it('rejects oversized custom instructions and invalid enums', async () => {
      const user = await createTestUser('pref-user3@example.com');

      // Oversized (> 2000 chars)
      const oversizedRes = await app.request('/api/v1/me/preferences', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: user.cookie,
        },
        body: JSON.stringify({
          expectedRevision: 0,
          customInstructions: 'A'.repeat(2001),
        }),
      });
      assert.strictEqual(oversizedRes.status, 400);
      const oversizedData = (await oversizedRes.json()) as { error: { code: string } };
      assert.strictEqual(oversizedData.error.code, 'SKILL_OVERSIZED');

      // Invalid responseLength
      const invalidLengthRes = await app.request('/api/v1/me/preferences', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: user.cookie,
        },
        body: JSON.stringify({
          expectedRevision: 0,
          responseLength: 'super-long',
        }),
      });
      assert.strictEqual(invalidLengthRes.status, 400);

      // Invalid responseStyle
      const invalidStyleRes = await app.request('/api/v1/me/preferences', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: user.cookie,
        },
        body: JSON.stringify({
          expectedRevision: 0,
          responseStyle: 'poetic',
        }),
      });
      assert.strictEqual(invalidStyleRes.status, 400);
    });
  });

  // ==========================================
  // Skills CRUD & Tenant Isolation
  // ==========================================
  describe('Skills CRUD and Tenant Isolation', () => {
    it('creates private custom skill and strictly rejects forged owner/admin fields', async () => {
      const userA = await createTestUser('alice@example.com');
      const userB = await createTestUser('bob@example.com');

      // Forgery attempts: should be rejected with 400 VALIDATION_ERROR
      const forgeRes = await app.request('/api/v1/skills', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: userA.cookie,
        },
        body: JSON.stringify({
          slug: 'alice-code-cleaner',
          title: 'Alice Code Cleaner',
          description: 'Cleans code and formats comments cleanly.',
          supportedProducts: ['chat', 'agent'],
          ownerId: userB.userId,
        }),
      });
      assert.strictEqual(forgeRes.status, 400);

      // Privileged field injection attempt: rejected with 400
      const adminRes = await app.request('/api/v1/skills', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: userA.cookie,
        },
        body: JSON.stringify({
          slug: 'alice-code-cleaner',
          title: 'Alice Code Cleaner',
          description: 'Cleans code and formats comments cleanly.',
          isAdmin: true,
        }),
      });
      assert.strictEqual(adminRes.status, 400);

      // Valid creation succeeds
      const createRes = await app.request('/api/v1/skills', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: userA.cookie,
        },
        body: JSON.stringify({
          slug: 'alice-code-cleaner',
          title: 'Alice Code Cleaner',
          description: 'Cleans code and formats comments cleanly.',
          supportedProducts: ['chat', 'agent'],
        }),
      });

      assert.strictEqual(createRes.status, 201);
      const data = (await createRes.json()) as {
        skill: { id: string; slug: string; ownerId: string; visibility: string };
      };
      assert.ok(data.skill.id);
      assert.strictEqual(data.skill.slug, 'alice-code-cleaner');
      assert.strictEqual(data.skill.ownerId, userA.userId);
      assert.strictEqual(data.skill.visibility, 'private');
    });

    it('rejects duplicate slugs for the same owner with 409 CONFLICT', async () => {
      const user = await createTestUser('charlie@example.com');

      const body = {
        slug: 'duplicate-slug',
        title: 'Original Skill',
        description: 'Original skill description for duplicate test',
      };

      const res1 = await app.request('/api/v1/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify(body),
      });
      assert.strictEqual(res1.status, 201);

      const res2 = await app.request('/api/v1/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify(body),
      });
      assert.strictEqual(res2.status, 409);
      const err = (await res2.json()) as { error: { code: string } };
      assert.strictEqual(err.error.code, 'CONFLICT');
    });

    it('rejects invalid slugs with 400 VALIDATION_ERROR', async () => {
      const user = await createTestUser('dave@example.com');

      const invalidSlugs = ['UPPERCASE', 'invalid_underscore', 'with space', 'a', '-start-hyphen'];
      for (const slug of invalidSlugs) {
        const res = await app.request('/api/v1/skills', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
          body: JSON.stringify({
            slug,
            title: 'Test Title',
            description: 'Valid description for invalid slug test',
          }),
        });
        assert.strictEqual(res.status, 400, `Expected 400 for slug '${slug}'`);
      }
    });

    it('enforces tenant isolation on GET, PATCH, and DELETE without existence leak', async () => {
      const userA = await createTestUser('user-a@example.com');
      const userB = await createTestUser('user-b@example.com');

      // User A creates a skill
      const createRes = await app.request('/api/v1/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: userA.cookie },
        body: JSON.stringify({
          slug: 'private-secret-skill',
          title: 'Secret Skill A',
          description: 'A private skill belonging exclusively to User A',
        }),
      });
      assert.strictEqual(createRes.status, 201);
      const skillA = ((await createRes.json()) as { skill: { id: string } }).skill;

      // 1. User B tries to GET User A's skill -> 404 NOT_FOUND (no leak)
      const getRes = await app.request(`/api/v1/skills/${skillA.id}`, {
        method: 'GET',
        headers: { Cookie: userB.cookie },
      });
      assert.strictEqual(getRes.status, 404);
      const getData = (await getRes.json()) as { error: { code: string } };
      assert.strictEqual(getData.error.code, 'NOT_FOUND');

      // 2. User B tries to PATCH User A's skill -> 404 NOT_FOUND
      const patchRes = await app.request(`/api/v1/skills/${skillA.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: userB.cookie },
        body: JSON.stringify({ title: 'Hacked Skill', expectedRevision: 1 }),
      });
      assert.strictEqual(patchRes.status, 404);

      // 3. User B tries to DELETE User A's skill -> 404 NOT_FOUND
      const delRes = await app.request(`/api/v1/skills/${skillA.id}`, {
        method: 'DELETE',
        headers: { Origin: trustedOrigin, Cookie: userB.cookie },
      });
      assert.strictEqual(delRes.status, 404);

      // 4. UUID validation check: invalid UUID format returns 400
      const badIdRes = await app.request('/api/v1/skills/not-a-valid-uuid', {
        method: 'GET',
        headers: { Cookie: userA.cookie },
      });
      assert.strictEqual(badIdRes.status, 400);

      // 5a. User A tries to PATCH with missing expectedRevision -> 400
      const missingRevRes = await app.request(`/api/v1/skills/${skillA.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: userA.cookie },
        body: JSON.stringify({ title: 'Missing Revision' }),
      });
      assert.strictEqual(missingRevRes.status, 400);

      // 5b. User A tries to PATCH with unknown/forbidden field -> 400
      const badPatchRes = await app.request(`/api/v1/skills/${skillA.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: userA.cookie },
        body: JSON.stringify({ ownerId: userB.userId, expectedRevision: 1 }),
      });
      assert.strictEqual(badPatchRes.status, 400);

      // 6. User A tries to PATCH with stale expectedRevision -> 409 CONFLICT
      const stalePatchRes = await app.request(`/api/v1/skills/${skillA.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: userA.cookie },
        body: JSON.stringify({
          title: 'Stale Update Attempt',
          expectedRevision: 99,
        }),
      });
      assert.strictEqual(stalePatchRes.status, 409);
      const staleErr = (await stalePatchRes.json()) as { error: { code: string } };
      assert.strictEqual(staleErr.error.code, 'CONFLICT');

      // 7. User A successfully PATCHes their skill (matching expectedRevision 1)
      const patchOk = await app.request(`/api/v1/skills/${skillA.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: userA.cookie },
        body: JSON.stringify({ title: 'Secret Skill A Updated', expectedRevision: 1 }),
      });
      assert.strictEqual(patchOk.status, 200);
      const updatedSkill = ((await patchOk.json()) as { skill: { title: string; revision: number } }).skill;
      assert.strictEqual(updatedSkill.title, 'Secret Skill A Updated');
      assert.strictEqual(updatedSkill.revision, 2);

      // 7b. Sequential stale edit: reusing expectedRevision 1 fails with 409 CONFLICT
      const staleReplayRes = await app.request(`/api/v1/skills/${skillA.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: userA.cookie },
        body: JSON.stringify({ title: 'Stale Replay', expectedRevision: 1 }),
      });
      assert.strictEqual(staleReplayRes.status, 409);

      // 8. User A successfully DELETEs their skill -> 204 No Content
      const delOk = await app.request(`/api/v1/skills/${skillA.id}`, {
        method: 'DELETE',
        headers: { Origin: trustedOrigin, Cookie: userA.cookie },
      });
      assert.strictEqual(delOk.status, 204);

      // 9. User A subsequent GET returns 404
      const getAfterDel = await app.request(`/api/v1/skills/${skillA.id}`, {
        method: 'GET',
        headers: { Cookie: userA.cookie },
      });
      assert.strictEqual(getAfterDel.status, 404);
    });

    it('handles concurrent metadata PATCH requests with optimistic locking (one 200, one 409)', async () => {
      const user = await createTestUser('meta-concurrent@example.com');
      const createRes = await app.request('/api/v1/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({
          slug: 'concurrent-meta-skill',
          title: 'Concurrent Meta Skill',
          description: 'Testing concurrency on metadata updates',
        }),
      });
      assert.strictEqual(createRes.status, 201);
      const skill = ((await createRes.json()) as { skill: { id: string; revision: number } }).skill;
      assert.strictEqual(skill.revision, 1);

      const makePatch = (title: string) =>
        app.request(`/api/v1/skills/${skill.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
          body: JSON.stringify({
            title,
            expectedRevision: 1,
          }),
        });

      const [res1, res2] = await Promise.all([
        makePatch('First Winner Title'),
        makePatch('Second Race Title'),
      ]);

      const statuses = [res1.status, res2.status].sort();
      assert.deepStrictEqual(statuses, [200, 409], 'Exactly one metadata PATCH must succeed (200) and the other conflict (409)');
    });

    it('lists skills with scope filters, pagination, and deterministic cursors', async () => {
      const userA = await createTestUser('list-a@example.com');
      const userB = await createTestUser('list-b@example.com');

      // Invalid scope is rejected with 400
      const invalidScopeRes = await app.request('/api/v1/skills?scope=unknown', {
        method: 'GET',
        headers: { Cookie: userA.cookie },
      });
      assert.strictEqual(invalidScopeRes.status, 400);

      // User A creates 2 skills and installs 1
      const skill1Res = await app.request('/api/v1/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: userA.cookie },
        body: JSON.stringify({
          slug: 'skill-one',
          title: 'Skill One',
          description: 'Description for skill one',
          instructions: 'Instructions for skill one',
        }),
      });
      assert.strictEqual(skill1Res.status, 201);

      const skill2Res = await app.request('/api/v1/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: userA.cookie },
        body: JSON.stringify({
          slug: 'skill-two',
          title: 'Skill Two',
          description: 'Description for skill two (not installed)',
        }),
      });
      assert.strictEqual(skill2Res.status, 201);

      // User B creates 1 skill
      await app.request('/api/v1/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: userB.cookie },
        body: JSON.stringify({
          slug: 'user-b-skill',
          title: 'User B Skill',
          description: 'Skill owned exclusively by user B',
        }),
      });

      // User A lists all visible skills
      const listRes = await app.request('/api/v1/skills', {
        method: 'GET',
        headers: { Cookie: userA.cookie },
      });
      assert.strictEqual(listRes.status, 200);
      const listData = (await listRes.json()) as { items: Array<{ slug: string; installed: boolean }>; nextCursor: string | null };
      const slugs = listData.items.map((i) => i.slug);
      assert.ok(slugs.includes('skill-one'));
      assert.ok(slugs.includes('skill-two'));
      assert.ok(!slugs.includes('user-b-skill'), 'User B skill must not be visible to User A');

      // User A lists with pagination: limit=1
      const page1Res = await app.request('/api/v1/skills?limit=1', {
        method: 'GET',
        headers: { Cookie: userA.cookie },
      });
      assert.strictEqual(page1Res.status, 200);
      const page1Data = (await page1Res.json()) as { items: Array<{ slug: string }>; nextCursor: string | null };
      assert.strictEqual(page1Data.items.length, 1);
      assert.ok(page1Data.nextCursor, 'nextCursor must be returned when more items exist');

      // Fetch page 2 using cursor
      const page2Res = await app.request(`/api/v1/skills?limit=1&cursor=${encodeURIComponent(page1Data.nextCursor!)}`, {
        method: 'GET',
        headers: { Cookie: userA.cookie },
      });
      assert.strictEqual(page2Res.status, 200);
      const page2Data = (await page2Res.json()) as { items: Array<{ slug: string }>; nextCursor: string | null };
      assert.strictEqual(page2Data.items.length, 1);
      assert.ok(page1Data.items[0]);
      assert.ok(page2Data.items[0]);
      assert.notStrictEqual(page1Data.items[0].slug, page2Data.items[0].slug);

      // User A lists with scope=installed
      const installedRes = await app.request('/api/v1/skills?scope=installed', {
        method: 'GET',
        headers: { Cookie: userA.cookie },
      });
      assert.strictEqual(installedRes.status, 200);
      const installedData = (await installedRes.json()) as { items: Array<{ slug: string }> };
      const installedSlugs = installedData.items.map((i) => i.slug);
      assert.ok(installedSlugs.includes('skill-one'));
      assert.ok(!installedSlugs.includes('skill-two'));
    });

    it('strictly rejects malformed pagination cursors with 400 VALIDATION_ERROR', async () => {
      const user = await createTestUser('cursor-val@example.com');

      const testCases = [
        { name: 'empty cursor', cursor: '' },
        { name: 'malformed not base64url', cursor: '!!!not-valid-base64url!!!' },
        { name: 'not two parts', cursor: Buffer.from('onepartonly').toString('base64url') },
        {
          name: 'invalid date timestamp',
          cursor: Buffer.from('not-a-valid-date::00000000-0000-0000-0000-000000000001').toString('base64url'),
        },
        {
          name: 'invalid uuid',
          cursor: Buffer.from('2026-10-14T10:00:00.000Z::not-a-valid-uuid').toString('base64url'),
        },
      ];

      for (const tc of testCases) {
        const res = await app.request(`/api/v1/skills?cursor=${encodeURIComponent(tc.cursor)}`, {
          method: 'GET',
          headers: { Cookie: user.cookie },
        });
        assert.strictEqual(res.status, 400, `Expected 400 for ${tc.name}`);
        const data = (await res.json()) as { error: { code: string; message: string } };
        assert.strictEqual(data.error.code, 'VALIDATION_ERROR');
      }
    });

    it('handles sub-millisecond timestamps correctly during pagination without skipping or repeating rows', async () => {
      if (db.isMemory) {
        return; // Sub-millisecond TIMESTAMPTZ precision requires real PostgreSQL (verified in CI)
      }

      const user = await createTestUser('submilli-pag@example.com');

      // Insert two skills directly into PostgreSQL with microsecond-differing timestamps
      const insertSkillSql = `
        INSERT INTO skill_definitions (id, owner_id, slug, title, description, visibility, supported_products, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
      `;
      const id1 = '11111111-1111-1111-1111-111111111111';
      const id2 = '22222222-2222-2222-2222-222222222222';
      const ts1 = '2026-10-14 10:00:00.123450+00';
      const ts2 = '2026-10-14 10:00:00.123451+00';

      await db.pool.query(insertSkillSql, [
        id1,
        user.userId,
        'micro-skill-1',
        'Micro Skill 1',
        'Testing microsecond timestamp precision 1',
        'private',
        ['chat'],
        ts1,
      ]);
      await db.pool.query(insertSkillSql, [
        id2,
        user.userId,
        'micro-skill-2',
        'Micro Skill 2',
        'Testing microsecond timestamp precision 2',
        'private',
        ['chat'],
        ts2,
      ]);

      // Page 1 with limit=1
      const page1Res = await app.request('/api/v1/skills?limit=1', {
        method: 'GET',
        headers: { Cookie: user.cookie },
      });
      assert.strictEqual(page1Res.status, 200);
      const page1Data = (await page1Res.json()) as { items: Array<{ id: string; slug: string }>; nextCursor: string | null };
      assert.strictEqual(page1Data.items.length, 1);
      assert.strictEqual(page1Data.items[0]?.id, id1);
      assert.ok(page1Data.nextCursor);

      // Verify cursor has full microsecond timestamp
      const decodedCursor = Buffer.from(page1Data.nextCursor!, 'base64url').toString('utf8');
      assert.ok(decodedCursor.includes('123450Z'), `Decoded cursor must contain microseconds: ${decodedCursor}`);

      // Page 2 using cursor
      const page2Res = await app.request(`/api/v1/skills?limit=1&cursor=${encodeURIComponent(page1Data.nextCursor!)}`, {
        method: 'GET',
        headers: { Cookie: user.cookie },
      });
      assert.strictEqual(page2Res.status, 200);
      const page2Data = (await page2Res.json()) as { items: Array<{ id: string; slug: string }>; nextCursor: string | null };
      assert.strictEqual(page2Data.items.length, 1);
      assert.strictEqual(page2Data.items[0]?.id, id2);
      assert.notStrictEqual(page2Data.items[0]?.id, page1Data.items[0]?.id, 'Must not repeat previous page item');
    });
  });

  // ==========================================
  // Skill Versions & Immutability
  // ==========================================
  describe('Skill Versions Endpoints', () => {
    it('publishes sequential immutable versions with automatic version numbering and hash computation', async () => {
      const user = await createTestUser('author@example.com');

      const createRes = await app.request('/api/v1/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({
          slug: 'versioned-skill',
          title: 'Versioned Skill',
          description: 'Skill with multiple published versions',
        }),
      });
      const skillId = ((await createRes.json()) as { skill: { id: string } }).skill.id;

      // 1. Publish version 1
      const v1Res = await app.request(`/api/v1/skills/${skillId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({
          instructions: 'Initial instruction revision for version 1.',
        }),
      });
      assert.strictEqual(v1Res.status, 201);
      const v1 = ((await v1Res.json()) as { version: { id: string; versionNumber: number; contentHash: string } }).version;
      assert.strictEqual(v1.versionNumber, 1);
      assert.ok(v1.contentHash);

      // 2. Publish version 2
      const v2Res = await app.request(`/api/v1/skills/${skillId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({
          instructions: 'Updated instruction revision for version 2.',
        }),
      });
      assert.strictEqual(v2Res.status, 201);
      const v2 = ((await v2Res.json()) as { version: { id: string; versionNumber: number; contentHash: string } }).version;
      assert.strictEqual(v2.versionNumber, 2);
      assert.notStrictEqual(v2.contentHash, v1.contentHash);

      // 3. Rejects forbidden caller-asserted contentHash field
      const badHashRes = await app.request(`/api/v1/skills/${skillId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({
          instructions: 'Instructions with forbidden caller-supplied hash.',
          contentHash: '0000000000000000000000000000000000000000000000000000000000000000',
        }),
      });
      assert.strictEqual(badHashRes.status, 400);
      const badHashData = (await badHashRes.json()) as { error: { message: string } };
      assert.match(badHashData.error.message, /forbidden field 'contentHash'/i);

      // 4. Rejects oversized instructions (> 32 KiB)
      const oversizedRes = await app.request(`/api/v1/skills/${skillId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({
          instructions: 'X'.repeat(32769),
        }),
      });
      assert.strictEqual(oversizedRes.status, 400);
      const err = (await oversizedRes.json()) as { error: { code: string } };
      assert.strictEqual(err.error.code, 'SKILL_OVERSIZED');
    });

    it('rejects version publication by non-owner with 404 NOT_FOUND', async () => {
      const userA = await createTestUser('owner@example.com');
      const userB = await createTestUser('stranger@example.com');

      const createRes = await app.request('/api/v1/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: userA.cookie },
        body: JSON.stringify({
          slug: 'owner-skill',
          title: 'Owner Skill',
          description: 'Owner skill description for publication test',
        }),
      });
      const skillId = ((await createRes.json()) as { skill: { id: string } }).skill.id;

      const pubRes = await app.request(`/api/v1/skills/${skillId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: userB.cookie },
        body: JSON.stringify({ instructions: 'Malicious publication' }),
      });
      assert.strictEqual(pubRes.status, 404);
    });
  });

  // ==========================================
  // Skill Installations
  // ==========================================
  describe('Skill Installations Endpoints', () => {
    it('installs skill pinning latest version and manages enablement and pinned versions', async () => {
      const user = await createTestUser('installer@example.com');

      // Create skill with version 1
      const createRes = await app.request('/api/v1/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({
          slug: 'installable-skill',
          title: 'Installable Skill',
          description: 'A skill ready to be installed and managed',
          instructions: 'Version 1 instructions',
        }),
      });
      const skill = ((await createRes.json()) as { skill: { id: string; latestVersion: { id: string } } }).skill;
      const v1Id = skill.latestVersion.id;

      // Publish version 2
      const v2Res = await app.request(`/api/v1/skills/${skill.id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({ instructions: 'Version 2 instructions' }),
      });
      const v2Id = ((await v2Res.json()) as { version: { id: string } }).version.id;

      // Note: createSkill with instructions auto-installs for owner. Let's create another user to install it.
      const user2 = await createTestUser('consumer@example.com');

      // User 2 cannot install User 1's private skill -> 404 NOT_FOUND
      const crossInstallRes = await app.request(`/api/v1/skills/${skill.id}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user2.cookie },
        body: JSON.stringify({}),
      });
      assert.strictEqual(crossInstallRes.status, 404);

      // User 1 installation already exists -> duplicate install returns 409 CONFLICT
      const dupInstallRes = await app.request(`/api/v1/skills/${skill.id}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({}),
      });
      assert.strictEqual(dupInstallRes.status, 409);
      const dupErr = (await dupInstallRes.json()) as { error: { code: string } };
      assert.strictEqual(dupErr.error.code, 'CONFLICT');

      // User 1 toggles installation enabled: false
      const disableRes = await app.request(`/api/v1/skills/${skill.id}/installation`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({ enabled: false }),
      });
      assert.strictEqual(disableRes.status, 200);
      const disabledData = (await disableRes.json()) as { installation: { enabled: boolean } };
      assert.strictEqual(disabledData.installation.enabled, false);

      // User 1 switches pinned version to v2
      const switchVerRes = await app.request(`/api/v1/skills/${skill.id}/installation`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({ selectedVersionId: v2Id }),
      });
      assert.strictEqual(switchVerRes.status, 200);
      const switchedData = (await switchVerRes.json()) as { installation: { selectedVersionId: string } };
      assert.strictEqual(switchedData.installation.selectedVersionId, v2Id);

      // User 1 switches pinned version back to v1 (fixes TS6133 by asserting v1Id usage)
      const switchBackRes = await app.request(`/api/v1/skills/${skill.id}/installation`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({ selectedVersionId: v1Id }),
      });
      assert.strictEqual(switchBackRes.status, 200);
      const switchedBackData = (await switchBackRes.json()) as { installation: { selectedVersionId: string } };
      assert.strictEqual(switchedBackData.installation.selectedVersionId, v1Id);

      // User 1 attempts to pin invalid/non-existent version -> 404 NOT_FOUND
      const badVerRes = await app.request(`/api/v1/skills/${skill.id}/installation`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({ selectedVersionId: '00000000-0000-0000-0000-000000000099' }),
      });
      assert.strictEqual(badVerRes.status, 404);
    });
  });

  // ==========================================
  // Built-in Skills Safety & Immutability
  // ==========================================
  describe('Built-in Skills Public Safety Boundary', () => {
    it('forbids public users from modifying, deleting, or publishing versions to built-in skills', async () => {
      // 1. Seed a built-in skill directly into database
      const insertBuiltIn = `
        INSERT INTO skill_definitions (id, owner_id, slug, title, description, visibility, supported_products)
        VALUES ('00000000-0000-0000-0000-000000000001', NULL, 'system-cleaner', 'System Cleaner', 'Built-in cleaner', 'built_in', ARRAY['chat', 'agent'])
        RETURNING id;
      `;
      const res = await db.pool.query(insertBuiltIn);
      const builtInId = res.rows[0].id;

      const user = await createTestUser('regular-user@example.com');

      // Built-in skill is visible to regular user
      const getRes = await app.request(`/api/v1/skills/${builtInId}`, {
        method: 'GET',
        headers: { Cookie: user.cookie },
      });
      assert.strictEqual(getRes.status, 200);

      // PATCH built-in skill -> 403 FORBIDDEN
      const patchRes = await app.request(`/api/v1/skills/${builtInId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({ title: 'Hacked System Title', expectedRevision: 1 }),
      });
      assert.strictEqual(patchRes.status, 403);
      const patchErr = (await patchRes.json()) as { error: { code: string } };
      assert.strictEqual(patchErr.error.code, 'FORBIDDEN');

      // DELETE built-in skill -> 403 FORBIDDEN
      const delRes = await app.request(`/api/v1/skills/${builtInId}`, {
        method: 'DELETE',
        headers: { Origin: trustedOrigin, Cookie: user.cookie },
      });
      assert.strictEqual(delRes.status, 403);
      const delErr = (await delRes.json()) as { error: { code: string } };
      assert.strictEqual(delErr.error.code, 'FORBIDDEN');

      // Publish version to built-in skill -> 403 FORBIDDEN
      const pubRes = await app.request(`/api/v1/skills/${builtInId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({ instructions: 'Malicious built-in update' }),
      });
      assert.strictEqual(pubRes.status, 403);
      const pubErr = (await pubRes.json()) as { error: { code: string } };
      assert.strictEqual(pubErr.error.code, 'FORBIDDEN');
    });
  });

  // ==========================================
  // P0 Instruction Format Validation & Safety
  // ==========================================
  describe('P0 Instruction Format Validation & Safety', () => {
    it('rejects instructions containing executable script tags, iframes, shebangs, and forbidden frontmatter', async () => {
      const user = await createTestUser('sec-user@example.com');

      // 1. Script tag injection attempt -> 400 SKILL_UNSAFE_CONTENT
      const scriptRes = await app.request('/api/v1/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({
          slug: 'xss-skill',
          title: 'XSS Skill',
          description: 'Attempts to inject html script tag',
          instructions: 'Hello <script>alert("xss")</script> World',
        }),
      });
      assert.strictEqual(scriptRes.status, 400);
      const scriptErr = (await scriptRes.json()) as { error: { code: string } };
      assert.strictEqual(scriptErr.error.code, 'SKILL_UNSAFE_CONTENT');

      // 2. Iframe tag injection attempt -> 400 SKILL_UNSAFE_CONTENT
      const iframeRes = await app.request('/api/v1/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({
          slug: 'iframe-skill',
          title: 'IFrame Skill',
          description: 'Attempts to inject iframe tag',
          instructions: 'Hello <iframe src="https://evil.example.com"></iframe> World',
        }),
      });
      assert.strictEqual(iframeRes.status, 400);
      const iframeErr = (await iframeRes.json()) as { error: { code: string } };
      assert.strictEqual(iframeErr.error.code, 'SKILL_UNSAFE_CONTENT');

      // 3. Shebang / shell executable script -> 400 SKILL_UNSAFE_CONTENT
      const shebangRes = await app.request('/api/v1/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({
          slug: 'shell-skill',
          title: 'Shell Skill',
          description: 'Attempts to inject executable shell script',
          instructions: '#!/bin/bash\nrm -rf /',
        }),
      });
      assert.strictEqual(shebangRes.status, 400);
      const shebangErr = (await shebangRes.json()) as { error: { code: string } };
      assert.strictEqual(shebangErr.error.code, 'SKILL_UNSAFE_CONTENT');

      // 4. Frontmatter declaring forbidden executable capabilities (tools, scripts) -> 400 SKILL_UNSAFE_CONTENT
      const fmRes = await app.request('/api/v1/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
        body: JSON.stringify({
          slug: 'forbidden-fm-skill',
          title: 'Forbidden Frontmatter Skill',
          description: 'Attempts to declare runtime tools in P0',
          instructions: '---\nname: forbidden-tools\ntools: [read_file, execute_bash]\n---\nValid body content',
        }),
      });
      assert.strictEqual(fmRes.status, 400);
      const fmErr = (await fmRes.json()) as { error: { code: string } };
      assert.strictEqual(fmErr.error.code, 'SKILL_UNSAFE_CONTENT');
    });
  });

  // ==========================================
  // Transaction Atomicity & Rollback Integrity
  // ==========================================
  describe('Transaction Atomicity & Rollback Integrity', () => {
    it('rolls back atomic creation transaction cleanly when error occurs, leaving no orphaned skill row', async () => {
      if (db.isMemory) {
        return; // Real PostgreSQL trigger failure injection is verified in CI.
      }

      const user = await createTestUser('atomic-rollback-user@example.com');
      const failingInstructions = 'Valid instruction content that fails on version insert';

      // Use a database-level test trigger instead of monkey-patching pg Pool/PoolClient methods.
      // This preserves node-postgres callback/promise semantics and deterministically fails step 2
      // of the real atomic transaction after skill_definitions has been inserted.
      await db.pool.query(`
        CREATE OR REPLACE FUNCTION test_fail_skill_version_insert()
        RETURNS TRIGGER AS $$
        BEGIN
          IF NEW.instructions = '${failingInstructions.replace(/'/g, "''")}' THEN
            RAISE EXCEPTION 'Simulated version insertion failure for atomic rollback verification';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS trg_test_fail_skill_version_insert ON skill_versions;

        CREATE TRIGGER trg_test_fail_skill_version_insert
        BEFORE INSERT ON skill_versions
        FOR EACH ROW
        EXECUTE FUNCTION test_fail_skill_version_insert();
      `);

      try {
        const res = await app.request('/api/v1/skills', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: trustedOrigin, Cookie: user.cookie },
          body: JSON.stringify({
            slug: 'rollback-verify-skill',
            title: 'Rollback Verify',
            description: 'Must be completely rolled back when version insertion fails',
            instructions: failingInstructions,
          }),
        });

        assert.notStrictEqual(res.status, 201);

        const check = await db.pool.query(
          'SELECT count(*) FROM skill_definitions WHERE slug = $1',
          ['rollback-verify-skill']
        );
        assert.strictEqual(
          parseInt(check.rows[0]?.count ?? '0', 10),
          0,
          'Skill definition row must not exist after transaction rollback'
        );
      } finally {
        await db.pool.query(
          'DROP TRIGGER IF EXISTS trg_test_fail_skill_version_insert ON skill_versions;'
        );
        await db.pool.query('DROP FUNCTION IF EXISTS test_fail_skill_version_insert();');
      }
    });
  });
});
