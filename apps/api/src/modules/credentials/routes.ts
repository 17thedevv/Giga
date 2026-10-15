import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AuthService } from '../auth/auth-service.js';
import { createAuthMiddleware } from '../auth/auth-middleware.js';
import { ValidationError } from '../auth/auth-validation.js';
import { validateUuid } from '../conversations/conversations-validation.js';
import type { ChatCredentialsService } from './service.js';

function object(body: unknown, fields: string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !fields.includes(key))) throw new ValidationError('Invalid request fields');
  return body as Record<string, unknown>;
}
async function json(request: { text(): Promise<string> }, fields: string[], optional = false): Promise<Record<string, unknown>> {
  const text = await request.text();
  let body: unknown;
  try { body = optional && !text ? {} : JSON.parse(text); } catch { throw new ValidationError('Malformed JSON payload'); }
  return object(body, fields);
}

export function createCredentialRoutes(service: ChatCredentialsService, auth: AuthService): Hono {
  const router = new Hono();
  const authenticate = createAuthMiddleware(auth);
  const limit = bodyLimit({ maxSize: 2048, onError: () => { throw new ValidationError('Request body is too large'); } });
  const noStore: MiddlewareHandler = async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); };
  // This router is mounted at /me. Never apply credential limits to Skills preferences.
  for (const path of ['/provider-credentials', '/provider-credentials/*', '/chat-credential-preference']) {
    router.use(path, authenticate, limit, noStore);
  }
  router.get('/provider-credentials', async (c) => c.json({ items: await service.list(c.get('user').id) }));
  router.post('/provider-credentials', async (c) => {
    const body = await json(c.req, ['provider', 'apiKey']);
    return c.json({ credential: await service.save(c.get('user').id, body.provider, body.apiKey) }, 201);
  });
  router.delete('/provider-credentials/:id', async (c) => {
    await service.delete(c.get('user').id, validateUuid(c.req.param('id')));
    return c.body(null, 204);
  });
  router.post('/provider-credentials/:id/validate', async (c) => {
    await json(c.req, [], true);
    return c.json({ credential: await service.validate(c.get('user').id, validateUuid(c.req.param('id')), c.req.raw.signal) });
  });
  router.get('/chat-credential-preference', async (c) => c.json(await service.preference(c.get('user').id)));
  router.put('/chat-credential-preference', async (c) => {
    const body = await json(c.req, ['mode', 'credentialId']);
    if (body.credentialId !== undefined && body.credentialId !== null) {
      if (typeof body.credentialId !== 'string') throw new ValidationError('Invalid credential ID');
      body.credentialId = validateUuid(body.credentialId);
    }
    return c.json(await service.setPreference(c.get('user').id, body.mode, body.credentialId));
  });
  return router;
}
