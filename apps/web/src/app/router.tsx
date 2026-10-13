import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

interface RouterContextType {
  path: string;
  navigate: (to: string) => void;
  params: Record<string, string>;
}

const RouterContext = createContext<RouterContextType | undefined>(undefined);

// Pattern matcher for routes with parameters (e.g. /chat/:conversationId, /agent/runs/:runId)
function matchRoute(currentPath: string, pattern: string): Record<string, string> | null {
  const currentParts = currentPath.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);

  if (currentParts.length !== patternParts.length) {
    return null;
  }

  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i];
    const currentPart = currentParts[i];

    if (patternPart.startsWith(':')) {
      const paramName = patternPart.slice(1);
      params[paramName] = decodeURIComponent(currentPart);
    } else if (patternPart !== currentPart) {
      return null;
    }
  }

  return params;
}

export const RouterProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [path, setPath] = useState<string>(() => window.location.pathname || '/login');

  useEffect(() => {
    const handlePopState = () => {
      setPath(window.location.pathname || '/');
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback((to: string) => {
    if (to === window.location.pathname) return;
    window.history.pushState({}, '', to);
    setPath(to);
  }, []);

  // Compute params for recognized route patterns
  let params: Record<string, string> = {};
  const chatMatch = matchRoute(path, '/chat/:conversationId');
  if (chatMatch) {
    params = chatMatch;
  }
  const runMatch = matchRoute(path, '/agent/runs/:runId');
  if (runMatch) {
    params = runMatch;
  }

  return (
    <RouterContext.Provider value={{ path, navigate, params }}>
      {children}
    </RouterContext.Provider>
  );
};

export function useRouter(): RouterContextType {
  const context = useContext(RouterContext);
  if (!context) {
    throw new Error('useRouter must be used within a RouterProvider');
  }
  return context;
}

export const Link: React.FC<{
  to: string;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onClick?: (e: React.MouseEvent) => void;
}> = ({ to, children, className, style, onClick }) => {
  const { navigate } = useRouter();

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (onClick) onClick(e);
    navigate(to);
  };

  return (
    <a href={to} onClick={handleClick} className={className} style={{ textDecoration: 'none', color: 'inherit', ...style }}>
      {children}
    </a>
  );
};
