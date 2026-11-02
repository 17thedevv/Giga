import { describe, expect, it } from 'vitest';
import { projectAgentRunEvent } from '../src/lib/api/agent-events.js';

const runId = '20000000-0000-4000-8000-000000000001';

describe('Agent SSE event projection', () => {
  it('projects only public fields and redacts sensitive text', () => {
    const secret = 'AIzaSyntheticAgentEventCredential0123456789';
    const event = projectAgentRunEvent('run.failed', '7', {
      runId,
      code: 'RUNTIME_UNAVAILABLE',
      message: `Provider rejected ${secret}`,
      workerLeaseToken: 'private-worker-token',
      rawReasoning: 'hidden internal content',
    }, runId);

    expect(event).toEqual({ sequence: 7, type: 'run.failed', code: 'RUNTIME_UNAVAILABLE', message: 'Provider rejected [redacted credential]' });
    expect(JSON.stringify(event)).not.toContain(secret);
    expect(JSON.stringify(event)).not.toContain('workerLeaseToken');
    expect(JSON.stringify(event)).not.toContain('rawReasoning');
  });

  it('projects each current event family into bounded display fields', () => {
    const callId = 'tool-call-123';
    expect(projectAgentRunEvent('plan.updated', '1', { runId, version: 1, steps: ['Inspect files'], internalPlan: 'private' }, runId))
      .toEqual({ sequence: 1, type: 'plan.updated', version: 1, steps: ['Inspect files'] });
    expect(projectAgentRunEvent('tool.started', '2', { runId, toolCallId: callId, name: 'read_file', stepNumber: 1 }, runId))
      .toEqual({ sequence: 2, type: 'tool.started', name: 'read_file', stepNumber: 1 });
    expect(projectAgentRunEvent('tool.completed', '3', { runId, toolCallId: callId, outcome: 'success', durationMs: 12, summary: 'Read source' }, runId))
      .toEqual({ sequence: 3, type: 'tool.completed', durationMs: 12, summary: 'Read source' });
    expect(projectAgentRunEvent('tool.failed', '4', { runId, toolCallId: callId, code: 'TOOL_ERROR', summary: 'Read failed' }, runId))
      .toEqual({ sequence: 4, type: 'tool.failed', code: 'TOOL_ERROR', summary: 'Read failed' });
    expect(projectAgentRunEvent('run.completed', '5', { runId, artifactIds: ['artifact-1'], verifiedChecks: [{ name: 'Typecheck', outcome: 'passed' }], summary: 'Done' }, runId))
      .toEqual({ sequence: 5, type: 'run.completed', artifactIds: ['artifact-1'], verifiedChecks: [{ name: 'Typecheck', outcome: 'passed' }], summary: 'Done' });
  });

  it('ignores ID-less heartbeat and tracks additive events without retaining their payload', () => {
    expect(projectAgentRunEvent('heartbeat', undefined, { private: 'ignored' }, runId)).toBeNull();
    const unknown = projectAgentRunEvent('future.event', '8', { secret: 'sentinel', providerResponse: { reasoning: 'private' } }, runId);
    expect(unknown).toEqual({ sequence: 8, type: 'unsupported', eventName: 'future.event' });
    expect(JSON.stringify(unknown)).not.toContain('sentinel');
    expect(projectAgentRunEvent('future.event', undefined, { secret: 'sentinel' }, runId)).toBeNull();
  });

  it('rejects malformed cursors, wrong-run payloads, and invalid known event shapes', () => {
    expect(() => projectAgentRunEvent('run.status', '01', { runId, status: 'running' }, runId)).toThrow('invalid event');
    expect(() => projectAgentRunEvent('run.status', '2147483648', { runId, status: 'running' }, runId)).toThrow('invalid event');
    expect(() => projectAgentRunEvent('run.status', undefined, { runId, status: 'running' }, runId)).toThrow('invalid event');
    expect(() => projectAgentRunEvent('run.status', '1', { runId: 'another-run', status: 'running' }, runId)).toThrow('invalid event');
    expect(() => projectAgentRunEvent('tool.started', '1', { runId, toolCallId: 'call-1', name: 'read_file', stepNumber: 0 }, runId)).toThrow('invalid event');
  });
});
