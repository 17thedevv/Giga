import React, { useState } from 'react';
import { useAuth } from '../../app/context/AuthContext.js';
import { Modal } from '../../components/Modal.js';
import { Input } from '../../components/Input.js';
import { Button } from '../../components/Button.js';
import { Alert } from '../../components/Alert.js';

export const SessionExpiredModal: React.FC = () => {
  const { sessionExpired, dismissSessionExpired, login } = useAuth();
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!sessionExpired) return null;

  const handleReauth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setErrorMsg('Please enter your password to restore session');
      return;
    }
    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      await login('trangthu@demo.giga.dev', password);
      dismissSessionExpired();
      setPassword('');
    } catch {
      setErrorMsg('Incorrect password. Please verify your credentials.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isOpen={sessionExpired} onClose={dismissSessionExpired} title="Session Expired">
      <form onSubmit={handleReauth} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <p style={{ fontSize: '14px', color: '#94a3b8', lineHeight: 1.5 }}>
          Your authenticated session has expired. To protect workspace state and prevent loss of uncommitted diffs, please re-authenticate:
        </p>

        {errorMsg && <Alert type="error" message={errorMsg} />}

        <Input
          type="password"
          label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter your password"
          autoFocus
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
          <Button type="button" variant="ghost" onClick={dismissSessionExpired}>
            Dismiss
          </Button>
          <Button type="submit" variant="primary" loading={isSubmitting}>
            Restore Session
          </Button>
        </div>
      </form>
    </Modal>
  );
};
