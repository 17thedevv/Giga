export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message, 400);
    this.name = 'ValidationError';
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required') {
    super('UNAUTHENTICATED', message, 401);
    this.name = 'UnauthenticatedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access forbidden') {
    super('FORBIDDEN', message, 403);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super('NOT_FOUND', message, 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message, 409);
    this.name = 'ConflictError';
  }
}

// Standard RFC 5322 compatible email regex
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

/**
 * Validates registration request body with strict constraints.
 */
export function validateRegisterInput(body: unknown): RegisterInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('Request body must be a valid JSON object');
  }

  const raw = body as Record<string, unknown>;

  // Validate email
  if (typeof raw.email !== 'string' || raw.email.trim() === '') {
    throw new ValidationError('Email is required');
  }
  const email = raw.email.trim();
  if (email.length > 255) {
    throw new ValidationError('Email must not exceed 255 characters');
  }
  if (!EMAIL_REGEX.test(email)) {
    throw new ValidationError('Invalid email format');
  }

  // Validate password
  if (typeof raw.password !== 'string') {
    throw new ValidationError('Password is required');
  }
  if (raw.password.length < 8) {
    throw new ValidationError('Password must be at least 8 characters long');
  }
  if (raw.password.length > 128) {
    throw new ValidationError('Password must not exceed 128 characters');
  }

  // Validate displayName
  if (typeof raw.displayName !== 'string' || raw.displayName.trim() === '') {
    throw new ValidationError('Display name is required');
  }
  const displayName = raw.displayName.trim();
  if (displayName.length > 64) {
    throw new ValidationError('Display name must not exceed 64 characters');
  }

  return { email, password: raw.password, displayName };
}

/**
 * Validates login request body.
 */
export function validateLoginInput(body: unknown): LoginInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('Request body must be a valid JSON object');
  }

  const raw = body as Record<string, unknown>;

  if (typeof raw.email !== 'string' || raw.email.trim() === '') {
    throw new ValidationError('Email is required');
  }
  const email = raw.email.trim();
  if (!EMAIL_REGEX.test(email)) {
    throw new ValidationError('Invalid email format');
  }

  if (typeof raw.password !== 'string' || raw.password === '') {
    throw new ValidationError('Password is required');
  }

  return { email, password: raw.password };
}
