import pg from 'pg';
import { logSystemEvent } from '../app/observability.js';

const { Pool } = pg;

export interface DatabaseConfig {
  readonly connectionString?: string;
  readonly options?: string;
  readonly maxConnections?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
}

/**
 * Sanitizes a database connection URL so passwords/credentials are never printed into logs.
 */
export function redactDatabaseUrl(rawUrl?: string): string {
  if (!rawUrl) return '<not-set>';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return '<invalid-url>';
  }
}

/**
 * Creates a PostgreSQL connection pool.
 */
export function createDatabasePool(config: DatabaseConfig = {}): pg.Pool {
  const poolConfig: pg.PoolConfig = {
    connectionString: config.connectionString,
    options: config.options,
    max: config.maxConnections ?? 10,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5000,
  };

  const pool = new Pool(poolConfig);

  // Error listener to prevent unhandled process crashes on background idle client failures
  pool.on('error', () => {
    logSystemEvent('database_idle_error', 'error');
  });

  return pool;
}

/**
 * Pings the database to verify active connectivity.
 */
export async function pingDatabase(pool: pg.Pool): Promise<boolean> {
  try {
    const res = await pool.query('SELECT 1 as alive;');
    return res.rowCount === 1;
  } catch {
    logSystemEvent('database_probe_failed', 'warn');
    return false;
  }
}

/**
 * Gracefully shuts down a database pool.
 */
export async function closeDatabasePool(pool: pg.Pool): Promise<void> {
  await pool.end();
}
