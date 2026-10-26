import React, { useState, useEffect } from 'react';
import { Modal } from '../../components/Modal.js';
import { Button } from '../../components/Button.js';
import { Alert } from '../../components/Alert.js';
import { KeyIcon, EyeIcon, EyeOffIcon, ShieldIcon } from '../../components/Icons.js';
import type { ProviderCredential } from '../../lib/api/types.js';
import { sanitizeUntrustedText } from '../../lib/security/untrusted-content.js';

interface SaveCredentialModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (apiKey: string) => Promise<void>;
  existingCredential?: ProviderCredential | null;
}

export const SaveCredentialModal: React.FC<SaveCredentialModalProps> = ({
  isOpen,
  onClose,
  onSave,
  existingCredential,
}) => {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Clear plaintext state whenever modal opens or closes
  useEffect(() => {
    if (!isOpen) {
      setApiKey('');
      setShowKey(false);
      setError(null);
      setValidationError(null);
      setIsSubmitting(false);
    }
  }, [isOpen]);

  const handleKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setApiKey(val);
    if (validationError) {
      setValidationError(null);
    }
    if (error) {
      setError(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = apiKey.trim();

    if (!trimmed) {
      setValidationError('Gemini API key is required');
      return;
    }

    if (trimmed.length < 16 || trimmed.length > 512) {
      setValidationError('API key must be between 16 and 512 characters');
      return;
    }

    // Backend validation contract: ASCII printable characters only
    if (!/^[\x21-\x7e]{16,512}$/.test(trimmed)) {
      setValidationError('API key contains invalid characters (must be printable ASCII)');
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);
      await onSave(trimmed);
      // Immediately clear plaintext input from memory
      setApiKey('');
      setShowKey(false);
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save credential';
      setApiKey('');
      setShowKey(false);
      setError(sanitizeUntrustedText(message, [trimmed]));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    // Zero out plaintext on close
    setApiKey('');
    setShowKey(false);
    onClose();
  };

  const isReplace = Boolean(existingCredential);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={isReplace ? 'Replace Gemini API Key' : 'Add Gemini API Key'}
    >
      <form onSubmit={handleSubmit} data-testid="save-credential-form" style={{ padding: '20px' }}>
        <div style={{ marginBottom: '16px' }}>
          <p style={{ fontSize: '13px', color: 'var(--giga-text-secondary, #94A3B8)', margin: '0 0 12px' }}>
            {isReplace
              ? `Enter your new Gemini API key to replace ${existingCredential?.displayHint}. Replacing your key will automatically update your active BYOK Chat configuration.`
              : 'Add your own Google Gemini API key to use with GigaChat in BYOK (Bring Your Own Key) mode.'}
          </p>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 12px',
              backgroundColor: 'rgba(59, 130, 246, 0.08)',
              border: '1px solid rgba(59, 130, 246, 0.25)',
              borderRadius: 'var(--giga-radius-md, 8px)',
              fontSize: '12px',
              color: 'var(--giga-primary, #3B82F6)',
              marginBottom: '16px',
            }}
          >
            <ShieldIcon size={16} />
            <span>
              Your key is encrypted on the server using AES-256-GCM. Saved keys cannot be viewed again in plaintext.
            </span>
          </div>
        </div>

        {error && (
          <div style={{ marginBottom: '16px' }}>
            <Alert type="error" message={error} onDismiss={() => setError(null)} />
          </div>
        )}

        <div style={{ marginBottom: '20px' }}>
          <label
            htmlFor="gemini-api-key-input"
            className="g-label"
            style={{
              display: 'block',
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--giga-text, #F8FAFC)',
              marginBottom: '6px',
            }}
          >
            Gemini API Key
          </label>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <input
              id="gemini-api-key-input"
              data-testid="gemini-api-key-input"
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={handleKeyChange}
              placeholder="AIzaSy..."
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              style={{
                width: '100%',
                padding: '10px 42px 10px 12px',
                backgroundColor: 'var(--giga-surface-muted, #18263A)',
                color: 'var(--giga-text, #F8FAFC)',
                border: `1px solid ${validationError ? 'var(--giga-danger, #EF4444)' : 'var(--giga-border, #334155)'}`,
                borderRadius: 'var(--giga-radius-md, 8px)',
                fontSize: '14px',
                fontFamily: 'monospace',
                outline: 'none',
              }}
              disabled={isSubmitting}
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              style={{
                position: 'absolute',
                right: '8px',
                background: 'transparent',
                border: 'none',
                color: 'var(--giga-text-secondary, #94A3B8)',
                cursor: 'pointer',
                padding: '6px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '4px',
              }}
              title={showKey ? 'Hide key' : 'Show key'}
              aria-label={showKey ? 'Hide key' : 'Show key'}
            >
              {showKey ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
            </button>
          </div>
          {validationError ? (
            <span
              data-testid="api-key-validation-error"
              style={{ display: 'block', fontSize: '12px', color: 'var(--giga-danger, #EF4444)', marginTop: '6px' }}
              role="alert"
            >
              {validationError}
            </span>
          ) : (
            <span style={{ display: 'block', fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)', marginTop: '6px' }}>
              Requires 16–512 ASCII printable characters from Google AI Studio.
            </span>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <Button variant="secondary" onClick={handleClose} disabled={isSubmitting} data-testid="cancel-save-credential-btn">
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={isSubmitting}
            disabled={isSubmitting || !apiKey.trim()}
            icon={<KeyIcon size={16} />}
            data-testid="submit-save-credential-btn"
          >
            {isSubmitting ? 'Saving...' : isReplace ? 'Save Replacement Key' : 'Save Key'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
