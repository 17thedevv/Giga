import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app/create-app.js';
import { createTestDatabase, type TestDbInstance } from '../test-db-helper.js';
import { MessageRepository } from '../../src/db/repositories/message-repository.js';
import { SESSION_COOKIE_NAME } from '../../src/modules/auth/session.js';
import type { Conversation, ConversationListResponse, ConversationWithMessages } from '../../src/modules/conversations/types.js';

describe('Conversations REST API Endpoints', () => {
  let db: TestDbInstance;
  let app: ReturnType<typeof createApp>;
  let msgRepo: MessageRepository;

  const trustedOrigin = 'http://localhost:3000';
  let userACookie: string;
  let userBCookie: string;

  before(async () => {
    db = await createTestDatabase();
    app = createApp({
      pool: db.pool,
      config: {
        allowedOrigins: [trustedOrigin],
      },
    });
    msgRepo = new MessageRepository(db.pool);
  });

  after(async () => {
    await db.cleanup();
    await db.pool.end();
  });

  beforeEach(async () => {
    await db.cleanup();

    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // Register User A
    const regARes = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: trustedOrigin },
      body: JSON.stringify({
        email: `alice-${tag}@example.com`,
        password: 'Password123!',
        displayName: 'Alice User',
      }),
    });
    assert.strictEqual(regARes.status, 201);

    // Login User A to acquire session cookie
    const loginARes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: trustedOrigin },
      body: JSON.stringify({
        email: `alice-${tag}@example.com`,
        password: 'Password123!',
      }),
    });
    assert.strictEqual(loginARes.status, 200);
    const rawSetCookieA = loginARes.headers.get('set-cookie');
    assert.ok(rawSetCookieA);
    const tokenMatchA = rawSetCookieA.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
    assert.ok(tokenMatchA);
    userACookie = `${SESSION_COOKIE_NAME}=${tokenMatchA[1]}`;

    // Register & Login User B
    const regBRes = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: trustedOrigin },
      body: JSON.stringify({
        email: `bob-${tag}@example.com`,
        password: 'Password123!',
        displayName: 'Bob User',
      }),
    });
    assert.strictEqual(regBRes.status, 201);

    const loginBRes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: trustedOrigin },
      body: JSON.stringify({
        email: `bob-${tag}@example.com`,
        password: 'Password123!',
      }),
    });
    assert.strictEqual(loginBRes.status, 200);
    const rawSetCookieB = loginBRes.headers.get('set-cookie');
    assert.ok(rawSetCookieB);
    const tokenMatchB = rawSetCookieB.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
    assert.ok(tokenMatchB);
    userBCookie = `${SESSION_COOKIE_NAME}=${tokenMatchB[1]}`;
  });

  describe('Authentication & CSRF Guards', () => {
    it('returns 401 UNAUTHENTICATED on all routes when session cookie is missing', async () => {
      const getList = await app.request('/api/v1/conversations');
      assert.strictEqual(getList.status, 401);
      const listErr = (await getList.json()) as { error: { code: string } };
      assert.strictEqual(listErr.error.code, 'UNAUTHENTICATED');

      const postConv = await app.request('/api/v1/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: trustedOrigin },
        body: JSON.stringify({ title: 'No Auth' }),
      });
      assert.strictEqual(postConv.status, 401);

      const fakeId = '00000000-0000-0000-0000-000000000001';
      const getSingle = await app.request(`/api/v1/conversations/${fakeId}`);
      assert.strictEqual(getSingle.status, 401);

      const deleteSingle = await app.request(`/api/v1/conversations/${fakeId}`, {
        method: 'DELETE',
        headers: { Origin: trustedOrigin },
      });
      assert.strictEqual(deleteSingle.status, 401);
    });

    it('returns 401 UNAUTHENTICATED when session token is invalid or expired', async () => {
      const res = await app.request('/api/v1/conversations', {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=invalid_or_expired_token` },
      });
      assert.strictEqual(res.status, 401);
    });

    it('enforces CSRF protection on POST and DELETE with untrusted origin', async () => {
      const postRes = await app.request('/api/v1/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://malicious-attacker.com',
          Cookie: userACookie,
        },
        body: JSON.stringify({ title: 'CSRF Test' }),
      });
      assert.strictEqual(postRes.status, 403);
      const postErr = (await postRes.json()) as { error: { code: string } };
      assert.strictEqual(postErr.error.code, 'FORBIDDEN');

      const delRes = await app.request('/api/v1/conversations/00000000-0000-0000-0000-000000000001', {
        method: 'DELETE',
        headers: {
          Origin: 'http://malicious-attacker.com',
          Cookie: userACookie,
        },
      });
      assert.strictEqual(delRes.status, 403);
    });
  });

  describe('CRUD Lifecycle & Ownership Isolation', () => {
    it('creates, lists, retrieves, and deletes conversation (204 No Content)', async () => {
      // 1. Create conversation with explicit title
      const createRes = await app.request('/api/v1/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: userACookie,
        },
        body: JSON.stringify({ title: 'System Architecture Discussion' }),
      });
      assert.strictEqual(createRes.status, 201);
      const createData = (await createRes.json()) as { conversation: Conversation };
      assert.ok(createData.conversation.id);
      assert.strictEqual(createData.conversation.title, 'System Architecture Discussion');
      assert.ok(createData.conversation.createdAt);
      assert.ok(createData.conversation.updatedAt);
      const convId = createData.conversation.id;

      // 2. List conversations — should contain newly created conversation
      const listRes = await app.request('/api/v1/conversations', {
        headers: { Cookie: userACookie },
      });
      assert.strictEqual(listRes.status, 200);
      const listData = (await listRes.json()) as ConversationListResponse;
      assert.strictEqual(listData.items.length, 1);
      assert.strictEqual(listData.items[0]?.id, convId);
      assert.strictEqual(listData.nextCursor, null);

      // 3. Add sample messages directly via message repository to test history retrieval
      await msgRepo.create({ conversationId: convId, role: 'user', content: 'What is Giga?' });
      await msgRepo.create({
        conversationId: convId,
        role: 'assistant',
        content: 'Giga is an autonomous pair programming workspace.',
      });

      // 4. GET /api/v1/conversations/:id retrieves conversation + message history
      const getRes = await app.request(`/api/v1/conversations/${convId}`, {
        headers: { Cookie: userACookie },
      });
      assert.strictEqual(getRes.status, 200);
      const getData = (await getRes.json()) as ConversationWithMessages;
      assert.strictEqual(getData.conversation.id, convId);
      assert.strictEqual(getData.messages.length, 2);
      assert.strictEqual(getData.messages[0]?.role, 'user');
      assert.strictEqual(getData.messages[0]?.content, 'What is Giga?');
      assert.strictEqual(getData.messages[1]?.role, 'assistant');

      // 5. DELETE /api/v1/conversations/:id -> 204 No Content
      const delRes = await app.request(`/api/v1/conversations/${convId}`, {
        method: 'DELETE',
        headers: { Origin: trustedOrigin, Cookie: userACookie },
      });
      assert.strictEqual(delRes.status, 204);
      assert.strictEqual(await delRes.text(), '');

      // 6. Subsequent GET returns 404 NOT_FOUND
      const getAfterDel = await app.request(`/api/v1/conversations/${convId}`, {
        headers: { Cookie: userACookie },
      });
      assert.strictEqual(getAfterDel.status, 404);
      const notFoundErr = (await getAfterDel.json()) as { error: { code: string } };
      assert.strictEqual(notFoundErr.error.code, 'NOT_FOUND');

      // 7. Subsequent DELETE returns 404 NOT_FOUND
      const delAgain = await app.request(`/api/v1/conversations/${convId}`, {
        method: 'DELETE',
        headers: { Origin: trustedOrigin, Cookie: userACookie },
      });
      assert.strictEqual(delAgain.status, 404);
    });

    it('proposes default fallback title "New Conversation" when title is omitted or empty', async () => {
      // Empty body object
      const res1 = await app.request('/api/v1/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: userACookie,
        },
        body: JSON.stringify({}),
      });
      assert.strictEqual(res1.status, 201);
      const data1 = (await res1.json()) as { conversation: Conversation };
      assert.strictEqual(data1.conversation.title, 'New Conversation');

      // Whitespace title
      const res2 = await app.request('/api/v1/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: userACookie,
        },
        body: JSON.stringify({ title: '   ' }),
      });
      assert.strictEqual(res2.status, 201);
      const data2 = (await res2.json()) as { conversation: Conversation };
      assert.strictEqual(data2.conversation.title, 'New Conversation');
    });

    it('multi-user tenant isolation: prevents data access and user enumeration between users', async () => {
      // User A creates a private conversation
      const createRes = await app.request('/api/v1/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: userACookie,
        },
        body: JSON.stringify({ title: 'Alice Confidential' }),
      });
      assert.strictEqual(createRes.status, 201);
      const convAId = ((await createRes.json()) as { conversation: Conversation }).conversation.id;

      // Add secret message
      await msgRepo.create({
        conversationId: convAId,
        role: 'user',
        content: 'Alice top secret credentials',
      });

      // User B lists conversations -> must be empty
      const listBRes = await app.request('/api/v1/conversations', {
        headers: { Cookie: userBCookie },
      });
      assert.strictEqual(listBRes.status, 200);
      const listBData = (await listBRes.json()) as ConversationListResponse;
      assert.strictEqual(listBData.items.length, 0);

      // User B attempts GET with Alice's conversation ID -> 404 NOT_FOUND (never 403 or 200)
      const getBRes = await app.request(`/api/v1/conversations/${convAId}`, {
        headers: { Cookie: userBCookie },
      });
      assert.strictEqual(getBRes.status, 404, 'Must return 404 without leaking conversation existence');
      const getBErr = (await getBRes.json()) as { error: { code: string; message: string } };
      assert.strictEqual(getBErr.error.code, 'NOT_FOUND');
      assert.ok(!JSON.stringify(getBErr).includes('Alice'));

      // User B attempts DELETE with Alice's conversation ID -> 404 NOT_FOUND
      const delBRes = await app.request(`/api/v1/conversations/${convAId}`, {
        method: 'DELETE',
        headers: { Origin: trustedOrigin, Cookie: userBCookie },
      });
      assert.strictEqual(delBRes.status, 404);

      // Verify Alice can still retrieve her conversation and messages intact
      const verifyARes = await app.request(`/api/v1/conversations/${convAId}`, {
        headers: { Cookie: userACookie },
      });
      assert.strictEqual(verifyARes.status, 200);
      const aData = (await verifyARes.json()) as ConversationWithMessages;
      assert.strictEqual(aData.messages.length, 1);
      assert.strictEqual(aData.messages[0]?.content, 'Alice top secret credentials');
    });
  });

  describe('Input Validation & Strict Safety Checks', () => {
    it('rejects malformed JSON payload with 400 VALIDATION_ERROR', async () => {
      const res = await app.request('/api/v1/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: userACookie,
        },
        body: '{ malformed json: missing quotes }',
      });
      assert.strictEqual(res.status, 400);
      const err = (await res.json()) as { error: { code: string; message: string } };
      assert.strictEqual(err.error.code, 'VALIDATION_ERROR');
    });

    it('rejects non-object body payloads with 400 VALIDATION_ERROR', async () => {
      const res = await app.request('/api/v1/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: userACookie,
        },
        body: JSON.stringify(['invalid', 'array']),
      });
      assert.strictEqual(res.status, 400);
      const err = (await res.json()) as { error: { code: string } };
      assert.strictEqual(err.error.code, 'VALIDATION_ERROR');
    });

    it('rejects client attempt to inject userId or unknown fields', async () => {
      const res = await app.request('/api/v1/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: userACookie,
        },
        body: JSON.stringify({
          title: 'Tamper Test',
          userId: '00000000-0000-0000-0000-000000000099',
        }),
      });
      assert.strictEqual(res.status, 400);
      const err = (await res.json()) as { error: { code: string; message: string } };
      assert.strictEqual(err.error.code, 'VALIDATION_ERROR');
      assert.ok(err.error.message.includes('Unknown field: userId'));
    });

    it('rejects non-string title or title exceeding 255 characters', async () => {
      // Non-string title
      const resNonString = await app.request('/api/v1/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: userACookie,
        },
        body: JSON.stringify({ title: 12345 }),
      });
      assert.strictEqual(resNonString.status, 400);

      // Oversized title (> 255 chars)
      const resOversized = await app.request('/api/v1/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: trustedOrigin,
          Cookie: userACookie,
        },
        body: JSON.stringify({ title: 'A'.repeat(256) }),
      });
      assert.strictEqual(resOversized.status, 400);
      const err = (await resOversized.json()) as { error: { code: string; message: string } };
      assert.strictEqual(err.error.code, 'VALIDATION_ERROR');
      assert.ok(err.error.message.includes('255'));
    });

    it('rejects invalid UUID in path parameters with 400 VALIDATION_ERROR', async () => {
      const resGet = await app.request('/api/v1/conversations/not-a-valid-uuid', {
        headers: { Cookie: userACookie },
      });
      assert.strictEqual(resGet.status, 400);
      const errGet = (await resGet.json()) as { error: { code: string; message: string } };
      assert.strictEqual(errGet.error.code, 'VALIDATION_ERROR');
      assert.ok(errGet.error.message.includes('UUID'));

      const resDel = await app.request('/api/v1/conversations/not-a-valid-uuid', {
        method: 'DELETE',
        headers: { Origin: trustedOrigin, Cookie: userACookie },
      });
      assert.strictEqual(resDel.status, 400);
    });
  });

  describe('Pagination & Cursor Validation', () => {
    beforeEach(async () => {
      // Create 5 test conversations for pagination
      for (let i = 1; i <= 5; i++) {
        await app.request('/api/v1/conversations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: trustedOrigin,
            Cookie: userACookie,
          },
          body: JSON.stringify({ title: `Pagination Conv ${i}` }),
        });
      }
    });

    it('paginates deterministically using keyset cursor across multiple pages', async () => {
      // Page 1: limit 2
      const page1Res = await app.request('/api/v1/conversations?limit=2', {
        headers: { Cookie: userACookie },
      });
      assert.strictEqual(page1Res.status, 200);
      const page1 = (await page1Res.json()) as ConversationListResponse;
      assert.strictEqual(page1.items.length, 2);
      assert.ok(page1.nextCursor);

      // Page 2: limit 2 with cursor from page 1
      const page2Res = await app.request(`/api/v1/conversations?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`, {
        headers: { Cookie: userACookie },
      });
      assert.strictEqual(page2Res.status, 200);
      const page2 = (await page2Res.json()) as ConversationListResponse;
      assert.strictEqual(page2.items.length, 2);
      assert.ok(page2.nextCursor);

      // Page 3: limit 2 with cursor from page 2 (1 item remaining)
      const page3Res = await app.request(`/api/v1/conversations?limit=2&cursor=${encodeURIComponent(page2.nextCursor)}`, {
        headers: { Cookie: userACookie },
      });
      assert.strictEqual(page3Res.status, 200);
      const page3 = (await page3Res.json()) as ConversationListResponse;
      assert.strictEqual(page3.items.length, 1);
      assert.strictEqual(page3.nextCursor, null, 'Final page must return null nextCursor');

      // Verify no overlap across pages
      const allIds = [
        ...page1.items.map((i) => i.id),
        ...page2.items.map((i) => i.id),
        ...page3.items.map((i) => i.id),
      ];
      assert.strictEqual(allIds.length, 5);
      assert.strictEqual(new Set(allIds).size, 5);
    });

    it('rejects invalid limit values (< 1, > 100, non-integer) with 400 VALIDATION_ERROR', async () => {
      for (const badLimit of ['0', '-1', '101', 'abc', '1.5']) {
        const res = await app.request(`/api/v1/conversations?limit=${badLimit}`, {
          headers: { Cookie: userACookie },
        });
        assert.strictEqual(res.status, 400, `Expected 400 for limit=${badLimit}`);
        const err = (await res.json()) as { error: { code: string; message: string } };
        assert.strictEqual(err.error.code, 'VALIDATION_ERROR');
      }
    });

    it('rejects malformed or tampered cursor with 400 VALIDATION_ERROR', async () => {
      // 1. Invalid base64 / non-JSON
      const resBadBase64 = await app.request('/api/v1/conversations?cursor=not-a-valid-base64!', {
        headers: { Cookie: userACookie },
      });
      assert.strictEqual(resBadBase64.status, 400);

      // 2. Valid JSON base64 but missing or invalid fields
      const badJsonPayload = Buffer.from(
        JSON.stringify({ updatedAt: 'invalid-date', id: 'not-a-uuid' })
      ).toString('base64url');

      const resBadJson = await app.request(`/api/v1/conversations?cursor=${badJsonPayload}`, {
        headers: { Cookie: userACookie },
      });
      assert.strictEqual(resBadJson.status, 400);
      const err = (await resBadJson.json()) as { error: { code: string } };
      assert.strictEqual(err.error.code, 'VALIDATION_ERROR');
    });
  });
});
