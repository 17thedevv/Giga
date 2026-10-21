import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app/create-app.js';
import { createWebUi } from '../src/app/web-ui.js';

describe('Optional same-origin web hosting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'giga-web-ui-'));
  await mkdir(join(root, 'assets'));
  await mkdir(join(root, 'giga'));
  await writeFile(join(root, 'index.html'), '<html><body>Giga fixture</body></html>');
  await writeFile(join(root, 'assets', 'app.js'), 'console.log("fixture");');
  await writeFile(join(root, 'giga', 'logo.svg'), '<svg></svg>');
  await writeFile(join(root, '.env'), 'DO_NOT_SERVE');
  after(async () => {
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep));
    await rm(target, { recursive: true, force: true });
  });

  const app = createApp();
  app.route('/', createWebUi(root));

  it('serves the SPA for supported deep links without caching the entrypoint', async () => {
    for (const path of ['/login', '/chat/example', '/agent/runs/example', '/settings', '/personalization']) {
      const res = await app.request(path);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('Content-Type') ?? '', /text\/html/);
      assert.equal(res.headers.get('Cache-Control'), 'no-store');
      assert.match(await res.text(), /Giga fixture/);
    }
  });

  it('serves built assets but does not turn missing assets into HTML', async () => {
    const js = await app.request('/assets/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('Content-Type') ?? '', /javascript/);
    assert.equal((await app.request('/giga/logo.svg')).status, 200);
    const missing = await app.request('/assets/missing.js');
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'NOT_FOUND');
  });

  it('preserves API, health, unknown-route and method boundaries', async () => {
    const health = await app.request('/health');
    assert.equal((await health.json()).service, 'giga-api');
    for (const path of ['/api/v1/missing', '/unknown', '/.env', '/assets/%2e%2e/.env']) {
      const res = await app.request(path);
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.code, 'NOT_FOUND');
    }
    assert.equal((await app.request('/login', { method: 'POST' })).status, 404);
  });

  it('fails before startup when the opt-in bundle is missing', () => {
    assert.throws(() => createWebUi(join(root, 'missing')), /requires a built apps\/web\/dist bundle/);
  });
});
