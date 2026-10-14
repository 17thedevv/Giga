import React, { useState } from 'react';
import { useAuth } from '../../app/context/AuthContext.js';
import { useApiMode } from '../../app/context/ApiModeContext.js';
import { useRouter } from '../../app/router.js';
import { Input } from '../../components/Input.js';
import { Button } from '../../components/Button.js';
import { Alert } from '../../components/Alert.js';
import { Badge } from '../../components/Badge.js';
import { GigaLogo } from '../../components/GigaLogo.js';

export const LoginView: React.FC = () => {
  const { login, error, clearError } = useAuth();
  const { mode, toggleMode } = useApiMode();
  const { navigate } = useRouter();

  const [email, setEmail] = useState('trangthu@demo.giga.dev');
  const [password, setPassword] = useState('CorrectPassword123!');
  const [clientErrors, setClientErrors] = useState<{ email?: string; password?: string }>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();

    const errors: { email?: string; password?: string } = {};
    if (!email.trim()) {
      errors.email = 'Email address is required';
    } else if (!email.includes('@')) {
      errors.email = 'Please enter a valid email format';
    }

    if (!password) {
      errors.password = 'Password is required';
    } else if (password.length < 8) {
      errors.password = 'Password must be at least 8 characters long';
    }

    if (Object.keys(errors).length > 0) {
      setClientErrors(errors);
      return;
    }
    setClientErrors({});
    setIsSubmitting(true);

    try {
      await login(email, password);
      navigate('/chat');
    } catch {
      // Error handled by AuthContext
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        backgroundColor: 'var(--giga-bg, #0B1220)',
      }}
    >
      <div
        className="g-card"
        style={{
          width: '100%',
          maxWidth: '440px',
          backgroundColor: 'var(--giga-surface, #111C2D)',
          border: '1px solid var(--giga-border, #1E293B)',
          borderRadius: 'var(--giga-radius-xl, 16px)',
          padding: '36px',
          boxShadow: 'var(--giga-shadow-md, 0 25px 50px -12px rgba(0, 0, 0, 0.5))',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <GigaLogo variant="horizontal" tone="color" width={140} />
          <button
            type="button"
            onClick={toggleMode}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
            title="Toggle between Real API and Mock Fixtures"
          >
            <Badge status={mode === 'real' ? 'real' : 'demo'}>
              Mode: {mode.toUpperCase()}
            </Badge>
          </button>
        </div>

        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--giga-text, #F8FAFC)', margin: '0 0 6px' }}>
            Developer Workspace
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--giga-text-secondary, #94A3B8)', margin: 0 }}>
            Sign in to access AI Chat and Autonomous Coding Agent.
          </p>
        </div>

        {mode === 'mock' && (
          <div
            style={{
              padding: '12px 14px',
              backgroundColor: 'var(--giga-primary-subtle, rgba(59, 130, 246, 0.12))',
              border: '1px solid rgba(59, 130, 246, 0.3)',
              borderRadius: 'var(--giga-radius-md, 8px)',
              fontSize: '12px',
              color: 'var(--giga-text, #F8FAFC)',
              marginBottom: '20px',
            }}
          >
            <strong style={{ color: 'var(--giga-primary, #3B82F6)' }}>Demo Environment:</strong> Using test fixtures. You may click Sign In with prefilled credentials.
          </div>
        )}

        {error && (
          <div style={{ marginBottom: '16px' }}>
            <Alert type="error" message={error} onDismiss={clearError} />
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <Input
            id="email"
            type="email"
            label="Email Address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@demo.giga.dev"
            error={clientErrors.email}
            autoComplete="email"
            disabled={isSubmitting}
          />

          <Input
            id="password"
            type="password"
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••••"
            error={clientErrors.password}
            autoComplete="current-password"
            disabled={isSubmitting}
          />

          <Button type="submit" variant="primary" loading={isSubmitting} style={{ marginTop: '8px' }}>
            Sign In to Workspace
          </Button>
        </form>

        <div style={{ marginTop: '28px', paddingTop: '16px', borderTop: '1px solid var(--giga-border, #1E293B)', textAlign: 'center' }}>
          <span style={{ fontSize: '12px', color: 'var(--giga-text-muted, #94A3B8)' }}>
            GIGA AI Cloud • Design System v1.0 • Tráng A Thư
          </span>
        </div>
      </div>
    </div>
  );
};
