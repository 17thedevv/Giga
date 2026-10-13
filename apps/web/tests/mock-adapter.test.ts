import { describe, it, expect, beforeEach } from 'vitest';
import { MockDataAdapter } from '../src/lib/api/mock-adapter.js';

describe('MockDataAdapter', () => {
  let adapter: MockDataAdapter;

  beforeEach(() => {
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

    it('returns current user session on getMe', async () => {
      const res = await adapter.getMe();
      expect(res.user.displayName).toContain('Tráng A Thư');
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
      expect(finalized.result?.prUrl).toContain('github.com/17thedevv/Giga/pull/');
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
});
