import type { MiddlewareHandler } from 'hono';
import { ForbiddenError } from './auth-validation.js';

export interface CsrfOptions {
  readonly allowedOrigins: readonly string[];
  readonly isDevelopment: boolean;
}

/**
 * Validates request Origin / Referer on state-changing methods to mitigate Cross-Site Request Forgery (CSRF).
 */
export function createCsrfMiddleware(options: CsrfOptions): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();

    // Safe idempotent methods do not modify server state
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return next();
    }

    const origin = c.req.header('origin');

    // If an Origin header is sent and allowedOrigins is configured
    if (origin && options.allowedOrigins.length > 0) {
      const isAllowed = options.allowedOrigins.some(
        (allowed) => allowed === origin || allowed === '*'
      );

      if (!isAllowed) {
        throw new ForbiddenError(`Untrusted request origin: ${origin}`);
      }
    }

    return next();
  };
}
