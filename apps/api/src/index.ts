import { startServer } from './app/server.js';
import { logSystemEvent } from './app/observability.js';

export { createApp } from './app/create-app.js';
export { loadConfig, parsePort, DEFAULT_PORT } from './app/config.js';
export { startServer } from './app/server.js';
export { createDatabasePool, closeDatabasePool, pingDatabase, redactDatabaseUrl } from './db/client.js';
export { runMigrations } from './db/migrate.js';
export { UserRepository } from './db/repositories/user-repository.js';
export { SessionRepository } from './db/repositories/session-repository.js';
export { AuthService } from './modules/auth/auth-service.js';

startServer().catch(() => {
  logSystemEvent('startup_failed', 'error');
  process.exit(1);
});
