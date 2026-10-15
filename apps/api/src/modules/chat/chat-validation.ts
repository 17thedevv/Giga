import { ValidationError } from '../auth/auth-validation.js';

export function validateIdempotencyKey(key: string | undefined): string {
  if (!key || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
    throw new ValidationError('Idempotency-Key must be 1-128 ASCII letters, digits, dots, underscores, colons or hyphens');
  }
  return key;
}
