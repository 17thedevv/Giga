import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import fixture from '../../../packages/contracts/fixtures/agent.json';
import { AgentRunTimeline } from '../src/features/agent/AgentRunTimeline.js';
import { realApiClient, SESSION_EXPIRED_EVENT } from '../src/lib/api/client.js';
import type { AgentRun, AgentCapabilities } from '../src/lib/api/agent-contract.js';
import type { PublicAgentRunEvent } from '../src/lib/api/agent-events.js';

const capabilities = fixture.capabilities as AgentCapabilities;
const run = fixture.run as AgentRun;

async function flushPendingPromises() {
  await act(async () => {
    for (let index = 0; index < 8; index++) await Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
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

  it('accepts an unfamiliar phase over SSE and renders HTML-like text without creating markup', async () => {
    const phaseEvent: PublicAgentRunEvent = { sequence: 1, type: 'run.status', status: 'running', phase: '<script>future</script>' };
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    let emit!: (event: PublicAgentRunEvent) => void;
    vi.spyOn(realApiClient, 'streamAgentRunEvents').mockImplementation(async (_id, onEvent) => {
      emit = onEvent;
      await new Promise<void>(() => {});
    });
    const view = render(<AgentRunTimeline run={run} onRefreshRun={vi.fn().mockResolvedValue(run)} />);
    await waitFor(() => expect(emit).toBeDefined());
    act(() => emit(phaseEvent));

    expect(await screen.findByText('Run status: running · <script>future</script>')).toBeDefined();
    expect(view.container.querySelector('script')).toBeNull();
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

  it('does not treat an empty clean EOF as complete for a terminal run and bounds retries', async () => {
    vi.useFakeTimers();
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    const stream = vi.spyOn(realApiClient, 'streamAgentRunEvents').mockResolvedValue(undefined);
    const refresh = vi.fn().mockResolvedValue({ ...run, status: 'failed' });
    render(<AgentRunTimeline run={run} onRefreshRun={refresh} />);

    await flushPendingPromises();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(stream).toHaveBeenCalledTimes(7);
    expect(refresh).toHaveBeenCalledTimes(7);
    expect(screen.getByTestId('agent-timeline-status').textContent).toContain('event history incomplete');
    expect(screen.queryByText(/Replay complete/)).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('did not reach a confirmed terminal event');
    expect(screen.getByTestId('retry-agent-timeline-btn')).toBeDefined();

    await act(async () => { fireEvent.click(screen.getByTestId('retry-agent-timeline-btn')); });
    await flushPendingPromises();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(stream).toHaveBeenCalledTimes(14);
    expect(screen.queryByText(/Replay complete/)).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('did not reach a confirmed terminal event');
  });

  it('resumes a partial terminal replay from the last contiguous cursor', async () => {
    vi.useFakeTimers();
    const first: PublicAgentRunEvent = { sequence: 1, type: 'run.status', status: 'running' };
    const terminal: PublicAgentRunEvent = { sequence: 2, type: 'run.failed', code: 'RUNTIME_UNAVAILABLE', message: 'Unavailable' };
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    const stream = vi.spyOn(realApiClient, 'streamAgentRunEvents')
      .mockImplementationOnce(async (_id, onEvent) => { onEvent(first); })
      .mockImplementationOnce(async (_id, onEvent, options) => {
        expect(options?.lastEventId).toBe(1);
        onEvent(terminal);
      });
    const refresh = vi.fn().mockResolvedValue({ ...run, status: 'failed' });
    render(<AgentRunTimeline run={run} onRefreshRun={refresh} />);
    await flushPendingPromises();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(stream).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId('agent-timeline-event')).toHaveLength(2);
    expect(screen.getByTestId('agent-timeline-status').textContent).toBe('Replay complete · run failed');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('accepts a contiguous terminal marker even when the observer then errors', async () => {
    const terminal: PublicAgentRunEvent = { sequence: 1, type: 'run.failed', code: 'RUNTIME_UNAVAILABLE', message: 'Unavailable' };
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    vi.spyOn(realApiClient, 'streamAgentRunEvents').mockImplementation(async (_id, onEvent) => {
      onEvent(terminal);
      throw new TypeError('synthetic observer disconnect');
    });
    const refresh = vi.fn().mockResolvedValue({ ...run, status: 'failed' });
    render(<AgentRunTimeline run={run} onRefreshRun={refresh} />);

    expect(await screen.findByText('Replay complete · run failed')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not treat a silent observer error as terminal replay evidence', async () => {
    vi.useFakeTimers();
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    const stream = vi.spyOn(realApiClient, 'streamAgentRunEvents').mockRejectedValue(new TypeError('observer closed without replay data'));
    render(<AgentRunTimeline run={run} onRefreshRun={vi.fn().mockResolvedValue({ ...run, status: 'failed' })} />);
    await flushPendingPromises();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(stream).toHaveBeenCalledTimes(7);
    expect(screen.queryByText(/Replay complete/)).toBeNull();
    expect(screen.getByTestId('agent-timeline-status').textContent).toContain('event history incomplete');
    expect(screen.getByTestId('retry-agent-timeline-btn')).toBeDefined();
  });

  it('clears a transient disconnect warning only after a replay event confirms recovery', async () => {
    vi.useFakeTimers();
    const runningRun = { ...run, status: 'running' as const };
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    const status: PublicAgentRunEvent = { sequence: 1, type: 'run.status', status: 'running' };
    let signal: AbortSignal | undefined;
    const stream = vi.spyOn(realApiClient, 'streamAgentRunEvents')
      .mockRejectedValueOnce(new TypeError('synthetic disconnect'))
      .mockImplementationOnce(async (_id, onEvent, options) => {
        signal = options?.signal;
        onEvent(status);
        await new Promise<void>(() => {});
      });
    render(<AgentRunTimeline run={runningRun} onRefreshRun={vi.fn().mockResolvedValue(runningRun)} />);
    await flushPendingPromises();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(stream).toHaveBeenCalledTimes(2);
    expect(signal?.aborted).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('agent-timeline-status').textContent).toContain('Receiving durable events');
  });

  it('keeps a sequence-gap integrity warning through repeated no-progress replay and manual retry', async () => {
    vi.useFakeTimers();
    const runningRun = { ...run, status: 'running' as const };
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    const gap: PublicAgentRunEvent = { sequence: 2, type: 'run.status', status: 'running' };
    const stream = vi.spyOn(realApiClient, 'streamAgentRunEvents').mockImplementation(async (_id, onEvent) => { onEvent(gap); });
    render(<AgentRunTimeline run={runningRun} onRefreshRun={vi.fn().mockResolvedValue(runningRun)} />);
    await flushPendingPromises();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(stream).toHaveBeenCalledTimes(7);
    expect(screen.getAllByRole('alert')[0]?.textContent).toContain('sequence gap');

    await act(async () => { fireEvent.click(screen.getByTestId('retry-agent-timeline-btn')); });
    await flushPendingPromises();
    expect(screen.getAllByRole('alert')[0]?.textContent).toContain('sequence gap');
    expect(screen.queryByText(/Replay complete/)).toBeNull();
  });

  it('keeps a nonterminal run incomplete after a clean stream close', async () => {
    vi.useFakeTimers();
    const runningRun = { ...run, status: 'running' as const };
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    const stream = vi.spyOn(realApiClient, 'streamAgentRunEvents')
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => new Promise<void>(() => {}));
    render(<AgentRunTimeline run={runningRun} onRefreshRun={vi.fn().mockResolvedValue(runningRun)} />);
    await flushPendingPromises();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(stream).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Replay complete/)).toBeNull();
    expect(screen.getAllByRole('alert')[0]?.textContent).toContain('ended before a terminal event');
    expect(screen.getByTestId('agent-timeline-status').textContent).toContain('Reconnecting');
  });

  it('isolates replay warnings and events when navigating to another run', async () => {
    vi.useFakeTimers();
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    const runningRun = { ...run, status: 'running' as const };
    const otherRun = { ...runningRun, id: '20000000-0000-4000-8000-000000000099' };
    const stream = vi.spyOn(realApiClient, 'streamAgentRunEvents')
      .mockImplementation(async () => new Promise<void>(() => {}))
      .mockRejectedValueOnce(new TypeError('synthetic disconnect'));
    const view = render(<AgentRunTimeline run={runningRun} onRefreshRun={vi.fn().mockResolvedValue(runningRun)} />);
    await flushPendingPromises();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    view.rerender(<AgentRunTimeline run={otherRun} onRefreshRun={vi.fn().mockResolvedValue(otherRun)} />);
    await flushPendingPromises();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(stream.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(stream.mock.calls.slice(1).every(([id]) => id === otherRun.id)).toBe(true);
    expect(screen.getByTestId('agent-run-timeline').querySelector('[role="alert"]')).toBeNull();
    expect(screen.queryByTestId('agent-timeline-events')).toBeNull();
    expect(screen.getByTestId('agent-timeline-empty')).toBeDefined();
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
