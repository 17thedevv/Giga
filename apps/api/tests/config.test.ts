import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePort, parseSameSite, loadConfig, DEFAULT_PORT } from '../src/app/config.js';

describe('PORT configuration and fail-fast validation', () => {
  it('keeps web hosting opt-in and rejects malformed configuration', () => {
    assert.strictEqual(loadConfig({}).serveWeb, false);
    assert.strictEqual(loadConfig({ SERVE_WEB: 'false' }).serveWeb, false);
    assert.strictEqual(loadConfig({ SERVE_WEB: 'true' }).serveWeb, true);
    assert.throws(() => loadConfig({ SERVE_WEB: 'yes' }), /SERVE_WEB must be true or false/);
  });
  it('returns default port 3000 when PORT is undefined', () => {
    assert.strictEqual(parsePort(undefined), DEFAULT_PORT);
  });

  it('returns default port 3000 when PORT is empty or whitespace only', () => {
    assert.strictEqual(parsePort(''), DEFAULT_PORT);
    assert.strictEqual(parsePort('   '), DEFAULT_PORT);
  });

  it('parses valid port numbers correctly', () => {
    assert.strictEqual(parsePort('8080'), 8080);
    assert.strictEqual(parsePort('1'), 1);
    assert.strictEqual(parsePort('65535'), 65535);
    assert.strictEqual(parsePort(' 4000 '), 4000);
  });

  it('fails fast on non-numeric strings', () => {
    assert.throws(
      () => parsePort('abc'),
      /Invalid PORT configuration: "abc"/
    );
    assert.throws(
      () => parsePort('3000abc'),
      /Invalid PORT configuration: "3000abc"/
    );
  });

  it('fails fast on floating point numbers', () => {
    assert.throws(
      () => parsePort('3000.5'),
      /Invalid PORT configuration: "3000.5"/
    );
  });

  it('fails fast on out-of-range port numbers', () => {
    assert.throws(
      () => parsePort('0'),
      /Invalid PORT configuration: "0"/
    );
    assert.throws(
      () => parsePort('-1'),
      /Invalid PORT configuration: "-1"/
    );
    assert.throws(
      () => parsePort('65536'),
      /Invalid PORT configuration: "65536"/
    );
    assert.throws(
      () => parsePort('99999'),
      /Invalid PORT configuration: "99999"/
    );
  });

  it('loadConfig extracts PORT from environment dictionary', () => {
    const config = loadConfig({ PORT: '5000' });
    assert.strictEqual(config.port, 5000);

    const defaultConfig = loadConfig({});
    assert.strictEqual(defaultConfig.port, DEFAULT_PORT);
    assert.strictEqual(defaultConfig.nodeEnv, 'development');
    assert.strictEqual(defaultConfig.cookieSecure, false);
    assert.strictEqual(defaultConfig.cookieSameSite, 'lax');
  });

  it('loadConfig propagates fail-fast validation error from environment', () => {
    assert.throws(
      () => loadConfig({ PORT: 'not-a-port' }),
      /Invalid PORT configuration/
    );
  });

  it('loadConfig requires distinct runtime and migration database roles in production mode', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production' }),
      /DATABASE_URL environment variable is required in production mode/
    );
    assert.throws(
      () => loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://api_user:pass@localhost:5432/db',
        ALLOWED_ORIGINS: 'https://giga.local',
        CHAT_ENABLED: 'false',
      }),
      /MIGRATION_DATABASE_URL is required in production mode/
    );
    assert.throws(
      () => loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://api_user:pass@localhost:5432/db',
        MIGRATION_DATABASE_URL: 'postgres://migration_user:pass@localhost:5432/db',
        ALLOWED_ORIGINS: 'https://giga.local',
        CHAT_ENABLED: 'false',
      }),
      /AGENT_LIFECYCLE_FINALIZER_DATABASE_URL is required in production mode/
    );
    assert.throws(
      () => loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://same_user:pass@localhost:5432/db',
        MIGRATION_DATABASE_URL: 'postgres://same_user:other@localhost:5432/db',
        AGENT_LIFECYCLE_FINALIZER_DATABASE_URL: 'postgres://lifecycle_user:pass@localhost:5432/db',
        ALLOWED_ORIGINS: 'https://giga.local',
        CHAT_ENABLED: 'false',
      }),
      /must use distinct database login roles/
    );

    assert.throws(
      () => loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://api_user:pass@localhost:5432/db',
        MIGRATION_DATABASE_URL: 'postgres://migration_user:pass@localhost:5432/db',
        AGENT_LIFECYCLE_FINALIZER_DATABASE_URL: 'postgres://api_user:other@localhost:5432/db',
        ALLOWED_ORIGINS: 'https://giga.local',
        CHAT_ENABLED: 'false',
      }),
      /must use distinct database login roles/
    );

    assert.throws(
      () => loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://api_user:pass@localhost:5432/db',
        MIGRATION_DATABASE_URL: 'postgres://migration_user:pass@localhost:5432/db',
        AGENT_LIFECYCLE_FINALIZER_DATABASE_URL: 'postgres://lifecycle_user:pass@localhost:5432/other',
        ALLOWED_ORIGINS: 'https://giga.local',
        CHAT_ENABLED: 'false',
      }),
      /must target the same database/
    );

    const prodConfig = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://api_user:pass@localhost:5432/db',
      MIGRATION_DATABASE_URL: 'postgres://migration_user:pass@localhost:5432/db',
      AGENT_LIFECYCLE_FINALIZER_DATABASE_URL: 'postgres://lifecycle_user:pass@localhost:5432/db',
      ALLOWED_ORIGINS: 'https://giga.local',
      CHAT_ENABLED: 'false',
    });
    assert.strictEqual(prodConfig.nodeEnv, 'production');
    assert.strictEqual(prodConfig.migrationDatabaseUrl, 'postgres://migration_user:pass@localhost:5432/db');
    assert.strictEqual(prodConfig.agentLifecycleFinalizerDatabaseUrl,
      'postgres://lifecycle_user:pass@localhost:5432/db');
    assert.strictEqual(prodConfig.cookieSecure, true);
    assert.deepStrictEqual(prodConfig.allowedOrigins, ['https://giga.local']);
  });

  it('parseSameSite handles valid values and rejects invalid', () => {
    assert.strictEqual(parseSameSite(undefined), 'lax');
    assert.strictEqual(parseSameSite('strict'), 'strict');
    assert.strictEqual(parseSameSite('none'), 'none');
    assert.strictEqual(parseSameSite('LAX'), 'lax');
    assert.throws(
      () => parseSameSite('invalid'),
      /Invalid COOKIE_SAME_SITE configuration/
    );
  });
});
