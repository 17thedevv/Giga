import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { User } from '../../lib/api/types.js';
import { realApiClient, ApiException } from '../../lib/api/client.js';
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

  const checkSession = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      if (mode === 'real') {
        const res = await realApiClient.getMe();
        setUser(res.user);
      } else {
        const res = await mockDataAdapter.getMe();
        setUser(res.user);
      }
    } catch (err: unknown) {
      if (err instanceof ApiException && err.status === 401) {
        setUser(null);
      } else if (mode === 'real') {
        // If real backend is offline or unauthenticated
        setUser(null);
      } else {
        setUser(null);
      }
    } finally {
      setIsLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(null);
    const run = async () => {
      try {
        if (mode === 'real') {
          const res = await realApiClient.getMe();
          if (active) setUser(res.user);
        } else {
          const res = await mockDataAdapter.getMe();
          if (active) setUser(res.user);
        }
      } catch {
        if (active) setUser(null);
      } finally {
        if (active) setIsLoading(false);
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
    try {
      if (mode === 'real') {
        const res = await realApiClient.login(email, password);
        setUser(res.user);
      } else {
        const res = await mockDataAdapter.login(email, password);
        setUser(res.user);
      }
      setSessionExpired(false);
    } catch (err: unknown) {
      if (err instanceof ApiException) {
        setError(err.message || 'Authentication failed');
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Unexpected error during login');
      }
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    setIsLoading(true);
    try {
      if (mode === 'real') {
        await realApiClient.logout();
      } else {
        await mockDataAdapter.logout();
      }
    } catch {
      // Ignore logout errors and clear local state
    } finally {
      setUser(null);
      setIsLoading(false);
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
