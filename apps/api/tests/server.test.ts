import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { startServer } from '../src/app/server.js';
import type { HealthResponse } from '../src/app/create-app.js';

describe('Server network socket lifecycle', () => {
  it('starts HTTP server on network port and handles request', async () => {
    // Port 0 tells the OS to assign an available ephemeral port
    const server = startServer(0);

    try {
      await new Promise<void>((resolve) => {
        if (server.listening) {
          resolve();
        } else {
          server.once('listening', resolve);
        }
      });

      const address = server.address() as AddressInfo;
      assert.ok(address && typeof address.port === 'number');

      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      assert.strictEqual(response.status, 200);

      const data = (await response.json()) as HealthResponse;
      assert.strictEqual(data.status, 'ok');
      assert.strictEqual(data.service, 'giga-api');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });
});
