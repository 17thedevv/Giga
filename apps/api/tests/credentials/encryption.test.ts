import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { CredentialEncryption, decodeMasterKey } from '../../src/modules/credentials/encryption.js';
import { ProviderCredential } from '../../src/modules/llm/provider-credential.js';
import { loadConfig } from '../../src/app/config.js';

describe('Chat credential encryption', () => {
  const owner = randomUUID(); const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const encryption = new CredentialEncryption(randomBytes(32).toString('base64'));
  it('round trips with fresh 96-bit nonce and different ciphertext every time', () => {
    const first = encryption.encrypt(secret, owner, id); const second = encryption.encrypt(secret, owner, id);
    assert.ok(encryption.decrypt(first, owner, id) === secret, 'round trip mismatch');
    assert.notEqual(first.nonce, second.nonce); assert.notEqual(first.ciphertext, second.ciphertext);
    assert.equal(Buffer.from(first.nonce, 'base64').length, 12);
    assert.equal(Buffer.from(first.auth_tag, 'base64').length, 16);
    assert.ok(!JSON.stringify(first).includes(secret));
  });
  for (const field of ['ciphertext', 'auth_tag', 'nonce'] as const) {
    it(`rejects tampered ${field} without disclosing material`, () => {
      const row = encryption.encrypt(secret, owner, id); const bytes = Buffer.from(row[field], 'base64'); bytes[0] = bytes[0]! ^ 1;
      row[field] = bytes.toString('base64');
      assert.throws(() => encryption.decrypt(row, owner, id), (error) => {
        assert.ok(!JSON.stringify(error).includes(secret)); assert.ok(!String(error).includes(row.ciphertext));
        return (error as { code: string }).code === 'CHAT_CREDENTIAL_UNAVAILABLE';
      });
    });
  }
  it('rejects wrong master key, key version, owner, and credential identity', () => {
    const row = encryption.encrypt(secret, owner, id);
    const wrong = new CredentialEncryption(randomBytes(32).toString('base64'));
    for (const decrypt of [() => wrong.decrypt(row, owner, id), () => encryption.decrypt({ ...row, key_version: 2 }, owner, id),
      () => encryption.decrypt(row, randomUUID(), id), () => encryption.decrypt(row, owner, randomUUID())]) {
      assert.throws(decrypt, { code: 'CHAT_CREDENTIAL_UNAVAILABLE' });
    }
  });
  it('requires exactly 32 bytes in canonical base64 and never echoes configuration', () => {
    for (const bad of ['', 'malformed-private-master', randomBytes(31).toString('base64'), randomBytes(33).toString('base64'),
      randomBytes(32).toString('base64') + '\n']) {
      assert.throws(() => decodeMasterKey(bad), { message: 'Invalid credential encryption configuration' });
      assert.throws(() => loadConfig({ NODE_ENV: 'test', CREDENTIAL_ENCRYPTION_KEY: bad }));
    }
    assert.equal(loadConfig({ NODE_ENV: 'test' }).credentialEncryption, undefined);
    const production = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://api_user@localhost/config_test',
      MIGRATION_DATABASE_URL: 'postgres://migration_user@localhost/config_test',
      AGENT_LIFECYCLE_FINALIZER_DATABASE_URL: 'postgres://lifecycle_user@localhost/config_test',
      ALLOWED_ORIGINS: 'https://example.com',
      CHAT_ENABLED: 'false',
    };
    assert.equal(loadConfig(production).credentialEncryption, undefined);
    assert.throws(() => loadConfig({ ...production, CREDENTIAL_ENCRYPTION_KEY: 'malformed' }), { message: 'Invalid credential encryption configuration' });
  });
  it('serialization and object inspection cannot enumerate plaintext from capabilities or encryption', () => {
    const credential = new ProviderCredential(secret, 'user', id);
    assert.ok(!JSON.stringify(credential).includes(secret));
    assert.ok(!JSON.stringify({ ...credential }).includes(secret));
    assert.deepEqual(Object.keys(encryption), []);
  });
});
