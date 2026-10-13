import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, type HealthResponse } from '../src/app/create-app.js';

describe('GET /health', () => {
  it('returns HTTP 200 and health status JSON', async () => {
    const app = createApp();
    const res = await app.request('/health');

    assert.strictEqual(res.status, 200);
    assert.match(
      res.headers.get('content-type') ?? '',
      /application\/json/i
    );

    const body = (await res.json()) as HealthResponse;
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.service, 'giga-api');
    assert.ok(typeof body.timestamp === 'string');
    assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
  });

  it('rejects POST /health with 404', async () => {
    const app = createApp();
    const res = await app.request('/health', { method: 'POST' });

    assert.strictEqual(res.status, 404);
  });
});
