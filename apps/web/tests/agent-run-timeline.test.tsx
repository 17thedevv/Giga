import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import fixture from '../../../packages/contracts/fixtures/agent.json';
import { AgentRunTimeline } from '../src/features/agent/AgentRunTimeline.js';
import { realApiClient, SESSION_EXPIRED_EVENT } from '../src/lib/api/client.js';
import type { AgentRun, AgentCapabilities } from '../src/lib/api/agent-contract.js';
import type { PublicAgentRunEvent } from '../src/lib/api/agent-events.js';

const capabilities = fixture.capabilities as AgentCapabilities;
const run = fixture.run as AgentRun;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentRunTimeline', () => {
  it('reconciles authoritative terminal state and deduplicates exact replay events', async () => {
    const status: PublicAgentRunEvent = { sequence: 1, type: 'run.status', status: 'running', phase: 'planning' };
    const completed: PublicAgentRunEvent = {
      sequence: 2,
      type: 'run.completed',
      summary: 'Verified result',
      artifactIds: [],
      verifiedChecks: [],
    };
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    const stream = vi.spyOn(realApiClient, 'streamAgentRunEvents').mockImplementation(async (_id, onEvent) => {
      onEvent(status);
      onEvent(status);
      onEvent(completed);
    });
    const refresh = vi.fn().mockResolvedValue({ ...run, status: 'completed' });

    render(<AgentRunTimeline run={run} onRefreshRun={refresh} />);

    expect(await screen.findByText(/Run completed · Verified result/)).toBeDefined();
    expect(await screen.findByText(/Replay complete · run completed/)).toBeDefined();
    expect(screen.getAllByTestId('agent-timeline-event')).toHaveLength(2);
    expect(stream).toHaveBeenCalledWith(run.id, expect.any(Function), expect.objectContaining({ lastEventId: 0, signal: expect.any(AbortSignal) }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('recovers from a cursor gap by reconciling and replaying from the last contiguous cursor', async () => {
    const first: PublicAgentRunEvent = { sequence: 1, type: 'run.status', status: 'running' };
    const second: PublicAgentRunEvent = { sequence: 2, type: 'run.failed', code: 'RUNTIME_UNAVAILABLE', message: 'Unavailable' };
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    const stream = vi.spyOn(realApiClient, 'streamAgentRunEvents')
      .mockImplementationOnce(async (_id, onEvent) => { onEvent(second); })
      .mockImplementationOnce(async (_id, onEvent, options) => {
        expect(options?.lastEventId).toBe(0);
        onEvent(first);
        onEvent(second);
      });
    const refresh = vi.fn().mockResolvedValueOnce({ ...run, status: 'running' }).mockResolvedValueOnce({ ...run, status: 'failed' });

    render(<AgentRunTimeline run={run} onRefreshRun={refresh} />);

    expect(await screen.findByText(/Run failed · RUNTIME_UNAVAILABLE/)).toBeDefined();
    await waitFor(() => expect(screen.getByTestId('agent-timeline-status').textContent).toContain('Replay complete'));
    expect(stream).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId('agent-timeline-event')).toHaveLength(2);
  });

  it('clears protected event content and aborts observation when the session expires', async () => {
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    let resolveStream!: () => void;
    let emit!: (event: PublicAgentRunEvent) => void;
    let signal: AbortSignal | undefined;
    vi.spyOn(realApiClient, 'streamAgentRunEvents').mockImplementation(async (_id, onEvent, options) => {
      emit = onEvent;
      signal = options?.signal;
      await new Promise<void>((resolve) => { resolveStream = resolve; });
    });
    const refresh = vi.fn().mockResolvedValue(run);
    const view = render(<AgentRunTimeline run={run} onRefreshRun={refresh} />);
    await waitFor(() => expect(signal).toBeDefined());
    act(() => window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)));

    expect(await screen.findByText('Session expired')).toBeDefined();
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByTestId('agent-timeline-events')).toBeNull();
    act(() => emit({ sequence: 1, type: 'run.failed', code: 'FAILURE', message: 'Late stale event' }));
    expect(screen.queryByText(/Late stale event/)).toBeNull();
    await act(async () => resolveStream());
    view.unmount();
  });

  it('fails closed when event replay is not advertised and never opens the stream', async () => {
    const disabled = {
      ...capabilities,
      capabilities: { ...capabilities.capabilities, eventReplay: { available: false as const, reason: 'not_implemented' as const } },
    };
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(disabled);
    const stream = vi.spyOn(realApiClient, 'streamAgentRunEvents');

    render(<AgentRunTimeline run={run} onRefreshRun={vi.fn().mockResolvedValue(run)} />);

    expect(await screen.findByTestId('agent-timeline-unavailable')).toBeDefined();
    expect(stream).not.toHaveBeenCalled();
    expect(screen.getByTestId('agent-timeline-empty').textContent).toContain('No replayable');
  });
});
