import React, { useState, useEffect, useCallback } from 'react';
import { useApiMode } from '../../app/context/ApiModeContext.js';
import type { UserPreferences, UpdatePreferencesDto } from '../../lib/api/types.js';
import { mockDataAdapter } from '../../lib/api/mock-adapter.js';
import { realApiClient, ApiException } from '../../lib/api/client.js';
import { Button } from '../../components/Button.js';
import { Textarea } from '../../components/Textarea.js';
import { Alert } from '../../components/Alert.js';
import { Badge } from '../../components/Badge.js';
import { SpinnerIcon, CheckIcon } from '../../components/Icons.js';

const LANGUAGE_OPTIONS = [
  { value: '', label: 'Auto / Default (No preference)' },
  { value: 'en', label: 'English (US / UK)' },
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'ja', label: '日本語 (Japanese)' },
  { value: 'es', label: 'Español (Spanish)' },
  { value: 'fr', label: 'Français (French)' },
  { value: 'de', label: 'Deutsch (German)' },
];

const LENGTH_OPTIONS = [
  { value: 'concise', label: 'Concise', description: 'Direct, minimal explanation, focused code' },
  { value: 'balanced', label: 'Balanced', description: 'Standard response with clear explanations' },
  { value: 'detailed', label: 'Detailed', description: 'In-depth breakdown, rationale, and edge cases' },
] as const;

const STYLE_OPTIONS = [
  { value: 'professional', label: 'Professional', description: 'Objective, clean, production-oriented' },
  { value: 'technical', label: 'Technical', description: 'Deeply architectural, precise terminology' },
  { value: 'casual', label: 'Casual', description: 'Approachable, friendly, conversational tone' },
] as const;

