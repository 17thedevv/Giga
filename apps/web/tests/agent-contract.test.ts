import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../packages/contracts/fixtures/agent.json';
import { agentWorkspaceSchema, agentRunSchema, agentMessageSchema, readAgentCapabilities,
  isAgentCapabilityAvailable, type AgentRun, type AgentWorkspace, type AgentMessage } from '../src/lib/api/agent-contract.js';
import { RealApiClient } from '../src/lib/api/client.js';
import { MockDataAdapter } from '../src/lib/api/mock-adapter.js';
import { SseStreamParser, type SseEvent } from '../src/lib/api/sse-parser.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('Workspace-first Agent contract consumer', () => {
  it('uses the shared DTO fixtures without the historical repository/PR requirements', () => {
    const workspace: AgentWorkspace = agentWorkspaceSchema.parse(fixture.workspace);
    const run: AgentRun = agentRunSchema.parse(fixture.run);
    const message: AgentMessage = agentMessageSchema.parse(fixture.message);
    expect(workspace).toEqual(fixture.workspace);
    expect(run).toEqual(fixture.run);
    expect(message).toEqual(fixture.message);
    expect(run).not.toHaveProperty('repository');
  });

  it('fetches authenticated discovery and keeps the mock discovery fixture aligned', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture.capabilities), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const real = await new RealApiClient().getAgentCapabilities();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/agent/capabilities', expect.objectContaining({ credentials: 'include' }));
    expect(real).toEqual(await new MockDataAdapter().getAgentCapabilities());
    expect(real).toEqual(fixture.capabilities);
    for (const name of ['ask', 'plan', 'execute', 'followUp', 'cloudRuntime'] as const) {
      expect(isAgentCapabilityAvailable(real, name)).toBe(false);
    }
  });

  it('fails closed on missing or unknown metadata, while tolerating additive fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
    const missing = await new RealApiClient().getAgentCapabilities();
    expect(Object.values(missing.capabilities).every((entry) => !entry.available)).toBe(true);
    const additive = { ...fixture.capabilities, future: 'field', capabilities: {
      ...fixture.capabilities.capabilities, futureFeature: { available: true }, eventReplay: { available: true, future: 'metadata' },
    } };
    expect(readAgentCapabilities(additive)).toEqual(fixture.capabilities);
    expect(readAgentCapabilities({ ...additive, schemaVersion: 2 }).capabilities.eventReplay.available).toBe(false);
  });

  it('preserves 401 errors so discovery cannot silently turn an expired session into supported features', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })));
    await expect(new RealApiClient().getAgentCapabilities()).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('parses unknown additive Agent SSE frames without disrupting following known events', () => {
    const events: SseEvent[] = [];
    const parser = new SseStreamParser((event) => events.push(event));
    parser.feed('id: 1\nevent: future.additive\ndata: {"safe":true}\n\nid: 2\nevent: run.failed\ndata: {"runId":"fixture","code":"RUNTIME_UNAVAILABLE","message":"Unavailable"}\n\n');
    parser.flush();
    expect(events.map((entry) => entry.event)).toEqual(['future.additive', 'run.failed']);
    expect(events[1].id).toBe('2');
    // Agent workspace reducers must ignore unknown event names, deduplicate by per-run ID
    // and reconcile with GET Run; this generic transport intentionally preserves names.
  });
});
