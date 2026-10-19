import React, { useEffect } from 'react';
import { useAuth } from '../../app/context/AuthContext.js';
import { useRouter } from '../../app/router.js';
import { SpinnerIcon } from '../../components/Icons.js';

export const AuthGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, isLoading } = useAuth();
  const { navigate, path } = useRouter();

  useEffect(() => {
    if (!isLoading && !user && path !== '/login') {
      navigate('/login');
    }
  }, [isLoading, user, path, navigate]);

  if (isLoading) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100dvh',
          backgroundColor: 'var(--giga-bg)',
          color: 'var(--giga-text-secondary)',
          gap: '12px',
        }}
      >
        <SpinnerIcon size={32} />
        <span style={{ fontSize: '14px' }}>Verifying Giga developer session...</span>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return <>{children}</>;
};
