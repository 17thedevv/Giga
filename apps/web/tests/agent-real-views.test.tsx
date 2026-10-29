import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import fixture from '../../../packages/contracts/fixtures/agent.json';
import { AgentLauncherView } from '../src/features/agent/AgentLauncherView.js';
import { AgentRunView } from '../src/features/agent/AgentRunView.js';
import { ApiModeProvider, useApiMode } from '../src/app/context/ApiModeContext.js';
import { ThemeProvider } from '../src/app/context/ThemeContext.js';
import { AuthProvider } from '../src/app/context/AuthContext.js';
import { RouterProvider, useRouter } from '../src/app/router.js';
import { ApiException, realApiClient } from '../src/lib/api/client.js';
import type { AgentCapabilities, AgentRun, AgentWorkspace } from '../src/lib/api/agent-contract.js';

const capabilities = fixture.capabilities as AgentCapabilities;
const workspace = fixture.workspace as AgentWorkspace;
const failedRun = fixture.run as AgentRun;

function renderReal(ui: React.ReactElement, initialPath = '/agent') {
  return render(
    <ThemeProvider>
      <ApiModeProvider initialMode="real">
        <AuthProvider>
          <RouterProvider initialPath={initialPath}>{ui}</RouterProvider>
        </AuthProvider>
      </ApiModeProvider>
    </ThemeProvider>
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('Real Agent workspace and run integration', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads real workspaces and run history and follows each opaque cursor independently', async () => {
    const nextWorkspace = { ...workspace, id: '10000000-0000-4000-8000-000000000002', name: 'Second workspace' };
    const nextRun = { ...failedRun, id: '20000000-0000-4000-8000-000000000002', task: 'Second backend run' };
    const listWorkspaces = vi.spyOn(realApiClient, 'listAgentWorkspaces')
      .mockResolvedValueOnce({ items: [workspace], nextCursor: 'workspace-cursor' })
      .mockResolvedValueOnce({ items: [nextWorkspace], nextCursor: null });
    const listRuns = vi.spyOn(realApiClient, 'listAgentRuns')
      .mockResolvedValueOnce({ items: [failedRun], nextCursor: 'run-cursor' })
      .mockResolvedValueOnce({ items: [nextRun], nextCursor: null });
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);

    renderReal(<AgentLauncherView />);

    await screen.findByText('New Workspace');
    expect(await screen.findByText('New Workspace', { selector: 'strong' })).toBeDefined();
    expect(screen.getByText(/Revision 1/)).toBeDefined();
    expect(await screen.findByText('Explain this task')).toBeDefined();
    expect(screen.getByText('failed', { selector: 'span' })).toBeDefined();

    fireEvent.click(screen.getByTestId('load-more-workspaces-btn'));
    await waitFor(() => expect(screen.getByText('Second workspace', { selector: 'strong' })).toBeDefined());
    fireEvent.click(screen.getByTestId('load-more-runs-btn'));
    await waitFor(() => expect(screen.getByText('Second backend run')).toBeDefined());

    expect(listWorkspaces).toHaveBeenNthCalledWith(1, { limit: 20 });
    expect(listWorkspaces).toHaveBeenNthCalledWith(2, { limit: 20, cursor: 'workspace-cursor' });
    expect(listRuns).toHaveBeenNthCalledWith(1, { limit: 20 });
    expect(listRuns).toHaveBeenNthCalledWith(2, { limit: 20, cursor: 'run-cursor' });
  });

  it('creates a blank workspace using the API and restores the selection in the URL', async () => {
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    vi.spyOn(realApiClient, 'listAgentWorkspaces').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(realApiClient, 'listAgentRuns').mockResolvedValue({ items: [], nextCursor: null });
    const created = { ...workspace, id: '10000000-0000-4000-8000-000000000003', name: 'Research workspace' };
    const create = vi.spyOn(realApiClient, 'createAgentWorkspace').mockResolvedValue({ workspace: created });

    renderReal(<AgentLauncherView />);
    fireEvent.click(await screen.findByTestId('create-workspace-btn'));
    fireEvent.change(screen.getByTestId('new-workspace-name-input'), { target: { value: 'Research workspace' } });
    fireEvent.click(screen.getByTestId('confirm-create-workspace-btn'));

    await waitFor(() => expect(create).toHaveBeenCalledWith({
      source: { kind: 'blank' },
      name: 'Research workspace',
    }));
    await waitFor(() => expect((screen.getByLabelText('Workspace') as HTMLSelectElement).value).toBe(created.id));
    expect(window.location.search).toBe('?workspace=' + created.id);
    expect(screen.getByTestId('selected-workspace-metadata').textContent).toContain('Revision 1');
  });

  it('admits a real run with a stable key and navigates to the authoritative RUNTIME_UNAVAILABLE result', async () => {
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    vi.spyOn(realApiClient, 'listAgentWorkspaces').mockResolvedValue({ items: [workspace], nextCursor: null });
    vi.spyOn(realApiClient, 'listAgentRuns').mockResolvedValue({ items: [], nextCursor: null });
    const createdRun = {
      ...failedRun,
      task: 'Summarize this owned workspace',
      error: { code: 'RUNTIME_UNAVAILABLE', message: 'Cloud runtime is not configured' },
    };
    const create = vi.spyOn(realApiClient, 'createAgentRun').mockResolvedValue({ run: createdRun });

    renderReal(<AgentLauncherView />);
    await screen.findByTestId('admission-only-notice');
    fireEvent.click(await screen.findByTestId('workspace-card-' + workspace.id));
    fireEvent.change(screen.getByTestId('agent-task-input'), { target: { value: createdRun.task } });
    const submit = screen.getByTestId('launch-agent-btn') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toContain('Admit Run');
    fireEvent.click(submit);

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [input, options] = create.mock.calls[0];
    expect(input).toEqual({ workspaceId: workspace.id, task: createdRun.task });
    expect(options?.idempotencyKey).toMatch(/^agent-[A-Za-z0-9-]+$/);
    await waitFor(() => expect(window.location.pathname).toBe('/agent/runs/' + createdRun.id));
    expect(screen.queryByTestId('demo-run-badge')).toBeNull();
  });

  it('offers only modes that the capability DTO enables', async () => {
    const askOnly: AgentCapabilities = {
      ...capabilities,
      capabilities: {
        ...capabilities.capabilities,
        cloudRuntime: { available: true },
        runExecution: { available: true },
        ask: { available: true },
        plan: { available: false, reason: 'not_implemented' },
        execute: { available: false, reason: 'not_implemented' },
      },
    };
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(askOnly);
    vi.spyOn(realApiClient, 'listAgentWorkspaces').mockResolvedValue({ items: [workspace], nextCursor: null });
    vi.spyOn(realApiClient, 'listAgentRuns').mockResolvedValue({ items: [], nextCursor: null });

    renderReal(<AgentLauncherView />);
    const ask = await screen.findByLabelText(/Ask/);
    const plan = screen.getByLabelText(/Plan/);
    const execute = screen.getByLabelText(/Execute/);
    expect((ask as HTMLInputElement).disabled).toBe(false);
    expect((plan as HTMLInputElement).disabled).toBe(true);
    expect((execute as HTMLInputElement).disabled).toBe(true);
  });

  it('reuses the same idempotency key when the user retries an uncertain submission', async () => {
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    vi.spyOn(realApiClient, 'listAgentWorkspaces').mockResolvedValue({ items: [workspace], nextCursor: null });
    vi.spyOn(realApiClient, 'listAgentRuns').mockResolvedValue({ items: [], nextCursor: null });
    const createdRun = { ...failedRun, task: 'Retry this run admission' };
    const create = vi.spyOn(realApiClient, 'createAgentRun')
      .mockRejectedValueOnce(new TypeError('synthetic timeout'))
      .mockResolvedValueOnce({ run: createdRun });

    renderReal(<AgentLauncherView />);
    await screen.findByTestId('admission-only-notice');
    fireEvent.click(await screen.findByTestId('workspace-card-' + workspace.id));
    fireEvent.change(screen.getByTestId('agent-task-input'), { target: { value: createdRun.task } });
    fireEvent.click(screen.getByTestId('launch-agent-btn'));
    await screen.findByText(/could not be confirmed/i);
    fireEvent.click(screen.getByTestId('launch-agent-btn'));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[0][1]?.idempotencyKey).toBe(create.mock.calls[1][1]?.idempotencyKey);
    expect(create.mock.calls[0][0]).toEqual(create.mock.calls[1][0]);
  });

  it('synchronously blocks a second run admission while the first request is active', async () => {
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    vi.spyOn(realApiClient, 'listAgentWorkspaces').mockResolvedValue({ items: [workspace], nextCursor: null });
    vi.spyOn(realApiClient, 'listAgentRuns').mockResolvedValue({ items: [], nextCursor: null });
    const pending = deferred<{ run: AgentRun }>();
    const create = vi.spyOn(realApiClient, 'createAgentRun').mockReturnValue(pending.promise);

    renderReal(<AgentLauncherView />);
    await screen.findByTestId('admission-only-notice');
    fireEvent.click(await screen.findByTestId('workspace-card-' + workspace.id));
    fireEvent.change(screen.getByTestId('agent-task-input'), { target: { value: 'Only admit this once' } });
    const submit = screen.getByTestId('launch-agent-btn') as HTMLButtonElement;
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(create).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId('launch-agent-btn') as HTMLButtonElement).disabled).toBe(true);
    pending.resolve({ run: { ...failedRun, id: '20000000-0000-4000-8000-000000000004' } });
    await waitFor(() => expect(window.location.pathname).toBe('/agent/runs/20000000-0000-4000-8000-000000000004'));
  });

  it('shows a safe 409 admission conflict without navigating or substituting Demo data', async () => {
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    vi.spyOn(realApiClient, 'listAgentWorkspaces').mockResolvedValue({ items: [workspace], nextCursor: null });
    vi.spyOn(realApiClient, 'listAgentRuns').mockResolvedValue({ items: [], nextCursor: null });
    const create = vi.spyOn(realApiClient, 'createAgentRun')
      .mockRejectedValueOnce(new ApiException(409, 'CONFLICT', 'Synthetic idempotency conflict'))
      .mockResolvedValueOnce({ run: { ...failedRun, id: '20000000-0000-4000-8000-000000000005' } });

    renderReal(<AgentLauncherView />);
    await screen.findByTestId('admission-only-notice');
    fireEvent.click(await screen.findByTestId('workspace-card-' + workspace.id));
    fireEvent.change(screen.getByTestId('agent-task-input'), { target: { value: 'Conflicting admission' } });
    fireEvent.click(screen.getByTestId('launch-agent-btn'));

    expect(await screen.findByText(/conflicts with an earlier admission/i)).toBeDefined();
    expect(window.location.pathname).toBe('/agent');
    expect(screen.queryByTestId('demo-run-badge')).toBeNull();
    expect(screen.queryByText('Synthetic idempotency conflict')).toBeNull();
    fireEvent.click(screen.getByTestId('launch-agent-btn'));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[0][1]?.idempotencyKey).not.toBe(create.mock.calls[1][1]?.idempotencyKey);
    await waitFor(() => expect(window.location.pathname).toBe('/agent/runs/20000000-0000-4000-8000-000000000005'));
  });

  it('keeps 401 and owner-scoped 403 errors visible without loading Demo workspace data', async () => {
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockRejectedValueOnce(
      new ApiException(401, 'UNAUTHENTICATED', 'Synthetic session failure')
    );
    const first = renderReal(<AgentLauncherView />);
    expect(await screen.findByText('Your session has expired. Sign in again to continue.')).toBeDefined();
    expect(screen.queryByText('React Task Manager')).toBeNull();
    first.unmount();

    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    vi.spyOn(realApiClient, 'listAgentWorkspaces').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(realApiClient, 'listAgentRuns').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(realApiClient, 'getAgentWorkspace').mockRejectedValue(
      new ApiException(403, 'FORBIDDEN', 'Synthetic ownership failure')
    );
    renderReal(<AgentLauncherView />, '/agent/workspaces/20000000-0000-4000-8000-000000000099');

    expect(await screen.findByText('This request is not permitted for the current account.')).toBeDefined();
    expect(screen.queryByText('Synthetic ownership failure')).toBeNull();
    expect(screen.queryByText('React Task Manager')).toBeNull();
  });

  it('restores a workspace from a direct route after refreshing the launcher', async () => {
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    vi.spyOn(realApiClient, 'listAgentWorkspaces').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(realApiClient, 'listAgentRuns').mockResolvedValue({ items: [], nextCursor: null });
    const getWorkspace = vi.spyOn(realApiClient, 'getAgentWorkspace').mockResolvedValue({ workspace });

    renderReal(<AgentLauncherView />, '/agent/workspaces/' + workspace.id);

    await waitFor(() => expect(getWorkspace).toHaveBeenCalledWith(workspace.id));
    await waitFor(() => expect((screen.getByLabelText('Workspace') as HTMLSelectElement).value).toBe(workspace.id));
    expect(screen.getByText('New Workspace', { selector: 'strong' })).toBeDefined();
  });

  it('does not substitute Demo workspaces when a Real API request fails', async () => {
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    vi.spyOn(realApiClient, 'listAgentWorkspaces').mockRejectedValue(new TypeError('synthetic network failure'));
    vi.spyOn(realApiClient, 'listAgentRuns').mockRejectedValue(new TypeError('synthetic network failure'));

    renderReal(<AgentLauncherView />);

    expect(await screen.findByTestId('workspaces-empty')).toBeDefined();
    expect(screen.queryByText('React Task Manager')).toBeNull();
    await waitFor(() => expect(screen.getAllByText(/service or network is unavailable/i).length).toBeGreaterThan(0));
  });

  it('loads the real run through GET after refresh and shows only backend results', async () => {
    const getRun = vi.spyOn(realApiClient, 'getAgentRun').mockResolvedValue({ run: failedRun });
    vi.spyOn(realApiClient, 'getAgentWorkspace').mockResolvedValue({ workspace });

    renderReal(<AgentRunView />, '/agent/runs/' + failedRun.id);

    expect(await screen.findByTestId('real-run-notice')).toBeDefined();
    expect(getRun).toHaveBeenCalledWith(failedRun.id);
    expect(screen.getByTestId('run-status-badge').textContent).toContain('failed');
    expect(screen.getByTestId('run-error-message').textContent).toContain('RUNTIME_UNAVAILABLE');
    expect(screen.getByTestId('runtime-unavailable-state').textContent).toContain('no Cloud execution was performed');
    expect(screen.getByTestId('run-task-title').textContent).toBe(failedRun.task);
    expect(screen.queryByText(/Created src\//)).toBeNull();
    expect(screen.queryByText(/Production Build/)).toBeNull();
    expect(screen.queryByTestId('demo-run-badge')).toBeNull();
  });

  it('treats an owner-scoped 404 as unavailable and does not render any Demo run', async () => {
    vi.spyOn(realApiClient, 'getAgentRun').mockRejectedValue(new ApiException(404, 'NOT_FOUND', 'Not found'));
    renderReal(<AgentRunView />, '/agent/runs/' + failedRun.id);

    expect(await screen.findByTestId('agent-run-not-found')).toBeDefined();
    expect(screen.getByText(/Run not found or unavailable for this account/i)).toBeDefined();
    expect(screen.queryByTestId('demo-run-badge')).toBeNull();
    expect(screen.queryByTestId('agent-run-view')).toBeNull();
  });

  it('ignores a stale run response after navigating to another run', async () => {
    const older = deferred<{ run: AgentRun }>();
    const newerRun = { ...failedRun, id: '20000000-0000-4000-8000-000000000002', task: 'New route task' };
    vi.spyOn(realApiClient, 'getAgentRun').mockImplementation((id) => id === failedRun.id ? older.promise : Promise.resolve({ run: newerRun }));
    vi.spyOn(realApiClient, 'getAgentWorkspace').mockResolvedValue({ workspace });

    function RouteControl() {
      const { navigate } = useRouter();
      return <button data-testid="navigate-new-run" onClick={() => navigate('/agent/runs/' + newerRun.id)}>Next run</button>;
    }

    renderReal(<><RouteControl /><AgentRunView /></>, '/agent/runs/' + failedRun.id);
    fireEvent.click(screen.getByTestId('navigate-new-run'));
    expect(await screen.findByText('New route task')).toBeDefined();
    older.resolve({ run: { ...failedRun, task: 'Stale old route task' } });

    await waitFor(() => expect(screen.queryByText('Stale old route task')).toBeNull());
    expect(screen.getByTestId('run-task-title').textContent).toBe('New route task');
  });

  it('keeps Real and Demo views separated when mode changes with a Real list request in flight', async () => {
    const pending = deferred<{ items: AgentWorkspace[]; nextCursor: null }>();
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    vi.spyOn(realApiClient, 'listAgentWorkspaces').mockReturnValue(pending.promise);
    vi.spyOn(realApiClient, 'listAgentRuns').mockResolvedValue({ items: [], nextCursor: null });

    function ModeControl() {
      const { mode, setMode } = useApiMode();
      return <button data-testid="switch-mode" onClick={() => setMode(mode === 'real' ? 'mock' : 'real')}>Switch</button>;
    }

    render(
      <ThemeProvider>
        <ApiModeProvider initialMode="real">
          <AuthProvider>
            <RouterProvider initialPath="/agent"><><ModeControl /><AgentLauncherView /></></RouterProvider>
          </AuthProvider>
        </ApiModeProvider>
      </ThemeProvider>
    );
    fireEvent.click(screen.getByTestId('switch-mode'));
    expect(await screen.findByRole('option', { name: 'React Task Manager' })).toBeDefined();
    pending.resolve({ items: [{ ...workspace, name: 'Late real workspace' }], nextCursor: null });
    await waitFor(() => expect(screen.queryByText('Late real workspace')).toBeNull());
    expect(screen.getByRole('option', { name: 'React Task Manager' })).toBeDefined();
  });
});
