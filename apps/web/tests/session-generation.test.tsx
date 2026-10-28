import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiModeProvider, useApiMode } from '../src/app/context/ApiModeContext.js';
import { AuthProvider, useAuth } from '../src/app/context/AuthContext.js';
import {
  getSessionGeneration,
  realApiClient,
} from '../src/lib/api/client.js';
import { MAX_SSE_LINE_CHARACTERS, SseBufferLimitError } from '../src/lib/api/sse-parser.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function user(email: string) {
  return { id: `user-${email}`, email, displayName: email.split('@')[0] };
}

const AuthProbe: React.FC = () => {
  const auth = useAuth();
  const { mode, setMode } = useApiMode();
  return (
    <div>
      <span data-testid="auth-email">{auth.user?.email ?? 'anonymous'}</span>
      <span data-testid="api-mode">{mode}</span>
      <button onClick={() => { void auth.login('new@example.test', 'SyntheticPassword123!').catch(() => {}); }}>Login</button>
      <button onClick={() => { void auth.logout(); }}>Logout</button>
      <button onClick={() => setMode(mode === 'real' ? 'mock' : 'real')}>Switch mode</button>
    </div>
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  localStorage.removeItem('giga_api_mode');
});

describe('API session generation fencing', () => {
  it('rejects a protected 200 response that arrives after a 401 invalidates its generation', async () => {
    const delayed = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      return String(input).includes('/auth/me')
        ? delayed.promise
        : Promise.resolve(jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'Expired' } }, 401));
    }));

    const staleResponse = realApiClient.getMe();
    const staleAssertion = expect(staleResponse).rejects.toMatchObject({ code: 'SESSION_EXPIRED', status: 401 });
    await expect(realApiClient.getConversation('trigger-401')).rejects.toMatchObject({ status: 401 });

    delayed.resolve(jsonResponse({ user: user('stale@example.test') }));
    await staleAssertion;
  });

  it('rejects a protected 201 response arriving after session invalidation', async () => {
    const delayed = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      return String(input).endsWith('/api/v1/conversations')
        ? delayed.promise
        : Promise.resolve(jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'Expired' } }, 401));
    }));

    const staleResponse = realApiClient.createConversation('stale create');
    const staleAssertion = expect(staleResponse).rejects.toMatchObject({ code: 'SESSION_EXPIRED', status: 401 });
    await expect(realApiClient.listModels()).rejects.toMatchObject({ status: 401 });

    delayed.resolve(jsonResponse({ conversation: {
      id: 'conversation-1', title: 'stale create', createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    } }, 201));
    await staleAssertion;
  });

  it('keeps protected 204 responses fenced after session invalidation', async () => {
    const delayed = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      return String(input).includes('/conversations/conversation-1')
        ? delayed.promise
        : Promise.resolve(jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'Expired' } }, 401));
    }));

    const staleResponse = realApiClient.deleteConversation('conversation-1');
    const staleAssertion = expect(staleResponse).rejects.toMatchObject({ code: 'SESSION_EXPIRED', status: 401 });
    await expect(realApiClient.listModels()).rejects.toMatchObject({ status: 401 });
    delayed.resolve(new Response(null, { status: 204 }));
    await staleAssertion;
  });

  it('allows ordinary concurrent protected successes in the same generation', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/auth/me')) return Promise.resolve(jsonResponse({ user: user('current@example.test') }));
      return Promise.resolve(jsonResponse({ items: [], nextCursor: null }));
    }));

    const [me, conversations] = await Promise.all([
      realApiClient.getMe(),
      realApiClient.listConversations(),
    ]);
    expect(me.user.email).toBe('current@example.test');
    expect(conversations).toEqual({ items: [], nextCursor: null });
  });

  it('ignores an old-session 401 after a new login without clearing authenticated UI', async () => {
    const oldResponse = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/conversations/old-session')) return oldResponse.promise;
      if (path.endsWith('/auth/login')) return Promise.resolve(jsonResponse({ user: user('new@example.test') }));
      if (path.endsWith('/auth/me')) return Promise.resolve(jsonResponse({ user: user('old@example.test') }));
      return Promise.resolve(jsonResponse({}));
    }));

    render(<ApiModeProvider initialMode="real"><AuthProvider><AuthProbe /></AuthProvider></ApiModeProvider>);
    await waitFor(() => expect(screen.getByTestId('auth-email').textContent).toBe('old@example.test'));
    const oldRequest = realApiClient.getConversation('old-session');
    const oldAssertion = expect(oldRequest).rejects.toMatchObject({ status: 401 });
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));
    await waitFor(() => expect(screen.getByTestId('auth-email').textContent).toBe('new@example.test'));
    const generationAfterLogin = getSessionGeneration();

    oldResponse.resolve(jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'Old session expired' } }, 401));
    await oldAssertion;
    expect(getSessionGeneration()).toBe(generationAfterLogin);
    expect(screen.getByTestId('auth-email').textContent).toBe('new@example.test');
  });

  it('invalidates only once for multiple 401s from the same session generation', async () => {
    const first401 = deferred<Response>();
    const second401 = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      return String(input).endsWith('/auth/me') ? first401.promise : second401.promise;
    }));

    const unauthorizedEvents: Event[] = [];
    const onExpired = (event: Event) => unauthorizedEvents.push(event);
    window.addEventListener('giga:session-expired', onExpired);
    const currentGeneration = getSessionGeneration();
    const first = realApiClient.getMe();
    const second = realApiClient.listModels();
    const firstAssertion = expect(first).rejects.toMatchObject({ status: 401 });
    const secondAssertion = expect(second).rejects.toMatchObject({ status: 401 });
    first401.resolve(jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'Expired' } }, 401));
    await firstAssertion;
    expect(getSessionGeneration()).toBe(currentGeneration + 1);
    second401.resolve(jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'Expired' } }, 401));
    await secondAssertion;
    expect(getSessionGeneration()).toBe(currentGeneration + 1);
    expect(unauthorizedEvents).toHaveLength(1);
    window.removeEventListener('giga:session-expired', onExpired);
  });

  it('does not let a delayed logout response clear a newer authenticated user', async () => {
    const delayedLogout = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/me')) return Promise.resolve(jsonResponse({ user: user('old@example.test') }));
      if (path.endsWith('/auth/logout')) return delayedLogout.promise;
      if (path.endsWith('/auth/login')) return Promise.resolve(jsonResponse({ user: user('new@example.test') }));
      return Promise.resolve(jsonResponse({}));
    }));

    render(<ApiModeProvider initialMode="real"><AuthProvider><AuthProbe /></AuthProvider></ApiModeProvider>);
    await waitFor(() => expect(screen.getByTestId('auth-email').textContent).toBe('old@example.test'));

    fireEvent.click(screen.getByRole('button', { name: 'Logout' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/v1/auth/logout', expect.any(Object)));
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));
    await waitFor(() => expect(screen.getByTestId('auth-email').textContent).toBe('new@example.test'));

    await act(async () => delayedLogout.resolve(new Response(null, { status: 204 })));
    await waitFor(() => expect(screen.getByTestId('auth-email').textContent).toBe('new@example.test'));
  });

  it('does not restore a Real user after switching to Mock mode while getMe is in flight', async () => {
    const delayedMe = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => delayedMe.promise));
    window.sessionStorage.clear();

    render(<ApiModeProvider initialMode="real"><AuthProvider><AuthProbe /></AuthProvider></ApiModeProvider>);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/v1/auth/me', expect.any(Object)));
    fireEvent.click(screen.getByRole('button', { name: 'Switch mode' }));
    await waitFor(() => {
      expect(screen.getByTestId('api-mode').textContent).toBe('mock');
      expect(screen.getByTestId('auth-email').textContent).toBe('anonymous');
    });

    await act(async () => delayedMe.resolve(jsonResponse({ user: user('real-stale@example.test') })));
    await waitFor(() => expect(screen.getByTestId('auth-email').textContent).toBe('anonymous'));
    expect(screen.queryByText('real-stale@example.test')).toBeNull();
  });

  it.each(['message', 'variant'] as const)('cancels and releases an oversized %s SSE stream', async action => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${'x'.repeat(MAX_SSE_LINE_CHARACTERS + 1)}`));
      },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(stream, {
      headers: { 'content-type': 'text/event-stream' },
    }))));

    const request = action === 'message'
      ? realApiClient.streamMessage('conversation-1', 'hello', () => {})
      : realApiClient.streamVariant('conversation-1', 'message-1', 'retry', () => {});
    await expect(request).rejects.toBeInstanceOf(SseBufferLimitError);
    expect(cancelled).toBe(true);
  });
});
