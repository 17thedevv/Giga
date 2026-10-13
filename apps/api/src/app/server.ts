import { serve, type ServerType } from '@hono/node-server';
import { createApp } from './create-app.js';
import { loadConfig } from './config.js';

export function startServer(overridePort?: number): ServerType {
  const config = loadConfig();
  const port = overridePort ?? config.port;
  const app = createApp();

  const server = serve(
    {
      fetch: app.fetch,
      port,
    },
    (info) => {
      console.log(`[giga-api] Server listening on http://localhost:${info.port}`);
    }
  );

  return server;
}