export const PersonalizationView: React.FC = () => {
  const { mode } = useApiMode();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);

  // Form states
  const [preferredLanguage, setPreferredLanguage] = useState<string>('');
  const [responseLength, setResponseLength] = useState<'concise' | 'balanced' | 'detailed'>('balanced');
  const [responseStyle, setResponseStyle] = useState<'professional' | 'casual' | 'technical'>('professional');
  const [customInstructions, setCustomInstructions] = useState<string>('');

  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const [conflictDetected, setConflictDetected] = useState(false);

  const loadPreferences = useCallback(async () => {
    setLoading(true);
    setErrorBanner(null);
    setConflictDetected(false);
    try {
      if (mode === 'real') {
        const res = await realApiClient.getPreferences();
        setPreferences(res.preferences);
        setPreferredLanguage(res.preferences.preferredLanguage || '');
        setResponseLength(res.preferences.responseLength || 'balanced');
        setResponseStyle(res.preferences.responseStyle || 'professional');
        setCustomInstructions(res.preferences.customInstructions || '');
      } else {
        const res = await mockDataAdapter.getPreferences();
        setPreferences(res.preferences);
        setPreferredLanguage(res.preferences.preferredLanguage || '');
        setResponseLength(res.preferences.responseLength || 'balanced');
        setResponseStyle(res.preferences.responseStyle || 'professional');
        setCustomInstructions(res.preferences.customInstructions || '');
      }
    } catch (err: unknown) {
      if (err instanceof ApiException && mode === 'real') {
        setErrorBanner(`Backend preferences endpoint returned status ${err.status}: ${err.message}. Switch to MOCK mode for live testing.`);
      } else {
        setErrorBanner(err instanceof Error ? err.message : 'Failed to load preferences.');
      }
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    loadPreferences();
  }, [loadPreferences]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!preferences) return;

    if (customInstructions.length > 2000) {
      setErrorBanner('Custom instructions must not exceed 2000 characters.');
      return;
    }

    setSaving(true);
    setErrorBanner(null);
    setSuccessBanner(null);
    setConflictDetected(false);

    const dto: UpdatePreferencesDto = {
      expectedRevision: preferences.revision,
      preferredLanguage: preferredLanguage || null,
      responseLength,
      responseStyle,
      customInstructions: customInstructions.trim(),
    };

    try {
      let updated: UserPreferences;
      if (mode === 'real') {
        const res = await realApiClient.updatePreferences(dto);
        updated = res.preferences;
      } else {
        const res = await mockDataAdapter.updatePreferences(dto);
        updated = res.preferences;
      }
      setPreferences(updated);
      setSuccessBanner(`Preferences saved successfully! (Revision #${updated.revision})`);
      setTimeout(() => setSuccessBanner(null), 4000);
    } catch (err: unknown) {
      if (err instanceof ApiException && err.status === 409) {
        setConflictDetected(true);
        setErrorBanner(
          `Revision conflict (HTTP 409): Your settings were updated elsewhere (Expected revision #${preferences.revision}). Click 'Reload Latest' to synchronize.`
        );
      } else {
        setErrorBanner(err instanceof Error ? err.message : 'Failed to save preferences.');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleResetDefaults = () => {
    setPreferredLanguage('');
    setResponseLength('balanced');
    setResponseStyle('professional');
    setCustomInstructions('');
    setErrorBanner(null);
  };

  const charCount = customInstructions.length;
  const isOverLimit = charCount > 2000;

  if (loading) {
    return (
      <div style={{ padding: '48px', textAlign: 'center', color: 'var(--giga-text-muted, #94A3B8)' }}>
        <SpinnerIcon size={24} />
        <div style={{ marginTop: '12px', fontSize: '14px' }}>Loading personalization profile...</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '800px', width: '100%', margin: '0 auto' }} data-testid="personalization-view">
      <div style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
          <h2 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--giga-text, #F8FAFC)', margin: 0 }}>
            Response Customization & Style
          </h2>
          {preferences && (
            <span data-testid="pref-revision-badge">
              <Badge status="real">
                Revision: {preferences.revision}
              </Badge>
            </span>
          )}
        </div>
        <p style={{ fontSize: '13px', color: 'var(--giga-text-secondary, #94A3B8)', margin: 0 }}>
          Configure your preferred language, verbosity, and custom instructions. These settings are applied globally across model responses.
        </p>
      </div>

      {conflictDetected && (
        <div style={{ marginBottom: '20px' }} data-testid="pref-conflict-alert">
          <Alert
            type="warning"
            title="Optimistic Concurrency Conflict (409)"
            message="Preferences were modified by another session. Please reload to review the latest state."
            action={
              <Button size="sm" variant="secondary" onClick={loadPreferences} data-testid="pref-reload-btn">
                Reload Latest Version
              </Button>
            }
          />
        </div>
      )}

      {errorBanner && !conflictDetected && (
        <div style={{ marginBottom: '20px' }}>
          <Alert type="error" message={errorBanner} onDismiss={() => setErrorBanner(null)} />
        </div>
      )}

      {successBanner && (
        <div style={{ marginBottom: '20px' }}>
          <Alert type="success" message={successBanner} onDismiss={() => setSuccessBanner(null)} />
        </div>
      )}

      <form
        onSubmit={handleSave}
        className="g-card"
        style={{
          backgroundColor: 'var(--giga-surface, #111C2D)',
          border: '1px solid var(--giga-border, #1E293B)',
          borderRadius: 'var(--giga-radius-lg, 12px)',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '24px',
        }}
      >
        {/* Preferred Language */}
        <div>
          <label htmlFor="pref-language" className="g-label" style={{ color: 'var(--giga-text, #F8FAFC)', marginBottom: '6px' }}>
            Preferred Response Language
          </label>
          <p style={{ fontSize: '12px', color: 'var(--giga-text-muted, #94A3B8)', margin: '0 0 10px' }}>
            Instructs the assistant to reply in your chosen language unless explicitly instructed otherwise in the prompt.
          </p>
          <select
            id="pref-language"
            value={preferredLanguage}
            onChange={(e) => setPreferredLanguage(e.target.value)}
            className="g-select"
            style={{
              width: '100%',
              maxWidth: '360px',
              padding: '9px 12px',
              backgroundColor: 'var(--giga-surface-muted, #18263A)',
              color: 'var(--giga-text, #F8FAFC)',
              border: '1px solid var(--giga-border, #334155)',
              borderRadius: 'var(--giga-radius-md, 8px)',
              fontSize: '14px',
            }}
            data-testid="pref-language-select"
          >
            {LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Response Length */}
        <div>
          <label className="g-label" style={{ color: 'var(--giga-text, #F8FAFC)', marginBottom: '6px' }}>
            Response Length & Verbosity
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
            {LENGTH_OPTIONS.map((opt) => {
              const isSelected = responseLength === opt.value;
              return (
                <div
                  key={opt.value}
                  onClick={() => setResponseLength(opt.value)}
                  style={{
                    padding: '14px',
                    backgroundColor: isSelected ? 'var(--giga-primary-subtle, rgba(59, 130, 246, 0.12))' : 'var(--giga-surface-muted, #18263A)',
                    border: `1px solid ${isSelected ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-border, #1E293B)'}`,
                    borderRadius: 'var(--giga-radius-md, 8px)',
                    cursor: 'pointer',
                    transition: 'all 0.14s ease',
                  }}
                  data-testid={`pref-length-${opt.value}`}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <strong style={{ fontSize: '14px', color: isSelected ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-text, #F8FAFC)' }}>
                      {opt.label}
                    </strong>
                    {isSelected && <span style={{ color: 'var(--giga-primary, #3B82F6)' }}><CheckIcon size={16} /></span>}
                  </div>
                  <p style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)', margin: 0, lineHeight: 1.4 }}>
                    {opt.description}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Response Style */}
        <div>
          <label className="g-label" style={{ color: 'var(--giga-text, #F8FAFC)', marginBottom: '6px' }}>
            Tone & Style
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
            {STYLE_OPTIONS.map((opt) => {
              const isSelected = responseStyle === opt.value;
              return (
                <div
                  key={opt.value}
                  onClick={() => setResponseStyle(opt.value)}
                  style={{
                    padding: '14px',
                    backgroundColor: isSelected ? 'var(--giga-primary-subtle, rgba(59, 130, 246, 0.12))' : 'var(--giga-surface-muted, #18263A)',
                    border: `1px solid ${isSelected ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-border, #1E293B)'}`,
                    borderRadius: 'var(--giga-radius-md, 8px)',
                    cursor: 'pointer',
                    transition: 'all 0.14s ease',
                  }}
                  data-testid={`pref-style-${opt.value}`}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <strong style={{ fontSize: '14px', color: isSelected ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-text, #F8FAFC)' }}>
                      {opt.label}
                    </strong>
                    {isSelected && <span style={{ color: 'var(--giga-primary, #3B82F6)' }}><CheckIcon size={16} /></span>}
                  </div>
                  <p style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)', margin: 0, lineHeight: 1.4 }}>
                    {opt.description}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Custom Instructions */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
            <label htmlFor="custom-instructions-area" className="g-label" style={{ color: 'var(--giga-text, #F8FAFC)', margin: 0 }}>
              Custom Instructions
            </label>
            <span
              style={{
                fontSize: '11px',
                fontWeight: 600,
                color: isOverLimit ? 'var(--giga-danger, #DC2626)' : 'var(--giga-text-muted, #94A3B8)',
              }}
            >
              {charCount} / 2000 chars
            </span>
          </div>
          <p style={{ fontSize: '12px', color: 'var(--giga-text-muted, #94A3B8)', margin: '0 0 10px' }}>
            Provide guidelines, preferred frameworks, architectural rules, or constraints for the AI to keep in mind across all conversations.
          </p>
          <Textarea
            id="custom-instructions-area"
            value={customInstructions}
            onChange={(e) => setCustomInstructions(e.target.value)}
            placeholder="e.g. Always write strict TypeScript. Prefer functional components with React Hooks. Include comments explaining non-trivial logic..."
            rows={5}
            error={isOverLimit ? 'Custom instructions exceed 2000 characters limit' : undefined}
            data-testid="pref-instructions-input"
          />
        </div>

        {/* Action Buttons */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: '16px',
            borderTop: '1px solid var(--giga-border, #1E293B)',
          }}
        >
          <Button type="button" variant="ghost" onClick={handleResetDefaults} disabled={saving} data-testid="reset-preferences-btn">
            Reset to Defaults
          </Button>

          <Button type="submit" variant="primary" loading={saving} disabled={isOverLimit} data-testid="save-preferences-btn">
            Save Preferences
          </Button>
        </div>
      </form>
    </div>
  );
};
