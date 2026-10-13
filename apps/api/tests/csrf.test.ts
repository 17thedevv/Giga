import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app/create-app.js';
import { parseAllowedOrigins } from '../src/app/config.js';

describe('CSRF Protection Hardening', () => {
  const trustedOrigin = 'https://app.giga.internal';

  const app = createApp({
    config: {
      allowedOrigins: [trustedOrigin],
      nodeEnv: 'development',
    },
  });

  it('accepts state-changing requests with a trusted Origin', async () => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: trustedOrigin,
      },
      body: JSON.stringify({ email: 'user@test.com', password: 'password123' }),
    });

    // Request passes CSRF middleware; reaches route (returns 401 unauthenticated, NOT 403 forbidden)
    assert.notStrictEqual(res.status, 403);
  });

  it('rejects state-changing requests from an unknown Origin with 403 FORBIDDEN', async () => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://malicious-attacker.com',
      },
      body: JSON.stringify({ email: 'user@test.com', password: 'password123' }),
    });

    assert.strictEqual(res.status, 403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.strictEqual(body.error.code, 'FORBIDDEN');
    // Security check: error message MUST NOT reflect the attacker's origin
    assert.strictEqual(body.error.message, 'Untrusted request origin');
  });

  it('rejects state-changing requests when both Origin and Referer are missing', async () => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: 'user@test.com', password: 'password123' }),
    });

    assert.strictEqual(res.status, 403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.strictEqual(body.error.code, 'FORBIDDEN');
    assert.strictEqual(body.error.message, 'Untrusted request origin');
  });

  it('accepts missing Origin when a trusted Referer origin is provided', async () => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Referer: `${trustedOrigin}/login?redirect=dashboard`,
      },
      body: JSON.stringify({ email: 'user@test.com', password: 'password123' }),
    });

    // Bypasses CSRF via valid Referer fallback; reaches auth validation
    assert.notStrictEqual(res.status, 403);
  });

  it('rejects malformed Referer headers with 403 FORBIDDEN', async () => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Referer: 'not-a-valid-url',
      },
      body: JSON.stringify({ email: 'user@test.com', password: 'password123' }),
    });

    assert.strictEqual(res.status, 403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.strictEqual(body.error.code, 'FORBIDDEN');
    assert.strictEqual(body.error.message, 'Untrusted request origin');
  });

  it('rejects untrusted Referer origin with 403 FORBIDDEN', async () => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Referer: 'https://evil.com/phishing',
      },
      body: JSON.stringify({ email: 'user@test.com', password: 'password123' }),
    });

    assert.strictEqual(res.status, 403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.strictEqual(body.error.code, 'FORBIDDEN');
  });

  it('fails closed when origin configuration is completely empty', async () => {
    // App with empty allowedOrigins
    const emptyApp = createApp({
      config: {
        allowedOrigins: [],
        nodeEnv: 'development',
      },
    });

    const res = await emptyApp.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: trustedOrigin,
      },
      body: JSON.stringify({ email: 'user@test.com', password: 'password123' }),
    });

    // Must fail closed (403) instead of silently skipping verification
    assert.strictEqual(res.status, 403);
  });

  it('rejects wildcard origin in production mode during configuration loading', () => {
    assert.throws(
      () => parseAllowedOrigins('*', true),
      /Wildcard origin '\*' is forbidden in production mode/
    );

    assert.throws(
      () => parseAllowedOrigins('https://app.giga.com, *', true),
      /Wildcard origin '\*' is forbidden in production mode/
    );
  });

  it('requires ALLOWED_ORIGINS in production mode', () => {
    assert.throws(
      () => parseAllowedOrigins(undefined, true),
      /ALLOWED_ORIGINS environment variable is required in production mode/
    );

    assert.throws(
      () => parseAllowedOrigins('', true),
      /ALLOWED_ORIGINS environment variable is required in production mode/
    );
  });

  it('rejects cross-origin cookie-authenticated mutations from attacker origin', async () => {
    const res = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        Origin: 'https://attacker.site',
        Cookie: 'giga_session=dummy_session_token_12345678901234567890123456789012',
      },
    });

    assert.strictEqual(res.status, 403);
  });

  it('leaves GET /health completely unaffected', async () => {
    const res = await app.request('/health', {
      method: 'GET',
      headers: {
        Origin: 'https://untrusted-external-scanner.com',
      },
    });

    assert.strictEqual(res.status, 200);
  });
});
