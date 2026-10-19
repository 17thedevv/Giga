import React, { useState } from 'react';
import { Modal } from '../../components/Modal.js';
import { Button } from '../../components/Button.js';
import { Alert } from '../../components/Alert.js';
import { TrashIcon, AlertTriangleIcon } from '../../components/Icons.js';
import type { ProviderCredential, ChatCredentialMode } from '../../lib/api/types.js';

interface DeleteCredentialModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  credential: ProviderCredential | null;
  activeMode: ChatCredentialMode;
}

export const DeleteCredentialModal: React.FC<DeleteCredentialModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  credential,
  activeMode,
}) => {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!credential) return null;

  const isByokActive = activeMode === 'byok';

  const handleDelete = async () => {
    try {
      setIsDeleting(true);
      setError(null);
      await onConfirm();
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to delete credential';
      setError(message);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isDeleting) {
          setError(null);
          onClose();
        }
      }}
      title="Delete Gemini API Key"
    >
      <div style={{ padding: '20px' }} data-testid="delete-credential-dialog">
        {error && (
          <div style={{ marginBottom: '16px' }}>
            <Alert type="error" message={error} onDismiss={() => setError(null)} />
          </div>
        )}

        <p style={{ fontSize: '14px', color: 'var(--giga-text, #F8FAFC)', margin: '0 0 14px' }}>
          Are you sure you want to delete your saved Gemini credential (<strong>{credential.displayHint}</strong>)?
        </p>

        {isByokActive && (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              padding: '12px 14px',
              backgroundColor: 'rgba(217, 119, 6, 0.12)',
              border: '1px solid rgba(217, 119, 6, 0.35)',
              borderRadius: 'var(--giga-radius-md, 8px)',
              fontSize: '13px',
              color: '#FBBF24',
              marginBottom: '16px',
            }}
            data-testid="delete-byok-warning"
          >
            <AlertTriangleIcon size={18} style={{ flexShrink: 0, marginTop: '2px' }} />
            <div>
              <strong>BYOK is currently active:</strong> Deleting this key will leave your Chat in an unusable state
              until you add a replacement key or switch back to the Giga Platform Key. The system will not silently
              fall back to the platform key.
            </div>
          </div>
        )}

        <p style={{ fontSize: '13px', color: 'var(--giga-text-secondary, #94A3B8)', margin: '0 0 20px' }}>
          This action will permanently remove the encrypted credential from the database and cannot be undone.
        </p>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={isDeleting}
            data-testid="cancel-delete-credential-btn"
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={handleDelete}
            loading={isDeleting}
            disabled={isDeleting}
            icon={<TrashIcon size={16} />}
            data-testid="confirm-delete-credential-btn"
          >
            {isDeleting ? 'Deleting...' : 'Delete Key'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
