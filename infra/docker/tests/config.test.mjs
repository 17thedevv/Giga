import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { configureEnvironment } from '../start.mjs';

function valid() {
  return {
    NODE_ENV: 'production', SERVE_WEB: 'true', AGENT_CLOUD_EXECUTION_ENABLED: 'false',
    GIGA_LOCAL_HTTP: 'true', COOKIE_SECURE: 'false', COOKIE_SAME_SITE: 'lax',
    ALLOWED_ORIGINS: 'http://localhost:8080', DB_HOST: 'postgres', DB_NAME: 'giga',
    DB_PASSWORD_API: randomBytes(32).toString('hex'),
    DB_PASSWORD_MIGRATION: randomBytes(32).toString('hex'),
    DB_PASSWORD_LIFECYCLE: randomBytes(32).toString('hex'),
    CHAT_ENABLED: 'false',
  };
}
test('Docker guard keeps local HTTP on production runtime with three distinct logins', () => {
  const env = configureEnvironment(valid());
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(new URL(env.DATABASE_URL).username, 'giga_runtime');
  assert.equal(new URL(env.MIGRATION_DATABASE_URL).username, 'giga_migration');
  assert.equal(new URL(env.AGENT_LIFECYCLE_FINALIZER_DATABASE_URL).username, 'giga_lifecycle');
});
test('Docker guard rejects absent or reused credentials', () => {
  for (const key of ['DB_PASSWORD_API', 'DB_PASSWORD_MIGRATION', 'DB_PASSWORD_LIFECYCLE']) {
    const env = valid(); delete env[key];
    assert.throws(() => configureEnvironment(env));
  }
  const reused = valid(); reused.DB_PASSWORD_API = reused.DB_PASSWORD_MIGRATION;
  assert.throws(() => configureEnvironment(reused));
});
test('Docker guard rejects cloud credentials and execution enable switches', () => {
  for (const extra of [
    { AGENT_CLOUD_EXECUTION_ENABLED: 'true' }, { E2B_API_KEY: 'fixture-only' },
    { AGENT_RUNTIME_ENABLED: 'true' }, { AGENT_API_TOKEN: 'fixture-only' },
  ]) assert.throws(() => configureEnvironment({ ...valid(), ...extra }));
});
test('Docker guard refuses public HTTP and insecure production-like cookies', () => {
  for (const extra of [
    { ALLOWED_ORIGINS: 'http://example.invalid:8080' }, { ALLOWED_ORIGINS: '*' },
    { NODE_ENV: 'development' }, { GIGA_LOCAL_HTTP: 'false' }, { COOKIE_SAME_SITE: 'none' },
  ]) assert.throws(() => configureEnvironment({ ...valid(), ...extra }));
  assert.doesNotThrow(() => configureEnvironment({
    ...valid(), GIGA_LOCAL_HTTP: 'false', COOKIE_SECURE: 'true', ALLOWED_ORIGINS: 'https://giga.example.invalid',
  }));
  assert.throws(() => configureEnvironment({
    ...valid(), GIGA_LOCAL_HTTP: 'false', COOKIE_SECURE: 'true', ALLOWED_ORIGINS: 'https://giga.example.invalid:9443',
  }));
});
