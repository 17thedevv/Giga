import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePort, loadConfig, DEFAULT_PORT } from '../src/app/config.js';

describe('PORT configuration and fail-fast validation', () => {
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
  });

  it('loadConfig propagates fail-fast validation error from environment', () => {
    assert.throws(
      () => loadConfig({ PORT: 'not-a-port' }),
      /Invalid PORT configuration/
    );
  });
});
