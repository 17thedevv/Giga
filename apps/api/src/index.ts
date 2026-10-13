import { startServer } from './app/server.js';

export { createApp } from './app/create-app.js';
export { loadConfig, parsePort, DEFAULT_PORT } from './app/config.js';
export { startServer } from './app/server.js';

try {
  startServer();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[giga-api] Startup failed: ${message}`);
  process.exit(1);
}
