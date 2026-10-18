import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsView } from '../src/features/settings/SettingsView.js';
import { Layout } from '../src/app/Layout.js';
import { ApiModeProvider } from '../src/app/context/ApiModeContext.js';
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
});
