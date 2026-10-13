import pg from 'pg';

const { Pool } = pg;

export interface DatabaseConfig {
  readonly connectionString?: string;
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
    max: config.maxConnections ?? 10,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5000,
  };

  const pool = new Pool(poolConfig);

  // Error listener to prevent unhandled process crashes on background idle client failures
  pool.on('error', (err) => {
    console.error('[giga-db] Unexpected idle PostgreSQL client error:', err.message);
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[giga-db] Database health check failed: ${message}`);
    return false;
  }
}

/**
 * Gracefully shuts down a database pool.
 */
export async function closeDatabasePool(pool: pg.Pool): Promise<void> {
  await pool.end();
}
