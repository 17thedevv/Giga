import React, { createContext, useContext, useState, useEffect } from 'react';
import type { ApiMode } from '../../lib/api/types.js';

interface ApiModeContextType {
  mode: ApiMode;
  setMode: (mode: ApiMode) => void;
  toggleMode: () => void;
}

const ApiModeContext = createContext<ApiModeContextType | undefined>(undefined);

export const ApiModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setModeState] = useState<ApiMode>(() => {
    const saved = localStorage.getItem('giga_api_mode');
    return (saved === 'real' || saved === 'mock') ? saved : 'mock';
  });

  const setMode = (newMode: ApiMode) => {
    setModeState(newMode);
    localStorage.setItem('giga_api_mode', newMode);
  };

  const toggleMode = () => {
    setMode(mode === 'mock' ? 'real' : 'mock');
  };

  useEffect(() => {
    localStorage.setItem('giga_api_mode', mode);
  }, [mode]);

  return (
    <ApiModeContext.Provider value={{ mode, setMode, toggleMode }}>
      {children}
    </ApiModeContext.Provider>
  );
};

export function useApiMode(): ApiModeContextType {
  const context = useContext(ApiModeContext);
  if (!context) {
    throw new Error('useApiMode must be used within an ApiModeProvider');
  }
  return context;
}
