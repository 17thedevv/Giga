import { describe, it, expect, beforeEach } from 'vitest';
import { MockDataAdapter } from '../src/lib/api/mock-adapter.js';

describe('MockDataAdapter', () => {
  let adapter: MockDataAdapter;

  beforeEach(() => {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.clear();
    }
    adapter = new MockDataAdapter();
  });

  describe('Authentication', () => {
    it('authenticates with valid email and password', async () => {
      const res = await adapter.login('trangthu@demo.giga.dev', 'CorrectPassword123!');
      expect(res.user).toBeDefined();
      expect(res.user.email).toBe('trangthu@demo.giga.dev');
    });

    it('rejects invalid email format', async () => {
      await expect(adapter.login('invalid-email', 'pass')).rejects.toThrow('Invalid email format');
    });

    it('returns current user session on getMe after login', async () => {
      await adapter.login('trangthu@demo.giga.dev', 'CorrectPassword123!');
      const res = await adapter.getMe();
      expect(res.user.displayName).toContain('Tráng A Thư');
    });

    it('rejects getMe with 401 when unauthenticated', async () => {
      await expect(adapter.getMe()).rejects.toThrow('No active mock session');
    });

    it('transitions to unauthenticated upon logout', async () => {
      await adapter.login('trangthu@demo.giga.dev', 'CorrectPassword123!');
      expect(await adapter.getMe()).toBeDefined();

      await adapter.logout();
      await expect(adapter.getMe()).rejects.toThrow('No active mock session');
    });

    it('allows successful re-login after logout', async () => {
      await adapter.login('trangthu@demo.giga.dev', 'CorrectPassword123!');
      await adapter.logout();
      await expect(adapter.getMe()).rejects.toThrow();

      const res = await adapter.login('trangthu@demo.giga.dev', 'CorrectPassword123!');
      expect(res.user.email).toBe('trangthu@demo.giga.dev');
      const me = await adapter.getMe();
      expect(me.user.email).toBe('trangthu@demo.giga.dev');
    });
  });

  describe('Conversations & Chat', () => {
    it('lists initial discussions and creates a new conversation', async () => {
      const list = await adapter.listConversations();
      expect(list.items.length).toBeGreaterThan(0);

      const created = await adapter.createConversation('Dockerizing Hono Service');
      expect(created.conversation.title).toBe('Dockerizing Hono Service');

      const updatedList = await adapter.listConversations();
      expect(updatedList.items[0].id).toBe(created.conversation.id);
    });

    it('deletes conversation and clears its messages', async () => {
      const created = await adapter.createConversation('Temporary');
      await adapter.deleteConversation(created.conversation.id);

      const list = await adapter.listConversations();
      expect(list.items.some((c) => c.id === created.conversation.id)).toBe(false);
    });

    it('streams simulated chat chunks incrementally', async () => {
      const chunks: string[] = [];
      let completed = false;

      await adapter.simulateChatStream(
        'Hello',
        (chunk) => chunks.push(chunk),
        () => {
          completed = true;
        }
      );

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join('')).toContain('Giga Coding Agent');
      expect(completed).toBe(true);
    });
  });

  describe('Agent Lifecycle & Invariant INV-07 Approval Gate', () => {
    it('launches a new run in queued status', async () => {
      const res = await adapter.createRun('Fix connection leak', '17thedevv/Giga');
      expect(res.run.status).toBe('queued');
      expect(res.run.repository).toBe('17thedevv/Giga');
    });

    it('enforces Invariant INV-07: approve transitions to applying first, never completed optimistically', async () => {
      const created = await adapter.createRun('Fix leak', '17thedevv/Giga');
      const awaiting = await adapter.updateRunStatus(created.run.id, 'awaiting_approval');
      expect(awaiting.status).toBe('awaiting_approval');

      // Approval submission
      const decisionRes = await adapter.submitDecision(created.run.id, 'prop_123', 'approve');
      // Must be applying, NOT completed!
      expect(decisionRes.run.status).toBe('applying');
      expect(decisionRes.run.result?.prUrl).toBeUndefined();

      // Finalize after server confirmation
      const finalized = await adapter.finalizeApprovedRun(created.run.id);
      expect(finalized.status).toBe('completed');
      expect(finalized.result?.prUrl).toBe('https://demo.giga.dev/simulated-pr');
      expect(finalized.result?.prNumber).toBe(9999);
    });

    it('transitions to cancelled when rejected', async () => {
      const created = await adapter.createRun('Reject test', '17thedevv/Giga');
      await adapter.updateRunStatus(created.run.id, 'awaiting_approval');

      const decisionRes = await adapter.submitDecision(created.run.id, 'prop_123', 'reject');
      expect(decisionRes.run.status).toBe('cancelled');
    });

    it('cancels active run when user triggers cancel', async () => {
      const created = await adapter.createRun('Cancel test', '17thedevv/Giga');
      const res = await adapter.cancelRun(created.run.id);
      expect(res.run.status).toBe('cancelled');
    });
  });

  describe('Provider Credentials & BYOK (17T-39)', () => {
    beforeEach(async () => {
      await adapter.login('trangthu@demo.giga.dev', 'CorrectPassword123!');
      adapter.resetCredentials();
    });

    it('starts with empty credentials and default platform preference', async () => {
      const creds = await adapter.getProviderCredentials();
      expect(creds.items).toEqual([]);

      const pref = await adapter.getChatCredentialPreference();
      expect(pref).toEqual({ mode: 'platform', credentialId: null });
    });

    it('saves a valid Gemini credential and generates masked hint without storing plaintext', async () => {
      const saved = await adapter.saveProviderCredential({
        provider: 'gemini',
        apiKey: 'AIzaSyDemoValidSecretKey1234567890',
      });

      expect(saved.credential.id).toBeDefined();
      expect(saved.credential.provider).toBe('gemini');
      expect(saved.credential.displayHint).toBe('••••7890');
      expect(saved.credential.status).toBe('unverified');
      expect(saved.credential.lastValidatedAt).toBeNull();

      // Plaintext key is not on credential
      expect((saved.credential as unknown as Record<string, unknown>).apiKey).toBeUndefined();

      const list = await adapter.getProviderCredentials();
      expect(list.items).toHaveLength(1);
      expect(list.items[0].id).toBe(saved.credential.id);
    });

    it('rejects invalid or too short api keys', async () => {
      await expect(
        adapter.saveProviderCredential({
          provider: 'gemini',
          apiKey: 'short',
        })
      ).rejects.toThrow('Expected Gemini provider');
    });

    it('validates a saved credential and updates status and timestamp', async () => {
      const saved = await adapter.saveProviderCredential({
        provider: 'gemini',
        apiKey: 'AIzaSyDemoValidSecretKey1234567890',
      });

      const validated = await adapter.validateProviderCredential(saved.credential.id);
      expect(validated.credential.status).toBe('valid');
      expect(validated.credential.lastValidatedAt).toBeDefined();
    });

    it('marks key invalid when validation fails', async () => {
      const saved = await adapter.saveProviderCredential({
        provider: 'gemini',
        apiKey: 'AIzaSyDemoInvalidKeyEndingIn0000',
      });

      const validated = await adapter.validateProviderCredential(saved.credential.id);
      expect(validated.credential.status).toBe('invalid');
      expect(validated.credential.lastValidatedAt).toBeDefined();
    });

    it('handles transient validation failure with 503 while preserving status', async () => {
      const saved = await adapter.saveProviderCredential({
        provider: 'gemini',
        apiKey: 'AIzaSyDemoValidSecretKey1234567890',
      });
      // First validate as valid
      await adapter.validateProviderCredential(saved.credential.id);

      adapter.mockValidateBehavior = 'transient_error';
      await expect(adapter.validateProviderCredential(saved.credential.id)).rejects.toThrow(
        'Credential validation is temporarily unavailable'
      );

      const list = await adapter.getProviderCredentials();
      expect(list.items[0].status).toBe('valid');
      expect(list.items[0].lastValidatedAt).toBeDefined();
    });

    it('switches preferences between platform and byok with valid credential', async () => {
      const saved = await adapter.saveProviderCredential({
        provider: 'gemini',
        apiKey: 'AIzaSyDemoValidSecretKey1234567890',
      });

      // Switch to byok
      const byokPref = await adapter.setChatCredentialPreference({
        mode: 'byok',
        credentialId: saved.credential.id,
      });
      expect(byokPref).toEqual({ mode: 'byok', credentialId: saved.credential.id });

      // Switch back to platform
      const platPref = await adapter.setChatCredentialPreference({
        mode: 'platform',
        credentialId: null,
      });
      expect(platPref).toEqual({ mode: 'platform', credentialId: null });
    });

    it('deleting credential in byok mode keeps mode byok and sets credentialId to null', async () => {
      const saved = await adapter.saveProviderCredential({
        provider: 'gemini',
        apiKey: 'AIzaSyDemoValidSecretKey1234567890',
      });
      await adapter.setChatCredentialPreference({
        mode: 'byok',
        credentialId: saved.credential.id,
      });

      await adapter.deleteProviderCredential(saved.credential.id);

      const creds = await adapter.getProviderCredentials();
      expect(creds.items).toHaveLength(0);

      const pref = await adapter.getChatCredentialPreference();
      // Must NOT silently fall back to platform!
      expect(pref).toEqual({ mode: 'byok', credentialId: null });
    });
  });
});
