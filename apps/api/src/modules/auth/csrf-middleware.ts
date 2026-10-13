import type { MiddlewareHandler } from 'hono';
import { ForbiddenError } from './auth-validation.js';

export interface CsrfOptions {
  readonly allowedOrigins: readonly string[];
  readonly isProduction?: boolean;
}

function parseOriginSafely(raw?: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Validates request Origin / Referer on state-changing methods to mitigate Cross-Site Request Forgery (CSRF).
 *
 * Security guarantees:
 * - Fail-closed: all state-changing requests (POST, PUT, DELETE, PATCH) MUST have a valid, trusted origin.
 * - Missing Origin falls back only to securely parsed Referer origin.
 * - Missing or empty origin configuration denies all mutations.
 * - Wildcard '*' origins are forbidden in production.
 * - Static safe error response: does not reflect attacker-controlled input.
 */
export function createCsrfMiddleware(options: CsrfOptions): MiddlewareHandler {
  const isProd = options.isProduction ?? false;

  const trustedOrigins = new Set<string>();
  for (const origin of options.allowedOrigins) {
    if (origin === '*') {
      if (!isProd) {
        trustedOrigins.add('*');
      }
      continue;
    }
    const normalized = parseOriginSafely(origin);
    if (normalized) {
      trustedOrigins.add(normalized);
    }
  }

  return async (c, next) => {
    const method = c.req.method.toUpperCase();

    // Safe idempotent methods do not modify server state
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return next();
    }

    // Fail closed: if no trusted origins exist, deny all state-changing mutations
    if (trustedOrigins.size === 0) {
      throw new ForbiddenError('Untrusted request origin');
    }

    const originHeader = c.req.header('origin');
    const refererHeader = c.req.header('referer');

    let candidateOrigin: string | null = null;

    if (originHeader) {
      candidateOrigin = parseOriginSafely(originHeader);
      if (!candidateOrigin) {
        // Malformed Origin header
        throw new ForbiddenError('Untrusted request origin');
      }
    } else if (refererHeader) {
      // Secure fallback: extract and validate the complete origin of Referer
      candidateOrigin = parseOriginSafely(refererHeader);
      if (!candidateOrigin) {
        // Malformed Referer header
        throw new ForbiddenError('Untrusted request origin');
      }
    } else {
      // Missing both Origin and Referer on state-changing request
      throw new ForbiddenError('Untrusted request origin');
    }

    // Wildcard allowed ONLY in non-production environments
    if (!isProd && trustedOrigins.has('*')) {
      return next();
    }

    if (!trustedOrigins.has(candidateOrigin)) {
      // Safe static message - do NOT reflect attacker-controlled header content
      throw new ForbiddenError('Untrusted request origin');
    }

    return next();
  };
}
