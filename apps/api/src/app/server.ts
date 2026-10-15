import { serve, type ServerType } from '@hono/node-server';
import type pg from 'pg';
import { createApp } from './create-app.js';
import { loadConfig, type AppConfig } from './config.js';
import { createDatabasePool, redactDatabaseUrl } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { createChatEngine } from '../modules/llm/chat-bootstrap.js';
import type { ProviderTransport } from '../modules/llm/providers/gemini/gemini-provider.js';
import type { LLMEngine } from '../modules/llm/engine.js';

export interface StartServerOptions {
  readonly port?: number;
  readonly pool?: pg.Pool;
  readonly config?: AppConfig;
  readonly skipMigrations?: boolean;
  readonly llmEngine?: LLMEngine;
  readonly providerTransport?: ProviderTransport;
}

export async function startServer(options: StartServerOptions = {}): Promise<{
  server: ServerType;
  pool?: pg.Pool;
  port: number;
}> {
  const config = options.config ?? loadConfig();
  const port = options.port ?? config.port;
  if ((config.chatEnabled === true || (config.nodeEnv === 'production' && config.chatEnabled !== false)) && !config.chat) {
    throw new Error('Enabled Chat requires server provider configuration');
  }
  if (config.chatEnabled === false && config.chat) throw new Error('Conflicting Chat enable configuration');
  // Fail configuration before opening DB connections or listening on a socket.
  const configuredEngine = createChatEngine(config.chat, options.providerTransport);
  const llmEngine = options.llmEngine ?? configuredEngine;

  let pool = options.pool;

  if (!pool && config.databaseUrl) {
    console.log(`[giga-api] Initializing PostgreSQL connection: ${redactDatabaseUrl(config.databaseUrl)}`);
    pool = createDatabasePool({ connectionString: config.databaseUrl });

    if (!options.skipMigrations) {
      try {
        const applied = await runMigrations(pool);
        if (applied.length > 0) {
          console.log(`[giga-api] Database migrations applied: ${applied.join(', ')}`);
        }
      } catch (err) {
        console.error('[giga-api] Database migration error on startup:', err);
        // Ensure pool connections are properly closed on startup failure
        await pool.end();
        throw err;
      }
    }
  }

  const app = createApp({
    pool,
    config,
    llmEngine,
  });

  const server = serve(
    {
      fetch: app.fetch,
      port,
    },
    (info) => {
      console.log(`[giga-api] Server listening on http://localhost:${info.port}`);
    }
  );

  return { server, pool, port };
}
