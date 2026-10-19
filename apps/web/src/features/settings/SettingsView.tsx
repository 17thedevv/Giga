import React, { useState, useEffect, useCallback, useRef } from 'react';
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
import { Button } from '../../components/Button.js';
import { SpinnerIcon, SettingsIcon, KeyIcon, RefreshCwIcon } from '../../components/Icons.js';

export const SettingsView: React.FC = () => {
  const { mode } = useApiMode();
  const activeModeRef = useRef(mode);
  const requestIdRef = useRef(0);
  const isMountedRef = useRef(true);

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

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Helper to reconcile authoritative state from active API
  const reconcileState = useCallback(async (targetMode: 'real' | 'mock', reqId: number) => {
    const currentApi = targetMode === 'real' ? realApiClient : mockDataAdapter;
    const [credsRes, prefRes] = await Promise.all([
      currentApi.getProviderCredentials(),
      currentApi.getChatCredentialPreference(),
    ]);

    // Check if stale or unmounted
    if (!isMountedRef.current || reqId !== requestIdRef.current || targetMode !== activeModeRef.current) {
      return null;
    }

    const activeCred = credsRes.items[0] || null;
    setCredential(activeCred);
    setPreference(prefRes);
    setHasLoaded(true);
    return { credential: activeCred, preference: prefRes };
  }, []);

  // Load authoritative credentials and preference from active backend
  const loadSettings = useCallback(async (targetMode?: 'real' | 'mock') => {
    const currentMode = targetMode ?? activeModeRef.current;
    const currentReqId = ++requestIdRef.current;
    activeModeRef.current = currentMode;

    setLoading(true);
    setErrorBanner(null);

    try {
      await reconcileState(currentMode, currentReqId);
    } catch (err: unknown) {
      if (!isMountedRef.current || currentReqId !== requestIdRef.current || currentMode !== activeModeRef.current) {
        return;
      }

      // On fetch failure, do not show stale credential or preference data as verified current state
      setCredential(null);
      setPreference({ mode: 'platform', credentialId: null });
      setHasLoaded(false);

      const message = err instanceof Error ? err.message : 'Failed to load provider credentials';
      setErrorBanner(message);
    } finally {
      if (isMountedRef.current && currentReqId === requestIdRef.current && currentMode === activeModeRef.current) {
        setLoading(false);
      }
    }
  }, [reconcileState]);

  // Mode change effect: invalidate pending loads and clear source-specific metadata immediately
  useEffect(() => {
    requestIdRef.current += 1;
    activeModeRef.current = mode;

    // Clear source-specific credential metadata immediately when changing API mode
    setCredential(null);
    setPreference({ mode: 'platform', credentialId: null });
    setHasLoaded(false);
    setValidationFeedback(null);
    setErrorBanner(null);
    setSuccessBanner(null);

    loadSettings(mode);
  }, [mode, loadSettings]);

  // Handle Save / Replace API Key
  const handleSaveCredential = async (apiKey: string) => {
    const currentMode = activeModeRef.current;
    const currentApi = currentMode === 'real' ? realApiClient : mockDataAdapter;

    try {
      setErrorBanner(null);
      const res = await currentApi.saveProviderCredential({
        provider: 'gemini',
        apiKey,
      });

      if (!isMountedRef.current || currentMode !== activeModeRef.current) return;

      // Refresh preference because saving may rebind BYOK preference
      let updatedPref: ChatCredentialPreference | null = null;
      try {
        updatedPref = await currentApi.getChatCredentialPreference();
      } catch {
        // Preference refresh failed; retain mode with updated credential ID if BYOK
        updatedPref = {
          mode: preference.mode,
          credentialId: preference.mode === 'byok' ? res.credential.id : null,
        };
        setErrorBanner('Gemini API key was saved, but failed to refresh preferences. Please refresh.');
      }

      if (!isMountedRef.current || currentMode !== activeModeRef.current) return;

      setCredential(res.credential);
      if (updatedPref) {
        setPreference(updatedPref);
      }
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
    const currentMode = activeModeRef.current;
    const currentApi = currentMode === 'real' ? realApiClient : mockDataAdapter;

    try {
      setIsValidating(true);
      setValidationFeedback(null);
      const res = await currentApi.validateProviderCredential(id);

      if (!isMountedRef.current || currentMode !== activeModeRef.current) return;

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
      if (!isMountedRef.current || currentMode !== activeModeRef.current) return;

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
        const credsRes = await currentApi.getProviderCredentials();
        if (isMountedRef.current && currentMode === activeModeRef.current && credsRes.items[0]) {
          setCredential(credsRes.items[0]);
        }
      } catch {
        // Ignore secondary refresh failure
      }
    } finally {
      if (isMountedRef.current) {
        setIsValidating(false);
      }
    }
  };

  // Handle Delete Key
  const handleDeleteCredential = async () => {
    if (!credential) return;
    const currentMode = activeModeRef.current;
    const currentApi = currentMode === 'real' ? realApiClient : mockDataAdapter;
    const credentialId = credential.id;

    try {
      setErrorBanner(null);
      await currentApi.deleteProviderCredential(credentialId);

      if (!isMountedRef.current || currentMode !== activeModeRef.current) return;

      // Reconcile authoritative state after deletion
      let freshCred: ProviderCredential | null = null;
      let freshPref: ChatCredentialPreference | null = null;
      try {
        const [credsRes, prefRes] = await Promise.all([
          currentApi.getProviderCredentials(),
          currentApi.getChatCredentialPreference(),
        ]);
        freshCred = credsRes.items[0] || null;
        freshPref = prefRes;
      } catch {
        // Refresh failed after successful deletion; clear credential conservatively
        freshCred = null;
        freshPref = { mode: preference.mode, credentialId: null };
      }

      if (!isMountedRef.current || currentMode !== activeModeRef.current) return;

      setCredential(freshCred);
      if (freshPref) {
        setPreference(freshPref);
      }
      setValidationFeedback(null);
      setSuccessBanner('Gemini API key has been deleted.');
    } catch (err: unknown) {
      // Check if already deleted before failing
      try {
        const currentCreds = await currentApi.getProviderCredentials();
        if (!currentCreds.items.some(item => item.id === credentialId)) {
          if (isMountedRef.current && currentMode === activeModeRef.current) {
            setCredential(null);
            setPreference(prev => ({ ...prev, credentialId: null }));
            setSuccessBanner('Gemini API key has been deleted.');
          }
          return;
        }
      } catch {
        // Ignore check failure
      }
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

    const currentMode = activeModeRef.current;
    const currentApi = currentMode === 'real' ? realApiClient : mockDataAdapter;

    try {
      setIsSavingMode(true);
      setErrorBanner(null);
      const updatedPref = await currentApi.setChatCredentialPreference({
        mode: newMode,
        credentialId: newMode === 'byok' ? credential?.id : null,
      });

      if (isMountedRef.current && currentMode === activeModeRef.current) {
        setPreference(updatedPref);
        setSuccessBanner(
          newMode === 'byok'
            ? 'Switched to My Gemini Key (BYOK) for Chat.'
            : 'Switched to Giga Platform Key for Chat.'
        );
      }
    } catch (err: unknown) {
      if (!isMountedRef.current || currentMode !== activeModeRef.current) return;

      // Check if update succeeded on server despite lost response
      try {
        const currentPref = await currentApi.getChatCredentialPreference();
        if (currentPref.mode === newMode) {
          setPreference(currentPref);
          setSuccessBanner(
            newMode === 'byok'
              ? 'Switched to My Gemini Key (BYOK) for Chat.'
              : 'Switched to Giga Platform Key for Chat.'
          );
          return;
        }
      } catch {
        // Ignore check error
      }

      const message = err instanceof Error ? err.message : 'Failed to update Chat credential preference';
      setErrorBanner(message);
    } finally {
      if (isMountedRef.current) {
        setIsSavingMode(false);
      }
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
        ) : !hasLoaded && errorBanner ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '48px 24px',
              backgroundColor: 'var(--giga-surface, #111C2D)',
              border: '1px solid var(--giga-border, #1E293B)',
              borderRadius: 'var(--giga-radius-lg, 12px)',
              textAlign: 'center',
              gap: '16px',
            }}
            data-testid="settings-initial-error-state"
          >
            <p style={{ fontSize: '14px', color: 'var(--giga-text-secondary, #94A3B8)', margin: 0 }}>
              Unable to load provider credentials. Please check your connection and try again.
            </p>
            <Button
              variant="primary"
              onClick={() => loadSettings()}
              icon={<RefreshCwIcon size={14} />}
              data-testid="settings-load-retry-btn"
            >
              Retry Loading Settings
            </Button>
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
