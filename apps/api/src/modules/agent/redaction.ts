/**
 * Shared credential redaction and UTF-8 bounding utilities for GigaAgent.
 * Used across AgentRepository, ExecutionRuntime adapters, and orchestrator boundaries.
 */

export const SENSITIVE_KEY_NAMES =
  '(?:[A-Za-z][A-Za-z0-9_-]{0,127})?(?:api[_-]?key|access[_-]?key|token|password|passwd|pass|secret(?:[_-]?key)?|private[_-]?key|privkey|database[_-]?url|connection[_-]?string|credential(?:s)?(?:[_-]?encryption)?[_-]?key|credentials?|encryption[_-]?key|authorization|proxy[_-]?authorization|cookies?|set[_-]?cookie)';

const SENSITIVE_KEY_SUFFIXES = [
  'apikey', 'accesskey', 'token', 'password', 'passwd', 'pass', 'secret', 'secretkey',
  'privatekey', 'privkey', 'databaseurl', 'connectionstring', 'credential', 'credentials',
  'credentialencryptionkey', 'credentialsencryptionkey', 'encryptionkey', 'authorization',
  'proxyauthorization', 'cookie', 'setcookie',
] as const;

const SENSITIVE_KEY_ASSIGNMENT_HEADER = /(["'])([A-Za-z][A-Za-z0-9_-]{0,127})\1(\s*[:=]\s*)/g;
const UNQUOTED_SENSITIVE_KEY_ASSIGNMENT_HEADER = /\b([A-Za-z][A-Za-z0-9_-]{0,127})(\s*[:=]\s*)/g;
const NEXT_ASSIGNMENT = /[A-Za-z][A-Za-z0-9_-]{0,127}\s*[:=]\s*/y;
const EXISTING_REDACTION = /["']?\[(?:REDACTED|REDACTED_KEY|REDACTED_PRIVATE_KEY)\]["']?/y;
const EXISTING_REDACTED_SCHEME = /(?:Bearer|Basic|Token)\s+\[REDACTED\]/iy;

function redactSensitiveAssignments(content: string): string {
  let sanitized = content;

  for (const header of [SENSITIVE_KEY_ASSIGNMENT_HEADER, UNQUOTED_SENSITIVE_KEY_ASSIGNMENT_HEADER]) {
    header.lastIndex = 0;
    let cursor = 0;
    let output = '';
    let match: RegExpExecArray | null;

    while ((match = header.exec(sanitized)) !== null) {
      const name = match[header === SENSITIVE_KEY_ASSIGNMENT_HEADER ? 2 : 1]!;
      if (!isSensitiveKey(name)) continue;

      const valueStart = header.lastIndex;
      NEXT_ASSIGNMENT.lastIndex = valueStart;
      if (NEXT_ASSIGNMENT.test(sanitized)) continue;
      EXISTING_REDACTION.lastIndex = valueStart;
      if (EXISTING_REDACTION.test(sanitized)) continue;
      EXISTING_REDACTED_SCHEME.lastIndex = valueStart;
      if (EXISTING_REDACTED_SCHEME.test(sanitized)) continue;

      const valueQuote = sanitized[valueStart];
      let valueEnd = valueStart;
      let replacementValue: string;
      if (valueQuote === '"' || valueQuote === "'") {
        let index = valueStart + 1;
        while (index < sanitized.length) {
          const character = sanitized[index]!;
          if (character === '\\') {
            index += Math.min(2, sanitized.length - index);
          } else if (character === valueQuote) {
            index++;
            break;
          } else {
            index++;
          }
        }
        valueEnd = index;
        replacementValue = header === SENSITIVE_KEY_ASSIGNMENT_HEADER
          ? `${valueQuote}[REDACTED]${valueQuote}`
          : '[REDACTED]';
      } else {
        while (valueEnd < sanitized.length && !/[\s,;}\]]/.test(sanitized[valueEnd]!)) valueEnd++;
        if (valueEnd === valueStart) continue;
        replacementValue = '[REDACTED]';
      }

      output += sanitized.slice(cursor, valueStart) + replacementValue;
      cursor = valueEnd;
      header.lastIndex = valueEnd;
    }

    sanitized = output ? output + sanitized.slice(cursor) : sanitized;
  }

  return sanitized;
}

function boundedUtf8Prefix(content: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
  let index = 0;
  let bytes = 0;

  while (index < content.length) {
    const codePoint = content.codePointAt(index)!;
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    const codePointBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + codePointBytes > limit) return { text: content.slice(0, index), truncated: true };
    bytes += codePointBytes;
    index += codeUnits;
  }

  return { text: content, truncated: false };
}

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /^(?:x)?key$/.test(normalized) || SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix)) ||
    /^(?:x)?(?:auth|access|refresh|lease|worker|session|id|bearer|security|csrf)?token$|^(?:authorization|proxyauthorization)$|^(?:cookie|setcookie)$/.test(normalized);
}

export function redactJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return redactStringPatterns(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        result[k] = '[REDACTED]';
      } else {
        result[k] = redactJsonValue(v);
      }
    }
    return result;
  }
  return value;
}

