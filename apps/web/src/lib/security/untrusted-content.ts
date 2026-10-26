const SENSITIVE_FIELD = /(?:password|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|authorization|database[-_]?url|connection[-_]?string)/i;

export function sanitizeUntrustedText(value: string, knownSecrets: readonly string[] = []): string {
  let result = value;
  for (const secret of [...knownSecrets].filter((item) => item.length >= 4).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join('[redacted]');
  }

  return result
    .replace(/\bAIza[\w-]{20,}\b/g, '[redacted credential]')
    .replace(/\bAIza[\w-]{12,19}\b/g, '[redacted credential fragment]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted credential]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{12,19}\b/g, '[redacted credential fragment]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[redacted credential]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,19}\b/g, '[redacted credential fragment]')
    .replace(/\b(?:xox[baprs]-|ya29\.)[A-Za-z0-9._-]{12,}\b/g, '[redacted credential]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}\b/g, '[redacted token]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi, '[redacted connection URL]')
    .replace(/\b(password|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|authorization)\s*[:=]\s*["']?[^,\s"'<>]+/gi, '$1=[redacted]');
}

const INCOMPLETE_CREDENTIAL_SUFFIXES = [
  /\bAIza[\w-]{0,19}$/,
  /\bgh[pousr]_[A-Za-z0-9]{0,19}$/,
  /\bsk-[A-Za-z0-9_-]{0,19}$/,
  /\b(?:xox[baprs]-[A-Za-z0-9._-]{0,11}|ya29\.[A-Za-z0-9._-]{0,11})$/,
  /\beyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}$/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{0,11}=*$/i,
  /\b(?:password|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|authorization)\s*[:=]\s*["']?[^,\s"'<>]*$/i,
];

function trailingCredentialCandidate(value: string): { start: number; text: string } | null {
  let earliestStart = Number.POSITIVE_INFINITY;
  for (const pattern of INCOMPLETE_CREDENTIAL_SUFFIXES) {
    const match = pattern.exec(value);
    if (match && match.index < earliestStart) earliestStart = match.index;
  }
  return Number.isFinite(earliestStart)
    ? { start: earliestStart, text: value.slice(earliestStart) }
    : null;
}

/**
 * Re-evaluate concatenated stream text on each delta. Only short, unresolved
 * prefixes are held back; once a known credential shape is recognizable it is
 * redacted immediately, including long key=value values. On a terminal event,
 * a substantial truncated credential-shaped suffix is redacted.
 */
export function sanitizeStreamingText(value: string, complete = false): string {
  const candidate = trailingCredentialCandidate(value);
  if (!candidate) return sanitizeUntrustedText(value);
  if (!complete) {
    const safeCandidate = sanitizeUntrustedText(candidate.text);
    return sanitizeUntrustedText(value.slice(0, candidate.start)) +
      (safeCandidate !== candidate.text ? safeCandidate : '');
  }
  if (candidate.text.length >= 12) {
    return `${sanitizeUntrustedText(value.slice(0, candidate.start))}[redacted credential fragment]`;
  }
  return sanitizeUntrustedText(value);
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
