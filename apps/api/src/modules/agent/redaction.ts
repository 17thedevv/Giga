/**
 * Shared credential redaction and UTF-8 bounding utilities for GigaAgent.
 * Used across AgentRepository, ExecutionRuntime adapters, and orchestrator boundaries.
 */

export const SENSITIVE_KEY_NAMES =
  '(?:x[_-]?)?api[_-]?key|(?:x[_-]?)?(?:auth[_-]?|access[_-]?|refresh[_-]?|lease[_-]?|worker[_-]?|session[_-]?|id[_-]?|bearer[_-]?)?token|password|passwd|pass|(?:client[_-]?|shared[_-]?)?secret(?:[_-]?key)?|private[_-]?key|privkey|authorization|proxy[_-]?authorization|credentials?|cookies?';

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /^(?:x)?(?:api)?key$|^(?:x)?(?:auth|access|refresh|lease|worker|session|id|bearer|security|csrf)?token$|^(?:client|shared)?secret(?:key)?$|^(?:pass|passwd|password)$|^(?:privatekey|privkey)$|^(?:authorization|proxyauthorization)$|^(?:credential|credentials)$|^(?:cookie|setcookie)$/i.test(
    normalized
  ) || ['apikey', 'token', 'secret', 'password', 'passwd', 'credential', 'credentials', 'privatekey', 'databaseurl', 'connectionstring'].some((suffix) => normalized.endsWith(suffix)) ||
    normalized.includes('credentialencryptionkey');
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

  // 1. Private keys (PEM format)
  sanitized = sanitized.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');

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

  // 7. Quoted JSON / object key-value pairs:
  const quotedRegex = new RegExp(
    '(["\'])(' + SENSITIVE_KEY_NAMES + ')\\1(\\s*:\\s*)(["\'])(?:\\\\.|(?!\\4)[^\\\\])*\\4',
    'gi'
  );
  sanitized = sanitized.replace(quotedRegex, '$1$2$1$3$4[REDACTED]$4');

  // Also handle quoted key with unquoted value
  const quotedUnquotedValRegex = new RegExp(
    '(["\'])(' + SENSITIVE_KEY_NAMES + ')\\1(\\s*:\\s*)(?!(?:\\[REDACTED\\]|"\\[REDACTED\\]"))([^\\s"\',;}\\]]+)',
    'gi'
  );
  sanitized = sanitized.replace(quotedUnquotedValRegex, '$1$2$1$3"[REDACTED]"');

  // 8. Unquoted key assignments (CLI output, env lines, key=value, key: value)
  // Environment variable prefixes (GEMINI_API_KEY, DATABASE_URL,
  // AGENT_LIFECYCLE_FINALIZER_DATABASE_URL, WORKER_LEASE_TOKEN) must not
  // defeat the suffix-based credential policy below.
  sanitized = sanitized.replace(
    /\b((?:[A-Za-z][A-Za-z0-9_-]*[_-])?(?:api[_-]?key|token|secret|password|passwd|database[_-]?url|connection[_-]?string|credentials?(?:[_-]?encryption)?[_-]?key|private[_-]?key))(\s*[:=]\s*)(?!(?:\[REDACTED(?:_KEY)?\]|"\[REDACTED\]"|[A-Za-z0-9_-]+[:=]))(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"',;}\]]+))/gi,
    '$1$2[REDACTED]'
  );
  const unquotedRegex = new RegExp(
    '\\b(' + SENSITIVE_KEY_NAMES + ')(\\s*[:=]\\s*)(?!(?:\\[REDACTED(?:_KEY)?\\]|"\\[REDACTED\\]"|[a-zA-Z0-9_\\-]+[:=]|(?:Bearer|Basic|Token)\\s+\\[REDACTED\\]))(?:["\']([^"\'\\r\\n]+)["\']|([^\\s"\',;}\\]]+))',
    'gi'
  );
  sanitized = sanitized.replace(unquotedRegex, '$1$2[REDACTED]');

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
