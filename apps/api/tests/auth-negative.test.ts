import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/create-app.js';
import { createTestDatabase, type TestDbInstance } from './test-db-helper.js';
import { hashSessionToken } from '../src/modules/auth/session.js';

describe('Authentication Negative and Security Tests', () => {
  let db: TestDbInstance;
  let app: ReturnType<typeof createApp>;

  before(async () => {
    db = await createTestDatabase();
    app = createApp({
      pool: db.pool,
      config: {
        allowedOrigins: ['https://giga.local', 'http://localhost:5173'],
      },
    });
  });

  beforeEach(async () => {
    await db.cleanup();
  });

  after(async () => {
    await db.pool.end();
  });

  it('rejects duplicate email registration with 409 CONFLICT', async () => {
    const payload = {
      email: 'duplicate@test.com',
      password: 'password123',
      displayName: 'First User',
    };

    // First registration succeeds
    const res1 = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://giga.local' },
      body: JSON.stringify(payload),
    });
    assert.strictEqual(res1.status, 201);

    // Duplicate registration (different case) fails with 409
    const res2 = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://giga.local' },
      body: JSON.stringify({
        ...payload,
        email: 'DUPLICATE@TEST.COM',
        displayName: 'Second User',
      }),
    });
    assert.strictEqual(res2.status, 409);
    const body = (await res2.json()) as { error: { code: string; message: string } };
    assert.strictEqual(body.error.code, 'CONFLICT');
    assert.match(body.error.message, /already exists/i);
  });

  it('rejects invalid registration inputs with 400 VALIDATION_ERROR', async () => {
    // Missing email
    const res1 = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://giga.local' },
      body: JSON.stringify({ password: 'password123', displayName: 'User' }),
    });
    assert.strictEqual(res1.status, 400);

    // Invalid email format
    const res2 = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://giga.local' },
      body: JSON.stringify({ email: 'notanemail', password: 'password123', displayName: 'User' }),
    });
    assert.strictEqual(res2.status, 400);

    // Password too short (< 8 chars)
    const res3 = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://giga.local' },
      body: JSON.stringify({ email: 'user@test.com', password: '123', displayName: 'User' }),
    });
    assert.strictEqual(res3.status, 400);

    // Missing display name
    const res4 = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://giga.local' },
      body: JSON.stringify({ email: 'user@test.com', password: 'password123' }),
    });
    assert.strictEqual(res4.status, 400);
  });

  it('returns generic error on wrong password or unknown user to prevent enumeration', async () => {
    // Register test account
    await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://giga.local' },
      body: JSON.stringify({
        email: 'known@test.com',
        password: 'correct-password',
        displayName: 'Known User',
      }),
    });

    // Wrong password
    const wrongPassRes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://giga.local' },
      body: JSON.stringify({ email: 'known@test.com', password: 'wrong-password' }),
    });
    assert.strictEqual(wrongPassRes.status, 401);
    const wrongPassBody = (await wrongPassRes.json()) as { error: { code: string; message: string } };

    // Unknown user
    const unknownUserRes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://giga.local' },
      body: JSON.stringify({ email: 'unknown@test.com', password: 'correct-password' }),
    });
    assert.strictEqual(unknownUserRes.status, 401);
    const unknownUserBody = (await unknownUserRes.json()) as { error: { code: string; message: string } };

    // Both error messages MUST be identical to prevent user enumeration
    assert.deepStrictEqual(wrongPassBody, unknownUserBody);
    assert.strictEqual(wrongPassBody.error.code, 'UNAUTHENTICATED');
    assert.strictEqual(wrongPassBody.error.message, 'Invalid email or password');
  });

  it('rejects /auth/me without session cookie', async () => {
    const res = await app.request('/api/v1/auth/me');
    assert.strictEqual(res.status, 401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.strictEqual(body.error.code, 'UNAUTHENTICATED');
  });

  it('rejects /auth/me with invalid or fabricated session token', async () => {
    const res = await app.request('/api/v1/auth/me', {
      headers: { Cookie: 'giga_session=malicious_fake_token_1234567890' },
    });
    assert.strictEqual(res.status, 401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.strictEqual(body.error.code, 'UNAUTHENTICATED');
  });

  it('rejects expired session tokens', async () => {
    // Create user and expired session directly in DB
    const userRes = await db.pool.query(
      "INSERT INTO users (email, display_name, password_hash) VALUES ('expired@test.com', 'Expired', 'hash') RETURNING id;"
    );
    const userId = userRes.rows[0].id;

    const rawToken = 'expired_token_12345678901234567890123456789012';
    const tokenHash = hashSessionToken(rawToken);
    const pastDate = new Date(Date.now() - 3600000); // 1 hour ago

    await db.pool.query(
      'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3);',
      [userId, tokenHash, pastDate]
    );

    const res = await app.request('/api/v1/auth/me', {
      headers: { Cookie: `giga_session=${rawToken}` },
    });
    assert.strictEqual(res.status, 401);
  });

  it('rejects malformed JSON payload with 400 VALIDATION_ERROR', async () => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://giga.local' },
      body: '{ not valid json',
    });
    assert.strictEqual(res.status, 400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.strictEqual(body.error.code, 'VALIDATION_ERROR');
    assert.match(body.error.message, /JSON/i);
  });

  it('handles repeated logout safely and idempotently', async () => {
    const res1 = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { Origin: 'https://giga.local' },
    });
    assert.strictEqual(res1.status, 204);

    const res2 = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { Origin: 'https://giga.local' },
    });
    assert.strictEqual(res2.status, 204);
  });

  it('rejects state-changing requests from untrusted origins (CSRF protection)', async () => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil-hacker-site.com',
      },
      body: JSON.stringify({ email: 'test@test.com', password: 'password123' }),
    });

    assert.strictEqual(res.status, 403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.strictEqual(body.error.code, 'FORBIDDEN');
    assert.match(body.error.message, /Untrusted request origin/i);
  });

  it('rejects state-changing requests missing origin header (CSRF fail-closed)', async () => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: 'test@test.com', password: 'password123' }),
    });

    assert.strictEqual(res.status, 403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.strictEqual(body.error.code, 'FORBIDDEN');
    assert.match(body.error.message, /Untrusted request origin/i);
  });
});
