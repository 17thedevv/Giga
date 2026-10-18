import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AuthService } from '../auth/auth-service.js';
import { createAuthMiddleware } from '../auth/auth-middleware.js';
import { ValidationError } from '../auth/auth-validation.js';
import type { AgentService } from './service.js';
import { agentUuid, eventCursor, listMessagesOptions, listOptions } from './validation.js';
import { observeEvents, type ObserverOptions } from './sse.js';
import { getAgentCapabilities } from './capabilities.js';

export function createAgentRoutes(service: AgentService, auth: AuthService, observerOptions?: ObserverOptions): Hono {
  const router = new Hono();
  router.use('*', createAuthMiddleware(auth));
  router.use('*', bodyLimit({ maxSize: 100000, onError: () => { throw new ValidationError('Request body exceeds size limit'); } }));
  router.get('/capabilities', (c) => {
    if (Object.keys(c.req.queries()).length) throw new ValidationError('Unknown query parameters');
    c.header('Cache-Control', 'private, no-store');
    return c.json(getAgentCapabilities());
  });
  async function json(req: { json(): Promise<unknown> }): Promise<unknown> {
    try { return await req.json(); } catch { throw new ValidationError('Invalid JSON payload'); }
  }
  router.post('/workspaces', async (c) => c.json({ workspace: await service.createWorkspace(c.get('user').id, await json(c.req)) }, 201));
  router.get('/workspaces', async (c) => c.json(await service.repository.listWorkspaces(c.get('user').id, listOptions(c.req.queries(), 'workspaces'))));
  router.get('/workspaces/:id', async (c) => c.json({ workspace: await service.repository.getWorkspace(c.get('user').id, agentUuid(c.req.param('id'))) }));
  router.post('/runs', async (c) => {
    const result = await service.createRun(c.get('user').id, await json(c.req), c.req.header('Idempotency-Key'));
    return c.json({ run: result.run }, result.duplicate ? 200 : 201);
  });
  router.get('/runs', async (c) => c.json(await service.repository.listRuns(c.get('user').id, listOptions(c.req.queries(), 'runs'))));
  router.get('/runs/:id', async (c) => c.json({ run: await service.repository.getRun(c.get('user').id, agentUuid(c.req.param('id'))) }));
  router.post('/runs/:id/messages', async (c) => {
    const ownerId = c.get('user').id;
    const runId = agentUuid(c.req.param('id'));
    const result = await service.appendMessage(
      ownerId,
      runId,
      await json(c.req),
      c.req.header('Idempotency-Key')
    );
    return c.json({ message: result.message }, result.duplicate ? 200 : 201);
  });
  router.get('/runs/:id/messages', async (c) => {
    const ownerId = c.get('user').id;
    const runId = agentUuid(c.req.param('id'));
    const options = listMessagesOptions(c.req.queries(), runId);
    return c.json(await service.repository.listMessages(ownerId, runId, options));
  });
  router.get('/runs/:id/events', async (c) => {
    const ownerId = c.get('user').id; const id = agentUuid(c.req.param('id'));
    const page = await service.repository.events(ownerId, id, 0); // Authorize before interpreting resource-specific cursor.
    if (Object.keys(c.req.queries()).length) throw new ValidationError('Unknown query parameters');
    const after = eventCursor(c.req.header('Last-Event-ID'));
    if (after > page.lastEventId) throw new ValidationError('Last-Event-ID exceeds run sequence');
    // Terminal replay is still an observation; no worker is started, stopped or resumed.
    return observeEvents(service.repository, ownerId, id, after, c.req.raw.signal, observerOptions);
  });
  return router;
}
