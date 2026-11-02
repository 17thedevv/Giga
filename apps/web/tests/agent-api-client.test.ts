import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../packages/contracts/fixtures/agent.json';
import { RealApiClient } from '../src/lib/api/client.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('Real Agent API client', () => {
  it('creates and loads workspaces using the implemented endpoints and projects public fields', async () => {
    const secret = 'synthetic-agent-internal-secret';
    const workspace = { ...fixture.workspace, ownerId: 'private-owner', workerLeaseToken: secret };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ workspace, internalConfig: secret }, 201))
      .mockResolvedValueOnce(json({
        items: [workspace],
        nextCursor: 'opaque+workspace/cursor',
        databaseRows: secret,
      }))
      .mockResolvedValueOnce(json({ workspace, worker: { secret } }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new RealApiClient();
    const created = await client.createAgentWorkspace({ source: { kind: 'blank' }, name: ' My workspace ' });
    const page = await client.listAgentWorkspaces({ limit: 20, cursor: 'incoming+cursor/1' });
    const fetched = await client.getAgentWorkspace(fixture.workspace.id);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/agent/workspaces');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ source: { kind: 'blank' }, name: ' My workspace ' });
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'POST', credentials: 'include' }));
    expect(String(fetchMock.mock.calls[1][0])).toContain('limit=20');
    expect(String(fetchMock.mock.calls[1][0])).toContain('cursor=incoming%2Bcursor%2F1');
    expect(String(fetchMock.mock.calls[2][0])).toBe('/api/v1/agent/workspaces/' + fixture.workspace.id);
    for (const result of [created.workspace, page.items[0], fetched.workspace]) {
      expect(result).not.toHaveProperty('ownerId');
      expect(result).not.toHaveProperty('workerLeaseToken');
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(page.nextCursor).toBe('opaque+workspace/cursor');
  });

  it('lists runs with a cursor independent from workspace pagination and projects internal fields', async () => {
    const secret = 'synthetic-agent-lease-token';
    const run = { ...fixture.run, workerLeaseToken: secret, provider: { apiKey: secret }, rawReasoning: secret };
    const fetchMock = vi.fn().mockResolvedValue(json({
      items: [run],
      nextCursor: 'opaque-run-cursor',
      workerQueue: { lease: secret },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const page = await new RealApiClient().listAgentRuns({
      limit: 50,
      cursor: 'run+cursor',
      workspaceId: fixture.workspace.id,
    });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/v1/agent/runs?');
    expect(url).toContain('limit=50');
    expect(url).toContain('cursor=run%2Bcursor');
    expect(url).toContain('workspaceId=' + fixture.workspace.id);
    expect(page.items[0]).toEqual(fixture.run);
    expect(page.items[0]).not.toHaveProperty('workerLeaseToken');
    expect(page.items[0]).not.toHaveProperty('provider');
    expect(page.items[0]).not.toHaveProperty('rawReasoning');
    expect(JSON.stringify(page)).not.toContain(secret);
  });

  it('posts a run with a valid generated or caller-reused idempotency key and preserves 409', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ run: fixture.run }, 201))
      .mockResolvedValueOnce(json({ run: fixture.run }, 200))
      .mockResolvedValueOnce(json({ error: { code: 'CONFLICT', message: 'Idempotency key conflict' } }, 409));
    vi.stubGlobal('fetch', fetchMock);
    const client = new RealApiClient();
    const input = { workspaceId: fixture.workspace.id, task: fixture.run.task, mode: 'ask' as const };

    await client.createAgentRun(input);
    await client.createAgentRun(input, { idempotencyKey: 'agent-retry-key' });
    const generatedKey = new Headers(fetchMock.mock.calls[0][1]?.headers).get('Idempotency-Key');
    expect(generatedKey).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('Idempotency-Key')).toBe('agent-retry-key');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(input);
    await expect(client.createAgentRun(input, { idempotencyKey: 'agent-retry-key' }))
      .rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('replays the same uncertain admission key, then confirms the run through authoritative GET', async () => {
    const run = {
      ...fixture.run,
      task: 'Inspect the owned workspace',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('synthetic network timeout'))
      .mockResolvedValueOnce(json({ run }, 200))
      .mockResolvedValueOnce(json({ run: { ...run, status: 'failed', error: { code: 'RUNTIME_UNAVAILABLE', message: 'No Cloud runtime' } } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new RealApiClient().createAgentRun({
      workspaceId: fixture.workspace.id,
      task: run.task,
      mode: 'ask',
    }, { idempotencyKey: 'agent-stable-retry' });

    expect(result.run.status).toBe('failed');
    expect(result.run.error?.code).toBe('RUNTIME_UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v1/agent/runs');
    expect(String(fetchMock.mock.calls[1][0])).toBe('/api/v1/agent/runs');
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Idempotency-Key'))
      .toBe(new Headers(fetchMock.mock.calls[1][1]?.headers).get('Idempotency-Key'));
    expect(fetchMock.mock.calls[0][1]?.body).toBe(fetchMock.mock.calls[1][1]?.body);
    expect(String(fetchMock.mock.calls[2][0])).toBe('/api/v1/agent/runs/' + run.id);
  });

  it('keeps an uncertain admission unresolved when idempotent replay also fails, without guessing from history', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('synthetic network timeout'))
      .mockRejectedValueOnce(new TypeError('synthetic replay timeout'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new RealApiClient().createAgentRun({
      workspaceId: fixture.workspace.id,
      task: 'Repeatable identical task',
      mode: 'ask',
    }, { idempotencyKey: 'agent-same-key' })).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/api/v1/agent/runs', '/api/v1/agent/runs']);
  });

  it('rejects malformed pages and run DTOs instead of passing them into UI state', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ items: [fixture.workspace], nextCursor: { token: 'invalid' } }))
      .mockResolvedValueOnce(json({ items: [{ ...fixture.run, result: { summary: 'missing arrays' } }], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new RealApiClient();

    await expect(client.listAgentWorkspaces()).rejects.toMatchObject({ status: 502, code: 'INVALID_RESPONSE' });
    await expect(client.listAgentRuns()).rejects.toMatchObject({ status: 502, code: 'INVALID_RESPONSE' });
  });

  it('restores a run through GET after route refresh and preserves session and owner errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ run: fixture.run }))
      .mockResolvedValueOnce(json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } }, 401))
      .mockResolvedValueOnce(json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404));
    vi.stubGlobal('fetch', fetchMock);
    const client = new RealApiClient();

    expect((await client.getAgentRun(fixture.run.id)).run).toEqual(fixture.run);
    await expect(client.getAgentRun(fixture.run.id)).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    await expect(client.getAgentRun(fixture.run.id)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('loads run messages in sequence order and projects away private response properties', async () => {
    const secret = 'synthetic-worker-lease-sentinel';
    const first = { ...fixture.message, ownerId: secret, workerLeaseToken: secret, rawReasoning: secret };
    const second = {
      ...fixture.message,
      id: '30000000-0000-4000-8000-000000000002',
      sequence: 2,
      role: 'tool_summary',
      content: 'Read-only summary',
      provider: { secret },
    };
    const fetchMock = vi.fn().mockResolvedValue(json({
      items: [first, second],
      nextCursor: 'opaque+message/cursor',
      databaseRow: { secret },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const page = await new RealApiClient().listAgentMessages(fixture.run.id, {
      workspaceId: fixture.workspace.id,
      limit: 25,
      cursor: 'cursor + 1',
    });

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `/api/v1/agent/runs/${fixture.run.id}/messages?limit=25&cursor=cursor+%2B+1`
    );
    expect(page.items.map(({ sequence }) => sequence)).toEqual([1, 2]);
    expect(page.items[0]).toEqual(fixture.message);
    expect(page.items[1]).toEqual({ ...fixture.message, id: second.id, sequence: 2, role: 'tool_summary', content: 'Read-only summary' });
    expect(page.nextCursor).toBe('opaque+message/cursor');
    expect(JSON.stringify(page)).not.toContain(secret);
  });

  it('rejects messages from another run/workspace and non-increasing sequences', async () => {
    const wrongRun = { ...fixture.message, runId: '20000000-0000-4000-8000-000000000099' };
    const repeatedSequence = { ...fixture.message, id: '30000000-0000-4000-8000-000000000099' };
    const wrongWorkspace = { ...fixture.message, workspaceId: '10000000-0000-4000-8000-000000000099' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ items: [wrongRun], nextCursor: null }))
      .mockResolvedValueOnce(json({ items: [wrongWorkspace], nextCursor: null }))
      .mockResolvedValueOnce(json({ items: [fixture.message, repeatedSequence], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new RealApiClient();
    const options = { workspaceId: fixture.workspace.id };

    await expect(client.listAgentMessages(fixture.run.id, options)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(client.listAgentMessages(fixture.run.id, options)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(client.listAgentMessages(fixture.run.id, options)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('posts an idempotent follow-up and replays the same request after an uncertain network failure', async () => {
    const secret = 'synthetic-internal-worker-token';
    const message = { ...fixture.message, sequence: 2, content: 'Explain this task with more detail', privateReasoning: secret };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('synthetic timeout'))
      .mockResolvedValueOnce(json({ message, internal: { secret } }, 200));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new RealApiClient().createAgentMessage(fixture.run.id, {
      content: '  Explain this task with more detail  ',
    }, { workspaceId: fixture.workspace.id, idempotencyKey: 'follow-up-same-key' });

    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/v1/agent/runs/${fixture.run.id}/messages`);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ content: message.content });
    expect(fetchMock.mock.calls[0][1]?.body).toBe(fetchMock.mock.calls[1][1]?.body);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Idempotency-Key')).toBe('follow-up-same-key');
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('Idempotency-Key')).toBe('follow-up-same-key');
    expect(result.message).toEqual({ ...fixture.message, sequence: 2, content: message.content });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('does not replay definite follow-up conflicts and rejects invalid UTF-8 payloads before fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: { code: 'CONFLICT', message: 'Run is terminal' } }, 409));
    vi.stubGlobal('fetch', fetchMock);
    const client = new RealApiClient();

    await expect(client.createAgentMessage(fixture.run.id, { content: 'follow-up' }, {
      workspaceId: fixture.workspace.id,
      idempotencyKey: 'follow-up-conflict-key',
    })).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    await expect(client.createAgentMessage(fixture.run.id, { content: '🙂'.repeat(4097) }, {
      workspaceId: fixture.workspace.id,
      idempotencyKey: 'follow-up-too-large-key',
    })).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    await expect(client.createAgentMessage(fixture.run.id, { content: 'bad\0text' }, {
      workspaceId: fixture.workspace.id,
      idempotencyKey: 'follow-up-nul-key',
    })).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
