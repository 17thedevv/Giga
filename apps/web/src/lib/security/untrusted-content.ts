const SENSITIVE_FIELD = /(?:password|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|authorization|database[-_]?url|connection[-_]?string)/i;

export function sanitizeUntrustedText(value: string, knownSecrets: readonly string[] = []): string {
  let result = value;
  for (const secret of [...knownSecrets].filter((item) => item.length >= 4).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join('[redacted]');
  }

  return result
    .replace(/\bAIza[\w-]{20,}\b/g, '[redacted credential]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted credential]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[redacted credential]')
    .replace(/\b(?:xox[baprs]-|ya29\.)[A-Za-z0-9._-]{12,}\b/g, '[redacted credential]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted token]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi, '[redacted connection URL]')
    .replace(/\b(password|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|authorization)\s*[:=]\s*["']?[^,\s"'<>]+/gi, '$1=[redacted]');
}

export function sanitizeUntrustedValue(value: unknown, knownSecrets: readonly string[] = []): unknown {
  if (typeof value === 'string') return sanitizeUntrustedText(value, knownSecrets);
  if (Array.isArray(value)) return value.map((item) => sanitizeUntrustedValue(item, knownSecrets));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_FIELD.test(key) ? '[redacted]' : sanitizeUntrustedValue(item, knownSecrets),
    ])
  );
}

export function extractSensitiveRequestValues(body: BodyInit | null | undefined): string[] {
  if (typeof body !== 'string') return [];
  try {
    const values: string[] = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (SENSITIVE_FIELD.test(key) && typeof item === 'string') values.push(item);
        else visit(item);
      }
    };
    visit(JSON.parse(body));
    return values;
  } catch {
    return [];
  }
}

export function safeGitHubPullRequestUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('%')) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(url.pathname)
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}
