import { Hono } from 'hono';
import type pg from 'pg';
import { UserRepository } from '../db/repositories/user-repository.js';
import { SessionRepository } from '../db/repositories/session-repository.js';
import { AuthService } from '../modules/auth/auth-service.js';
import { createAuthRoutes } from '../modules/auth/auth-routes.js';
import { createCsrfMiddleware } from '../modules/auth/csrf-middleware.js';
import { AppError } from '../modules/auth/auth-validation.js';
import { ConversationRepository } from '../db/repositories/conversation-repository.js';
import { MessageRepository } from '../db/repositories/message-repository.js';
import { ConversationsService } from '../modules/conversations/conversations-service.js';
import { createConversationRoutes } from '../modules/conversations/conversations-routes.js';
import { PostgresSkillStorage } from '../modules/skills/postgres-storage.js';
import { PostgresUserPreferencesStorage } from '../modules/skills/preferences-storage.js';
import { SkillsService } from '../modules/skills/skills-service.js';
import { createSkillsRoutes } from '../modules/skills/skills-routes.js';
import { createPreferencesRoutes } from '../modules/skills/preferences-routes.js';
import { SkillError } from '../modules/skills/types.js';
import type { LLMEngine } from '../modules/llm/engine.js';
import { ChatRuntime } from '../modules/chat/chat-runtime.js';
import { PostgresGenerationRepository } from '../modules/chat/generation-repository.js';
import { createChatRoutes } from '../modules/chat/chat-routes.js';
import { DEFAULT_DEV_ORIGINS, type AppConfig } from './config.js';

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
  readonly conversationsService?: ConversationsService;
  readonly skillStorage?: PostgresSkillStorage;
  readonly preferencesStorage?: PostgresUserPreferencesStorage;
  readonly skillsService?: SkillsService;
  readonly llmEngine?: LLMEngine;
  readonly chatRuntime?: ChatRuntime;
  readonly config?: Partial<AppConfig>;
}

export function createApp(dependencies: AppDependencies = {}): Hono {
  const app = new Hono();

  const isProduction = dependencies.config?.nodeEnv === 'production';
  const cookieConfig = {
    secure: dependencies.config?.cookieSecure ?? isProduction,
    sameSite: dependencies.config?.cookieSameSite ?? 'lax',
  };

  // Determine active allowed origins: fail-closed in production if not explicitly set
  const allowedOrigins = dependencies.config?.allowedOrigins ?? (
    isProduction ? [] : DEFAULT_DEV_ORIGINS
  );

  // CSRF validation on all state-changing API routes (always active and fail-closed)
  app.use(
    '/api/*',
    createCsrfMiddleware({
      allowedOrigins,
      isProduction,
    })
  );

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

  // Mount Conversations module if conversationsService or pool is available alongside authService
  let conversationsService = dependencies.conversationsService;
  if (!conversationsService && dependencies.pool) {
    const convRepo = new ConversationRepository(dependencies.pool);
    const msgRepo = new MessageRepository(dependencies.pool);
    conversationsService = new ConversationsService(convRepo, msgRepo);
  }

  if (conversationsService && authService) {
    const conversationsRouter = createConversationRoutes({
      conversationsService,
      authService,
    });
    app.route('/api/v1/conversations', conversationsRouter);
  }

  // Chat uses only the explicitly injected LLM Engine; unconfigured admission fails closed.
  const chatRuntime = dependencies.chatRuntime ?? (dependencies.pool
    ? new ChatRuntime(new PostgresGenerationRepository(dependencies.pool), dependencies.llmEngine,
      { maxOutputTokens: dependencies.config?.chat?.maxOutputTokens })
    : undefined);
  if (chatRuntime && authService) {
    app.route('/api/v1/conversations', createChatRoutes(chatRuntime, authService));
  }

  // Mount Skills and Preferences modules if dependencies/pool are available
  let skillStorage = dependencies.skillStorage;
  let preferencesStorage = dependencies.preferencesStorage;
  if (!skillStorage && dependencies.pool) {
    skillStorage = new PostgresSkillStorage(dependencies.pool);
  }
  if (!preferencesStorage && dependencies.pool) {
    preferencesStorage = new PostgresUserPreferencesStorage(dependencies.pool);
  }

  let skillsService = dependencies.skillsService;
  if (!skillsService && skillStorage && preferencesStorage) {
    skillsService = new SkillsService(skillStorage, preferencesStorage);
  }

  if (authService && skillsService) {
    const preferencesRouter = createPreferencesRoutes({
      skillsService,
      authService,
    });
    app.route('/api/v1/me/preferences', preferencesRouter);

    const skillsRouter = createSkillsRoutes({
      skillsService,
      authService,
    });
    app.route('/api/v1/skills', skillsRouter);
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

    if (err instanceof SkillError) {
      let statusCode = 400;
      if (err.code === 'SKILL_NOT_FOUND') statusCode = 404;
      else if (err.code === 'SKILL_UNAUTHORIZED') statusCode = 403;
      else if (err.code === 'SKILL_CONFLICT') statusCode = 409;
      else if (err.code === 'SKILL_OVERSIZED') statusCode = 400;

      const errorBody: ErrorResponse = {
        error: {
          code: err.code,
          message: err.message,
        },
      };
      return c.json(errorBody, statusCode as 400 | 403 | 404 | 409);
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
