import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AuthService } from '../auth/auth-service.js';
import { createAuthMiddleware } from '../auth/auth-middleware.js';
import { ValidationError } from '../auth/auth-validation.js';
import { validateUuid } from '../conversations/conversations-validation.js';
import type { ChatRuntime } from './chat-runtime.js';

export function createChatRoutes(runtime: ChatRuntime, auth: AuthService): Hono {
  const router = new Hono();
  router.use('*', createAuthMiddleware(auth));
  // Both admissions share the exact same streaming coordinator and response framing.
  router.post('/:id/:transport{messages:stream|generations:stream}', bodyLimit({ maxSize: 100000, onError: () => {
    throw new ValidationError('Request body exceeds size limit');
  } }), async (c) => {
    const conversationId = validateUuid(c.req.param('id'));
    let body: unknown;
    try { body = await c.req.json(); } catch { throw new ValidationError('Invalid JSON payload'); }
    const admission = c.req.param('transport') === 'generations:stream'
      ? await runtime.admitVariant(c.get('user').id, conversationId, body, c.req.header('Idempotency-Key'))
      : await runtime.admit(c.get('user').id, conversationId, body, c.req.header('Idempotency-Key'));
    if (admission.duplicate) {
      return c.json({ error: { code: 'CONFLICT', message: 'Generation already exists; reconcile using GET' }, generation: admission.generation }, 409);
    }
    const transform = new TransformStream<Uint8Array, Uint8Array>();
    const writer = transform.writable.getWriter();
    const encoder = new TextEncoder();
    const ownerId = c.get('user').id;
    // writer.write rejects on downstream cancellation; backpressure is bounded in the coordinator.
    void runtime.run(ownerId, admission.generation, async ({ event, data }) => {
      await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    }, c.req.raw.signal).finally(async () => {
      try { await writer.close(); } catch { /* downstream disconnected */ }
    });
    return new Response(transform.readable, { headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    } });
  });
  router.get('/:id/messages/:userMessageId/generations', async (c) => {
    return c.json(await runtime.variants(c.get('user').id, validateUuid(c.req.param('id')), validateUuid(c.req.param('userMessageId'))));
  });
  router.get('/:id/generations/:generationId', async (c) => {
    const generation = await runtime.get(c.get('user').id, validateUuid(c.req.param('id')), validateUuid(c.req.param('generationId')));
    return c.json({ generation });
  });
  router.post('/:id/generations/:generationId/cancel', bodyLimit({ maxSize: 1, onError: () => {
    throw new ValidationError('Cancel requires an empty body');
  } }), async (c) => {
    if ((await c.req.text()) !== '') throw new ValidationError('Cancel requires an empty body');
    const result = await runtime.cancel(c.get('user').id, validateUuid(c.req.param('id')),
      validateUuid(c.req.param('generationId')), c.req.header('Idempotency-Key'));
    return c.json({ generation: result.generation }, result.accepted ? 202 : 200);
  });
  return router;
}

export function createModelRoutes(runtime: ChatRuntime, auth: AuthService): Hono {
  const router = new Hono();
  router.use('*', createAuthMiddleware(auth));
  router.get('/', async (c) => {
    return c.json({ models: runtime.listModels() });
  });
  return router;
}
