import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiModeProvider } from '../src/app/context/ApiModeContext.js';
import { AuthProvider } from '../src/app/context/AuthContext.js';
import { RouterProvider } from '../src/app/router.js';
import { LoginView } from '../src/features/auth/LoginView.js';
import { realApiClient, ApiException } from '../src/lib/api/client.js';
const account={id:'test-user',email:'new@example.invalid',displayName:'New user'};
const renderLogin=()=>render(<ApiModeProvider initialMode="real"><AuthProvider><RouterProvider><LoginView /></RouterProvider></AuthProvider></ApiModeProvider>);
beforeEach(()=>{localStorage.clear();vi.spyOn(realApiClient,'getMe').mockRejectedValue(new ApiException(401,'UNAUTHENTICATED','Sign in'));});
afterEach(()=>vi.restoreAllMocks());
const fill=()=>{
  fireEvent.change(screen.getByLabelText('Display name'),{target:{value:'New user'}});
  fireEvent.change(screen.getByLabelText('Email Address'),{target:{value:account.email}});
  fireEvent.change(screen.getByLabelText('Password'),{target:{value:'test-only-password-123'}});
};
describe('Real account creation',()=>{
  it('starts blank and registers through the real API, then permits normal sign-in without persisting the password',async()=>{
    const register=vi.spyOn(realApiClient,'register').mockResolvedValue({user:account});
    const login=vi.spyOn(realApiClient,'login').mockResolvedValue({user:account});
    renderLogin();expect((screen.getByLabelText('Email Address') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button',{name:'Create account'}));fill();
    fireEvent.submit(screen.getByLabelText('Email Address').closest('form')!);
    await waitFor(()=>expect(screen.getByText(/Account created. Sign in/)).toBeDefined());
    expect(register).toHaveBeenCalledOnce();expect(register).toHaveBeenCalledWith(account.email,'test-only-password-123','New user');
    expect(login).not.toHaveBeenCalled();expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Password'),{target:{value:'test-only-password-123'}});
    fireEvent.submit(screen.getByLabelText('Email Address').closest('form')!);
    await waitFor(()=>expect(login).toHaveBeenCalledWith(account.email,'test-only-password-123'));
    expect(JSON.stringify(localStorage)).not.toContain('test-only-password-123');
  });
  it('validates sign-up fields before making a network request',async()=>{
    const register=vi.spyOn(realApiClient,'register');renderLogin();
    fireEvent.click(screen.getByRole('button',{name:'Create account'}));
    fireEvent.submit(screen.getByLabelText('Email Address').closest('form')!);
    await waitFor(()=>expect(screen.getByText('Display name is required')).toBeDefined());
    expect(screen.getByText('Email address is required')).toBeDefined();expect(screen.getByText('Password is required')).toBeDefined();expect(register).not.toHaveBeenCalled();
  });
  it('shows duplicate-account failure and keeps the form available to correct or sign in',async()=>{
    vi.spyOn(realApiClient,'register').mockRejectedValue(new ApiException(409,'CONFLICT','Email is already registered'));
    renderLogin();fireEvent.click(screen.getByRole('button',{name:'Create account'}));fill();
    fireEvent.submit(screen.getByLabelText('Email Address').closest('form')!);
    await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Email is already registered'));
    expect(screen.queryByText(/Account created. Sign in/)).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Sign in'}));
    expect(screen.getByRole('button',{name:'Sign In to Workspace'})).toBeDefined();
  });
});

