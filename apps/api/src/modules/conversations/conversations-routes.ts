import { Hono } from 'hono';
import type { AuthService } from '../auth/auth-service.js';
import { createAuthMiddleware } from '../auth/auth-middleware.js';
import type { ConversationsService } from './conversations-service.js';
import {
  ValidationError,
  validateCreateConversationInput,
  validatePaginationParams,
  validateUuid,
} from './conversations-validation.js';

export interface ConversationRoutesOptions {
  readonly conversationsService: ConversationsService;
  readonly authService: AuthService;
}

export function createConversationRoutes(options: ConversationRoutesOptions): Hono {
  const router = new Hono();
  const authMiddleware = createAuthMiddleware(options.authService);

  // Apply authentication to all conversation routes
  router.use('*', authMiddleware);

  /**
   * GET /api/v1/conversations
   * Lists conversations for the authenticated user with deterministic keyset pagination.
   */
  router.get('/', async (c) => {
    const user = c.get('user');
    const { limit, cursor } = validatePaginationParams(c.req.query());
    const response = await options.conversationsService.listConversations(user.id, {
      limit,
      cursor,
    });
    return c.json(response, 200);
  });

  /**
   * POST /api/v1/conversations
   * Creates a new conversation for the authenticated user.
   */
  router.post('/', async (c) => {
    const user = c.get('user');

    let body: unknown;
    try {
      const text = await c.req.text();
      body = text.trim() === '' ? {} : JSON.parse(text);
    } catch {
      throw new ValidationError('Invalid JSON payload');
    }

    const input = validateCreateConversationInput(body);
    const conversation = await options.conversationsService.createConversation(user.id, input);
    return c.json({ conversation }, 201);
  });

  /**
   * GET /api/v1/conversations/:id
   * Retrieves conversation details and ordered message history.
   */
  router.get('/:id', async (c) => {
    const user = c.get('user');
    const id = validateUuid(c.req.param('id'), 'conversation ID');
    const result = await options.conversationsService.getConversationWithMessages(id, user.id);
    return c.json(result, 200);
  });

  /**
   * DELETE /api/v1/conversations/:id
   * Deletes a conversation and its messages.
   */
  router.delete('/:id', async (c) => {
    const user = c.get('user');
    const id = validateUuid(c.req.param('id'), 'conversation ID');
    await options.conversationsService.deleteConversation(id, user.id);
    return c.body(null, 204);
  });

  return router;
}
