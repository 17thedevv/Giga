import React, { createContext, useContext, useState, useEffect, useLayoutEffect, useCallback } from 'react';
import type { User } from '../../lib/api/types.js';
import {
  realApiClient,
  ApiException,
  SESSION_EXPIRED_EVENT,
  advanceSessionGeneration,
  getSessionGeneration,
  isCurrentSessionGeneration,
} from '../../lib/api/client.js';
import { mockDataAdapter } from '../../lib/api/mock-adapter.js';
import { useApiMode } from './ApiModeContext.js';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  error: string | null;
  sessionExpired: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  dismissSessionExpired: () => void;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { mode } = useApiMode();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState<boolean>(false);
  useEffect(() => {
    if (mode !== 'real' || typeof window === 'undefined') return;
    const invalidateSession = () => {
      setUser(null);
      setIsLoading(false);
      setError(null);
      setSessionExpired(false);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, invalidateSession);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, invalidateSession);
  }, [mode]);

  const checkSession = useCallback(async () => {
    const generation = getSessionGeneration();
    setIsLoading(true);
    setError(null);
    try {
      if (mode === 'real') {
        const res = await realApiClient.getMe();
        if (isCurrentSessionGeneration(generation)) setUser(res.user);
      } else {
        const res = await mockDataAdapter.getMe();
        if (isCurrentSessionGeneration(generation)) setUser(res.user);
      }
    } catch (err: unknown) {
      if (isCurrentSessionGeneration(generation)) {
        if (err instanceof ApiException && err.status === 401) {
          setUser(null);
        } else if (mode === 'real') {
          // If real backend is offline or unauthenticated
          setUser(null);
        } else {
          setUser(null);
        }
      }
    } finally {
      if (isCurrentSessionGeneration(generation)) setIsLoading(false);
    }
  }, [mode]);

  useLayoutEffect(() => {
    let active = true;
    // Mode transitions invalidate outstanding auth/API requests through the
    // same generation used by the real API client; Mock and Real stay isolated.
    const generation = advanceSessionGeneration();
    setIsLoading(true);
    setError(null);
    const isCurrent = () => active && isCurrentSessionGeneration(generation);
    const run = async () => {
      try {
        if (mode === 'real') {
          const res = await realApiClient.getMe();
          if (isCurrent()) setUser(res.user);
        } else {
          const res = await mockDataAdapter.getMe();
          if (isCurrent()) setUser(res.user);
        }
      } catch {
        if (isCurrent()) setUser(null);
      } finally {
        if (isCurrent()) setIsLoading(false);
      }
    };
    run();
    return () => {
      active = false;
    };
  }, [mode]);

  const login = async (email: string, password: string) => {
    setIsLoading(true);
    setError(null);
    let generation: number;
    let loginRequest: Promise<{ user: User }>;
    if (mode === 'real') {
      // RealApiClient advances the generation synchronously when login begins.
      loginRequest = realApiClient.login(email, password);
      generation = getSessionGeneration();
    } else {
      generation = advanceSessionGeneration();
      loginRequest = mockDataAdapter.login(email, password);
    }
    try {
      const res = await loginRequest;
      if (isCurrentSessionGeneration(generation)) setUser(res.user);
      if (isCurrentSessionGeneration(generation)) setSessionExpired(false);
    } catch (err: unknown) {
      if (isCurrentSessionGeneration(generation)) {
        if (err instanceof ApiException) {
          setError(err.message || 'Authentication failed');
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('Unexpected error during login');
        }
      }
      throw err;
    } finally {
      if (isCurrentSessionGeneration(generation)) setIsLoading(false);
    }
  };

  const logout = async () => {
    setIsLoading(true);
    let generation: number;
    let logoutRequest: Promise<void>;
    if (mode === 'real') {
      // The real client advances before the request is sent, so a later login
      // fences this response and its local state update.
      logoutRequest = realApiClient.logout();
      generation = getSessionGeneration();
    } else {
      generation = advanceSessionGeneration();
      logoutRequest = mockDataAdapter.logout();
    }
    try {
      await logoutRequest;
    } catch {
      // Ignore logout errors and clear local state
    } finally {
      if (isCurrentSessionGeneration(generation)) {
        setUser(null);
        setIsLoading(false);
      }
    }
  };

  const dismissSessionExpired = () => {
    setSessionExpired(false);
  };

  const clearError = () => {
    setError(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        error,
        sessionExpired,
        login,
        logout,
        checkSession,
        dismissSessionExpired,
        clearError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
