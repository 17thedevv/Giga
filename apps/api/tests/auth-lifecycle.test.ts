import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/create-app.js';
import { createTestDatabase, type TestDbInstance } from './test-db-helper.js';

describe('Authentication Lifecycle Integration', () => {
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

  it('executes full auth lifecycle: register -> persist -> login -> me -> logout -> me rejected', async () => {
    // 1. Register a new user
    const registerPayload = {
      email: 'Tra@Example.com', // Test case-insensitivity / normalization
      password: 'StrongPassword123!',
      displayName: 'Trà Backend',
    };

    const registerRes = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: trustedOrigin,
      },
      body: JSON.stringify(registerPayload),
    });

    assert.strictEqual(registerRes.status, 201);
    const registerData = (await registerRes.json()) as { user: { id: string; email: string; displayName: string } };
    assert.ok(registerData.user.id);
    assert.strictEqual(registerData.user.email, 'tra@example.com'); // Lowercase normalized
    assert.strictEqual(registerData.user.displayName, 'Trà Backend');

    // 2. Verify user record is persisted in PostgreSQL
    const dbCheck = await db.pool.query('SELECT * FROM users WHERE id = $1;', [registerData.user.id]);
    assert.strictEqual(dbCheck.rows.length, 1);
    const dbUser = dbCheck.rows[0];
    assert.strictEqual(dbUser.email, 'tra@example.com');
    assert.notStrictEqual(dbUser.password_hash, registerPayload.password); // Password MUST be hashed
    assert.match(dbUser.password_hash, /^\$argon2id\$/); // Argon2id hash format

    // 3. Login with valid credentials
    const loginRes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: trustedOrigin,
      },
      body: JSON.stringify({
        email: 'TRA@EXAMPLE.COM',
        password: 'StrongPassword123!',
      }),
    });

    assert.strictEqual(loginRes.status, 200);
    const loginData = (await loginRes.json()) as { user: { id: string; email: string; displayName: string } };
    assert.strictEqual(loginData.user.id, registerData.user.id);

    // 4. Extract session cookie from Set-Cookie header
    const setCookieHeader = loginRes.headers.get('set-cookie');
    assert.ok(setCookieHeader, 'Set-Cookie header must be present');
    assert.match(setCookieHeader, /giga_session=[a-f0-9]{64}/);
    assert.match(setCookieHeader, /HttpOnly/i);

    const cookieMatch = setCookieHeader.match(/giga_session=([^;]+)/);
    assert.ok(cookieMatch && cookieMatch[1]);
    const sessionToken = cookieMatch[1];

    // Verify session state in database
    const sessionDbCheck = await db.pool.query('SELECT * FROM sessions WHERE user_id = $1;', [registerData.user.id]);
    assert.strictEqual(sessionDbCheck.rows.length, 1);
    assert.strictEqual(sessionDbCheck.rows[0].revoked_at, null);

    // 5. Call GET /api/v1/auth/me with valid session cookie
    const meRes = await app.request('/api/v1/auth/me', {
      headers: {
        Cookie: `giga_session=${sessionToken}`,
      },
    });

    assert.strictEqual(meRes.status, 200);
    const meData = (await meRes.json()) as { user: { id: string; email: string; displayName: string } };
    assert.strictEqual(meData.user.id, registerData.user.id);
    assert.strictEqual(meData.user.email, 'tra@example.com');
    assert.strictEqual(meData.user.displayName, 'Trà Backend');

    // 6. Logout
    const logoutRes = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        Origin: trustedOrigin,
        Cookie: `giga_session=${sessionToken}`,
      },
    });

    assert.strictEqual(logoutRes.status, 204);
    const logoutCookieHeader = logoutRes.headers.get('set-cookie');
    assert.ok(logoutCookieHeader);
    assert.match(logoutCookieHeader, /Max-Age=0/i);

    // Verify session revoked in database
    const revokedSessionCheck = await db.pool.query('SELECT * FROM sessions WHERE user_id = $1;', [registerData.user.id]);
    assert.ok(revokedSessionCheck.rows[0].revoked_at !== null, 'Session must have revoked_at timestamp set');

    // 7. Call GET /api/v1/auth/me again -> MUST receive 401 UNAUTHENTICATED
    const meAfterLogoutRes = await app.request('/api/v1/auth/me', {
      headers: {
        Cookie: `giga_session=${sessionToken}`,
      },
    });

    assert.strictEqual(meAfterLogoutRes.status, 401);
    const meAfterLogoutData = (await meAfterLogoutRes.json()) as { error: { code: string; message: string } };
    assert.deepStrictEqual(meAfterLogoutData, {
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Authentication required',
      },
    });
  });
});
