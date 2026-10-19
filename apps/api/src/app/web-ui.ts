import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';

const WEB_ROOT = fileURLToPath(new URL('../../../web/dist/', import.meta.url));

/** Only web routes are mounted; unknown API routes keep their JSON 404. */
export function createWebUi(root = WEB_ROOT): Hono {
  if (!existsSync(join(root, 'index.html'))) {
    throw new Error('SERVE_WEB requires a built apps/web/dist bundle');
  }
  const web = new Hono();
  web.get('/assets/*', serveStatic({ root }));
  web.get('/giga/*', serveStatic({ root }));
  const index = serveStatic({ root, path: 'index.html' });
  for (const route of [
    '/', '/login', '/chat', '/chat/:conversationId', '/agent', '/agent/runs/:runId',
    '/skills', '/skills/*', '/personalization', '/personalization/*', '/settings', '/settings/*',
  ]) {
    web.get(route, (c, next) => {
      c.header('Cache-Control', 'no-store');
      return index(c, next);
    });
  }
  return web;
}
