import React, { useState, useEffect, useCallback } from 'react';
import { useApiMode } from '../../app/context/ApiModeContext.js';
import { realApiClient, ApiException } from '../../lib/api/client.js';
import { mockDataAdapter } from '../../lib/api/mock-adapter.js';
import type {
  ProviderCredential,
  ChatCredentialPreference,
  ChatCredentialMode,
} from '../../lib/api/types.js';
import { GeminiProviderCard } from './GeminiProviderCard.js';
import { SaveCredentialModal } from './SaveCredentialModal.js';
import { DeleteCredentialModal } from './DeleteCredentialModal.js';
import { Alert } from '../../components/Alert.js';
import { SpinnerIcon, SettingsIcon, KeyIcon } from '../../components/Icons.js';

export const SettingsView: React.FC = () => {
  const { mode } = useApiMode();
  const api = mode === 'real' ? realApiClient : mockDataAdapter;

  const [loading, setLoading] = useState(true);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  // Authoritative State
  const [credential, setCredential] = useState<ProviderCredential | null>(null);
  const [preference, setPreference] = useState<ChatCredentialPreference>({
    mode: 'platform',
    credentialId: null,
  });
  const [hasLoaded, setHasLoaded] = useState(false);

  // Action / Modal States
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isSavingMode, setIsSavingMode] = useState(false);
  const [validationFeedback, setValidationFeedback] = useState<{
    type: 'success' | 'error' | 'warning';
    message: string;
  } | null>(null);

  // Load authoritative credentials and preference from active backend
  const loadSettings = useCallback(async () => {
    try {
      setLoading(true);
      setErrorBanner(null);

      const [credsRes, prefRes] = await Promise.all([
        api.getProviderCredentials(),
        api.getChatCredentialPreference(),
      ]);

      const activeCred = credsRes.items[0] || null;
      setCredential(activeCred);
      setPreference(prefRes);
      setHasLoaded(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load provider credentials';
      setErrorBanner(message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Handle Save / Replace API Key
  const handleSaveCredential = async (apiKey: string) => {
    try {
      setErrorBanner(null);
      const res = await api.saveProviderCredential({
        provider: 'gemini',
        apiKey,
      });

      // Reload both credentials and preference because saving may rebind BYOK preference
      const prefRes = await api.getChatCredentialPreference();
      setCredential(res.credential);
      setPreference(prefRes);
      setValidationFeedback(null);
      setSuccessBanner(
        credential
          ? 'Gemini API key successfully replaced. Your active BYOK configuration has been updated.'
          : 'Gemini API key successfully saved.'
      );
    } catch (err: unknown) {
      throw err; // propagate to modal to display inside form
    }
  };

  // Handle Validate Key
  const handleValidateCredential = async (id: string) => {
    try {
      setIsValidating(true);
      setValidationFeedback(null);
      const res = await api.validateProviderCredential(id);
      setCredential(res.credential);

      if (res.credential.status === 'valid') {
        setValidationFeedback({
          type: 'success',
          message: 'Gemini credential is valid and verified with Google API.',
        });
      } else {
        setValidationFeedback({
          type: 'error',
          message: 'Gemini API key was rejected by Google as invalid. Please check your key in Google AI Studio.',
        });
      }
    } catch (err: unknown) {
      if (err instanceof ApiException) {
        if (err.status === 429 || err.code === 'PROVIDER_RATE_LIMIT') {
          setValidationFeedback({
            type: 'warning',
            message: 'Validation request was rate-limited by Google (HTTP 429). The credential retains its current validity status.',
          });
        } else if (err.status === 503 || err.code === 'PROVIDER_UNAVAILABLE') {
          setValidationFeedback({
            type: 'warning',
            message: 'Validation service is temporarily unavailable (HTTP 503). Prior validity status is preserved.',
          });
        } else {
          setValidationFeedback({
            type: 'error',
            message: err.message || 'Validation request failed.',
          });
        }
      } else {
        setValidationFeedback({
          type: 'error',
          message: err instanceof Error ? err.message : 'Validation failed.',
        });
      }

      // Re-fetch credentials to synchronize lastValidatedAt timestamp if recorded
      try {
        const credsRes = await api.getProviderCredentials();
        if (credsRes.items[0]) {
          setCredential(credsRes.items[0]);
        }
      } catch {
        // Ignore secondary refresh failure
      }
    } finally {
      setIsValidating(false);
    }
  };

  // Handle Delete Key
  const handleDeleteCredential = async () => {
    if (!credential) return;
    try {
      setErrorBanner(null);
      await api.deleteProviderCredential(credential.id);
      const [credsRes, prefRes] = await Promise.all([
        api.getProviderCredentials(),
        api.getChatCredentialPreference(),
      ]);
      setCredential(credsRes.items[0] || null);
      setPreference(prefRes);
      setValidationFeedback(null);
      setSuccessBanner('Gemini API key has been deleted.');
    } catch (err: unknown) {
      throw err;
    }
  };

  // Handle Mode Change (Platform vs BYOK)
  const handleModeChange = async (newMode: ChatCredentialMode) => {
    if (newMode === preference.mode) return;

    if (newMode === 'byok' && !credential) {
      setErrorBanner('Cannot switch to My Gemini Key without a saved credential. Please add an API key first.');
      return;
    }

    try {
      setIsSavingMode(true);
      setErrorBanner(null);
      const updatedPref = await api.setChatCredentialPreference({
        mode: newMode,
        credentialId: newMode === 'byok' ? credential?.id : null,
      });
      setPreference(updatedPref);
      setSuccessBanner(
        newMode === 'byok'
          ? 'Switched to My Gemini Key (BYOK) for Chat.'
          : 'Switched to Giga Platform Key for Chat.'
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to update Chat credential preference';
      setErrorBanner(message);
    } finally {
      setIsSavingMode(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        overflowY: 'auto',
        backgroundColor: 'var(--giga-bg, #0B1220)',
        padding: '24px 20px',
      }}
      data-testid="settings-view"
    >
      <div style={{ maxWidth: '840px', width: '100%', margin: '0 auto' }}>
        {/* View Header */}
        <div style={{ marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            <SettingsIcon size={24} style={{ color: 'var(--giga-primary, #3B82F6)' }} />
            <h1 style={{ fontSize: '24px', fontWeight: 700, color: 'var(--giga-text, #F8FAFC)', margin: 0 }}>
              Settings
            </h1>
          </div>
          <p style={{ fontSize: '14px', color: 'var(--giga-text-secondary, #94A3B8)', margin: 0 }}>
            Configure model providers, API credentials, and Chat runtime preferences.
          </p>
        </div>

        {/* Settings Navigation Tabs */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            borderBottom: '1px solid var(--giga-border, #1E293B)',
            marginBottom: '24px',
          }}
          data-testid="settings-tabs"
        >
          <button
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 16px',
              border: 'none',
              borderBottom: '2px solid var(--giga-primary, #3B82F6)',
              backgroundColor: 'transparent',
              color: 'var(--giga-text, #F8FAFC)',
              fontSize: '14px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
            data-testid="tab-ai-providers"
          >
            <KeyIcon size={16} style={{ color: 'var(--giga-primary, #3B82F6)' }} />
            <span>AI Providers & BYOK</span>
          </button>
        </div>

        {/* Global Notifications */}
        {errorBanner && (
          <div style={{ marginBottom: '20px' }} data-testid="settings-error-banner">
            <Alert type="error" message={errorBanner} onDismiss={() => setErrorBanner(null)} />
          </div>
        )}

        {successBanner && (
          <div style={{ marginBottom: '20px' }} data-testid="settings-success-banner">
            <Alert type="success" message={successBanner} onDismiss={() => setSuccessBanner(null)} />
          </div>
        )}

        {/* Content Area */}
        {loading ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '60px 0',
              color: 'var(--giga-text-secondary, #94A3B8)',
              gap: '12px',
            }}
            data-testid="settings-loading-state"
          >
            <SpinnerIcon size={24} />
            <span style={{ fontSize: '14px' }}>Loading provider credentials...</span>
          </div>
        ) : hasLoaded ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <GeminiProviderCard
              credential={credential}
              preference={preference}
              onModeChange={handleModeChange}
              onValidate={handleValidateCredential}
              onOpenSaveModal={() => setIsSaveModalOpen(true)}
              onOpenDeleteModal={() => setIsDeleteModalOpen(true)}
              isValidating={isValidating}
              isSavingMode={isSavingMode}
              validationFeedback={validationFeedback}
              onDismissValidationFeedback={() => setValidationFeedback(null)}
            />
          </div>
        ) : null}
      </div>

      {/* Add / Replace Key Modal */}
      <SaveCredentialModal
        isOpen={isSaveModalOpen}
        onClose={() => setIsSaveModalOpen(false)}
        onSave={handleSaveCredential}
        existingCredential={credential}
      />

      {/* Delete Key Confirmation Modal */}
      <DeleteCredentialModal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        onConfirm={handleDeleteCredential}
        credential={credential}
        activeMode={preference.mode}
      />
    </div>
  );
};
