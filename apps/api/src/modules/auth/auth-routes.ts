import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AuthService } from './auth-service.js';
import {
  validateRegisterInput,
  validateLoginInput,
  ValidationError,
} from './auth-validation.js';
import {
  SESSION_COOKIE_NAME,
  getSessionCookieOptions,
  getExpiredCookieOptions,
  type CookieConfig,
} from './session.js';
import { createAuthMiddleware } from './auth-middleware.js';

export interface AuthRouteOptions {
  readonly authService: AuthService;
  readonly cookieConfig: CookieConfig;
}

export function createAuthRoutes(options: AuthRouteOptions): Hono {
  const router = new Hono();
  const { authService, cookieConfig } = options;

  // POST /api/v1/auth/register
  router.post('/register', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError('Malformed JSON payload');
    }

    const input = validateRegisterInput(body);
    const user = await authService.register(input);

    return c.json({ user }, 201);
  });

  // POST /api/v1/auth/login
  router.post('/login', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError('Malformed JSON payload');
    }

    const input = validateLoginInput(body);
    const { user, sessionToken } = await authService.login(input);

    // Set secure HttpOnly session cookie
    setCookie(c, SESSION_COOKIE_NAME, sessionToken, getSessionCookieOptions(cookieConfig));

    return c.json({ user }, 200);
  });

  // POST /api/v1/auth/logout
  router.post('/logout', async (c) => {
    const sessionToken = getCookie(c, SESSION_COOKIE_NAME);

    if (sessionToken) {
      await authService.logout(sessionToken);
    }

    // Always expire/clear the session cookie
    setCookie(c, SESSION_COOKIE_NAME, '', getExpiredCookieOptions(cookieConfig));

    return c.body(null, 204);
  });

  // GET /api/v1/auth/me (Protected route)
  const requireAuth = createAuthMiddleware(authService);
  router.get('/me', requireAuth, (c) => {
    const user = c.get('user');
    return c.json({ user }, 200);
  });

  return router;
}
