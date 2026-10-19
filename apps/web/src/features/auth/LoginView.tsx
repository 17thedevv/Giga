import React, { useEffect, useState } from 'react';
import { useAuth } from '../../app/context/AuthContext.js';
import { useApiMode } from '../../app/context/ApiModeContext.js';
import { useRouter } from '../../app/router.js';
import { Input } from '../../components/Input.js';
import { Button } from '../../components/Button.js';
import { Alert } from '../../components/Alert.js';
import { Badge } from '../../components/Badge.js';
import { realApiClient } from '../../lib/api/client.js';
import { GigaLogo } from '../../components/GigaLogo.js';

export const LoginView: React.FC = () => {
  const { login, error, clearError } = useAuth();
  const { mode, toggleMode } = useApiMode();
  const { navigate } = useRouter();

  const [email, setEmail] = useState(mode === 'mock' ? 'trangthu@demo.giga.dev' : '');
  const [password, setPassword] = useState(mode === 'mock' ? 'CorrectPassword123!' : '');
  const [isSignUp, setIsSignUp] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [clientErrors, setClientErrors] = useState<{ email?: string; password?: string; displayName?: string }>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setEmail(mode === 'mock' ? 'trangthu@demo.giga.dev' : '');
    setPassword(mode === 'mock' ? 'CorrectPassword123!' : '');
    setRegistrationError(null);
    setNotice(null);
  }, [mode]);

  const switchForm = () => {
    setIsSignUp(!isSignUp); setClientErrors({}); setRegistrationError(null); setNotice(null); clearError(); setPassword('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    setRegistrationError(null);
    setNotice(null);
    if (isSignUp && mode !== 'real') return;

    const errors: { email?: string; password?: string; displayName?: string } = {};
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

    if (password.length > 128) errors.password = 'Password must not exceed 128 characters';
    if (isSignUp && !displayName.trim()) errors.displayName = 'Display name is required';
    if (isSignUp && displayName.trim().length > 64) errors.displayName = 'Display name must not exceed 64 characters';

    if (Object.keys(errors).length > 0) {
      setClientErrors(errors);
      return;
    }
    setClientErrors({});
    setIsSubmitting(true);

    try {
      if (isSignUp) {
        await realApiClient.register(email.trim(), password, displayName.trim());
        setIsSignUp(false);
        setPassword('');
        setNotice('Account created. Sign in with your new password to begin.');
      } else {
        await login(email.trim(), password);
        navigate('/chat');
      }
    } catch (error) {
      if (isSignUp) setRegistrationError(error instanceof Error ? error.message : 'Could not create account. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="g-login-page"
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
        className="g-card g-login-card"
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
            disabled={isSubmitting}
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
            {isSignUp ? 'Make room for your ideas.' : 'A little space for possibility.'}
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--giga-text-secondary, #94A3B8)', margin: 0 }}>
            {isSignUp ? 'Create your account and start a conversation.' : 'Sign in to think, create, and build with Giga.'}
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

        {notice && <div style={{ marginBottom: 16 }}><Alert type="success" message={notice} /></div>}
        {registrationError && <div style={{ marginBottom: 16 }}><Alert type="error" message={registrationError} onDismiss={() => setRegistrationError(null)} /></div>}
        {isSignUp && mode === 'mock' && <div style={{ marginBottom: 16 }}><Alert type="info" message="Account creation uses the real API. Switch Mode to REAL above to continue." /></div>}
        {error && (
          <div style={{ marginBottom: '16px' }}>
            <Alert type="error" message={error} onDismiss={clearError} />
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {isSignUp && <Input id="displayName" label="Display name" value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="nickname" maxLength={64} disabled={isSubmitting} error={clientErrors.displayName} placeholder="What should we call you?" />}
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
            autoComplete={isSignUp ? 'new-password' : 'current-password'}
            maxLength={128}
            disabled={isSubmitting}
          />

          <Button type="submit" variant="primary" disabled={isSignUp && mode !== 'real'} loading={isSubmitting} style={{ marginTop: '8px' }}>
            {isSignUp ? 'Create account' : 'Sign In to Workspace'}
          </Button>
        </form>
        <div className="g-auth-switch"><span>{isSignUp ? 'Already have an account?' : 'New to Giga?'}</span><button type="button" onClick={switchForm} disabled={isSubmitting}>{isSignUp ? 'Sign in' : 'Create account'}</button></div>

        <div style={{ marginTop: '28px', paddingTop: '16px', borderTop: '1px solid var(--giga-border, #1E293B)', textAlign: 'center' }}>
          <span style={{ fontSize: '12px', color: 'var(--giga-text-muted, #94A3B8)' }}>
            Your ideas, with room to grow.
          </span>
        </div>
      </div>
    </div>
  );
};
