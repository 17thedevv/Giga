import React, { useState } from 'react';
import { useAuth } from '../../app/context/AuthContext.js';
import { useApiMode } from '../../app/context/ApiModeContext.js';
import { useRouter } from '../../app/router.js';
import { Input } from '../../components/Input.js';
import { Button } from '../../components/Button.js';
import { Alert } from '../../components/Alert.js';
import { Badge } from '../../components/Badge.js';
import { LogoIcon } from '../../components/Icons.js';

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
        backgroundColor: '#090d16',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '420px',
          backgroundColor: '#0f172a',
          border: '1px solid #1e293b',
          borderRadius: '12px',
          padding: '32px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <LogoIcon size={28} />
            <span style={{ fontSize: '18px', fontWeight: 700, letterSpacing: '0.05em', color: '#f1f5f9' }}>
              G I G A
            </span>
          </div>
          <button
            type="button"
            onClick={toggleMode}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
            title="Toggle between Real API and Mock Fixtures"
          >
            <Badge status={mode === 'real' ? 'real' : 'demo'}>
              Mode: {mode.toUpperCase()}
            </Badge>
          </button>
        </div>

        <div style={{ marginBottom: '20px' }}>
          <h1 style={{ fontSize: '20px', fontWeight: 600, color: '#f1f5f9', marginBottom: '6px' }}>
            Developer Workspace
          </h1>
          <p style={{ fontSize: '13px', color: '#94a3b8' }}>
            Sign in to access AI Chat and Autonomous Coding Agent.
          </p>
        </div>

        {mode === 'mock' && (
          <div
            style={{
              padding: '10px 12px',
              backgroundColor: '#172554',
              border: '1px solid #1e40af',
              borderRadius: '6px',
              fontSize: '12px',
              color: '#bfdbfe',
              marginBottom: '20px',
            }}
          >
            <strong>Demo Environment:</strong> Using test fixtures. You may click Sign In with prefilled credentials.
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

        <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid #1e293b', textAlign: 'center' }}>
          <span style={{ fontSize: '12px', color: '#64748b' }}>
            Giga v0.1 • Linear 17T-11 • Tráng A Thư
          </span>
        </div>
      </div>
    </div>
  );
};
