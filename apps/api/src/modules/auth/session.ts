import crypto from 'node:crypto';

export const SESSION_COOKIE_NAME = 'giga_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 604,800 seconds

/**
 * Generates an unpredictable 256-bit cryptographically secure session token.
 */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Computes the SHA-256 hash of a session token for secure database storage.
 * Only the hash is stored in PostgreSQL; raw tokens never touch the database.
 */
export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Calculates session expiration date from current time.
 */
export function calculateSessionExpiry(now = new Date()): Date {
  return new Date(now.getTime() + SESSION_TTL_MS);
}

export interface CookieConfig {
  readonly secure: boolean;
  readonly sameSite: 'lax' | 'strict' | 'none';
}

/**
 * Returns cookie options for setting the authenticated session cookie.
 */
export function getSessionCookieOptions(config: CookieConfig): {
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  maxAge: number;
} {
  return {
    path: '/',
    httpOnly: true,
    secure: config.secure,
    sameSite: config.sameSite,
    maxAge: SESSION_TTL_SECONDS,
  };
}

/**
 * Returns cookie options for expiring/clearing the session cookie.
 */
export function getExpiredCookieOptions(config: CookieConfig): {
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  maxAge: number;
} {
  return {
    path: '/',
    httpOnly: true,
    secure: config.secure,
    sameSite: config.sameSite,
    maxAge: 0,
  };
}
