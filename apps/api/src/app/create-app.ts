import { Hono } from 'hono';

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

export function createApp(): Hono {
  const app = new Hono();

  // Health check endpoint
  app.get('/health', (c) => {
    const responseBody: HealthResponse = {
      status: 'ok',
      service: 'giga-api',
      timestamp: new Date().toISOString(),
    };
    return c.json(responseBody, 200);
  });

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

  // Global error handler - guarantees no stack traces or credentials in response
  app.onError((_err, c) => {
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
