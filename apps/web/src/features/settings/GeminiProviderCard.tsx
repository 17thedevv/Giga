import React from 'react';
import { Card } from '../../components/Card.js';
import { Badge } from '../../components/Badge.js';
import { Button } from '../../components/Button.js';
import { Alert } from '../../components/Alert.js';
import {
  KeyIcon,
  RefreshCwIcon,
  TrashIcon,
  ShieldIcon,
  SlidersIcon,
} from '../../components/Icons.js';
import type { ProviderCredential, ChatCredentialPreference, ChatCredentialMode } from '../../lib/api/types.js';

interface GeminiProviderCardProps {
  credential: ProviderCredential | null;
  preference: ChatCredentialPreference;
  onModeChange: (mode: ChatCredentialMode) => Promise<void>;
  onValidate: (id: string) => Promise<void>;
  onOpenSaveModal: () => void;
  onOpenDeleteModal: () => void;
  isValidating: boolean;
  isSavingMode: boolean;
  validationFeedback: { type: 'success' | 'error' | 'warning'; message: string } | null;
  onDismissValidationFeedback: () => void;
}

export const GeminiProviderCard: React.FC<GeminiProviderCardProps> = ({
  credential,
  preference,
  onModeChange,
  onValidate,
  onOpenSaveModal,
  onOpenDeleteModal,
  isValidating,
  isSavingMode,
  validationFeedback,
  onDismissValidationFeedback,
}) => {
  const hasCredential = Boolean(credential);
  const activeMode = preference.mode;

  // Determine if there is a configuration error for BYOK mode
  const isByokConfigError =
    activeMode === 'byok' &&
    (!hasCredential || !preference.credentialId || credential?.status === 'invalid');

  const formatTimestamp = (isoDate: string | null) => {
    if (!isoDate) return 'Never validated';
    try {
      const d = new Date(isoDate);
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoDate;
    }
  };

  const getStatusBadge = () => {
    if (!credential) return null;
    switch (credential.status) {
      case 'valid':
        return (
          <Badge status="success" data-testid="credential-status-badge">
            Valid
          </Badge>
        );
      case 'invalid':
        return (
          <Badge status="danger" data-testid="credential-status-badge">
            Invalid
          </Badge>
        );
      case 'unverified':
      default:
        return (
          <Badge status="warning" data-testid="credential-status-badge">
            Unverified
          </Badge>
        );
    }
  };

  return (
    <Card
      className="gemini-provider-card"
      style={{
        backgroundColor: 'var(--giga-surface, #111C2D)',
        border: '1px solid var(--giga-border, #1E293B)',
        borderRadius: 'var(--giga-radius-lg, 12px)',
        padding: '24px',
        width: '100%',
      }}
      data-testid="gemini-provider-card"
    >
      {/* Header: Provider Name, Logo, Description */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
          marginBottom: '20px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div
            style={{
              width: '44px',
              height: '44px',
              borderRadius: 'var(--giga-radius-md, 8px)',
              backgroundColor: 'rgba(59, 130, 246, 0.12)',
              border: '1px solid rgba(59, 130, 246, 0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--giga-primary, #3B82F6)',
              flexShrink: 0,
            }}
          >
            <KeyIcon size={22} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <h3 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--giga-text, #F8FAFC)', margin: 0 }}>
                Google Gemini
              </h3>
              {getStatusBadge()}
            </div>
            <p style={{ fontSize: '13px', color: 'var(--giga-text-secondary, #94A3B8)', margin: '4px 0 0' }}>
              Chat with Google's Gemini models using the platform key or your own API key.
            </p>
          </div>
        </div>

        {/* Action Button: Add or Replace Key */}
        <div>
          <Button
            variant={hasCredential ? 'outline' : 'primary'}
            size="sm"
            onClick={onOpenSaveModal}
            icon={<KeyIcon size={14} />}
            data-testid="add-replace-key-btn"
          >
            {hasCredential ? 'Replace Key' : 'Add Gemini API Key'}
          </Button>
        </div>
      </div>

      {/* Configuration Error Alert if BYOK mode is missing/invalid */}
      {isByokConfigError && (
        <div style={{ marginBottom: '20px' }} data-testid="byok-configuration-error">
          <Alert
            type="error"
            title="Chat Configuration Error"
            message={
              !hasCredential || !preference.credentialId
                ? 'My Gemini Key (BYOK) is active, but no credential is saved or available. Chat generations will fail until you add a valid key or switch to Giga Platform Key.'
                : 'My Gemini Key (BYOK) is active, but your saved key was rejected by Google Gemini as invalid. Please replace or re-validate your key, or switch to Giga Platform Key.'
            }
          />
        </div>
      )}

      {/* Validation feedback alert */}
      {validationFeedback && (
        <div style={{ marginBottom: '20px' }} data-testid="validation-feedback-alert">
          <Alert
            type={validationFeedback.type}
            message={validationFeedback.message}
            onDismiss={onDismissValidationFeedback}
          />
        </div>
      )}

      {/* Credential Mode Selector */}
      <div
        style={{
          backgroundColor: 'var(--giga-surface-muted, #18263A)',
          border: '1px solid var(--giga-border, #1E293B)',
          borderRadius: 'var(--giga-radius-md, 8px)',
          padding: '16px',
          marginBottom: '20px',
        }}
        data-testid="credential-mode-selector"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
          <SlidersIcon size={16} style={{ color: 'var(--giga-primary, #3B82F6)' }} />
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
            Chat Credential Mode
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* Mode 1: Giga Platform Key */}
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '12px',
              padding: '10px 12px',
              borderRadius: 'var(--giga-radius-md, 8px)',
              backgroundColor: activeMode === 'platform' ? 'rgba(59, 130, 246, 0.08)' : 'transparent',
              border: `1px solid ${activeMode === 'platform' ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-border, #1E293B)'}`,
              cursor: isSavingMode ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s ease',
            }}
            data-testid="mode-option-platform"
          >
            <input
              type="radio"
              name="chat-credential-mode"
              value="platform"
              checked={activeMode === 'platform'}
              onChange={() => onModeChange('platform')}
              disabled={isSavingMode}
              style={{ marginTop: '3px', cursor: 'pointer' }}
              data-testid="radio-mode-platform"
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                Giga Platform Key
              </div>
              <div style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)', marginTop: '2px' }}>
                The Chat runtime uses the platform's configured Gemini credential provided by Giga.
              </div>
            </div>
            {activeMode === 'platform' && (
              <span style={{ color: 'var(--giga-primary, #3B82F6)', fontSize: '12px', fontWeight: 600 }}>
                Active
              </span>
            )}
          </label>

          {/* Mode 2: My Gemini Key (BYOK) */}
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '12px',
              padding: '10px 12px',
              borderRadius: 'var(--giga-radius-md, 8px)',
              backgroundColor: activeMode === 'byok' ? 'rgba(59, 130, 246, 0.08)' : 'transparent',
              border: `1px solid ${activeMode === 'byok' ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-border, #1E293B)'}`,
              cursor: isSavingMode || !hasCredential ? 'pointer' : 'pointer',
              transition: 'all 0.15s ease',
            }}
            data-testid="mode-option-byok"
          >
            <input
              type="radio"
              name="chat-credential-mode"
              value="byok"
              checked={activeMode === 'byok'}
              onChange={() => onModeChange('byok')}
              disabled={isSavingMode || !hasCredential}
              style={{ marginTop: '3px', cursor: hasCredential ? 'pointer' : 'not-allowed' }}
              data-testid="radio-mode-byok"
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                My Gemini Key
              </div>
              <div style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)', marginTop: '2px' }}>
                The Chat runtime uses your authenticated saved Gemini credential directly.
                {!hasCredential && ' (Add an API key below to enable this option)'}
              </div>
            </div>
            {activeMode === 'byok' && (
              <span style={{ color: 'var(--giga-primary, #3B82F6)', fontSize: '12px', fontWeight: 600 }}>
                Active
              </span>
            )}
          </label>
        </div>
      </div>

      {/* Credential Details & Actions */}
      {credential ? (
        <div
          style={{
            borderTop: '1px solid var(--giga-border, #1E293B)',
            paddingTop: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px',
          }}
          data-testid="credential-details-row"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)' }}>Saved Key:</span>
              <span
                style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  fontFamily: 'monospace',
                  color: 'var(--giga-text, #F8FAFC)',
                  backgroundColor: 'var(--giga-surface-muted, #18263A)',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  border: '1px solid var(--giga-border, #1E293B)',
                }}
                data-testid="masked-credential-hint"
              >
                {credential.displayHint}
              </span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--giga-text-secondary, #94A3B8)' }} data-testid="last-validated-time">
              Last validated: {formatTimestamp(credential.lastValidatedAt)}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onValidate(credential.id)}
              loading={isValidating}
              disabled={isValidating}
              icon={<RefreshCwIcon size={14} />}
              data-testid="validate-key-btn"
            >
              {isValidating ? 'Validating...' : 'Validate'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onOpenDeleteModal}
              disabled={isValidating}
              style={{ color: 'var(--giga-danger, #EF4444)', borderColor: 'rgba(239, 68, 68, 0.35)' }}
              icon={<TrashIcon size={14} />}
              data-testid="delete-key-btn"
            >
              Delete
            </Button>
          </div>
        </div>
      ) : (
        <div
          style={{
            borderTop: '1px solid var(--giga-border, #1E293B)',
            paddingTop: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px',
          }}
          data-testid="no-credential-state"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShieldIcon size={16} style={{ color: 'var(--giga-text-secondary, #94A3B8)' }} />
            <span style={{ fontSize: '13px', color: 'var(--giga-text-secondary, #94A3B8)' }}>
              No custom Gemini API key configured. Giga is using the platform key.
            </span>
          </div>
          <Button variant="primary" size="sm" onClick={onOpenSaveModal} icon={<KeyIcon size={14} />} data-testid="empty-add-key-btn">
            Add API Key
          </Button>
        </div>
      )}
    </Card>
  );
};
