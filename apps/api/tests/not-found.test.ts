import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, type ErrorResponse } from '../src/app/create-app.js';

describe('404 Route Handler', () => {
  it('returns HTTP 404 with structured error JSON on unknown GET route', async () => {
    const app = createApp();
    const res = await app.request('/unknown-route');

    assert.strictEqual(res.status, 404);
    assert.match(
      res.headers.get('content-type') ?? '',
      /application\/json/i
    );

    const body = (await res.json()) as ErrorResponse;
    assert.deepStrictEqual(body, {
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
      },
    });
  });

  it('returns HTTP 404 on unknown POST route without leaking internals', async () => {
    const app = createApp();
    const res = await app.request('/api/v1/non-existent', {
      method: 'POST',
      body: JSON.stringify({ test: true }),
      headers: { 'content-type': 'application/json' },
    });

    assert.strictEqual(res.status, 404);
    const body = (await res.json()) as Record<string, unknown>;
    assert.strictEqual(typeof body['error'], 'object');
    assert.strictEqual((body['error'] as { code: string }).code, 'NOT_FOUND');
    // Ensure no stack traces or sensitive keys are leaked
    assert.strictEqual(body['stack'], undefined);
    assert.strictEqual((body['error'] as Record<string, unknown>)['stack'], undefined);
  });
});
