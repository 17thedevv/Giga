/**
 * Shared LLM Engine v0.1 — Error Classification and Sanitization
 *
 * All errors thrown or exposed by the LLM Engine must be classified, safe,
 * and scrubbed of any secrets, raw auth tokens, or internal URLs.
 */

/**
 * Redacts any detected API keys, credentials, and authentication headers.
 */
export function sanitizeErrorMessage(message: string): string {
  if (!message || typeof message !== 'string') {
    return 'Unknown LLM error';
  }

  let sanitized = message;

  // Bearer tokens
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9\-_.~+/=]+/gi, 'Bearer [REDACTED]');

  // URL query params
  sanitized = sanitized.replace(/([?&](?:api[_-]?key|key|token|auth)=)[^&\s]+/gi, '$1[REDACTED]');

  // Common prefix tokens (e.g. sk-..., ghp-...)
  sanitized = sanitized.replace(/\b(?:sk|ghp|gho|pat|xoxb|xoxp)[-_][A-Za-z0-9_\-]{8,}\b/gi, '[REDACTED_KEY]');

  // Key/secret value assignments: key=..., apiKey=..., password=..., secret=...
  sanitized = sanitized.replace(
    /\b(api[_-]?key|apiKey|key|password|client[_-]?secret|auth[_-]?token|secret|authorization)(\s*[:=]\s*)["']?([^\s"',;]+)["']?/gi,
    '$1$2[REDACTED]'
  );

  return sanitized;
}

const SENSITIVE_KEY_REGEX = /(?:key|token|auth|secret|password|bearer|credential|header)/i;

/**
 * Recursively sanitizes any value in details, scrubbing secrets from strings
 * and redacting values associated with sensitive keys.
 */
export function sanitizeDetailValue(value: unknown, depth = 0): unknown {
  if (depth > 5) {
    return '[TRUNCATED_DEPTH]';
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizeErrorMessage(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDetailValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    const sanitizedObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_REGEX.test(k)) {
        sanitizedObj[k] = '[REDACTED]';
      } else {
        sanitizedObj[k] = sanitizeDetailValue(v, depth + 1);
      }
    }
    return sanitizedObj;
  }

  return String(value);
}

export function sanitizeDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return undefined;
  }
  return sanitizeDetailValue(details, 0) as Record<string, unknown>;
}

export abstract class LLMError extends Error {
  public abstract readonly code: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly details?: Record<string, unknown>;

  constructor(message: string, statusCode = 500, details?: Record<string, unknown>) {
    super(sanitizeErrorMessage(message));
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isOperational = true;
    this.details = sanitizeDetails(details);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UnknownModelAliasError extends LLMError {
  public readonly code = 'UNKNOWN_MODEL_ALIAS';

  constructor(alias: string) {
    super(`Unknown model alias: '${alias}'`, 404, { alias: sanitizeErrorMessage(alias) });
  }
}

export class UnsupportedCapabilityError extends LLMError {
  public readonly code = 'UNSUPPORTED_CAPABILITY';

  constructor(capability: string, target: string) {
    super(`Capability '${capability}' is not supported by '${target}'`, 400, {
      capability,
      target: sanitizeErrorMessage(target),
    });
  }
}

export class UnsupportedReasoningEffortError extends LLMError {
  public readonly code = 'UNSUPPORTED_REASONING_EFFORT';

  constructor(effort: string, target: string) {
    super(`Reasoning effort '${effort}' is not supported for '${target}'`, 400, {
      effort: sanitizeErrorMessage(effort),
      target: sanitizeErrorMessage(target),
    });
  }
}

export class LLMValidationError extends LLMError {
  public readonly code = 'LLM_VALIDATION_ERROR';

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 400, details);
  }
}

export class ProviderUnavailableError extends LLMError {
  public readonly code = 'PROVIDER_UNAVAILABLE';

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 503, details);
  }
}

export class ProviderRateLimitError extends LLMError {
  public readonly code = 'PROVIDER_RATE_LIMIT';
  public readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message, 429, retryAfterMs !== undefined ? { retryAfterMs } : undefined);
    this.retryAfterMs = retryAfterMs;
  }
}

export class ProviderTimeoutError extends LLMError {
  public readonly code = 'PROVIDER_TIMEOUT';

  constructor(message: string) {
    super(message, 504);
  }
}

export class ProviderFailureError extends LLMError {
  public readonly code = 'PROVIDER_FAILURE';

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 502, details);
  }
}

export class BYOKCredentialInvalidError extends LLMError {
  public readonly code = 'BYOK_CREDENTIAL_INVALID';
  constructor() { super('The selected Chat credential was rejected', 422); }
}

export class ChatCredentialUnavailableError extends LLMError {
  public readonly code = 'CHAT_CREDENTIAL_UNAVAILABLE';
  constructor() { super('Chat credential is unavailable; configure Chat credentials', 503); }
}

/** Safe classification for Chat BYOK; existing platform generation errors stay unchanged. */
export class BYOKProviderError extends LLMError {
  constructor(public readonly code: 'PROVIDER_RATE_LIMIT' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_TIMEOUT') {
    super('The user provider account could not complete the request', code === 'PROVIDER_RATE_LIMIT' ? 429 : code === 'PROVIDER_TIMEOUT' ? 504 : 503);
  }
}

export class LLMCancelledError extends LLMError {
  public readonly code = 'LLM_CANCELLED';

  constructor(message = 'LLM operation was cancelled') {
    super(message, 499);
  }
}

/**
 * Classifies any thrown error into a standardized, sanitized LLMError.
 */
export function toLLMError(err: unknown, defaultMessage = 'LLM request failed'): LLMError {
  if (err instanceof LLMError) {
    return err;
  }

  const message = err instanceof Error ? err.message : String(err ?? defaultMessage);
  const name = err instanceof Error ? err.name : '';

  // Check abort / cancellation
  if (name === 'AbortError' || message.toLowerCase().includes('aborted') || message.toLowerCase().includes('cancelled')) {
    return new LLMCancelledError(sanitizeErrorMessage(message));
  }

  // Check rate limit
  if (message.includes('429') || message.toLowerCase().includes('rate limit')) {
    return new ProviderRateLimitError(message);
  }

  // Check timeout
  if (
    name === 'TimeoutError' ||
    message.toLowerCase().includes('timeout') ||
    message.toLowerCase().includes('timed out')
  ) {
    return new ProviderTimeoutError(message);
  }

  return new ProviderFailureError(message);
}
