import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { configureEnvironment } from '../start.mjs';
import { configureMigrationEnvironment } from '../migrate.mjs';

test('generates separate allowlists and switches origin while preserving database credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'giga-config-test-'));
  try {
    const configure = (...args) => spawnSync(process.execPath, [
      fileURLToPath(new URL('../configure.mjs', import.meta.url)), ...args,
    ], { cwd: dir, encoding: 'utf8' });
    assert.equal(configure('--local').status, 0);
    const sourcePath = join(dir, '.env');
    const localText = (await readFile(sourcePath, 'utf8')) + 'IMAGE_TAG_OVERRIDE=keep-me\n';
    await writeFile(sourcePath, localText);
    const local = parseEnv(localText);
    const localHosts = await readFile(local.NGINX_HOSTS_FILE, 'utf8');
    assert.match(localHosts, /"localhost" 1;/);

    const switched = configure('--origin=https://giga.example.invalid', '--tls-dir=' + dir,
      '--from=.env', '--output=.env.https');
    assert.equal(switched.status, 0, switched.stderr);
    const https = parseEnv(await readFile(join(dir, '.env.https'), 'utf8'));
    assert.equal(https.PUBLIC_ORIGIN, 'https://giga.example.invalid');
    assert.equal(https.COMPOSE_FILE, 'compose.yaml');
    assert.equal(https.IMAGE_TAG_OVERRIDE, 'keep-me');
    assert.notEqual(local.NGINX_HOSTS_FILE, https.NGINX_HOSTS_FILE);
    assert.match(await readFile(https.NGINX_HOSTS_FILE, 'utf8'), /"giga\.example\.invalid" 1;/);
    assert.equal(await readFile(local.NGINX_HOSTS_FILE, 'utf8'), localHosts);
    assert.ok(await readFile(sourcePath, 'utf8') === localText, 'Source env must be preserved');
    const keys = Object.keys(local).filter(key => key.startsWith('DB_PASSWORD_'));
    assert.equal(keys.length, 5);
    for (const key of keys) assert.ok(local[key] === https[key], key + ' must be preserved');
    assert.notEqual(configure('--local', '--from=.env', '--output=.env.https').status, 0);

    const legacy = localText.replace(/^NGINX_HOSTS_FILE=.*\n/m, '');
    await writeFile(join(dir, '.env.legacy'), legacy);
    assert.equal(configure('--local', '--from=.env.legacy', '--output=.env.upgraded').status, 0);
    const upgraded = parseEnv(await readFile(join(dir, '.env.upgraded'), 'utf8'));
    assert.match(await readFile(upgraded.NGINX_HOSTS_FILE, 'utf8'), /"localhost" 1;/);
    for (const key of keys) assert.ok(local[key] === upgraded[key], key + ' must survive env upgrade');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function validApi() {
  return {
    NODE_ENV: 'production', SERVE_WEB: 'true', AGENT_CLOUD_EXECUTION_ENABLED: 'false',
    GIGA_LOCAL_HTTP: 'true', COOKIE_SECURE: 'false', COOKIE_SAME_SITE: 'lax',
    ALLOWED_ORIGINS: 'http://localhost:8080', DB_HOST: 'postgres', DB_NAME: 'giga',
    DB_PASSWORD_API: randomBytes(32).toString('hex'),
    CHAT_ENABLED: 'false',
  };
}

function validMigration() {
  return {
    NODE_ENV: 'production', DB_HOST: 'postgres', DB_NAME: 'giga',
    DB_PASSWORD_MIGRATION: randomBytes(32).toString('hex'),
  };
}

test('Docker API guard configures runtime with unprivileged login and external migration mode', () => {
  const env = configureEnvironment(validApi());
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.MIGRATION_MODE, 'external');
  assert.equal(new URL(env.DATABASE_URL).username, 'giga_runtime');
  assert.equal(env.MIGRATION_DATABASE_URL, undefined);
  assert.equal(env.AGENT_LIFECYCLE_FINALIZER_DATABASE_URL, undefined);
});

test('Docker API guard rejects privileged credentials and invalid runtime password', () => {
  const missing = validApi();
  delete missing.DB_PASSWORD_API;
  assert.throws(() => configureEnvironment(missing));

  const malformed = validApi();
  malformed.DB_PASSWORD_API = 'not-a-valid-hex-password';
  assert.throws(() => configureEnvironment(malformed));

  for (const key of ['DB_PASSWORD_MIGRATION', 'DB_PASSWORD_LIFECYCLE', 'DB_PASSWORD_QUOTA',
                     'MIGRATION_DATABASE_URL', 'AGENT_LIFECYCLE_FINALIZER_DATABASE_URL']) {
    const env = validApi();
    env[key] = randomBytes(32).toString('hex');
    assert.throws(() => configureEnvironment(env), /forbidden in the API container/);
  }
});

test('Docker migration guard configures dedicated migration login and rejects non-migration credentials', () => {
  const env = configureMigrationEnvironment(validMigration());
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(new URL(env.MIGRATION_DATABASE_URL).username, 'giga_migration');
  assert.equal(env.MIGRATION_MODE, 'auto');

  const missing = validMigration();
  delete missing.DB_PASSWORD_MIGRATION;
  assert.throws(() => configureMigrationEnvironment(missing));

  for (const key of ['DB_PASSWORD_API', 'DB_PASSWORD_LIFECYCLE', 'DB_PASSWORD_QUOTA',
                     'DATABASE_URL', 'AGENT_LIFECYCLE_FINALIZER_DATABASE_URL']) {
    const injected = validMigration();
    injected[key] = randomBytes(32).toString('hex');
    assert.throws(() => configureMigrationEnvironment(injected), /forbidden in the migration container/);
  }
});

test('Docker guard rejects cloud credentials and execution enable switches', () => {
  for (const extra of [
    { AGENT_CLOUD_EXECUTION_ENABLED: 'true' }, { E2B_API_KEY: 'fixture-only' },
    { AGENT_RUNTIME_ENABLED: 'true' }, { AGENT_API_TOKEN: 'fixture-only' },
  ]) assert.throws(() => configureEnvironment({ ...validApi(), ...extra }));
});

test('Docker guard refuses public HTTP and insecure production-like cookies', () => {
  for (const extra of [
    { ALLOWED_ORIGINS: 'http://example.invalid:8080' }, { ALLOWED_ORIGINS: '*' },
    { NODE_ENV: 'development' }, { GIGA_LOCAL_HTTP: 'false' }, { COOKIE_SAME_SITE: 'none' },
  ]) assert.throws(() => configureEnvironment({ ...validApi(), ...extra }));
  assert.doesNotThrow(() => configureEnvironment({
    ...validApi(), GIGA_LOCAL_HTTP: 'false', COOKIE_SECURE: 'true', ALLOWED_ORIGINS: 'https://giga.example.invalid',
  }));
  assert.throws(() => configureEnvironment({
    ...validApi(), GIGA_LOCAL_HTTP: 'false', COOKIE_SECURE: 'true', ALLOWED_ORIGINS: 'https://giga.example.invalid:9443',
  }));
});
