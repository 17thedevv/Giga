import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

type Environment = 'production' | 'development' | 'test';
type StreamOutcome = 'completed' | 'stopped' | 'disconnected' | 'provider_error' | 'timeout' | 'failed';
type SystemEvent = 'server_listening' | 'startup_failed' | 'migration_applied' | 'migration_failed'
  | 'database_idle_error' | 'database_probe_failed' | 'operations_listener_failed';

interface Trace {
  requestId: string;
  correlationId?: string;
  method: string;
  environment: Environment;
  sink: LogSink;
}

export type LogSink = (line: string) => void;
const requestTrace = new AsyncLocalStorage<Trace>();
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
let stdoutBlocked = false;
const stdout: LogSink = line => {
  if (stdoutBlocked) return;
  if (!process.stdout.write(line + '\n')) {
    stdoutBlocked = true;
    process.stdout.once('drain', () => { stdoutBlocked = false; });
  }
};

function environment(): Environment {
  return process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test'
    ? process.env.NODE_ENV
    : 'development';
}

function emit(sink: LogSink, env: Environment, level: 'info' | 'warn' | 'error', event: string, fields: object = {}): void {
  // Only callers below construct log fields. Never serialize Error objects or request data.
  sink(JSON.stringify({ timestamp: new Date().toISOString(), level, service: 'giga-api', environment: env, event, ...fields }));
}

function errorCategory(status: number): string | undefined {
  if (status === 401) return 'authentication';
  if (status === 403) return 'authorization';
  if (status === 429) return 'rate_limit';
  if (status === 503) return 'dependency_unavailable';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return undefined;
}

function traceFields(trace: Trace): object {
  return { requestId: trace.requestId, correlationId: trace.correlationId, method: trace.method };
}

export function requestLogging(env: Environment, sink: LogSink = stdout): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    const incomingCorrelation = c.req.header('x-correlation-id');
    const trace: Trace = {
      requestId: randomUUID(),
      // Correlate opaque UUIDs without copying any caller-supplied value to logs.
      correlationId: incomingCorrelation && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(incomingCorrelation)
        ? createHash('sha256').update(incomingCorrelation.toLowerCase()).digest('hex').slice(0, 32)
        : undefined,
      method: methods.has(c.req.method) ? c.req.method : 'OTHER',
      environment: env,
      sink,
    };
    await requestTrace.run(trace, async () => {
      await next();
      // Set it on the finalized response, including raw streaming Responses.
      c.header('X-Request-ID', trace.requestId);
      const status = c.res.status;
      const route = c.req.routePath;
      emit(sink, env, status >= 500 ? 'error' : 'info', 'http_request', {
        ...traceFields(trace),
        route: route?.length <= 160 ? route : 'unmatched',
        status,
        durationMs: Math.round(performance.now() - started),
        errorCategory: errorCategory(status),
      });
    });
  };
}

export function logChatStream(outcome: StreamOutcome, started: number): void {
  const trace = requestTrace.getStore();
  if (!trace) return;
  const successful = outcome === 'completed' || outcome === 'stopped';
  emit(trace.sink, trace.environment, successful ? 'info' : 'warn', 'chat_stream_end', {
    ...traceFields(trace),
    route: '/api/v1/conversations/:id/:transport',
    status: 200,
    durationMs: Math.round(performance.now() - started),
    outcome,
    errorCategory: successful ? undefined : outcome,
  });
}

export function logSystemEvent(event: SystemEvent, level: 'info' | 'warn' | 'error', version?: number): void {
  emit(stdout, environment(), level, event, { version, errorCategory: level === 'info' ? undefined : event });
}
