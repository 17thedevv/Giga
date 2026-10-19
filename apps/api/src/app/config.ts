import { loadChatConfig, type ChatProviderConfig } from '../modules/llm/chat-bootstrap.js';
import { CredentialEncryption } from '../modules/credentials/encryption.js';

export interface AppConfig {
  readonly serveWeb?: boolean;
  readonly credentialEncryption?: CredentialEncryption;
  readonly chatEnabled?: boolean;
  readonly chat?: ChatProviderConfig;
  readonly port: number;
  readonly databaseUrl?: string;
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly cookieSecure: boolean;
  readonly cookieSameSite: 'lax' | 'strict' | 'none';
  readonly allowedOrigins: readonly string[];
}

export const DEFAULT_PORT = 3000;

export const DEFAULT_DEV_ORIGINS: readonly string[] = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
];

export function parsePort(rawPort: string | undefined): number {
  if (rawPort === undefined || rawPort.trim() === '') {
    return DEFAULT_PORT;
  }

  const trimmed = rawPort.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid PORT configuration: "${rawPort}". PORT must be an integer between 1 and 65535.`
    );
  }

  const port = Number(trimmed);
  if (port < 1 || port > 65535) {
    throw new Error(
      `Invalid PORT configuration: "${rawPort}". PORT must be an integer between 1 and 65535.`
    );
  }

  return port;
}

export function parseSameSite(rawSameSite?: string): 'lax' | 'strict' | 'none' {
  if (!rawSameSite || rawSameSite.trim() === '') {
    return 'lax';
  }
  const normalized = rawSameSite.trim().toLowerCase();
  if (normalized === 'lax' || normalized === 'strict' || normalized === 'none') {
    return normalized;
  }
  throw new Error(`Invalid COOKIE_SAME_SITE configuration: "${rawSameSite}". Must be 'lax', 'strict', or 'none'.`);
}

/**
 * Validates and normalizes allowed CORS / CSRF origins.
 * Fail-closed in production: missing origin config or wildcard '*' causes startup validation error.
 */
export function parseAllowedOrigins(
  rawOrigins: string | undefined,
  isProduction: boolean
): string[] {
  if (!rawOrigins || rawOrigins.trim() === '') {
    if (isProduction) {
      throw new Error('ALLOWED_ORIGINS environment variable is required in production mode.');
    }
    return [...DEFAULT_DEV_ORIGINS];
  }

  const list = rawOrigins
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  if (list.length === 0) {
    if (isProduction) {
      throw new Error('ALLOWED_ORIGINS environment variable is required in production mode.');
    }
    return [...DEFAULT_DEV_ORIGINS];
  }

  for (const origin of list) {
    if (origin === '*') {
      if (isProduction) {
        throw new Error("Wildcard origin '*' is forbidden in production mode.");
      }
      continue;
    }

    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Invalid origin protocol in '${origin}'. Allowed protocols: http, https.`);
      }
      if (url.origin.toLowerCase() !== origin.toLowerCase()) {
        throw new Error(
          `Origin '${origin}' must be an exact origin (scheme + host + optional port) without paths or trailing slashes.`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid origin '${origin}': ${message}`);
    }
  }

  return list;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (
    env.NODE_ENV === 'production'
      ? 'production'
      : env.NODE_ENV === 'test'
        ? 'test'
        : 'development'
  ) as 'development' | 'production' | 'test';

  const port = parsePort(env.PORT);
  if (env.SERVE_WEB !== undefined && env.SERVE_WEB !== 'true' && env.SERVE_WEB !== 'false') {
    throw new Error('SERVE_WEB must be true or false');
  }

  const databaseUrl = env.DATABASE_URL?.trim();
  if (nodeEnv === 'production' && !databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required in production mode.');
  }

  const cookieSecure = env.COOKIE_SECURE !== undefined
    ? env.COOKIE_SECURE === 'true' || env.COOKIE_SECURE === '1'
    : nodeEnv === 'production';

  const cookieSameSite = parseSameSite(env.COOKIE_SAME_SITE);

  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS, nodeEnv === 'production');
  const chat = loadChatConfig(env, nodeEnv === 'production');
  // Missing key disables BYOK in every environment, including production. A
  // supplied malformed key fails startup; platform Chat remains independently usable.
  const credentialEncryption = env.CREDENTIAL_ENCRYPTION_KEY === undefined ? undefined
    : new CredentialEncryption(env.CREDENTIAL_ENCRYPTION_KEY);

  return {
    serveWeb: env.SERVE_WEB === 'true',
    port,
    databaseUrl,
    nodeEnv,
    cookieSecure,
    cookieSameSite,
    allowedOrigins,
    ...(chat ? { chat } : {}),
    chatEnabled: Boolean(chat),
    ...(credentialEncryption ? { credentialEncryption } : {}),
  };
}
