import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, type TestDbInstance } from '../test-db-helper.js';
import { UserRepository } from '../../src/db/repositories/user-repository.js';
import { ConversationRepository } from '../../src/db/repositories/conversation-repository.js';
import { MessageRepository } from '../../src/db/repositories/message-repository.js';
import { getAppliedMigrationVersions, runMigrations } from '../../src/db/migrate.js';
import { decodeCursor } from '../../src/modules/conversations/conversations-validation.js';

describe('Conversations & Messages PostgreSQL Persistence', () => {
  let db: TestDbInstance;
  let userRepo: UserRepository;
  let convRepo: ConversationRepository;
  let msgRepo: MessageRepository;

  let userAId: string;
  let userBId: string;

  before(async () => {
    db = await createTestDatabase();
    userRepo = new UserRepository(db.pool);
    convRepo = new ConversationRepository(db.pool);
    msgRepo = new MessageRepository(db.pool);
  });

  after(async () => {
    await db.cleanup();
    await db.pool.end();
  });

  beforeEach(async () => {
    await db.cleanup();

    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const userA = await userRepo.createUser({
      email: `alice-${tag}@example.com`,
      displayName: 'Alice',
      passwordHash: 'hash_a',
    });
    userAId = userA.id;

    const userB = await userRepo.createUser({
      email: `bob-${tag}@example.com`,
      displayName: 'Bob',
      passwordHash: 'hash_b',
    });
    userBId = userB.id;
  });

  it('Migration verification: migration 002 is recorded in schema_migrations and idempotent', async () => {
    const versions = await getAppliedMigrationVersions(db.pool);
    assert.ok(versions.has(1), 'Migration 001 applied');
    assert.ok(versions.has(2), 'Migration 002 applied');
    assert.ok(versions.has(3), 'Migration 003 applied');

    const secondRun = await runMigrations(db.pool);
    assert.strictEqual(secondRun.length, 0, 'Migration rerun must be idempotent');
  });

  it('Foreign key constraint: fails when creating conversation for nonexistent user', async () => {
    const fakeUserId = '00000000-0000-0000-0000-000000000000';
    await assert.rejects(
      async () => {
        await convRepo.create({
          userId: fakeUserId,
          title: 'Orphan Conversation',
        });
      },
      (err: Error) => {
        assert.ok(
          err.message.includes('foreign key') ||
            err.message.includes('violates foreign key constraint') ||
            err.message.includes('references users'),
          `Unexpected error message: ${err.message}`
        );
        return true;
      }
    );
  });

  it('Foreign key constraint: fails when creating message for nonexistent conversation', async () => {
    const fakeConvId = '00000000-0000-0000-0000-000000000000';
    await assert.rejects(
      async () => {
        await msgRepo.create({
          conversationId: fakeConvId,
          role: 'user',
          content: 'Hello void',
        });
      },
      (err: Error) => {
        assert.ok(
          err.message.includes('foreign key') ||
            err.message.includes('violates foreign key constraint') ||
            err.message.includes('references conversations'),
          `Unexpected error message: ${err.message}`
        );
        return true;
      }
    );
  });

  it('Check constraint: rejects invalid role on message creation', async () => {
    const conv = await convRepo.create({
      userId: userAId,
      title: 'Valid Conversation',
    });

    await assert.rejects(
      async () => {
        await msgRepo.create({
          conversationId: conv.id,
          role: 'admin' as unknown as 'user',
          content: 'I am not user or assistant',
        });
      },
      (err: Error) => {
        assert.ok(
          err.message.includes('check constraint') ||
            err.message.includes('violates check constraint') ||
            err.message.includes('CHECK'),
          `Unexpected error: ${err.message}`
        );
        return true;
      }
    );
  });

  it('Cascade deletion: deleting a conversation deletes all associated messages', async () => {
    const conv = await convRepo.create({
      userId: userAId,
      title: 'Conversation to Delete',
    });

    await msgRepo.create({ conversationId: conv.id, role: 'user', content: 'Message 1' });
    await msgRepo.create({ conversationId: conv.id, role: 'assistant', content: 'Message 2' });

    const beforeMessages = await msgRepo.listByConversation(conv.id);
    assert.strictEqual(beforeMessages.length, 2);

    const deleted = await convRepo.delete(conv.id, userAId);
    assert.strictEqual(deleted, true);

    const afterMessages = await msgRepo.listByConversation(conv.id);
    assert.strictEqual(afterMessages.length, 0, 'All messages must be deleted via CASCADE');
  });

  it('Cascade deletion: deleting a user cascades to conversations and messages', async () => {
    const conv = await convRepo.create({
      userId: userAId,
      title: 'User A Conversation',
    });
    await msgRepo.create({ conversationId: conv.id, role: 'user', content: 'User A Message' });

    // Delete user A
    await db.pool.query('DELETE FROM users WHERE id = $1;', [userAId]);

    const foundConv = await convRepo.findById(conv.id, userAId);
    assert.strictEqual(foundConv, null);

    const foundMessages = await msgRepo.listByConversation(conv.id);
    assert.strictEqual(foundMessages.length, 0);
  });

  it('Multi-user tenant isolation: User B cannot access or delete User A conversations', async () => {
    const convA = await convRepo.create({
      userId: userAId,
      title: 'Alice Private Conversation',
    });

    // User B attempts lookup
    const lookupByB = await convRepo.findById(convA.id, userBId);
    assert.strictEqual(lookupByB, null, 'User B must not see User A conversation');

    // User B attempts delete
    const deleteByB = await convRepo.delete(convA.id, userBId);
    assert.strictEqual(deleteByB, false, 'User B must not be able to delete User A conversation');

    // Ensure User A conversation remains intact
    const lookupByA = await convRepo.findById(convA.id, userAId);
    assert.ok(lookupByA);
    assert.strictEqual(lookupByA.id, convA.id);
  });

  it('Message ordering: lists messages deterministically in created_at ASC, id ASC order', async () => {
    const conv = await convRepo.create({
      userId: userAId,
      title: 'Ordered Messages Test',
    });

    const m1 = await msgRepo.create({ conversationId: conv.id, role: 'user', content: 'First message' });
    const m2 = await msgRepo.create({ conversationId: conv.id, role: 'assistant', content: 'Second message' });
    const m3 = await msgRepo.create({ conversationId: conv.id, role: 'user', content: 'Third message' });

    const messages = await msgRepo.listByConversation(conv.id);
    assert.strictEqual(messages.length, 3);
    assert.strictEqual(messages[0]?.id, m1.id);
    assert.strictEqual(messages[1]?.id, m2.id);
    assert.strictEqual(messages[2]?.id, m3.id);
  });

  it('Keyset pagination: deterministic multi-page traversal and tie-breaking', async () => {
    const conv1 = await convRepo.create({ userId: userAId, title: 'Chat 1' });
    const conv2 = await convRepo.create({ userId: userAId, title: 'Chat 2' });
    const conv3 = await convRepo.create({ userId: userAId, title: 'Chat 3' });
    const conv4 = await convRepo.create({ userId: userAId, title: 'Chat 4' });
    const conv5 = await convRepo.create({ userId: userAId, title: 'Chat 5' });

    // Page 1: limit 2
    const page1 = await convRepo.listByUser({ userId: userAId, limit: 2 });
    assert.strictEqual(page1.items.length, 2);
    assert.ok(page1.nextCursor);

    // Page 2: limit 2 with cursor from page 1
    const cursor1 = decodeCursor(page1.nextCursor);
    const page2 = await convRepo.listByUser({ userId: userAId, limit: 2, cursor: cursor1 });
    assert.strictEqual(page2.items.length, 2);
    assert.ok(page2.nextCursor);

    // Page 3: limit 2 with cursor from page 2 (only 1 remaining item)
    const cursor2 = decodeCursor(page2.nextCursor);
    const page3 = await convRepo.listByUser({ userId: userAId, limit: 2, cursor: cursor2 });
    assert.strictEqual(page3.items.length, 1);
    assert.strictEqual(page3.nextCursor, null, 'Last page must have nextCursor null');

    // Aggregate items across all pages
    const allIds = [
      ...page1.items.map((i) => i.id),
      ...page2.items.map((i) => i.id),
      ...page3.items.map((i) => i.id),
    ];
    assert.strictEqual(allIds.length, 5);

    // Verify all 5 created conversations are present with zero duplicates
    const expectedIds = new Set([conv1.id, conv2.id, conv3.id, conv4.id, conv5.id]);
    assert.strictEqual(new Set(allIds).size, 5);
    for (const id of allIds) {
      assert.ok(expectedIds.has(id));
    }
  });

  it('Keyset pagination: tie-breaks deterministically when multiple items have identical updated_at', async () => {
    const fixedDate = new Date('2026-10-14T10:00:00.000Z');
    // Insert 3 conversations with identical updated_at
    const resA = await db.pool.query(
      'INSERT INTO conversations (user_id, title, updated_at) VALUES ($1, $2, $3) RETURNING id;',
      [userAId, 'Tie A', fixedDate]
    );
    const resB = await db.pool.query(
      'INSERT INTO conversations (user_id, title, updated_at) VALUES ($1, $2, $3) RETURNING id;',
      [userAId, 'Tie B', fixedDate]
    );
    const resC = await db.pool.query(
      'INSERT INTO conversations (user_id, title, updated_at) VALUES ($1, $2, $3) RETURNING id;',
      [userAId, 'Tie C', fixedDate]
    );

    const idA = resA.rows[0].id;
    const idB = resB.rows[0].id;
    const idC = resC.rows[0].id;

    // Page with limit 2
    const p1 = await convRepo.listByUser({ userId: userAId, limit: 2 });
    assert.strictEqual(p1.items.length, 2);
    assert.ok(p1.nextCursor);

    // Page 2 with limit 2
    const cursor = decodeCursor(p1.nextCursor);
    const p2 = await convRepo.listByUser({ userId: userAId, limit: 2, cursor });
    assert.strictEqual(p2.items.length, 1);
    assert.strictEqual(p2.nextCursor, null);

    const retrievedIds = [...p1.items.map((i) => i.id), ...p2.items.map((i) => i.id)];
    assert.strictEqual(new Set(retrievedIds).size, 3);
    assert.ok(retrievedIds.includes(idA));
    assert.ok(retrievedIds.includes(idB));
    assert.ok(retrievedIds.includes(idC));
  });
});
