import { Hono } from 'hono';
import type pg from 'pg';
import { UserRepository } from '../db/repositories/user-repository.js';
import { SessionRepository } from '../db/repositories/session-repository.js';
import { AuthService } from '../modules/auth/auth-service.js';
import { createAuthRoutes } from '../modules/auth/auth-routes.js';
import { createCsrfMiddleware } from '../modules/auth/csrf-middleware.js';
import { AppError } from '../modules/auth/auth-validation.js';
import type { AppConfig } from './config.js';

export interface HealthResponse {
  readonly status: 'ok';
  readonly service: 'giga-api';
  readonly timestamp: string;
}

export interface ErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export interface AppDependencies {
  readonly pool?: pg.Pool;
  readonly authService?: AuthService;
  readonly config?: Partial<AppConfig>;
}

export function createApp(dependencies: AppDependencies = {}): Hono {
  const app = new Hono();

  const isDev = dependencies.config?.nodeEnv !== 'production';
  const cookieConfig = {
    secure: dependencies.config?.cookieSecure ?? !isDev,
    sameSite: dependencies.config?.cookieSameSite ?? 'lax',
  };

  // CSRF validation on state-changing methods
  if (dependencies.config?.allowedOrigins && dependencies.config.allowedOrigins.length > 0) {
    app.use(
      '/api/*',
      createCsrfMiddleware({
        allowedOrigins: dependencies.config.allowedOrigins,
        isDevelopment: isDev,
      })
    );
  }

  // Health check endpoint (lightweight, zero database access required)
  app.get('/health', (c) => {
    const responseBody: HealthResponse = {
      status: 'ok',
      service: 'giga-api',
      timestamp: new Date().toISOString(),
    };
    return c.json(responseBody, 200);
  });

  // Mount Authentication module if authService or pool is available
  let authService = dependencies.authService;
  if (!authService && dependencies.pool) {
    const userRepo = new UserRepository(dependencies.pool);
    const sessionRepo = new SessionRepository(dependencies.pool);
    authService = new AuthService(userRepo, sessionRepo);
  }

  if (authService) {
    const authRouter = createAuthRoutes({
      authService,
      cookieConfig,
    });
    app.route('/api/v1/auth', authRouter);
  }

  // 404 handler for unknown routes
  app.notFound((c) => {
    const errorBody: ErrorResponse = {
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
      },
    };
    return c.json(errorBody, 404);
  });

  // Global error handler - guarantees structured error responses and no leaked internals/stack traces
  app.onError((err, c) => {
    if (err instanceof AppError) {
      const errorBody: ErrorResponse = {
        error: {
          code: err.code,
          message: err.message,
        },
      };
      return c.json(errorBody, err.statusCode as 400 | 401 | 403 | 404 | 409 | 500);
    }

    console.error('[giga-api] Unexpected unhandled error:', err);

    const errorBody: ErrorResponse = {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    };
    return c.json(errorBody, 500);
  });

  return app;
}
