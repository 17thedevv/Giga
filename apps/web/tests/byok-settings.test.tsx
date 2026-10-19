import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsView } from '../src/features/settings/SettingsView.js';
import { Layout } from '../src/app/Layout.js';
import { ApiModeProvider, useApiMode } from '../src/app/context/ApiModeContext.js';
import { ThemeProvider } from '../src/app/context/ThemeContext.js';
import { AuthProvider } from '../src/app/context/AuthContext.js';
import { RouterProvider } from '../src/app/router.js';
import { mockDataAdapter, MOCK_USER } from '../src/lib/api/mock-adapter.js';
import { realApiClient, ApiException } from '../src/lib/api/client.js';

function renderWithProviders(ui: React.ReactElement, initialPath = '/settings', mode: 'mock' | 'real' = 'mock') {
  return render(
    <ThemeProvider>
      <ApiModeProvider initialMode={mode}>
        <AuthProvider>
          <RouterProvider initialPath={initialPath}>
            {ui}
          </RouterProvider>
        </AuthProvider>
      </ApiModeProvider>
    </ThemeProvider>
  );
}

describe('Gemini BYOK Settings & Credential UX (17T-39)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockDataAdapter.setMockSession(MOCK_USER);
    mockDataAdapter.resetCredentials();
  });

  // 1. Empty credential state
  it('Scenario 1: renders empty credential state with Giga Platform Key default and Add Key action', async () => {
    renderWithProviders(<SettingsView />);

    await waitFor(() => {
      expect(screen.getByText('Google Gemini')).toBeDefined();
    });
    expect(screen.getByTestId('no-credential-state')).toBeDefined();
    expect(screen.getByText(/No custom Gemini API key configured/i)).toBeDefined();

    // Mode selector has platform selected
    const platformRadio = screen.getByTestId('radio-mode-platform') as HTMLInputElement;
    expect(platformRadio.checked).toBe(true);

    const byokRadio = screen.getByTestId('radio-mode-byok') as HTMLInputElement;
    expect(byokRadio.checked).toBe(false);
    expect(byokRadio.disabled).toBe(true); // Disabled when no credential exists

    expect(screen.getByTestId('empty-add-key-btn')).toBeDefined();
  });

  // 2. Creating a Gemini credential
  it('Scenario 2: creates a new Gemini credential and displays safe masked hint', async () => {
    renderWithProviders(<SettingsView />);

    await waitFor(() => {
      expect(screen.getByTestId('empty-add-key-btn')).toBeDefined();
    });

    // Click Add Key button
    fireEvent.click(screen.getByTestId('empty-add-key-btn'));

    // Modal opens
    expect(screen.getByTestId('save-credential-form')).toBeDefined();
    const input = screen.getByTestId('gemini-api-key-input') as HTMLInputElement;
    expect(input.type).toBe('password');

    // Type valid Gemini key
    fireEvent.change(input, { target: { value: 'AIzaSyExampleSecretKey123456789' } });
    expect(input.value).toBe('AIzaSyExampleSecretKey123456789');

    // Submit form
    fireEvent.click(screen.getByTestId('submit-save-credential-btn'));

    // Modal closes and card updates with masked hint
    await waitFor(() => {
      expect(screen.getByTestId('masked-credential-hint')).toBeDefined();
    });

    expect(screen.getByTestId('masked-credential-hint').textContent).toBe('••••6789');
    expect(screen.getByTestId('credential-status-badge').textContent).toBe('Unverified');
    expect(screen.getByTestId('settings-success-banner')).toBeDefined();
  });

  // 3. Replacing an existing credential
  it('Scenario 3: replaces an existing credential and rebinds active BYOK mode', async () => {
    // Save initial key and switch to byok
    await mockDataAdapter.saveProviderCredential({
      provider: 'gemini',
      apiKey: 'AIzaSyInitialKey12345678901111',
    });
    const creds = await mockDataAdapter.getProviderCredentials();
    await mockDataAdapter.setChatCredentialPreference({
      mode: 'byok',
      credentialId: creds.items[0].id,
    });

    renderWithProviders(<SettingsView />);

    await waitFor(() => {
      expect(screen.getByTestId('masked-credential-hint').textContent).toBe('••••1111');
    });

    // Click Replace Key
    fireEvent.click(screen.getByTestId('add-replace-key-btn'));
    expect(screen.getByText('Replace Gemini API Key')).toBeDefined();

    const input = screen.getByTestId('gemini-api-key-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'AIzaSyReplacementKey987654322222' } });
    fireEvent.click(screen.getByTestId('submit-save-credential-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('masked-credential-hint').textContent).toBe('••••2222');
    });

    // Authoritative preference still BYOK and rebound to new ID
    const updatedPref = await mockDataAdapter.getChatCredentialPreference();
    expect(updatedPref.mode).toBe('byok');
    const updatedCreds = await mockDataAdapter.getProviderCredentials();
    expect(updatedPref.credentialId).toBe(updatedCreds.items[0].id);
  });

  // 4. Clearing plaintext after successful save
  it('Scenario 4: clears plaintext input after save and when modal is dismissed', async () => {
    renderWithProviders(<SettingsView />);

    await waitFor(() => {
      expect(screen.getByTestId('empty-add-key-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('empty-add-key-btn'));
    const input = screen.getByTestId('gemini-api-key-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'AIzaSySecretToBeCleared12345' } });

    // Cancel / dismiss modal
    fireEvent.click(screen.getByTestId('cancel-save-credential-btn'));
    expect(screen.queryByTestId('save-credential-form')).toBeNull();

    // Reopen modal -> input must be completely empty!
    fireEvent.click(screen.getByTestId('empty-add-key-btn'));
    const reopenedInput = screen.getByTestId('gemini-api-key-input') as HTMLInputElement;
    expect(reopenedInput.value).toBe('');

    // Enter key and save
    fireEvent.change(reopenedInput, { target: { value: 'AIzaSySecretToBeCleared12345' } });
    fireEvent.click(screen.getByTestId('submit-save-credential-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('save-credential-form')).toBeNull();
    });

    // Reopen again -> input must be empty!
    fireEvent.click(screen.getByTestId('add-replace-key-btn'));
    const finalInput = screen.getByTestId('gemini-api-key-input') as HTMLInputElement;
    expect(finalInput.value).toBe('');
  });

  // 5. Safe metadata-only display
  it('Scenario 5: renders only safe metadata (masked hint, status, timestamp) and never plaintext', async () => {
    const rawSecretKey = 'AIzaSyTopSecretNeverLeakThisInDom5555';
    await mockDataAdapter.saveProviderCredential({
      provider: 'gemini',
      apiKey: rawSecretKey,
    });

    const { container } = renderWithProviders(<SettingsView />);

    await waitFor(() => {
      expect(screen.getByTestId('masked-credential-hint')).toBeDefined();
    });

    expect(screen.getByTestId('masked-credential-hint').textContent).toBe('••••5555');
    expect(screen.getByTestId('credential-status-badge').textContent).toBe('Unverified');
    expect(screen.getByTestId('last-validated-time').textContent).toContain('Never validated');

    // Assert that the container DOM string never contains the plaintext secret!
    expect(container.innerHTML).not.toContain(rawSecretKey);
  });

  // 6. Validating an existing credential
  it('Scenario 6: validates saved credential via ID and updates status to Valid', async () => {
    await mockDataAdapter.saveProviderCredential({
      provider: 'gemini',
      apiKey: 'AIzaSyValidCandidateKey12345678',
    });

    renderWithProviders(<SettingsView />);

    await waitFor(() => {
      expect(screen.getByTestId('validate-key-btn')).toBeDefined();
    });

    expect(screen.getByTestId('credential-status-badge').textContent).toBe('Unverified');

    // Click Validate
    fireEvent.click(screen.getByTestId('validate-key-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('credential-status-badge').textContent).toBe('Valid');
    });

    expect(screen.getByTestId('validation-feedback-alert')).toBeDefined();
    expect(screen.getByText(/credential is valid/i)).toBeDefined();
    expect(screen.getByTestId('last-validated-time').textContent).not.toContain('Never validated');
  });

  // 7. Invalid key feedback
  it('Scenario 7: handles invalid key feedback and shows clear corrective guidance', async () => {
    await mockDataAdapter.saveProviderCredential({
      provider: 'gemini',
      apiKey: 'AIzaSyInvalidKeyEndingIn0000',
    });

    renderWithProviders(<SettingsView />);

    await waitFor(() => {
      expect(screen.getByTestId('validate-key-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('validate-key-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('credential-status-badge').textContent).toBe('Invalid');
    });

    expect(screen.getByTestId('validation-feedback-alert')).toBeDefined();
    expect(screen.getByText(/rejected by Google as invalid/i)).toBeDefined();
  });

  // 8. Transient provider error handling
  it('Scenario 8: handles 503 transient error without marking valid key invalid', async () => {
    const saved = await mockDataAdapter.saveProviderCredential({
      provider: 'gemini',
      apiKey: 'AIzaSyTransientTestKey12345678',
    });
    // First validate it as valid
    await mockDataAdapter.validateProviderCredential(saved.credential.id);

    renderWithProviders(<SettingsView />);

    await waitFor(() => {
      expect(screen.getByTestId('credential-status-badge').textContent).toBe('Valid');
    });

    // Simulate transient 503 outage
    mockDataAdapter.mockValidateBehavior = 'transient_error';
    fireEvent.click(screen.getByTestId('validate-key-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('validation-feedback-alert')).toBeDefined();
    });

    expect(screen.getByText(/temporarily unavailable \(HTTP 503\)/i)).toBeDefined();
    // Prior valid status MUST be preserved!
    expect(screen.getByTestId('credential-status-badge').textContent).toBe('Valid');
  });

  // 9. Deleting a credential
  it('Scenario 9: confirms and deletes a saved credential', async () => {
    await mockDataAdapter.saveProviderCredential({
      provider: 'gemini',
      apiKey: 'AIzaSyDeleteMeKey1234567890',
    });

    renderWithProviders(<SettingsView />);

    await waitFor(() => {
      expect(screen.getByTestId('delete-key-btn')).toBeDefined();
    });

    // Click Delete button to open confirmation dialog
    fireEvent.click(screen.getByTestId('delete-key-btn'));
    expect(screen.getByTestId('delete-credential-dialog')).toBeDefined();

    // Confirm deletion
    fireEvent.click(screen.getByTestId('confirm-delete-credential-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('no-credential-state')).toBeDefined();
    });

    expect(screen.getByTestId('settings-success-banner')).toBeDefined();
    expect(screen.queryByTestId('masked-credential-hint')).toBeNull();
  });

  // 10. Deleting the credential currently selected for BYOK
  it('Scenario 10: deleting active BYOK credential shows explicit configuration error without silent fallback', async () => {
    const saved = await mockDataAdapter.saveProviderCredential({
      provider: 'gemini',
      apiKey: 'AIzaSyActiveByokKey123456789',
    });
    await mockDataAdapter.setChatCredentialPreference({
      mode: 'byok',
      credentialId: saved.credential.id,
    });

    renderWithProviders(<SettingsView />);

    await waitFor(() => {
      expect(screen.getByTestId('delete-key-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('delete-key-btn'));
    // Warning inside dialog explains BYOK impact
    expect(screen.getByTestId('delete-byok-warning')).toBeDefined();

    fireEvent.click(screen.getByTestId('confirm-delete-credential-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('byok-configuration-error')).toBeDefined();
    });

    expect(screen.getByText(/Chat Configuration Error/i)).toBeDefined();
    // Mode MUST still be BYOK; never silently revert to platform!
    const byokRadio = screen.getByTestId('radio-mode-byok') as HTMLInputElement;
    expect(byokRadio.checked).toBe(true);
  });

  // 11. Platform-to-BYOK mode switch
  it('Scenario 11: switches from Platform to BYOK mode and calls authoritative API', async () => {
    await mockDataAdapter.saveProviderCredential({
      provider: 'gemini',
      apiKey: 'AIzaSySwitchKey1234567890',
    });

    renderWithProviders(<SettingsView />);

    await waitFor(() => {
      expect(screen.getByTestId('radio-mode-platform')).toBeDefined();
    });

    const byokRadio = screen.getByTestId('radio-mode-byok') as HTMLInputElement;
    expect(byokRadio.checked).toBe(false);

    // Select BYOK
    fireEvent.click(byokRadio);

    await waitFor(() => {
      expect(byokRadio.checked).toBe(true);
    });

    const pref = await mockDataAdapter.getChatCredentialPreference();
    expect(pref.mode).toBe('byok');
    expect(pref.credentialId).toBeDefined();
  });

  // 12. BYOK-to-Platform mode switch
  it('Scenario 12: switches from BYOK to Platform mode and clears credentialId', async () => {
    const saved = await mockDataAdapter.saveProviderCredential({
      provider: 'gemini',
      apiKey: 'AIzaSySwitchKey1234567890',
    });
    await mockDataAdapter.setChatCredentialPreference({
      mode: 'byok',
      credentialId: saved.credential.id,
    });

    renderWithProviders(<SettingsView />);

    await waitFor(() => {
      const byokRadio = screen.getByTestId('radio-mode-byok') as HTMLInputElement;
      expect(byokRadio.checked).toBe(true);
    });

    const platformRadio = screen.getByTestId('radio-mode-platform') as HTMLInputElement;
    fireEvent.click(platformRadio);

    await waitFor(() => {
      expect(platformRadio.checked).toBe(true);
    });

    const pref = await mockDataAdapter.getChatCredentialPreference();
    expect(pref.mode).toBe('platform');
    expect(pref.credentialId).toBeNull();
  });

  // 13. Preference persistence after reload
  it('Scenario 13: persists selected mode and metadata across remounting / page reload', async () => {
    const saved = await mockDataAdapter.saveProviderCredential({
      provider: 'gemini',
      apiKey: 'AIzaSyPersistentKey12345678',
    });
    await mockDataAdapter.setChatCredentialPreference({
      mode: 'byok',
      credentialId: saved.credential.id,
    });

    // First mount
    const { unmount } = renderWithProviders(<SettingsView />);
    await waitFor(() => {
      expect(screen.getByTestId('masked-credential-hint').textContent).toBe('••••5678');
    });
    const byokRadio = screen.getByTestId('radio-mode-byok') as HTMLInputElement;
    expect(byokRadio.checked).toBe(true);

    // Unmount (simulating navigate away)
    unmount();

    // Second mount (simulating navigate back / reload)
    renderWithProviders(<SettingsView />);
    await waitFor(() => {
      expect(screen.getByTestId('masked-credential-hint').textContent).toBe('••••5678');
    });
    const reloadedRadio = screen.getByTestId('radio-mode-byok') as HTMLInputElement;
    expect(reloadedRadio.checked).toBe(true);
  });

  // 14. Session expiration
  it('Scenario 14: handles session expiration (401) safely without crashing', async () => {
    // Unset mock session
    mockDataAdapter.setMockSession(null);

    renderWithProviders(<SettingsView />);

    await waitFor(() => {
      expect(screen.getByTestId('settings-error-banner')).toBeDefined();
    });

    expect(screen.getByText(/Session required/i)).toBeDefined();
  });

  // 15. No plaintext key leakage into rendered content or persistent storage
  it('Scenario 15: strictly protects against plaintext key leakage in storage or rendered markup', async () => {
    const secretKey = 'AIzaSyStrictNoLeakSecretTestKey9999';

    renderWithProviders(<SettingsView />);

    await waitFor(() => {
      expect(screen.getByTestId('empty-add-key-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('empty-add-key-btn'));
    const input = screen.getByTestId('gemini-api-key-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: secretKey } });
    fireEvent.click(screen.getByTestId('submit-save-credential-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('masked-credential-hint')).toBeDefined();
    });

    // Check localStorage
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      expect(localStorage.getItem(key)).not.toContain(secretKey);
    }

    // Check sessionStorage
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)!;
      expect(sessionStorage.getItem(key)).not.toContain(secretKey);
    }

    // Check full rendered HTML
    expect(document.body.innerHTML).not.toContain(secretKey);
  });

  // 16. Responsive layout and keyboard accessibility
  it('Scenario 16: supports keyboard accessibility (Escape to dismiss modal) and layout navigation', async () => {
    renderWithProviders(<Layout><SettingsView /></Layout>);

    await waitFor(() => {
      expect(screen.getByTestId('nav-settings')).toBeDefined();
    });

    // Wait for settings to load
    await waitFor(() => {
      expect(screen.getByTestId('empty-add-key-btn')).toBeDefined();
    });

    // Check ARIA attributes on nav button
    const navBtn = screen.getByTestId('nav-settings');
    expect(navBtn.getAttribute('aria-current')).toBe('page');

    // Open Add Key modal
    fireEvent.click(screen.getByTestId('empty-add-key-btn'));
    expect(screen.getByTestId('save-credential-form')).toBeDefined();

    // Press Escape key
    fireEvent.keyDown(window, { key: 'Escape' });

    // Modal closes
    await waitFor(() => {
      expect(screen.queryByTestId('save-credential-form')).toBeNull();
    });
  });

  // 17. Real API mode does not fall back to Mock mode
  it('Scenario 17: in Real API mode, failures do not silently fall back to mock data', async () => {
    const getMeSpy = vi.spyOn(realApiClient, 'getMe').mockResolvedValue({ user: MOCK_USER });
    const realSpy = vi.spyOn(realApiClient, 'getProviderCredentials').mockRejectedValueOnce(
      new ApiException(500, 'INTERNAL_SERVER_ERROR', 'Real server failure')
    );

    renderWithProviders(<SettingsView />, '/settings', 'real');

    await waitFor(() => {
      expect(screen.getByTestId('settings-error-banner')).toBeDefined();
    });

    expect(screen.getByText('Real server failure')).toBeDefined();
    // Must NOT have loaded mock credentials or fallback!
    expect(screen.queryByTestId('no-credential-state')).toBeNull();

    realSpy.mockRestore();
    getMeSpy.mockRestore();
  });

  describe('Independent Review Findings Regressions (PR #35)', () => {
    function ModeSwitcher() {
      const { mode, setMode } = useApiMode();
      return (
        <div>
          <span data-testid="current-api-mode">{mode}</span>
          <button data-testid="switch-to-real-btn" onClick={() => setMode('real')}>
            Switch to Real
          </button>
          <button data-testid="switch-to-mock-btn" onClick={() => setMode('mock')}>
            Switch to Mock
          </button>
        </div>
      );
    }

    describe('P1 — Contradictory BYOK Fallback Messaging', () => {
      it('accurately distinguishes platform mode from BYOK mode without credential and never claims platform fallback in BYOK', async () => {
        // 1. Platform mode without credential
        const firstMount = renderWithProviders(<SettingsView />);
        await waitFor(() => {
          expect(screen.getByTestId('credential-status-description')).toBeDefined();
        });

        expect(screen.getByTestId('credential-status-description').textContent).toBe(
          'Platform key selected. No custom Gemini API key configured.'
        );
        expect(screen.queryByTestId('byok-configuration-error')).toBeNull();
        firstMount.unmount();

        // 2. Reach BYOK preference without a credential by saving, switching to BYOK, and deleting
        const saved = await mockDataAdapter.saveProviderCredential({
          provider: 'gemini',
          apiKey: 'AIzaSyTempKeyForEmptyByok1234',
        });
        await mockDataAdapter.setChatCredentialPreference({
          mode: 'byok',
          credentialId: saved.credential.id,
        });
        await mockDataAdapter.deleteProviderCredential(saved.credential.id);

        // Remount SettingsView to reflect BYOK mode without credential
        const secondMount = renderWithProviders(<SettingsView />);
        await waitFor(() => {
          expect(screen.getByTestId('byok-configuration-error')).toBeDefined();
        });

        // Assert status text clearly indicates Chat is unavailable without automatic fallback
        const desc = screen.getByTestId('credential-status-description');
        expect(desc.textContent).toBe(
          'My Gemini Key (BYOK) is selected, but no key is configured. Chat is unavailable until configuration is fixed.'
        );
        // Strictly assert: never claims platform mode is active or that Giga is using the platform key!
        expect(screen.queryByText(/Giga is using the platform key/i)).toBeNull();
        expect(screen.queryByText(/Platform key selected\./i)).toBeNull();
        secondMount.unmount();
      });

      it('accurately displays unusable notice for BYOK with invalid credential with no automatic fallback', async () => {
        const saved = await mockDataAdapter.saveProviderCredential({
          provider: 'gemini',
          apiKey: 'AIzaSyInvalidKey000000000000',
        });
        await mockDataAdapter.setChatCredentialPreference({
          mode: 'byok',
          credentialId: saved.credential.id,
        });
        // Validate key to mark it invalid
        await mockDataAdapter.validateProviderCredential(saved.credential.id);

        renderWithProviders(<SettingsView />);

        await waitFor(() => {
          expect(screen.getByTestId('byok-configuration-error')).toBeDefined();
        });

        // Config alert states selected key is unusable with no automatic fallback
        expect(
          screen.getByText(/Selected key is unusable; there is no automatic fallback to the platform key/i)
        ).toBeDefined();

        // In-card notice renders
        expect(screen.getByTestId('byok-invalid-notice')).toBeDefined();
        expect(screen.getByTestId('byok-invalid-notice').textContent).toBe(
          'Selected key is unusable. Chat is unavailable with no automatic fallback.'
        );

        // Strictly assert: never claims platform key is active or being used
        expect(screen.queryByText(/Giga is using the platform key/i)).toBeNull();
        expect(screen.queryByText(/Platform key selected\./i)).toBeNull();
      });
    });

    describe('P1 — Stale Settings State Across Real/Mock Switching', () => {
      it('fences requests across Real -> Mock -> Real switching and clears source-specific metadata', async () => {
        const getMeSpy = vi.spyOn(realApiClient, 'getMe').mockResolvedValue({ user: MOCK_USER });

        // Save a credential in Mock mode
        await mockDataAdapter.saveProviderCredential({
          provider: 'gemini',
          apiKey: 'AIzaSyMockKeyForFencing12345',
        });

        let resolveRealLoad1: (val: any) => void;
        const realLoad1Promise = new Promise((resolve) => {
          resolveRealLoad1 = resolve;
        });

        let resolveRealLoad2: (val: any) => void;
        const realLoad2Promise = new Promise((resolve) => {
          resolveRealLoad2 = resolve;
        });

        let realCallCount = 0;
        const realCredsSpy = vi.spyOn(realApiClient, 'getProviderCredentials').mockImplementation(async () => {
          realCallCount++;
          if (realCallCount === 1) return realLoad1Promise as any;
          return realLoad2Promise as any;
        });
        const realPrefSpy = vi.spyOn(realApiClient, 'getChatCredentialPreference').mockResolvedValue({
          mode: 'platform',
          credentialId: null,
        });

        renderWithProviders(
          <>
            <ModeSwitcher />
            <SettingsView />
          </>,
          '/settings',
          'real'
        );

        // 1. Initial Real mode load is in-flight (Real Call 1)
        expect(screen.getByTestId('current-api-mode').textContent).toBe('real');
        expect(screen.getByTestId('settings-loading-state')).toBeDefined();

        // 2. Switch to Mock mode before Real Call 1 resolves
        fireEvent.click(screen.getByTestId('switch-to-mock-btn'));
        expect(screen.getByTestId('current-api-mode').textContent).toBe('mock');

        // Mock mode loads its credential
        await waitFor(() => {
          expect(screen.getByTestId('masked-credential-hint').textContent).toBe('••••2345');
        });

        // 3. Delayed Real Call 1 now resolves with stale Real data
        resolveRealLoad1!({
          items: [
            {
              id: 'stale_real_id',
              provider: 'gemini',
              displayHint: '••••REAL1',
              status: 'valid',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              lastValidatedAt: new Date().toISOString(),
            },
          ],
        });

        // Stale response must be IGNORED! Mock state must remain displayed
        await new Promise((r) => setTimeout(r, 50));
        expect(screen.getByTestId('masked-credential-hint').textContent).toBe('••••2345');

        // 4. Switch from Mock back to Real mode
        fireEvent.click(screen.getByTestId('switch-to-real-btn'));
        expect(screen.getByTestId('current-api-mode').textContent).toBe('real');

        // Metadata must be immediately cleared; Mock credential must NOT be visible!
        expect(screen.queryByText('••••2345')).toBeNull();
        expect(screen.getByTestId('settings-loading-state')).toBeDefined();

        // 5. Real Call 2 resolves
        resolveRealLoad2!({
          items: [
            {
              id: 'real_id_2',
              provider: 'gemini',
              displayHint: '••••REAL2',
              status: 'valid',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              lastValidatedAt: new Date().toISOString(),
            },
          ],
        });

        await waitFor(() => {
          expect(screen.getByTestId('masked-credential-hint').textContent).toBe('••••REAL2');
        });

        realCredsSpy.mockRestore();
        realPrefSpy.mockRestore();
        getMeSpy.mockRestore();
      });

      it('on fetch failure in new API mode, does not show stale credential from previous mode as verified state', async () => {
        const getMeSpy = vi.spyOn(realApiClient, 'getMe').mockResolvedValue({ user: MOCK_USER });
        // Start in Mock mode with saved credential
        await mockDataAdapter.saveProviderCredential({
          provider: 'gemini',
          apiKey: 'AIzaSyStaleMockKey99999999',
        });

        // Real API will fail with 500
        const realSpy = vi.spyOn(realApiClient, 'getProviderCredentials').mockRejectedValue(
          new ApiException(500, 'INTERNAL_ERROR', 'Database connection refused')
        );

        renderWithProviders(
          <>
            <ModeSwitcher />
            <SettingsView />
          </>,
          '/settings',
          'mock'
        );

        await waitFor(() => {
          expect(screen.getByTestId('masked-credential-hint').textContent).toBe('••••9999');
        });

        // Switch to Real mode
        fireEvent.click(screen.getByTestId('switch-to-real-btn'));

        await waitFor(() => {
          expect(screen.getByTestId('settings-error-banner')).toBeDefined();
        });

        expect(screen.getByText('Database connection refused')).toBeDefined();
        // Crucial: Stale Mock data ••••9999 must NOT be rendered as verified state!
        expect(screen.queryByText('••••9999')).toBeNull();
        expect(screen.queryByTestId('gemini-provider-card')).toBeNull();

        realSpy.mockRestore();
        getMeSpy.mockRestore();
      });
    });

    describe('P2 — Missing Initial Load Retry', () => {
      it('renders visible Retry button on initial 500/503 failure and restores Settings UI on successful retry', async () => {
        const getMeSpy = vi.spyOn(realApiClient, 'getMe').mockResolvedValue({ user: MOCK_USER });
        let callCount = 0;
        const realSpy = vi.spyOn(realApiClient, 'getProviderCredentials').mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            throw new ApiException(503, 'SERVICE_UNAVAILABLE', 'Provider service unavailable');
          }
          return { items: [] };
        });
        const prefSpy = vi.spyOn(realApiClient, 'getChatCredentialPreference').mockResolvedValue({
          mode: 'platform',
          credentialId: null,
        });

        renderWithProviders(<SettingsView />, '/settings', 'real');

        // Initial failure
        await waitFor(() => {
          expect(screen.getByTestId('settings-error-banner')).toBeDefined();
        });
        expect(screen.getByText('Provider service unavailable')).toBeDefined();

        // Retry button is prominently visible
        const retryBtn = screen.getByTestId('settings-load-retry-btn');
        expect(retryBtn).toBeDefined();

        // Normal card is NOT rendered yet
        expect(screen.queryByTestId('gemini-provider-card')).toBeNull();

        // Click Retry
        fireEvent.click(retryBtn);

        // Loading state shows during retry
        expect(screen.getByTestId('settings-loading-state')).toBeDefined();

        // Success restores normal Settings UI
        await waitFor(() => {
          expect(screen.getByTestId('gemini-provider-card')).toBeDefined();
        });
        expect(screen.getByTestId('no-credential-state')).toBeDefined();
        expect(screen.queryByTestId('settings-load-retry-btn')).toBeNull();

        realSpy.mockRestore();
        prefSpy.mockRestore();
        getMeSpy.mockRestore();
      });
    });

    describe('Additional Consistency Checks — Mutation Partial Success', () => {
      it('save credential succeeds but preference refresh fails: updates credential and does not report save failure', async () => {
        let prefCalls = 0;
        const prefSpy = vi.spyOn(mockDataAdapter, 'getChatCredentialPreference').mockImplementation(async () => {
          prefCalls++;
          if (prefCalls === 2) {
            throw new Error('Preference service temporarily down');
          }
          return { mode: 'platform', credentialId: null };
        });

        renderWithProviders(<SettingsView />);
        await waitFor(() => {
          expect(screen.getByTestId('empty-add-key-btn')).toBeDefined();
        });

        fireEvent.click(screen.getByTestId('empty-add-key-btn'));
        const input = screen.getByTestId('gemini-api-key-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'AIzaSySecretPartialSuccessKey1111' } });
        fireEvent.click(screen.getByTestId('submit-save-credential-btn'));

        // Modal closes because save succeeded
        await waitFor(() => {
          expect(screen.queryByTestId('save-credential-form')).toBeNull();
        });

        // Masked hint is updated with new key
        expect(screen.getByTestId('masked-credential-hint').textContent).toBe('••••1111');

        prefSpy.mockRestore();
      });

      it('delete credential succeeds but metadata refresh fails: clears deleted credential and does not tell user deletion failed', async () => {
        await mockDataAdapter.saveProviderCredential({
          provider: 'gemini',
          apiKey: 'AIzaSyDeletePartialFail12345',
        });

        let credCalls = 0;
        const origGetCreds = mockDataAdapter.getProviderCredentials.bind(mockDataAdapter);
        const credSpy = vi.spyOn(mockDataAdapter, 'getProviderCredentials').mockImplementation(async () => {
          credCalls++;
          if (credCalls === 2) {
            throw new Error('Network timeout during refresh');
          }
          return origGetCreds();
        });

        renderWithProviders(<SettingsView />);
        await waitFor(() => {
          expect(screen.getByTestId('delete-key-btn')).toBeDefined();
        });

        fireEvent.click(screen.getByTestId('delete-key-btn'));
        fireEvent.click(screen.getByTestId('confirm-delete-credential-btn'));

        await waitFor(() => {
          expect(screen.getByTestId('settings-success-banner')).toBeDefined();
        });

        expect(screen.getByText('Gemini API key has been deleted.')).toBeDefined();
        expect(screen.queryByTestId('masked-credential-hint')).toBeNull();

        credSpy.mockRestore();
      });

      it('mode change succeeds on server but response is lost: reconciles authoritative mode', async () => {
        await mockDataAdapter.saveProviderCredential({
          provider: 'gemini',
          apiKey: 'AIzaSyModeReconcileKey12345',
        });

        // Simulate server applied BYOK, but client got transport error on response
        const origSetPref = mockDataAdapter.setChatCredentialPreference.bind(mockDataAdapter);
        const setPrefSpy = vi.spyOn(mockDataAdapter, 'setChatCredentialPreference').mockImplementation(async (dto) => {
          await origSetPref(dto);
          throw new Error('Transport connection closed prematurely');
        });

        renderWithProviders(<SettingsView />);
        await waitFor(() => {
          expect(screen.getByTestId('radio-mode-byok')).toBeDefined();
        });

        const byokRadio = screen.getByTestId('radio-mode-byok') as HTMLInputElement;
        fireEvent.click(byokRadio);

        // Reconciles authoritative state: preference is byok and success banner is shown
        await waitFor(() => {
          expect(byokRadio.checked).toBe(true);
        });
        expect(screen.getByTestId('settings-success-banner')).toBeDefined();
        expect(screen.getByText('Switched to My Gemini Key (BYOK) for Chat.')).toBeDefined();

        setPrefSpy.mockRestore();
      });
    });
  });
});
