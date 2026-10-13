import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiModeProvider } from '../src/app/context/ApiModeContext.js';
import { AuthProvider } from '../src/app/context/AuthContext.js';
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
});
