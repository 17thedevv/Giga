import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import {
  E2bCloudSandboxProviderClient,
  E2bProviderError,
  MockE2bTransport,
  validateE2bConfig,
  loadE2bConfigFromEnv,
  boundCombinedOutput,
  createRealE2bTransport,
  type E2bSdkSeam,
} from '../../src/modules/agent/e2b-provider.js';
import {
  IsolatedCloudSandboxAdapter,
  type CloudSandboxProviderClient,
} from '../../src/modules/agent/sandbox-adapter.js';
import {
  DeterministicFakeExecutionRuntime,
  type ValidatedToolCall,
} from '../../src/modules/agent/execution-runtime.js';
import { getAgentCapabilities } from '../../src/modules/agent/capabilities.js';
import { agentCapabilitiesSchema } from '../../../../packages/contracts/agent.js';
import { AgentOrchestrator } from '../../src/modules/agent/orchestrator.js';
import { createDefaultToolRegistry } from '../../src/modules/agent/tool-registry.js';
import type { AgentRepository } from '../../src/modules/agent/repository.js';
import type { AgentDecisionProvider } from '../../src/modules/agent/decision-provider.js';
import type { ToolRisk } from '../../src/modules/agent/types.js';

describe('E2B Cloud Sandbox Provider Client (17T-69)', () => {
  const dummyOwnerId = randomUUID();
  const dummyWorkspaceId = randomUUID();
  const dummyRunId = randomUUID();

  function makeToolCall(
    toolName: string,
    risk: ToolRisk,
    args: Record<string, unknown>
  ): ValidatedToolCall {
    return {
      toolCallId: `call-${randomUUID().slice(0, 8)}`,
      toolName,
      risk,
      args,
    };
  }

  // 1. Feature Gate Disabled Tests
  describe('1. Feature gate disabled → không dispatch', () => {
    it('createSandbox fails closed when enabled is false or omitted', async () => {
      const transport = new MockE2bTransport();
      const client = new E2bCloudSandboxProviderClient({
        enabled: false,
        apiKey: 'e2b_test_dummy_key_12345',
        transport,
      });

      assert.equal(client.isEnabled, false);
      assert.equal(client.isConfigured, false);

      await assert.rejects(
        async () => {
          await client.createSandbox({
            workspaceId: dummyWorkspaceId,
            ownerId: dummyOwnerId,
            timeoutMs: 30_000,
            networkPolicy: { egressEnabled: false, allowlist: [] },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof E2bProviderError);
          assert.equal(err.code, 'FEATURE_GATE_DISABLED');
          return true;
        }
      );

      // Verify transport was NEVER called
      assert.equal(transport.createdCount, 0);
    });

    it('executeCommand fails closed when enabled is false', async () => {
      const client = new E2bCloudSandboxProviderClient({
        enabled: false,
        apiKey: 'e2b_test_key_123',
      });

      await assert.rejects(
        async () => {
          await client.executeCommand('sbx-dummy', { command: 'echo hello' });
        },
        (err: unknown) => {
          assert.ok(err instanceof E2bProviderError);
          assert.equal(err.code, 'FEATURE_GATE_DISABLED');
          return true;
        }
      );
    });

    it('loadE2bConfigFromEnv defaults to disabled even if E2B_API_KEY is present', () => {
      const configWithKeyOnly = loadE2bConfigFromEnv({
        E2B_API_KEY: 'e2b_some_secret_key',
      });
      assert.equal(configWithKeyOnly.enabled, false);

      const configExplicitlyEnabled = loadE2bConfigFromEnv({
        E2B_API_KEY: 'e2b_some_secret_key',
        GIGA_AGENT_E2B_ENABLED: 'true',
      });
      assert.equal(configExplicitlyEnabled.enabled, true);
      assert.equal(configExplicitlyEnabled.apiKey, 'e2b_some_secret_key');
    });

    it('IsolatedCloudSandboxAdapter with disabled E2B provider fails prepare closed with RUNTIME_UNAVAILABLE', async () => {
      const e2bClient = new E2bCloudSandboxProviderClient({
        enabled: false,
        apiKey: 'e2b_test_key',
      });

      const adapter = new IsolatedCloudSandboxAdapter({
        providerClient: e2bClient,
      });

      const ac = new AbortController();
      const prep = await adapter.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Do not run',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });

      assert.equal(prep.available, false);
      if (!prep.available) {
        assert.equal(prep.code, 'RUNTIME_UNAVAILABLE');
        assert.match(prep.reason ?? '', /disabled by feature gate/i);
      }
    });
  });

  // 2. Missing API Key Tests
  describe('2. Missing API key → fail closed', () => {
    it('fails closed when enabled is true but apiKey is missing or empty', async () => {
      const transport = new MockE2bTransport();

      for (const badKey of [undefined, '', '   ']) {
        const client = new E2bCloudSandboxProviderClient({
          enabled: true,
          apiKey: badKey,
          transport,
        });

        assert.equal(client.isConfigured, false);

        await assert.rejects(
          async () => {
            await client.createSandbox({
              workspaceId: dummyWorkspaceId,
              ownerId: dummyOwnerId,
              timeoutMs: 30_000,
              networkPolicy: { egressEnabled: true, allowlist: [] },
            });
          },
          (err: unknown) => {
            assert.ok(err instanceof E2bProviderError);
            assert.equal(err.code, 'MISSING_API_KEY');
            return true;
          }
        );

        assert.equal(transport.createdCount, 0);
      }
    });
  });

  // 3. Invalid Configuration Tests
  describe('3. Invalid provider configuration → fail closed', () => {
    it('fails closed on newline characters in apiKey', () => {
      const res = validateE2bConfig({
        enabled: true,
        apiKey: 'e2b_test\nkey_with_newline',
      });
      assert.equal(res.valid, false);
      if (!res.valid) {
        assert.equal(res.code, 'INVALID_CONFIG');
      }
    });

    it('fails closed on non-positive defaultTimeoutMs', () => {
      for (const badTimeout of [-100, 0, NaN, Infinity]) {
        const res = validateE2bConfig({
          enabled: true,
          apiKey: 'e2b_valid_key_123',
          defaultTimeoutMs: badTimeout,
        });
        assert.equal(res.valid, false);
        if (!res.valid) {
          assert.equal(res.code, 'INVALID_CONFIG');
        }
      }
    });

    it('fails closed on invalid maxOutputBytes', () => {
      for (const badBytes of [-1, 0, NaN]) {
        const res = validateE2bConfig({
          enabled: true,
          apiKey: 'e2b_valid_key_123',
          maxOutputBytes: badBytes,
        });
        assert.equal(res.valid, false);
        if (!res.valid) {
          assert.equal(res.code, 'INVALID_CONFIG');
        }
      }
    });

    it('fails closed on invalid template name containing disallowed characters', () => {
      const res = validateE2bConfig({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        template: '<script>alert(1)</script>',
      });
      assert.equal(res.valid, false);
      if (!res.valid) {
        assert.equal(res.code, 'INVALID_CONFIG');
      }
    });

    it('fails closed on plain HTTP or unapproved endpoint domains (Blocker 3)', () => {
      // Insecure plain HTTP must be rejected with SECURITY_VIOLATION
      const httpRes = validateE2bConfig({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        domain: 'http://api.e2b.dev',
      });
      assert.equal(httpRes.valid, false);
      if (!httpRes.valid) {
        assert.equal(httpRes.code, 'SECURITY_VIOLATION');
        assert.match(httpRes.reason, /HTTPS is strictly required/i);
      }

      // Arbitrary untrusted domain must be rejected with SECURITY_VIOLATION
      for (const untrusted of ['https://evil.com', 'https://attacker.org', 'https://internal.corp']) {
        const untrustedRes = validateE2bConfig({
          enabled: true,
          apiKey: 'e2b_valid_key_123',
          domain: untrusted,
        });
        assert.equal(untrustedRes.valid, false);
        if (!untrustedRes.valid) {
          assert.equal(untrustedRes.code, 'SECURITY_VIOLATION');
          assert.match(untrustedRes.reason, /Unapproved E2B endpoint host/i);
        }
      }

      // Malformed URL must be rejected with INVALID_CONFIG
      const malformedRes = validateE2bConfig({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        domain: 'not a valid url at all',
      });
      assert.equal(malformedRes.valid, false);
      if (!malformedRes.valid) {
        assert.equal(malformedRes.code, 'INVALID_CONFIG');
      }

      // Approved *.e2b.dev HTTPS endpoints must pass
      const approved1 = validateE2bConfig({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        domain: 'https://api.e2b.dev',
      });
      assert.equal(approved1.valid, true);

      const approved2 = validateE2bConfig({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        domain: 'https://dedicated-cluster.e2b.dev',
      });
      assert.equal(approved2.valid, true);
    });

    it('fails closed when networkIsolationGuaranteed is true but networkIsolationProof is missing (Blocker 3)', () => {
      const res = validateE2bConfig({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: true,
        // networkIsolationProof missing!
      });
      assert.equal(res.valid, false);
      if (!res.valid) {
        assert.equal(res.code, 'INVALID_CONFIG');
        assert.match(res.reason, /networkIsolationProof/i);
      }
    });
  });

  // 4. Missing Network / Isolation Guarantee Tests
  describe('4. Missing network/isolation guarantee → fail closed', () => {
    it('loadE2bConfigFromEnv does not trust raw boolean without auditable VPC proof (Blocker 3)', () => {
      // Raw boolean alone must not satisfy isolation guarantee
      const cfgRawBool = loadE2bConfigFromEnv({
        GIGA_AGENT_E2B_ENABLED: 'true',
        E2B_API_KEY: 'e2b_key',
        E2B_NETWORK_ISOLATION_GUARANTEED: 'true',
      });
      assert.equal(cfgRawBool.networkIsolationGuaranteed, false);
      assert.equal(cfgRawBool.networkIsolationProof, undefined);

      // Auditable VPC gateway ID + verified firewall flag satisfies proof
      const cfgVerified = loadE2bConfigFromEnv({
        GIGA_AGENT_E2B_ENABLED: 'true',
        E2B_API_KEY: 'e2b_key',
        E2B_VPC_GATEWAY_ID: 'vpc-gw-ap-southeast-1',
        E2B_EGRESS_FIREWALL_VERIFIED: 'true',
      });
      assert.equal(cfgVerified.networkIsolationGuaranteed, true);
      assert.equal(cfgVerified.networkIsolationProof, 'vpc-gw-ap-southeast-1');
    });
    it('fails closed when egressEnabled is false and networkIsolationGuaranteed is not true', async () => {
      const transport = new MockE2bTransport();
      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: false, // Provider cannot guarantee egress isolation!
        transport,
      });

      await assert.rejects(
        async () => {
          await client.createSandbox({
            workspaceId: dummyWorkspaceId,
            ownerId: dummyOwnerId,
            timeoutMs: 30_000,
            networkPolicy: { egressEnabled: false, allowlist: [] }, // Deny egress requested
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof E2bProviderError);
          assert.equal(err.code, 'NETWORK_ISOLATION_UNSUPPORTED');
          assert.match(err.message, /enterprise VPC \/ custom isolation guarantee/);
          return true;
        }
      );

      assert.equal(transport.createdCount, 0);
    });

    it('fails closed when allowlist is specified and networkIsolationGuaranteed is not true', async () => {
      const transport = new MockE2bTransport();
      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: false,
        transport,
      });

      await assert.rejects(
        async () => {
          await client.createSandbox({
            workspaceId: dummyWorkspaceId,
            ownerId: dummyOwnerId,
            timeoutMs: 30_000,
            networkPolicy: { egressEnabled: true, allowlist: ['github.com'] },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof E2bProviderError);
          assert.equal(err.code, 'NETWORK_ISOLATION_UNSUPPORTED');
          return true;
        }
      );
    });

    it('succeeds when networkIsolationGuaranteed is true', async () => {
      const transport = new MockE2bTransport();
      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-proof-verified',
        transport,
      });

      const res = await client.createSandbox({
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        timeoutMs: 30_000,
        networkPolicy: { egressEnabled: false, allowlist: [] },
      });

      assert.ok(res.sandboxId);
      assert.equal(transport.createdCount, 1);
    });
  });

  // 5. Invariant INV-07: No Host Shell Fallback Tests
  describe('5. Strict Invariant: No host-shell fallback (INV-07)', () => {
    it('never calls child_process on provider creation, execution, timeout, or failure', async () => {
      let childProcessCalled = false;
      const originalExec = childProcess.exec;
      const originalSpawn = childProcess.spawn;
      const originalExecSync = childProcess.execSync;

      // Wrap childProcess methods with detection
      (childProcess as Record<string, unknown>).exec = () => {
        childProcessCalled = true;
        throw new Error('INV-07 VIOLATION: child_process.exec called');
      };
      (childProcess as Record<string, unknown>).spawn = () => {
        childProcessCalled = true;
        throw new Error('INV-07 VIOLATION: child_process.spawn called');
      };
      (childProcess as Record<string, unknown>).execSync = () => {
        childProcessCalled = true;
        throw new Error('INV-07 VIOLATION: child_process.execSync called');
      };

      try {
        const transport = new MockE2bTransport();
        const client = new E2bCloudSandboxProviderClient({
          enabled: true,
          apiKey: 'e2b_valid_key_123',
          networkIsolationGuaranteed: true,
          networkIsolationProof: 'vpc-gw-proof-verified',
          transport,
        });

        const { sandboxId } = await client.createSandbox({
          workspaceId: dummyWorkspaceId,
          ownerId: dummyOwnerId,
          timeoutMs: 30_000,
          networkPolicy: { egressEnabled: true, allowlist: [] },
        });

        await client.executeCommand(sandboxId, { command: 'npm test' });
        await client.executeCommand(sandboxId, { command: 'fail-command' });
        await client.destroySandbox(sandboxId);

        // Verify childProcess was NEVER touched
        assert.equal(childProcessCalled, false);
      } finally {
        (childProcess as Record<string, unknown>).exec = originalExec;
        (childProcess as Record<string, unknown>).spawn = originalSpawn;
        (childProcess as Record<string, unknown>).execSync = originalExecSync;
      }
    });
  });

  // 6. Create Session Lifecycle Tests
  describe('6. Create session lifecycle', () => {
    it('creates session, passes metadata, and tracks active status', async () => {
      const transport = new MockE2bTransport();
      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        template: 'custom-node-20',
        domain: 'https://api.e2b.dev',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-proof-verified',
        transport,
      });

      const { sandboxId, endpoint } = await client.createSandbox({
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        timeoutMs: 45_000,
        env: { GIGA_SANDBOX: '1' },
        networkPolicy: { egressEnabled: true, allowlist: [] },
      });

      assert.ok(sandboxId.startsWith('e2b-sbx-'));
      assert.equal(endpoint, 'https://api.e2b.dev');
      assert.equal(transport.createdCount, 1);
      assert.equal(transport.lastCreateOptions?.template, 'custom-node-20');
      assert.equal(transport.lastCreateOptions?.metadata?.workspaceId, dummyWorkspaceId);
      assert.equal(transport.lastCreateOptions?.metadata?.ownerId, dummyOwnerId);
      assert.equal(transport.lastCreateOptions?.envs?.GIGA_SANDBOX, '1');

      assert.equal(client.getSandboxStatus(sandboxId), 'active');
      assert.equal(client.activeSandboxCount, 1);
    });
  });

  // 7. Execute Mocked Command Tests
  describe('7. Execute mocked command', () => {
    it('executes command and returns bounded exit code, stdout, stderr and duration', async () => {
      const transport = new MockE2bTransport();
      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-proof-verified',
        transport,
      });

      const { sandboxId } = await client.createSandbox({
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        timeoutMs: 30_000,
        networkPolicy: { egressEnabled: true, allowlist: [] },
      });

      const successResult = await client.executeCommand(sandboxId, {
        command: 'echo "hello from e2b"',
      });

      assert.equal(successResult.exitCode, 0);
      assert.match(successResult.stdout, /Mock E2B executed: echo "hello from e2b"/);
      assert.equal(successResult.stderr, '');
      assert.ok(successResult.durationMs >= 0);

      const failResult = await client.executeCommand(sandboxId, {
        command: 'fail-command',
      });

      assert.equal(failResult.exitCode, 1);
      assert.equal(failResult.stderr, 'Command failed with exit code 1');
    });
  });

  // 8. Read / Write / List Files Tests
  describe('8. Read/write/list mocked files', () => {
    it('performs isolated file operations and prevents path traversal', async () => {
      const transport = new MockE2bTransport();
      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-proof-verified',
        transport,
      });

      const { sandboxId } = await client.createSandbox({
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        timeoutMs: 30_000,
        networkPolicy: { egressEnabled: true, allowlist: [] },
      });

      // Write file
      const fileContent = 'export const add = (a, b) => a + b;';
      const expectedBytes = Buffer.byteLength(fileContent, 'utf8');
      const writeRes = await client.writeFile(sandboxId, 'src/math.ts', fileContent);
      assert.equal(writeRes.bytesWritten, expectedBytes);

      // Read file
      const readRes = await client.readFile(sandboxId, 'src/math.ts');
      assert.equal(readRes.content, fileContent);
      assert.equal(readRes.bytes, expectedBytes);

      // List files
      const fileList = await client.listFiles(sandboxId);
      assert.equal(fileList.length, 1);
      assert.equal(fileList[0]?.path, 'src/math.ts');
      assert.equal(fileList[0]?.size, expectedBytes);

      // Path traversal attempts must be rejected with SECURITY_VIOLATION before transport
      for (const badPath of ['../../etc/passwd', '/etc/shadow', 'C:\\boot.ini', 'src/..\0.txt']) {
        await assert.rejects(
          async () => {
            await client.readFile(sandboxId, badPath);
          },
          (err: unknown) => {
            assert.ok(err instanceof E2bProviderError);
            assert.equal(err.code, 'SECURITY_VIOLATION');
            return true;
          }
        );

        await assert.rejects(
          async () => {
            await client.writeFile(sandboxId, badPath, 'evil');
          },
          (err: unknown) => {
            assert.ok(err instanceof E2bProviderError);
            assert.equal(err.code, 'SECURITY_VIOLATION');
            return true;
          }
        );
      }
    });

    it('captures immutable snapshot with exact file hashes', async () => {
      const transport = new MockE2bTransport();
      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-proof-verified',
        transport,
      });

      const { sandboxId } = await client.createSandbox({
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        timeoutMs: 30_000,
        networkPolicy: { egressEnabled: true, allowlist: [] },
      });

      await client.writeFile(sandboxId, 'a.txt', 'alpha');
      await client.writeFile(sandboxId, 'b.txt', 'beta');

      const snapshot = await client.createSnapshot(sandboxId);
      assert.equal(snapshot.files.length, 2);
      assert.equal(snapshot.files[0]?.path, 'a.txt');
      assert.ok(snapshot.files[0]?.sha256);
      assert.equal(snapshot.files[1]?.path, 'b.txt');
      assert.ok(snapshot.files[1]?.sha256);
    });
  });

  // 9. Stop / Cancel Tests
  describe('9. Stop/cancel', () => {
    it('aborts in-flight execution when signal is aborted', async () => {
      const transport = new MockE2bTransport();
      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-proof-verified',
        transport,
      });

      const { sandboxId } = await client.createSandbox({
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        timeoutMs: 30_000,
        networkPolicy: { egressEnabled: true, allowlist: [] },
      });

      const ac = new AbortController();
      ac.abort();

      await assert.rejects(
        async () => {
          await client.executeCommand(sandboxId, {
            command: 'sleep 10',
            signal: ac.signal,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof E2bProviderError);
          assert.equal(err.code, 'EXECUTION_ABORTED');
          return true;
        }
      );
    });
  });

  // 10. Destroy Tests
  describe('10. Destroy', () => {
    it('kills sandbox and removes from active registry', async () => {
      const transport = new MockE2bTransport();
      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-proof-verified',
        transport,
      });

      const { sandboxId } = await client.createSandbox({
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        timeoutMs: 30_000,
        networkPolicy: { egressEnabled: true, allowlist: [] },
      });

      assert.equal(client.activeSandboxCount, 1);
      await client.destroySandbox(sandboxId);

      assert.equal(transport.killedCount, 1);
      assert.equal(client.activeSandboxCount, 0);
      assert.equal(client.getSandboxStatus(sandboxId), 'destroyed');

      // Subsequent calls on destroyed sandbox fail closed with SANDBOX_NOT_FOUND
      await assert.rejects(
        async () => {
          await client.executeCommand(sandboxId, { command: 'ls' });
        },
        (err: unknown) => {
          assert.ok(err instanceof E2bProviderError);
          assert.equal(err.code, 'SANDBOX_NOT_FOUND');
          return true;
        }
      );
    });
  });

  // 11. Duplicate Destroy Idempotency Tests
  describe('11. Duplicate destroy idempotency', () => {
    it('safely handles repeated destroySandbox calls without error or duplicate transport kills', async () => {
      const transport = new MockE2bTransport();
      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-proof-verified',
        transport,
      });

      const { sandboxId } = await client.createSandbox({
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        timeoutMs: 30_000,
        networkPolicy: { egressEnabled: true, allowlist: [] },
      });

      // Call destroy 3 times sequentially
      await client.destroySandbox(sandboxId);
      await client.destroySandbox(sandboxId);
      await client.destroySandbox(sandboxId);

      // Transport kill was called exactly once
      assert.equal(transport.killedCount, 1);
      assert.equal(client.activeSandboxCount, 0);
    });

    it('failed destroy retains sandbox entry and status so retry can successfully destroy without false success (Blocker 2)', async () => {
      const transport = new MockE2bTransport();
      transport.failKillAttempts = 1; // First kill will fail with simulated network error

      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-proof-verified',
        transport,
      });

      const { sandboxId } = await client.createSandbox({
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        timeoutMs: 30_000,
        networkPolicy: { egressEnabled: true, allowlist: [] },
      });

      assert.equal(client.activeSandboxCount, 1);
      assert.equal(client.getSandboxStatus(sandboxId), 'active');

      // Attempt 1: fails
      await assert.rejects(
        async () => {
          await client.destroySandbox(sandboxId);
        },
        (err: unknown) => {
          assert.ok(err instanceof E2bProviderError);
          assert.equal(err.code, 'PROVIDER_ERROR');
          assert.match(err.message, /Failed to destroy E2B sandbox/i);
          return true;
        }
      );

      // Invariant: sandbox was NOT marked destroyed, NOT removed from registry!
      assert.equal(client.activeSandboxCount, 1);
      assert.equal(client.getSandboxStatus(sandboxId), 'active');
      assert.equal(transport.killedCount, 0);

      // Attempt 2 (Retry): succeeds!
      await client.destroySandbox(sandboxId);

      assert.equal(transport.killedCount, 1);
      assert.equal(client.activeSandboxCount, 0);
      assert.equal(client.getSandboxStatus(sandboxId), 'destroyed');

      // Subsequent call is idempotent
      await client.destroySandbox(sandboxId);
      assert.equal(transport.killedCount, 1);
    });
  });

  // 12. Timeout Tests
  describe('12. Timeout', () => {
    it('throws EXECUTION_TIMEOUT when command exceeds effective timeout', async () => {
      const transport = new MockE2bTransport();
      transport.simulateTimeoutMs = 50; // Delay longer than timeoutMs

      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-proof-verified',
        defaultTimeoutMs: 20,
        transport,
      });

      const { sandboxId } = await client.createSandbox({
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        timeoutMs: 30_000,
        networkPolicy: { egressEnabled: true, allowlist: [] },
      });

      await assert.rejects(
        async () => {
          await client.executeCommand(sandboxId, {
            command: 'slow-command',
            timeoutMs: 20,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof E2bProviderError);
          assert.equal(err.code, 'EXECUTION_TIMEOUT');
          return true;
        }
      );
    });
  });

  // 13. Abort Tests
  describe('13. Abort', () => {
    it('aborts allocation when signal is aborted before createSandbox completes', async () => {
      const transport = new MockE2bTransport();
      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-proof-verified',
        transport,
      });

      const ac = new AbortController();
      ac.abort();

      await assert.rejects(
        async () => {
          await client.createSandbox({
            workspaceId: dummyWorkspaceId,
            ownerId: dummyOwnerId,
            timeoutMs: 30_000,
            networkPolicy: { egressEnabled: true, allowlist: [] },
            signal: ac.signal,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof E2bProviderError);
          assert.equal(err.code, 'EXECUTION_ABORTED');
          return true;
        }
      );

      assert.equal(transport.createdCount, 0);
    });
  });

  // 14. Provider Disconnect Tests
  describe('14. Provider disconnect', () => {
    it('fails closed with PROVIDER_ERROR when provider connection is lost', async () => {
      const transport = new MockE2bTransport();
      transport.simulateDisconnect = true;

      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-proof-verified',
        transport,
      });

      await assert.rejects(
        async () => {
          await client.createSandbox({
            workspaceId: dummyWorkspaceId,
            ownerId: dummyOwnerId,
            timeoutMs: 30_000,
            networkPolicy: { egressEnabled: true, allowlist: [] },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof E2bProviderError);
          assert.equal(err.code, 'PROVIDER_ERROR');
          assert.match(err.message, /Connection reset/);
          return true;
        }
      );
    });
  });

  // 15. Late Response Fencing Tests
  describe('15. Late response fencing', () => {
    it('late provider execution after adapter timeout does not mutate verification evidence', async () => {
      const transport = new MockE2bTransport();
      transport.simulateLateCompletionMs = 80;

      const e2bClient = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-proof-verified',
        defaultTimeoutMs: 25,
        transport,
      });

      const adapter = new IsolatedCloudSandboxAdapter({
        providerClient: e2bClient,
        defaultTimeoutMs: 25,
      });

      const ac = new AbortController();
      const prep = await adapter.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Late fencing test',
        modelId: 'giga-agent-default',
        signal: ac.signal,
        timeoutMs: 25,
      });

      assert.equal(prep.available, true);
      if (!prep.available) return;

      const invokeRes = await adapter.invoke(
        prep.sessionId,
        makeToolCall('run_build', 'sandbox_execute', {}),
        ac.signal
      );

      assert.equal(invokeRes.success, false);
      assert.equal(invokeRes.errorCode, 'TIMEOUT');

      // Wait for late response to arrive
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Evidence must NOT have recorded a passed build from late RPC!
      const evidence = await adapter.getVerificationEvidence(prep.sessionId);
      const passedChecks = evidence.filter((c) => c.outcome === 'passed');
      assert.equal(passedChecks.length, 0);
    });
  });

  // 16. Lease Expiration Fencing Tests
  describe('16. Lease expiration fencing', () => {
    it('orchestrator rejects run progression when worker lease expires', async () => {
      const fakeRun = {
        id: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        task: 'Lease test',
        mode: 'execute' as const,
        status: 'running' as const,
        runtime: 'cloud' as const,
        modelId: 'giga-agent-default',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Mock repository with lease expiration on renew
      const mockRepo: Partial<AgentRepository> = {
        async claimRun() {
          return {
            run: fakeRun,
            workerId: 'worker-1',
            leaseToken: 'token-123',
            attemptCount: 1,
            leaseExpiresAt: new Date(Date.now() + 100).toISOString(),
          };
        },
        async renewLease() {
          return false; // Stale worker! Lease expired!
        },
        async listSteps() {
          return [];
        },
        async getConversationContext() {
          return { messages: [], totalBytes: 0, isTruncated: false };
        },
        async releaseLease() {},
        async finalizeRun() {
          return {
            run: { ...fakeRun, status: 'failed' },
            event: {
              sequence: 1,
              type: 'run.failed',
              data: { runId: fakeRun.id, code: 'WORKER_LEASE_EXPIRED', message: 'Worker lease expired' },
            },
          };
        },
      };

      const mockDecisionProvider: AgentDecisionProvider = {
        async decide() {
          return { kind: 'complete', summary: 'Done' };
        },
      };

      const orchestrator = new AgentOrchestrator(
        mockRepo as AgentRepository,
        createDefaultToolRegistry(),
        mockDecisionProvider,
        new DeterministicFakeExecutionRuntime(),
        { leaseDurationMs: 100 }
      );

      const outcome = await orchestrator.executeRun(dummyOwnerId, dummyRunId);
      assert.equal(outcome.status, 'fenced');
      if (outcome.status === 'fenced') {
        assert.match(outcome.reason, /lease/i);
      }
    });
  });

  // 17. Output Truncation & Bounds Tests
  describe('17. Output truncation/bounds', () => {
    it('strictly truncates output exceeding maxOutputBytes with truncation marker', async () => {
      const transport = new MockE2bTransport();
      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-proof-verified',
        maxOutputBytes: 80, // Very small byte bound
        transport,
      });

      const { sandboxId } = await client.createSandbox({
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        timeoutMs: 30_000,
        networkPolicy: { egressEnabled: true, allowlist: [] },
      });

      // Write and read large content
      await client.writeFile(sandboxId, 'large.txt', 'X'.repeat(500));
      const readRes = await client.readFile(sandboxId, 'large.txt');

      assert.ok(readRes.content.includes('[OUTPUT_TRUNCATED]'));
      assert.ok(readRes.bytes <= 80);
      assert.ok(Buffer.byteLength(readRes.content, 'utf8') <= 80);
    });

    it('enforces one shared UTF-8 byte budget across both stdout and stderr combined in executeCommand (Blocker 4)', async () => {
      const transport = new MockE2bTransport();
      // Configure mock transport to return huge stdout (40 KiB) and huge stderr (40 KiB)
      transport.createSandbox = async (opts) => {
        const handle = await MockE2bTransport.prototype.createSandbox.call(transport, opts);
        handle.commands.run = async () => ({
          exitCode: 0,
          stdout: 'A'.repeat(40_000),
          stderr: 'B'.repeat(40_000),
        });
        return handle;
      };

      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-proof-verified',
        maxOutputBytes: 1024, // 1 KiB combined budget
        transport,
      });

      const { sandboxId } = await client.createSandbox({
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        timeoutMs: 30_000,
        networkPolicy: { egressEnabled: true, allowlist: [] },
      });

      const res = await client.executeCommand(sandboxId, { command: 'heavy-output' });

      const stdoutBytes = Buffer.byteLength(res.stdout, 'utf8');
      const stderrBytes = Buffer.byteLength(res.stderr, 'utf8');
      const combinedBytes = stdoutBytes + stderrBytes;

      assert.ok(
        combinedBytes <= 1024,
        `Expected combined output <= 1024 bytes, got ${combinedBytes} (stdout=${stdoutBytes}, stderr=${stderrBytes})`
      );
      assert.ok(res.stdout.includes('[OUTPUT_TRUNCATED]'));
      assert.ok(res.stderr.includes('[OUTPUT_TRUNCATED]'));
    });

    it('boundCombinedOutput allocates shared budget fairly and redacts secrets after truncation (Blocker 4)', () => {
      // 1. Both large: evenly bounded, sum <= 200
      const bothLarge = boundCombinedOutput('S'.repeat(500), 'E'.repeat(500), 200);
      assert.ok(Buffer.byteLength(bothLarge.stdout, 'utf8') + Buffer.byteLength(bothLarge.stderr, 'utf8') <= 200);
      assert.ok(bothLarge.stdout.includes('[OUTPUT_TRUNCATED]'));
      assert.ok(bothLarge.stderr.includes('[OUTPUT_TRUNCATED]'));

      // 2. Small stdout, large stderr: stdout preserved, stderr gets remainder
      const smallStdout = boundCombinedOutput('Short stdout line', 'E'.repeat(1000), 200);
      assert.equal(smallStdout.stdout, 'Short stdout line');
      assert.ok(smallStdout.stderr.includes('[OUTPUT_TRUNCATED]'));
      assert.ok(Buffer.byteLength(smallStdout.stdout, 'utf8') + Buffer.byteLength(smallStdout.stderr, 'utf8') <= 200);

      // 3. Large stdout, small stderr: stderr preserved, stdout gets remainder
      const smallStderr = boundCombinedOutput('S'.repeat(1000), 'Short error line', 200);
      assert.equal(smallStderr.stderr, 'Short error line');
      assert.ok(smallStderr.stdout.includes('[OUTPUT_TRUNCATED]'));
      assert.ok(Buffer.byteLength(smallStderr.stdout, 'utf8') + Buffer.byteLength(smallStderr.stderr, 'utf8') <= 200);

      // 4. Redaction preserved with Bearer token and e2b_ key in truncated output
      const sensitiveOutput = boundCombinedOutput(
        'Secret Authorization: Bearer abcdef1234567890abcdef ' + 'X'.repeat(500),
        'Token e2b_9876543210fedcba ' + 'Y'.repeat(500),
        250
      );
      assert.ok(!sensitiveOutput.stdout.includes('abcdef1234567890abcdef'));
      assert.ok(!sensitiveOutput.stderr.includes('9876543210fedcba'));
      assert.ok(sensitiveOutput.stdout.includes('[REDACTED]'));
      assert.ok(sensitiveOutput.stderr.includes('[REDACTED_KEY]'));
      assert.ok(
        Buffer.byteLength(sensitiveOutput.stdout, 'utf8') + Buffer.byteLength(sensitiveOutput.stderr, 'utf8') <= 250
      );
    });
  });

  // 18. Secret Redaction Tests
  describe('18. Secret redaction', () => {
    it('redacts E2B API keys, Bearer tokens, and sensitive env variables in outputs and errors', async () => {
      const transport = new MockE2bTransport();
      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_1234567890abcdef',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-proof-verified',
        transport,
      });

      const { sandboxId } = await client.createSandbox({
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        timeoutMs: 30_000,
        networkPolicy: { egressEnabled: true, allowlist: [] },
      });

      // Write content containing sensitive tokens
      await client.writeFile(
        sandboxId,
        'config.log',
        'Authorization: Bearer my-secret-jwt-token\ne2b_key=e2b_secret123456789\npassword=SuperSecretPassword123'
      );

      const readRes = await client.readFile(sandboxId, 'config.log');
      assert.equal(readRes.content.includes('my-secret-jwt-token'), false);
      assert.equal(readRes.content.includes('e2b_secret123456789'), false);
      assert.equal(readRes.content.includes('SuperSecretPassword123'), false);
      assert.ok(readRes.content.includes('[REDACTED]'));
    });
  });

  // 19. Public DTO Hygiene Tests
  describe('19. Public DTO không có provider secret/lease token', () => {
    it('capabilities discovery response contains no provider secrets or credentials and reflects disabled runtime', () => {
      const caps = getAgentCapabilities();
      const parsed = agentCapabilitiesSchema.parse(caps);

      // cloudRuntime must be strictly disabled
      assert.equal(parsed.capabilities.cloudRuntime.available, false);
      assert.equal(parsed.capabilities.runExecution.available, false);

      const jsonStr = JSON.stringify(caps);
      assert.equal(jsonStr.includes('e2b'), false);
      assert.equal(jsonStr.includes('apiKey'), false);
      assert.equal(jsonStr.includes('leaseToken'), false);
      assert.equal(jsonStr.includes('workerId'), false);
    });
  });

  // 20. Cross-Owner Access Denial Tests
  describe('20. Cross-owner access denial', () => {
    it('rejects attempt to pass sensitive environment variables into E2B sandbox', async () => {
      const transport = new MockE2bTransport();
      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-proof-verified',
        transport,
      });

      for (const forbiddenKey of ['DATABASE_URL', 'JWT_SECRET', 'GEMINI_API_KEY', 'GITHUB_TOKEN']) {
        await assert.rejects(
          async () => {
            await client.createSandbox({
              workspaceId: dummyWorkspaceId,
              ownerId: dummyOwnerId,
              timeoutMs: 30_000,
              env: { [forbiddenKey]: 'secret-value' },
              networkPolicy: { egressEnabled: true, allowlist: [] },
            });
          },
          (err: unknown) => {
            assert.ok(err instanceof E2bProviderError);
            assert.equal(err.code, 'SECURITY_VIOLATION');
            return true;
          }
        );
      }
    });

    it('rejects duplicate prepare on active session with mismatched tenant or mode', async () => {
      const transport = new MockE2bTransport();
      const e2bClient = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-proof-verified',
        transport,
      });

      const adapter = new IsolatedCloudSandboxAdapter({
        providerClient: e2bClient,
      });

      const ac = new AbortController();
      const prep1 = await adapter.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Owner A task',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });

      assert.equal(prep1.available, true);

      // Attempt prepare from attacker Owner B with same runId
      const attackerOwnerId = randomUUID();
      const prepAttacker = await adapter.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: attackerOwnerId,
        mode: 'execute',
        task: 'Owner B hijacking attempt',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });

      assert.equal(prepAttacker.available, false);
      if (!prepAttacker.available) {
        assert.equal(prepAttacker.code, 'TENANT_MISMATCH');
      }
    });
  });

  // 21. Adapter Signature / SDK Drift Detection Tests
  describe('21. Adapter signature/SDK drift detection', () => {
    it('verifies E2bCloudSandboxProviderClient strictly satisfies CloudSandboxProviderClient interface', () => {
      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_test_key',
        transport: new MockE2bTransport(),
      });

      // Typecheck: Assign to CloudSandboxProviderClient
      const providerClient: CloudSandboxProviderClient = client;

      assert.equal(providerClient.providerName, 'e2b');
      assert.equal(typeof providerClient.createSandbox, 'function');
      assert.equal(typeof providerClient.executeCommand, 'function');
      assert.equal(typeof providerClient.readFile, 'function');
      assert.equal(typeof providerClient.writeFile, 'function');
      assert.equal(typeof providerClient.listFiles, 'function');
      assert.equal(typeof providerClient.createSnapshot, 'function');
      assert.equal(typeof providerClient.destroySandbox, 'function');
    });
  });

  // 22. Real E2B SDK Transport Mapping Tests (Blocker 1)
  describe('22. Real E2B SDK transport mapping (Blocker 1)', () => {
    it('createRealE2bTransport correctly maps lifecycle, commands, files, and kill to injected SDK seam', async () => {
      let createdTemplate: string | undefined;
      let createdOpts: any;
      let commandRunArgs: { cmd: string; opts?: any } | undefined;
      let fileReadPath: string | undefined;
      let fileWriteArgs: { path: string; data: string } | undefined;
      let fileListPath: string | undefined;
      let killCalled = false;

      const mockSdkInstance = {
        sandboxId: 'e2b-real-sdk-sbx-999',
        commands: {
          async run(cmd: string, opts?: any) {
            commandRunArgs = { cmd, opts };
            return {
              exitCode: 0,
              stdout: 'SDK stdout result',
              stderr: '',
              error: undefined,
            };
          },
        },
        files: {
          async read(path: string) {
            fileReadPath = path;
            return 'SDK file content from MicroVM';
          },
          async write(path: string, data: string) {
            fileWriteArgs = { path, data };
          },
          async list(path: string) {
            fileListPath = path;
            return [
              { name: 'app.ts', path: 'src/app.ts', type: 'file', size: 120 },
              { name: 'assets', path: 'assets', type: 'directory' },
            ];
          },
        },
        async kill() {
          killCalled = true;
        },
      };

      const mockSdkSeam: E2bSdkSeam = {
        Sandbox: {
          async create(template?: string, opts?: any) {
            createdTemplate = template;
            createdOpts = opts;
            return mockSdkInstance;
          },
        },
      };

      const transport = createRealE2bTransport(mockSdkSeam);
      const handle = await transport.createSandbox({
        apiKey: 'e2b_5555555555555555',
        template: 'custom-node-22',
        domain: 'https://dedicated.e2b.dev',
        timeoutMs: 45_000,
        envs: { FOO: 'bar' },
        metadata: { workspaceId: dummyWorkspaceId, ownerId: dummyOwnerId },
      });

      assert.equal(handle.sandboxId, 'e2b-real-sdk-sbx-999');
      assert.equal(createdTemplate, 'custom-node-22');
      assert.equal(createdOpts.apiKey, 'e2b_5555555555555555');
      assert.equal(createdOpts.domain, 'https://dedicated.e2b.dev');
      assert.equal(createdOpts.timeoutMs, 45_000);
      assert.deepEqual(createdOpts.envs, { FOO: 'bar' });
      assert.deepEqual(createdOpts.metadata, { workspaceId: dummyWorkspaceId, ownerId: dummyOwnerId });

      // Run command mapping
      const cmdResult = await handle.commands.run('npm test', { cwd: '/app', envs: { CI: 'true' } });
      assert.equal(cmdResult.exitCode, 0);
      assert.equal(cmdResult.stdout, 'SDK stdout result');
      assert.equal(commandRunArgs?.cmd, 'npm test');
      assert.equal(commandRunArgs?.opts?.cwd, '/app');
      assert.deepEqual(commandRunArgs?.opts?.envs, { CI: 'true' });

      // File operations mapping
      const readContent = await handle.files.read('src/app.ts');
      assert.equal(readContent, 'SDK file content from MicroVM');
      assert.equal(fileReadPath, 'src/app.ts');

      await handle.files.write('output.json', '{"status":"ok"}');
      assert.deepEqual(fileWriteArgs, { path: 'output.json', data: '{"status":"ok"}' });

      const entries = await handle.files.list('src');
      assert.equal(fileListPath, 'src');
      assert.equal(entries.length, 2);
      assert.equal(entries[0]?.name, 'app.ts');

      // Kill mapping
      assert.equal(handle.isOpen?.(), true);
      await handle.kill();
      assert.equal(killCalled, true);
      assert.equal(handle.isOpen?.(), false);
    });

    it('E2bCloudSandboxProviderClient defaults to createRealE2bTransport when transport is omitted', async () => {
      // Create client with transport omitted
      const client = new E2bCloudSandboxProviderClient({
        enabled: true,
        apiKey: 'e2b_valid_key_123',
        networkIsolationGuaranteed: true,
        networkIsolationProof: 'vpc-gw-test-001',
        // transport: undefined -> defaults to createRealE2bTransport()
      });

      assert.equal(client.isEnabled, true);
      assert.equal(client.isConfigured, true);
      assert.equal(client.providerName, 'e2b');
    });
  });
});
