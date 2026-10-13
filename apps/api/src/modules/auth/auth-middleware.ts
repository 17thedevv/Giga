import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { SESSION_COOKIE_NAME } from './session.js';
import { UnauthenticatedError } from './auth-validation.js';
import type { AuthService, UserPublic } from './auth-service.js';

declare module 'hono' {
  interface ContextVariableMap {
    user: UserPublic;
    sessionToken: string;
  }
}

/**
 * Middleware ensuring request carries a valid, active session cookie.
 */
export function createAuthMiddleware(authService: AuthService): MiddlewareHandler {
  return async (c, next) => {
    const sessionToken = getCookie(c, SESSION_COOKIE_NAME);
    if (!sessionToken) {
      throw new UnauthenticatedError('Authentication required');
    }

    const user = await authService.getMe(sessionToken);
    c.set('user', user);
    c.set('sessionToken', sessionToken);

    return next();
  };
}
