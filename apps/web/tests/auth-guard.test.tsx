import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiModeProvider } from '../src/app/context/ApiModeContext.js';
import { AuthProvider, useAuth } from '../src/app/context/AuthContext.js';
import { RouterProvider } from '../src/app/router.js';
import { LoginView } from '../src/features/auth/LoginView.js';

describe('Auth & Routing Integration', () => {
  it('renders login view with demo accounts notice and form inputs', () => {
    render(
      <ApiModeProvider>
        <AuthProvider>
          <RouterProvider>
            <LoginView />
          </RouterProvider>
        </AuthProvider>
      </ApiModeProvider>
    );

    expect(screen.getByText('Developer Workspace')).toBeDefined();
    expect(screen.getByLabelText(/Email Address/i)).toBeDefined();
    expect(screen.getByLabelText(/Password/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /Sign In to Workspace/i })).toBeDefined();
  });

  it('validates required email and password fields on submit', async () => {
    render(
      <ApiModeProvider>
        <AuthProvider>
          <RouterProvider>
            <LoginView />
          </RouterProvider>
        </AuthProvider>
      </ApiModeProvider>
    );

    const emailInput = screen.getByLabelText(/Email Address/i) as HTMLInputElement;
    const passwordInput = screen.getByLabelText(/Password/i) as HTMLInputElement;
    const form = emailInput.closest('form')!;

    // Clear prefilled fields
    fireEvent.change(emailInput, { target: { value: '' } });
    fireEvent.change(passwordInput, { target: { value: '' } });

    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText(/Email address is required/i)).toBeDefined();
      expect(screen.getByText(/Password is required/i)).toBeDefined();
    });
  });

  it('validates email format constraint', async () => {
    render(
      <ApiModeProvider>
        <AuthProvider>
          <RouterProvider>
            <LoginView />
          </RouterProvider>
        </AuthProvider>
      </ApiModeProvider>
    );

    const emailInput = screen.getByLabelText(/Email Address/i) as HTMLInputElement;
    const form = emailInput.closest('form')!;

    fireEvent.change(emailInput, { target: { value: 'not-an-email' } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText(/Please enter a valid email format/i)).toBeDefined();
    });
  });

  describe('Session Lifecycle & Persistence Guard', () => {
    const SessionTester: React.FC = () => {
      const { user, login, logout, checkSession, isLoading } = useAuth();
      return (
        <div>
          <div data-testid="auth-loading">{String(isLoading)}</div>
          <div data-testid="auth-user">{user ? user.email : 'anonymous'}</div>
          <button data-testid="login-btn" onClick={() => login('trangthu@demo.giga.dev', 'CorrectPassword123!')}>
            Login
          </button>
          <button data-testid="logout-btn" onClick={() => logout()}>
            Logout
          </button>
          <button data-testid="check-btn" onClick={() => checkSession()}>
            CheckSession
          </button>
        </div>
      );
    };

    it('guarantees logout persists across checkSession and AuthProvider remount', async () => {
      // Clear sessionStorage initially
      window.sessionStorage.clear();

      const { unmount } = render(
        <ApiModeProvider initialMode="mock">
          <AuthProvider>
            <SessionTester />
          </AuthProvider>
        </ApiModeProvider>
      );

      // Initially unauthenticated
      await waitFor(() => {
        expect(screen.getByTestId('auth-loading').textContent).toBe('false');
        expect(screen.getByTestId('auth-user').textContent).toBe('anonymous');
      });

      // 1. Perform mock login
      fireEvent.click(screen.getByTestId('login-btn'));
      await waitFor(() => {
        expect(screen.getByTestId('auth-user').textContent).toBe('trangthu@demo.giga.dev');
      });

      // 2. Perform mock logout
      fireEvent.click(screen.getByTestId('logout-btn'));
      await waitFor(() => {
        expect(screen.getByTestId('auth-user').textContent).toBe('anonymous');
      });

      // 3. Trigger checkSession - must remain anonymous!
      fireEvent.click(screen.getByTestId('check-btn'));
      await waitFor(() => {
        expect(screen.getByTestId('auth-user').textContent).toBe('anonymous');
      });

      // 4. Remount AuthProvider (simulating page reload) - must remain anonymous!
      unmount();

      render(
        <ApiModeProvider initialMode="mock">
          <AuthProvider>
            <SessionTester />
          </AuthProvider>
        </ApiModeProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-loading').textContent).toBe('false');
        expect(screen.getByTestId('auth-user').textContent).toBe('anonymous');
      });

      // 5. Subsequent re-login succeeds normally
      fireEvent.click(screen.getByTestId('login-btn'));
      await waitFor(() => {
        expect(screen.getByTestId('auth-user').textContent).toBe('trangthu@demo.giga.dev');
      });
    });
  });
});