export function redactStringPatterns(content: string): string {
  if (!content || typeof content !== 'string') return '';
  let sanitized = content;

  // 1. Private keys (PEM format). An unmatched BEGIN marker consumes the
  // remainder of this bounded scan so truncation cannot expose key material.
  sanitized = sanitized.replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, '[REDACTED_PRIVATE_KEY]');

  // 2. URL userinfo credentials: https://user:password@host or postgres://user:pass@host:port/db
  sanitized = sanitized.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:\s/@]+):([^@\s/]+)@/gi, '$1$2:[REDACTED]@');

  // 3. URL query parameters: ?api_key=..., &token=..., etc.
  sanitized = sanitized.replace(/([?&](?:api[_-]?key|key|token|auth(?:[_-]?token)?|access[_-]?token|secret|password)=)(?!\[REDACTED\])[^&\s#]+/gi, '$1[REDACTED]');

  // 4. Authorization headers: Authorization: Bearer ..., Authorization: Basic ..., Authorization: ...
  sanitized = sanitized.replace(/\b(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)(?!\[REDACTED\])[^\s,;\r\n]+/gi, '$1[REDACTED]');
  sanitized = sanitized.replace(/\b(Authorization\s*:\s*)(?!(?:Bearer|Basic|Token)\s+|\[REDACTED\])[^\s,;\r\n]+/gi, '$1[REDACTED]');

  // 5. Standalone Authorization scheme tokens (Bearer ..., Basic ...)
  sanitized = sanitized.replace(/\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9\-_.~+/=]+/gi, 'Bearer [REDACTED]');
  sanitized = sanitized.replace(/\bBasic\s+(?!\[REDACTED\])[A-Za-z0-9+/=]{16,}/gi, 'Basic [REDACTED]');

  // 6. Common API key prefixes: e2b-..., e2b_..., sk-..., ghp-..., gho-..., pat-..., live_..., test_...
  sanitized = sanitized.replace(/\b(?:e2b|sk|ghp|gho|ghu|ghs|ghr|pat|xoxb|xoxp|xapp|glpat|npm|live|test)[-_][A-Za-z0-9_\-]{8,}\b/gi, '[REDACTED_KEY]');

  // 7. Quoted and unquoted key-value pairs use the same normalized predicate
  // as structured object redaction. Unclosed quoted values are redacted to the
  // end of this bounded scan.
  sanitized = redactSensitiveAssignments(sanitized);

  return sanitized;
}

export function redactSensitiveContent(content: string): string {
  if (!content || typeof content !== 'string') return '';
  const trimmed = content.trim();

  // If the content is valid JSON, recursively redact structured keys first
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed);
      const redactedObj = redactJsonValue(parsed);
      const isFormatted = content.includes('\n');
      const jsonStr = JSON.stringify(redactedObj, null, isFormatted ? 2 : undefined);
      return redactStringPatterns(jsonStr);
    } catch {
      // Fallback to pattern-based string redaction
    }
  }

  return redactStringPatterns(content);
}

export function boundUtf8(content: string, maxBytes = 16384): string {
  const buf = Buffer.from(content, 'utf8');
  if (buf.length <= maxBytes) return content;

  let end = maxBytes;
  // Scan backwards past any UTF-8 continuation bytes (10xxxxxx)
  while (end > 0 && (buf[end - 1]! & 0xC0) === 0x80) {
    end--;
  }

  if (end > 0) {
    const lead = buf[end - 1]!;
    let seqLen = 1;
    if ((lead & 0x80) === 0x00) seqLen = 1;
    else if ((lead & 0xE0) === 0xC0) seqLen = 2;
    else if ((lead & 0xF0) === 0xE0) seqLen = 3;
    else if ((lead & 0xF8) === 0xF0) seqLen = 4;

    if (end - 1 + seqLen > maxBytes) {
      end = end - 1;
    } else {
      end = end - 1 + seqLen;
    }
  }

  let result = buf.subarray(0, end).toString('utf8');
  while (Buffer.byteLength(result, 'utf8') > maxBytes) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Redact an untrusted string for model context while limiting all pattern work
 * to a deterministic UTF-8 prefix. Reserve room for an explicit truncation
 * marker and run redaction before returning the final byte-bounded value.
 */
export function sanitizeBoundedModelContext(content: string, maxBytes = 16384): string {
  if (!content || typeof content !== 'string' || !Number.isFinite(maxBytes) || maxBytes <= 0) return '';
  const limit = Math.floor(maxBytes);
  if (limit <= 0) return '';

  const initial = boundedUtf8Prefix(content, limit);
  const marker = '[TRUNCATED]';
  const scanLimit = initial.truncated ? Math.max(0, limit - Buffer.byteLength(marker, 'utf8')) : limit;
  const bounded = boundedUtf8Prefix(content, scanLimit);
  const sanitized = redactStringPatterns(bounded.text);
  return boundUtf8(initial.truncated ? sanitized + marker : sanitized, limit);
}
