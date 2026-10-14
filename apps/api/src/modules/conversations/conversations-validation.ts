import { AppError, ValidationError } from '../auth/auth-validation.js';
import type { CreateConversationInput, PaginationCursor } from './types.js';

export { AppError, ValidationError };

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super('NOT_FOUND', message, 404);
    this.name = 'NotFoundError';
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates that an input is a valid RFC 4122 UUID.
 */
export function validateUuid(val: unknown, fieldName = 'id'): string {
  if (typeof val !== 'string' || !UUID_REGEX.test(val.trim())) {
    throw new ValidationError(`Invalid ${fieldName}: must be a valid UUID`);
  }
  return val.trim();
}

/**
 * Encodes a pagination cursor into an opaque base64url string.
 */
export function encodeCursor(cursor: PaginationCursor): string {
  const json = JSON.stringify(cursor);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decodes and validates an opaque base64url pagination cursor.
 */
export function decodeCursor(cursorStr: string): PaginationCursor {
  try {
    const raw = Buffer.from(cursorStr, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.updatedAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      Number.isNaN(Date.parse(parsed.updatedAt)) ||
      !UUID_REGEX.test(parsed.id)
    ) {
      throw new ValidationError('Invalid pagination cursor');
    }
    return {
      updatedAt: new Date(parsed.updatedAt).toISOString(),
      id: parsed.id,
    };
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError('Invalid pagination cursor');
  }
}

/**
 * Validates pagination query parameters (limit and cursor).
 */
export function validatePaginationParams(query: Record<string, string | undefined>): {
  limit: number;
  cursor?: PaginationCursor;
} {
  let limit = 20;
  if (query.limit !== undefined && query.limit.trim() !== '') {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new ValidationError('Limit must be an integer between 1 and 100');
    }
    limit = parsed;
  }

  let cursor: PaginationCursor | undefined;
  if (query.cursor !== undefined && query.cursor.trim() !== '') {
    cursor = decodeCursor(query.cursor.trim());
  }

  return { limit, cursor };
}

/**
 * Validates conversation creation payload with strict field allowlist and length checks.
 */
export function validateCreateConversationInput(body: unknown): CreateConversationInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('Request body must be a valid JSON object');
  }

  const raw = body as Record<string, unknown>;

  const allowedKeys = new Set(['title']);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      throw new ValidationError(`Unknown field: ${key}`);
    }
  }

  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string') {
      throw new ValidationError('Title must be a string');
    }
    const trimmed = raw.title.trim();
    if (trimmed.length > 255) {
      throw new ValidationError('Title must not exceed 255 characters');
    }
    return { title: trimmed.length > 0 ? trimmed : 'New Conversation' };
  }

  return { title: 'New Conversation' };
}
