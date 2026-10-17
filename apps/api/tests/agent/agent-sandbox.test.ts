import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  DeterministicFakeExecutionRuntime,
  UnavailableExecutionRuntime,
  type ValidatedToolCall,
} from '../../src/modules/agent/execution-runtime.js';
import {
  IsolatedCloudSandboxAdapter,
  SimulatedCloudSandboxProviderClient,
  sanitizeSandboxOutput,
} from '../../src/modules/agent/sandbox-adapter.js';
import { createDefaultToolRegistry, isSafeRelativePath } from '../../src/modules/agent/tool-registry.js';
import type { ToolRisk } from '../../src/modules/agent/types.js';

describe('GigaAgent Isolated Sandbox Adapter & Cloud Security Gate (17T-47)', () => {
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

  describe('1. Standardized ExecutionRuntime Interface & Lifecycle', () => {
    it('initializes session with active status, metadata, and isolated environment', async () => {
      const runtime = new DeterministicFakeExecutionRuntime();
      const ac = new AbortController();

      const prep = await runtime.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Build test app',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });

      assert.equal(prep.available, true);
      if (!prep.available) return;

      const session = await runtime.getSession?.(prep.sessionId);
      assert.ok(session);
      assert.equal(session.active, true);
      assert.equal(session.runId, dummyRunId);
      assert.equal(session.workspaceId, dummyWorkspaceId);
      assert.equal(session.ownerId, dummyOwnerId);
      assert.equal(session.mode, 'execute');

      // Secret Fencing: Environment must contain only safe identifiers, never host secrets
      const env = runtime.getEnvironment(prep.sessionId);
      assert.ok(env);
      assert.equal(env.get('GIGA_SANDBOX'), '1');
      assert.equal(env.get('GIGA_WORKSPACE_ID'), dummyWorkspaceId);
      assert.equal(env.get('GIGA_RUN_ID'), dummyRunId);
      assert.equal(env.has('DATABASE_URL'), false);
      assert.equal(env.has('JWT_SECRET'), false);
    });

    it('captures immutable snapshot with exact file sizes and SHA-256 digests', async () => {
      const runtime = new DeterministicFakeExecutionRuntime({
        initialFiles: {
          'package.json': '{"name": "test-app"}',
          'src/index.ts': 'console.log("hello world");',
        },
      });
      const ac = new AbortController();

      const prep = await runtime.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Snapshot test',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });
      assert.equal(prep.available, true);
      if (!prep.available) return;

      const snapshot = await runtime.createSnapshot(prep.sessionId);
      assert.equal(snapshot.sessionId, prep.sessionId);
      assert.equal(snapshot.workspaceId, dummyWorkspaceId);
      assert.equal(snapshot.fileCount, 2);
      assert.equal(snapshot.files.length, 2);

      const pkgFile = snapshot.files.find((f) => f.path === 'package.json');
      assert.ok(pkgFile);
      assert.equal(pkgFile.size, Buffer.byteLength('{"name": "test-app"}', 'utf8'));
      assert.ok(pkgFile.sha256);
      assert.equal(pkgFile.sha256.length, 64); // SHA-256 hex string

      // Modifying a file results in an updated snapshot digest
      await runtime.invoke(
        prep.sessionId,
        makeToolCall('write_file', 'sandbox_write', {
          path: 'package.json',
          content: '{"name": "modified-app"}',
        }),
        ac.signal
      );

      const snapshot2 = await runtime.createSnapshot(prep.sessionId);
      const pkgFile2 = snapshot2.files.find((f) => f.path === 'package.json');
      assert.notEqual(pkgFile?.sha256, pkgFile2?.sha256);
    });

    it('stop marks session inactive; subsequent invocations fail-closed with SESSION_NOT_FOUND', async () => {
      const runtime = new DeterministicFakeExecutionRuntime();
      const ac = new AbortController();

      const prep = await runtime.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Lifecycle test',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });
      assert.equal(prep.available, true);
      if (!prep.available) return;

      await runtime.stop(prep.sessionId);

      const session = await runtime.getSession?.(prep.sessionId);
      assert.equal(session?.active, false);

      const result = await runtime.invoke(
        prep.sessionId,
        makeToolCall('read_file', 'read', { path: 'src/index.ts' }),
        ac.signal
      );

      assert.equal(result.success, false);
      assert.equal(result.errorCode, 'SESSION_NOT_FOUND');
    });

    it('cleanup frees resources safely without throwing', async () => {
      const runtime = new DeterministicFakeExecutionRuntime();
      const ac = new AbortController();

      const prep = await runtime.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Cleanup test',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });
      assert.equal(prep.available, true);
      if (!prep.available) return;

      await runtime.cleanup(prep.sessionId);
      const session = await runtime.getSession?.(prep.sessionId);
      assert.equal(session?.active, false);
    });
  });

  describe('2. Server-side Mode Security Gate (Ask / Plan / Execute)', () => {
    it('Ask mode: permits read tools but denies write and execution tools at adapter boundary', async () => {
      const runtime = new DeterministicFakeExecutionRuntime({
        initialFiles: { 'README.md': '# Welcome' },
      });
      const ac = new AbortController();

      const prep = await runtime.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'ask',
        task: 'Can I write files?',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });
      assert.equal(prep.available, true);
      if (!prep.available) return;

      // Read tools succeed in Ask mode
      const readRes = await runtime.invoke(
        prep.sessionId,
        makeToolCall('read_file', 'read', { path: 'README.md' }),
        ac.signal
      );
      assert.equal(readRes.success, true);

      const listRes = await runtime.invoke(
        prep.sessionId,
        makeToolCall('list_files', 'read', {}),
        ac.signal
      );
      assert.equal(listRes.success, true);

      // Write and Execute tools fail-closed with POLICY_VIOLATION
      const writeRes = await runtime.invoke(
        prep.sessionId,
        makeToolCall('write_file', 'sandbox_write', { path: 'pwn.sh', content: 'rm -rf /' }),
        ac.signal
      );
      assert.equal(writeRes.success, false);
      assert.equal(writeRes.errorCode, 'POLICY_VIOLATION');

      const editRes = await runtime.invoke(
        prep.sessionId,
        makeToolCall('edit_file', 'sandbox_write', { path: 'README.md', find: 'Welcome', replace: 'Hacked' }),
        ac.signal
      );
      assert.equal(editRes.success, false);
      assert.equal(editRes.errorCode, 'POLICY_VIOLATION');

      const buildRes = await runtime.invoke(
        prep.sessionId,
        makeToolCall('run_build', 'sandbox_execute', {}),
        ac.signal
      );
      assert.equal(buildRes.success, false);
      assert.equal(buildRes.errorCode, 'POLICY_VIOLATION');

      const testRes = await runtime.invoke(
        prep.sessionId,
        makeToolCall('run_tests', 'sandbox_execute', {}),
        ac.signal
      );
      assert.equal(testRes.success, false);
      assert.equal(testRes.errorCode, 'POLICY_VIOLATION');

      const cmdRes = await runtime.invoke(
        prep.sessionId,
        makeToolCall('run_command', 'sandbox_execute', { command: 'whoami' }),
        ac.signal
      );
      assert.equal(cmdRes.success, false);
      assert.equal(cmdRes.errorCode, 'POLICY_VIOLATION');
    });

    it('Plan mode: permits read tools but denies write and execution tools at adapter boundary', async () => {
      const runtime = new DeterministicFakeExecutionRuntime({
        initialFiles: { 'src/index.ts': 'export const x = 1;' },
      });
      const ac = new AbortController();

      const prep = await runtime.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'plan',
        task: 'Plan implementation steps',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });
      assert.equal(prep.available, true);
      if (!prep.available) return;

      // Read tools succeed in Plan mode
      const readRes = await runtime.invoke(
        prep.sessionId,
        makeToolCall('read_file', 'read', { path: 'src/index.ts' }),
        ac.signal
      );
      assert.equal(readRes.success, true);

      // Writes and execution tools fail-closed with POLICY_VIOLATION
      const writeRes = await runtime.invoke(
        prep.sessionId,
        makeToolCall('write_file', 'sandbox_write', { path: 'src/new.ts', content: 'export const y = 2;' }),
        ac.signal
      );
      assert.equal(writeRes.success, false);
      assert.equal(writeRes.errorCode, 'POLICY_VIOLATION');

      const buildRes = await runtime.invoke(
        prep.sessionId,
        makeToolCall('run_build', 'sandbox_execute', {}),
        ac.signal
      );
      assert.equal(buildRes.success, false);
      assert.equal(buildRes.errorCode, 'POLICY_VIOLATION');
    });

    it('Execute mode: permits read, write, and sandbox execution tools', async () => {
      const runtime = new DeterministicFakeExecutionRuntime();
      const ac = new AbortController();

      const prep = await runtime.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Build and verify app',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });
      assert.equal(prep.available, true);
      if (!prep.available) return;

      const writeRes = await runtime.invoke(
        prep.sessionId,
        makeToolCall('write_file', 'sandbox_write', { path: 'src/app.ts', content: 'export const ok = true;' }),
        ac.signal
      );
      assert.equal(writeRes.success, true);

      const readRes = await runtime.invoke(
        prep.sessionId,
        makeToolCall('read_file', 'read', { path: 'src/app.ts' }),
        ac.signal
      );
      assert.equal(readRes.success, true);

      const buildRes = await runtime.invoke(
        prep.sessionId,
        makeToolCall('run_build', 'sandbox_execute', {}),
        ac.signal
      );
      assert.equal(buildRes.success, true);

      const testRes = await runtime.invoke(
        prep.sessionId,
        makeToolCall('run_tests', 'sandbox_execute', {}),
        ac.signal
      );
      assert.equal(testRes.success, true);
    });
  });

  describe('3. Strict Invariant: No Host Shell Execution (INV-07)', () => {
    it('run_command in fake runtime executes strictly in-memory without spawning child processes', async () => {
      let commandExecuted = false;
      const runtime = new DeterministicFakeExecutionRuntime({
        customCommandRunner: (cmd) => {
          commandExecuted = true;
          return { exitCode: 0, stdout: `Executed: ${cmd}`, stderr: '' };
        },
      });
      const ac = new AbortController();

      const prep = await runtime.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Run build command',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });
      assert.equal(prep.available, true);
      if (!prep.available) return;

      const res = await runtime.invoke(
        prep.sessionId,
        makeToolCall('run_command', 'sandbox_execute', { command: 'tsc --noEmit' }),
        ac.signal
      );

      assert.equal(res.success, true);
      assert.equal(commandExecuted, true);
      assert.match(String(res.output.stdout), /Executed: tsc --noEmit/);
    });

    it('ToolRegistry validates run_command arguments and limits length to 512 chars', () => {
      const registry = createDefaultToolRegistry();

      // Valid command
      const valid = registry.validate('run_command', { command: 'npm test' }, 'execute');
      assert.equal(valid.valid, true);

      // Oversized command (> 512 chars) rejected
      const oversized = registry.validate(
        'run_command',
        { command: 'echo ' + 'a'.repeat(512) },
        'execute'
      );
      assert.equal(oversized.valid, false);
      if (!oversized.valid) {
        assert.equal(oversized.errorCode, 'INVALID_ARGUMENTS');
      }

      // Empty command rejected
      const empty = registry.validate('run_command', { command: '   ' }, 'execute');
      assert.equal(empty.valid, false);
    });
  });

  describe('4. Path Traversal & Host Boundary Escape Prevention', () => {
    it('isSafeRelativePath rejects traversal, absolute paths, null bytes, and Windows drive letters', () => {
      // Safe relative paths
      assert.equal(isSafeRelativePath('src/index.ts'), true);
      assert.equal(isSafeRelativePath('package.json'), true);
      assert.equal(isSafeRelativePath('deep/nested/folder/file.txt'), true);

      // Path traversal attacks
      assert.equal(isSafeRelativePath('../etc/passwd'), false);
      assert.equal(isSafeRelativePath('../../secret.env'), false);
      assert.equal(isSafeRelativePath('src/../../etc/passwd'), false);
      assert.equal(isSafeRelativePath('foo/../bar'), false);

      // Absolute paths
      assert.equal(isSafeRelativePath('/etc/shadow'), false);
      assert.equal(isSafeRelativePath('/var/run/docker.sock'), false);
      assert.equal(isSafeRelativePath('C:\\Windows\\System32\\cmd.exe'), false);
      assert.equal(isSafeRelativePath('D:/secrets.txt'), false);

      // UNC paths
      assert.equal(isSafeRelativePath('\\\\10.0.0.1\\share\\file'), false);

      // Null byte injection
      assert.equal(isSafeRelativePath('src/index.ts\0.js'), false);
      assert.equal(isSafeRelativePath('\0/etc/passwd'), false);

      // Empty or whitespace
      assert.equal(isSafeRelativePath(''), false);
      assert.equal(isSafeRelativePath('   '), false);
    });

    it('runtime adapter rejects path traversal attempts with SECURITY_VIOLATION before fs access', async () => {
      const runtime = new DeterministicFakeExecutionRuntime();
      const ac = new AbortController();

      const prep = await runtime.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Security test',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });
      assert.equal(prep.available, true);
      if (!prep.available) return;

      const maliciousPaths = [
        '../../etc/passwd',
        '/var/run/docker.sock',
        'C:\\Windows\\System32\\config\\SAM',
        '\\\\192.168.1.1\\loot\\exploit',
        'src/file.ts\0.exe',
      ];

      for (const badPath of maliciousPaths) {
        const res = await runtime.invoke(
          prep.sessionId,
          makeToolCall('read_file', 'read', { path: badPath }),
          ac.signal
        );
        assert.equal(res.success, false, `Expected path '${badPath}' to fail`);
        assert.equal(res.errorCode, 'SECURITY_VIOLATION', `Expected SECURITY_VIOLATION for '${badPath}'`);
      }
    });
  });

  describe('5. Tenant Isolation & Lease Fencing', () => {
    it('assertTenantAccess verifies caller owner and workspace match session', async () => {
      const runtime = new DeterministicFakeExecutionRuntime();
      const ac = new AbortController();

      const prep = await runtime.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Tenant test',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });
      assert.equal(prep.available, true);
      if (!prep.available) return;

      // Legitimate tenant matches
      assert.equal(runtime.assertTenantAccess(prep.sessionId, dummyOwnerId, dummyWorkspaceId), true);

      // Attacker with different ownerId is rejected
      const attackerOwnerId = randomUUID();
      assert.equal(runtime.assertTenantAccess(prep.sessionId, attackerOwnerId, dummyWorkspaceId), false);

      // Attacker with different workspaceId is rejected
      const otherWorkspaceId = randomUUID();
      assert.equal(runtime.assertTenantAccess(prep.sessionId, dummyOwnerId, otherWorkspaceId), false);
    });
  });

  describe('6. Timeout & Cancellation Handling', () => {
    it('aborts execution when signal is already aborted', async () => {
      const runtime = new DeterministicFakeExecutionRuntime();
      const ac = new AbortController();
      ac.abort();

      const prep = await runtime.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Abort test',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });

      assert.equal(prep.available, false);
      if (!prep.available) {
        assert.equal(prep.code, 'RUNTIME_UNAVAILABLE');
      }
    });

    it('returns TIMEOUT when tool latency exceeds configured timeoutMs', async () => {
      const runtime = new DeterministicFakeExecutionRuntime({
        simulatedLatencyMs: 100,
        defaultTimeoutMs: 20, // Timeout is shorter than simulated latency
      });
      const ac = new AbortController();

      const prep = await runtime.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Timeout test',
        modelId: 'giga-agent-default',
        signal: ac.signal,
        timeoutMs: 20,
      });
      assert.equal(prep.available, true);
      if (!prep.available) return;

      const res = await runtime.invoke(
        prep.sessionId,
        makeToolCall('list_files', 'read', {}),
        ac.signal
      );

      assert.equal(res.success, false);
      assert.equal(res.errorCode, 'TIMEOUT');
    });
  });

  describe('7. Fail-Closed Behavior & Unavailable Runtimes', () => {
    it('UnavailableExecutionRuntime cleanly returns RUNTIME_UNAVAILABLE without crashing', async () => {
      const runtime = new UnavailableExecutionRuntime();

      const prep = await runtime.prepare();
      assert.equal(prep.available, false);
      assert.equal(prep.code, 'RUNTIME_UNAVAILABLE');

      const res = await runtime.invoke();
      assert.equal(res.success, false);
      assert.equal(res.errorCode, 'RUNTIME_UNAVAILABLE');

      const evidence = await runtime.getVerificationEvidence();
      assert.deepEqual(evidence, []);

      const snapshot = await runtime.createSnapshot('dummy-session');
      assert.equal(snapshot.fileCount, 0);
      assert.deepEqual(snapshot.files, []);

      await runtime.stop();
      await runtime.cleanup();
      const session = await runtime.getSession?.();
      assert.equal(session, undefined);
    });

    it('IsolatedCloudSandboxAdapter without provider client returns RUNTIME_UNAVAILABLE', async () => {
      const adapter = new IsolatedCloudSandboxAdapter(); // No provider client
      const ac = new AbortController();

      assert.equal(adapter.isConfigured, false);

      const prep = await adapter.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Unconfigured cloud test',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });

      assert.equal(prep.available, false);
      assert.equal(prep.code, 'RUNTIME_UNAVAILABLE');
    });
  });

  describe('8. Isolated Cloud Sandbox Adapter with Simulated Remote MicroVM', () => {
    it('runs end-to-end sandbox lifecycle: create -> write -> read -> build -> test -> snapshot -> destroy', async () => {
      const providerClient = new SimulatedCloudSandboxProviderClient();
      const adapter = new IsolatedCloudSandboxAdapter({
        providerClient,
        defaultTimeoutMs: 10_000,
      });
      const ac = new AbortController();

      assert.equal(adapter.isConfigured, true);
      assert.equal(adapter.providerName, 'simulated-cloud-microvm');

      // 1. Prepare sandbox session
      const prep = await adapter.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Cloud sandbox E2E',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });

      assert.equal(prep.available, true);
      if (!prep.available) return;

      assert.equal(providerClient.getSandboxCount(), 1);

      // Secret Fencing: Remote sandbox received only scoped workspace environment
      assert.ok(providerClient.lastReceivedEnv);
      assert.equal(providerClient.lastReceivedEnv.GIGA_SANDBOX, '1');
      assert.equal(providerClient.lastReceivedEnv.GIGA_WORKSPACE_ID, dummyWorkspaceId);
      assert.equal(providerClient.lastReceivedEnv.GIGA_RUN_ID, dummyRunId);
      assert.equal(providerClient.lastReceivedEnv.DATABASE_URL, undefined);
      assert.equal(providerClient.lastReceivedEnv.JWT_SECRET, undefined);

      // 2. Write file into remote sandbox
      const writeRes = await adapter.invoke(
        prep.sessionId,
        makeToolCall('write_file', 'sandbox_write', {
          path: 'src/index.ts',
          content: 'export const hello = "world";',
        }),
        ac.signal
      );
      assert.equal(writeRes.success, true);

      // 3. Read file from remote sandbox
      const readRes = await adapter.invoke(
        prep.sessionId,
        makeToolCall('read_file', 'read', { path: 'src/index.ts' }),
        ac.signal
      );
      assert.equal(readRes.success, true);
      assert.equal(readRes.output.content, 'export const hello = "world";');

      // 4. Run build in remote sandbox
      const buildRes = await adapter.invoke(
        prep.sessionId,
        makeToolCall('run_build', 'sandbox_execute', {}),
        ac.signal
      );
      assert.equal(buildRes.success, true);

      // 5. Run tests in remote sandbox
      const testRes = await adapter.invoke(
        prep.sessionId,
        makeToolCall('run_tests', 'sandbox_execute', {}),
        ac.signal
      );
      assert.equal(testRes.success, true);

      // 6. Verification evidence captured
      const evidence = await adapter.getVerificationEvidence(prep.sessionId);
      assert.equal(evidence.length, 2);
      assert.equal(evidence[0]?.name, 'run_build');
      assert.equal(evidence[0]?.outcome, 'passed');
      assert.equal(evidence[1]?.name, 'run_tests');
      assert.equal(evidence[1]?.outcome, 'passed');

      // 7. Snapshot remote sandbox
      const snapshot = await adapter.createSnapshot(prep.sessionId);
      assert.equal(snapshot.fileCount, 1);
      assert.equal(snapshot.files[0]?.path, 'src/index.ts');
      assert.ok(snapshot.files[0]?.sha256);

      // 8. Stop & destroy remote sandbox
      await adapter.stop(prep.sessionId);
      assert.equal(providerClient.getSandboxCount(), 0);

      const postStop = await adapter.invoke(
        prep.sessionId,
        makeToolCall('read_file', 'read', { path: 'src/index.ts' }),
        ac.signal
      );
      assert.equal(postStop.success, false);
      assert.equal(postStop.errorCode, 'SESSION_NOT_FOUND');
    });

    it('cloud build failure records failed check and returns BUILD_FAILED', async () => {
      const providerClient = new SimulatedCloudSandboxProviderClient();
      providerClient.simulateBuildFailure = true;

      const adapter = new IsolatedCloudSandboxAdapter({ providerClient });
      const ac = new AbortController();

      const prep = await adapter.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Cloud build failure test',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });
      assert.equal(prep.available, true);
      if (!prep.available) return;

      const buildRes = await adapter.invoke(
        prep.sessionId,
        makeToolCall('run_build', 'sandbox_execute', {}),
        ac.signal
      );

      assert.equal(buildRes.success, false);
      assert.equal(buildRes.errorCode, 'BUILD_FAILED');

      const evidence = await adapter.getVerificationEvidence(prep.sessionId);
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0]?.outcome, 'failed');
    });

    it('cloud remote timeout cleanly produces TIMEOUT error code', async () => {
      const providerClient = new SimulatedCloudSandboxProviderClient();
      providerClient.simulateTimeout = true;

      const adapter = new IsolatedCloudSandboxAdapter({ providerClient });
      const ac = new AbortController();

      const prep = await adapter.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Cloud timeout test',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });
      assert.equal(prep.available, true);
      if (!prep.available) return;

      const res = await adapter.invoke(
        prep.sessionId,
        makeToolCall('run_command', 'sandbox_execute', { command: 'slow-task' }),
        ac.signal
      );

      assert.equal(res.success, false);
      assert.equal(res.errorCode, 'TIMEOUT');
    });

    it('cloud adapter output truncation caps stdout/stderr at maxOutputBytes (64 KiB)', async () => {
      const providerClient = new SimulatedCloudSandboxProviderClient();
      const adapter = new IsolatedCloudSandboxAdapter({
        providerClient,
        maxOutputBytes: 100, // Small limit for testing truncation
      });
      const ac = new AbortController();

      const prep = await adapter.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Truncation test',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });
      assert.equal(prep.available, true);
      if (!prep.available) return;

      // Write a large file
      await adapter.invoke(
        prep.sessionId,
        makeToolCall('write_file', 'sandbox_write', {
          path: 'large.txt',
          content: 'A'.repeat(500),
        }),
        ac.signal
      );

      // Read the large file - content should be truncated
      const readRes = await adapter.invoke(
        prep.sessionId,
        makeToolCall('read_file', 'read', { path: 'large.txt' }),
        ac.signal
      );

      assert.equal(readRes.success, true);
      const content = String(readRes.output.content);
      assert.ok(content.includes('[OUTPUT_TRUNCATED]'));
      assert.ok(content.length <= 150);
    });

    it('sanitizeSandboxOutput redacts unquoted tokens, Bearer auth, and structured JSON without leaking secrets', () => {
      // 1. Unquoted key assignment: api_key=...
      const res1 = sanitizeSandboxOutput('api_key=OpaqueSecret12345678', 1000);
      assert.equal(res1, 'api_key=[REDACTED]');
      assert.equal(res1.includes('OpaqueSecret12345678'), false);

      // 2. Unquoted key with colon: token: ...
      const res2 = sanitizeSandboxOutput('token: ReallySecretToken987654', 1000);
      assert.equal(res2, 'token: [REDACTED]');
      assert.equal(res2.includes('ReallySecretToken987654'), false);

      // 3. Standalone Bearer auth
      const res3 = sanitizeSandboxOutput('Bearer abcdefghijklmnop', 1000);
      assert.equal(res3, 'Bearer [REDACTED]');
      assert.equal(res3.includes('abcdefghijklmnop'), false);

      // 4. Structured JSON object
      const jsonInput = JSON.stringify({
        apiKey: 'super-secret-key-12345',
        databaseUrl: 'postgres://user:mypassword@localhost:5432/db',
        headers: { 'X-API-Key': 'HeaderSecretValue999' },
      });
      const res4 = sanitizeSandboxOutput(jsonInput, 1000);
      assert.equal(res4.includes('super-secret-key-12345'), false);
      assert.equal(res4.includes('mypassword'), false);
      assert.equal(res4.includes('HeaderSecretValue999'), false);
      assert.ok(res4.includes('[REDACTED]'));

      // 5. UTF-8 multi-byte emoji boundary truncation
      const emojiInput = '🙂'.repeat(10); // 40 bytes (each emoji is 4 bytes in UTF-8)
      const res5 = sanitizeSandboxOutput(emojiInput, 10); // 10 bytes can hold only 2 emojis (8 bytes)
      assert.equal(Buffer.byteLength(res5.split('\n')[0]!, 'utf8'), 8);
      assert.equal(res5.split('\n')[0], '🙂🙂');
    });

    it('post-allocation abort fencing: destroys newly allocated sandbox if signal was aborted mid-flight', async () => {
      const providerClient = new SimulatedCloudSandboxProviderClient();
      providerClient.simulateLateAllocationMs = 40; // Allocation takes 40ms
      const adapter = new IsolatedCloudSandboxAdapter({ providerClient });
      const ac = new AbortController();

      // Trigger abort while allocation is running
      const prepPromise = adapter.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Abort mid-allocation test',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });

      // Abort after 10ms (while createSandbox is in flight)
      setTimeout(() => ac.abort(), 10);

      const prep = await prepPromise;
      assert.equal(prep.available, false);
      assert.equal(prep.code, 'RUNTIME_UNAVAILABLE');

      // The allocated sandbox MUST be immediately destroyed to prevent orphaned cloud resources!
      assert.equal(providerClient.getSandboxCount(), 0);
    });

    it('independent adapter-level timeout races and terminates hanging provider RPCs', async () => {
      const providerClient = new SimulatedCloudSandboxProviderClient();
      providerClient.simulateHangingCommand = true; // RPC hangs forever
      const adapter = new IsolatedCloudSandboxAdapter({
        providerClient,
        defaultTimeoutMs: 30, // 30ms adapter wall-clock deadline
      });
      const ac = new AbortController();

      const prep = await adapter.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Hanging RPC test',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });
      assert.equal(prep.available, true);
      if (!prep.available) return;

      const start = Date.now();
      const res = await adapter.invoke(
        prep.sessionId,
        makeToolCall('run_command', 'sandbox_execute', { command: 'hanging-job' }),
        ac.signal
      );

      const elapsed = Date.now() - start;
      assert.equal(res.success, false);
      assert.equal(res.errorCode, 'TIMEOUT');
      assert.ok(elapsed >= 25 && elapsed < 500, `Expected elapsed to be ~30ms, got ${elapsed}ms`);
    });

    it('cleanup failure tracking: retains session for reconciliation and supports retryDestroy', async () => {
      const providerClient = new SimulatedCloudSandboxProviderClient();
      providerClient.simulateDestroyFailure = true; // Initial destruction fails
      const adapter = new IsolatedCloudSandboxAdapter({ providerClient });
      const ac = new AbortController();

      const prep = await adapter.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Cleanup failure test',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });
      assert.equal(prep.available, true);
      if (!prep.available) return;

      // Attempt cleanup - should fail because destroySandbox failed
      await assert.rejects(
        async () => {
          await adapter.cleanup(prep.sessionId);
        },
        /Failed to destroy sandbox/
      );

      // Session MUST be retained in pending destructions for ops reconciliation!
      const pending = adapter.getPendingDestructions();
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.sessionId, prep.sessionId);
      assert.equal(pending[0]?.destroyStatus, 'destroy_failed');
      assert.ok(pending[0]?.destroyError);

      // Restore provider client (e.g. network restored) and retry destruction
      providerClient.simulateDestroyFailure = false;
      const retrySuccess = await adapter.retryDestroy(prep.sessionId);
      assert.equal(retrySuccess, true);

      // Verify no pending destructions remain
      assert.equal(adapter.getPendingDestructions().length, 0);

      // Now cleanup can remove the session cleanly
      await adapter.cleanup(prep.sessionId);
      const session = await adapter.getSession(prep.sessionId);
      assert.equal(session, undefined);
    });

    it('forwards fail-closed network egress policy to provider during sandbox creation', async () => {
      const providerClient = new SimulatedCloudSandboxProviderClient();
      const adapter = new IsolatedCloudSandboxAdapter({
        providerClient,
        egressEnabled: false, // Default deny-by-default
        egressAllowlist: ['registry.npmjs.org', 'cdn.jsdelivr.net'],
      });
      const ac = new AbortController();

      const prep = await adapter.prepare({
        runId: dummyRunId,
        workspaceId: dummyWorkspaceId,
        ownerId: dummyOwnerId,
        mode: 'execute',
        task: 'Egress policy test',
        modelId: 'giga-agent-default',
        signal: ac.signal,
      });
      assert.equal(prep.available, true);
      if (!prep.available) return;

      // Verify the provider received the explicit network policy
      assert.ok(providerClient.lastReceivedNetworkPolicy);
      assert.equal(providerClient.lastReceivedNetworkPolicy.egressEnabled, false);
      assert.deepEqual(providerClient.lastReceivedNetworkPolicy.allowlist, [
        'registry.npmjs.org',
        'cdn.jsdelivr.net',
      ]);
    });
  });
});
