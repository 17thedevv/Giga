export interface AppConfig {
  readonly port: number;
  readonly databaseUrl?: string;
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly cookieSecure: boolean;
  readonly cookieSameSite: 'lax' | 'strict' | 'none';
  readonly allowedOrigins: readonly string[];
}

export const DEFAULT_PORT = 3000;

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development') as 'development' | 'production' | 'test';
  const port = parsePort(env.PORT);

  const databaseUrl = env.DATABASE_URL?.trim();
  if (nodeEnv === 'production' && !databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required in production mode.');
  }

  const cookieSecure = env.COOKIE_SECURE !== undefined
    ? env.COOKIE_SECURE === 'true' || env.COOKIE_SECURE === '1'
    : nodeEnv === 'production';

  const cookieSameSite = parseSameSite(env.COOKIE_SAME_SITE);

  const allowedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter((o) => o.length > 0)
    : [];

  return {
    port,
    databaseUrl,
    nodeEnv,
    cookieSecure,
    cookieSameSite,
    allowedOrigins,
  };
}
