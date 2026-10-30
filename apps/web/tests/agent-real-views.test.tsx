import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('makes the URL workspace authoritative while resolving a new deep link', async () => {
    const workspaceB = { ...workspace, id: '10000000-0000-4000-8000-000000000012', name: 'Workspace B' };
    const runA = { ...failedRun, id: '20000000-0000-4000-8000-000000000012', task: 'Workspace A run' };
    const pendingWorkspace = deferred<{ workspace: AgentWorkspace }>();
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    vi.spyOn(realApiClient, 'listAgentWorkspaces').mockResolvedValue({ items: [workspace], nextCursor: null });
    const listRuns = vi.spyOn(realApiClient, 'listAgentRuns').mockImplementation(async (query) => ({
      items: query?.workspaceId === workspace.id ? [runA] : [],
      nextCursor: null,
    }));
    const getWorkspace = vi.spyOn(realApiClient, 'getAgentWorkspace').mockReturnValue(pendingWorkspace.promise);
    const createRun = vi.spyOn(realApiClient, 'createAgentRun').mockResolvedValue({ run: failedRun });

    function RouteControl() {
      const { navigate } = useRouter();
      return <button data-testid="navigate-workspace-b" onClick={() => navigate('/agent?workspace=' + workspaceB.id)}>Workspace B</button>;
    }

    renderReal(<><RouteControl /><AgentLauncherView /></>, '/agent?workspace=' + workspace.id);
    await waitFor(() => expect((screen.getByLabelText('Workspace') as HTMLSelectElement).value).toBe(workspace.id));
    expect(await screen.findByText('Workspace A run')).toBeDefined();

    fireEvent.click(screen.getByTestId('navigate-workspace-b'));
    await waitFor(() => expect(getWorkspace).toHaveBeenCalledWith(workspaceB.id));
    expect(window.location.search).toBe('?workspace=' + workspaceB.id);
    expect(screen.getByTestId('workspace-selection-pending')).toBeDefined();
    expect((screen.getByLabelText('Workspace') as HTMLSelectElement).value).toBe('');
    expect((screen.getByTestId('workspace-card-' + workspace.id) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('Workspace A run')).toBeNull();
    expect((screen.getByTestId('launch-agent-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(listRuns).toHaveBeenLastCalledWith({ limit: 20, workspaceId: workspaceB.id });
    fireEvent.click(screen.getByTestId('launch-agent-btn'));
    expect(createRun).not.toHaveBeenCalled();

    await act(async () => { pendingWorkspace.resolve({ workspace: workspaceB }); });
    await waitFor(() => expect((screen.getByLabelText('Workspace') as HTMLSelectElement).value).toBe(workspaceB.id));
    fireEvent.change(screen.getByTestId('agent-task-input'), { target: { value: 'Run only in B' } });
    fireEvent.click(screen.getByTestId('launch-agent-btn'));
    await waitFor(() => expect(createRun).toHaveBeenCalledWith(
      { workspaceId: workspaceB.id, task: 'Run only in B' },
      expect.objectContaining({ idempotencyKey: expect.any(String) })
    ));
  });

  it('ignores stale workspace detail responses and rejects mismatched or unavailable IDs', async () => {
    const workspaceB = { ...workspace, id: '10000000-0000-4000-8000-000000000013', name: 'Workspace B' };
    const workspaceC = { ...workspace, id: '10000000-0000-4000-8000-000000000014', name: 'Workspace C' };
    const workspaceDId = '10000000-0000-4000-8000-000000000015';
    const workspaceEId = '10000000-0000-4000-8000-000000000025';
    const pendingB = deferred<{ workspace: AgentWorkspace }>();
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    vi.spyOn(realApiClient, 'listAgentWorkspaces').mockResolvedValue({ items: [workspace], nextCursor: null });
    vi.spyOn(realApiClient, 'listAgentRuns').mockResolvedValue({ items: [], nextCursor: null });
    const getWorkspace = vi.spyOn(realApiClient, 'getAgentWorkspace').mockImplementation((id) => {
      if (id === workspaceB.id) return pendingB.promise;
      if (id === workspaceDId) return Promise.resolve({ workspace: workspaceC });
      if (id === workspaceEId) return Promise.reject(new ApiException(404, 'NOT_FOUND', 'Synthetic unavailable workspace'));
      return Promise.resolve({ workspace: workspaceC });
    });

    function RouteControl() {
      const { navigate } = useRouter();
      return <>
        <button data-testid="navigate-workspace-b" onClick={() => navigate('/agent?workspace=' + workspaceB.id)}>B</button>
        <button data-testid="navigate-workspace-c" onClick={() => navigate('/agent?workspace=' + workspaceC.id)}>C</button>
        <button data-testid="navigate-workspace-d" onClick={() => navigate('/agent?workspace=' + workspaceDId)}>D</button>
        <button data-testid="navigate-workspace-e" onClick={() => navigate('/agent?workspace=' + workspaceEId)}>E</button>
      </>;
    }

    renderReal(<><RouteControl /><AgentLauncherView /></>, '/agent?workspace=' + workspace.id);
    await waitFor(() => expect((screen.getByLabelText('Workspace') as HTMLSelectElement).value).toBe(workspace.id));
    fireEvent.click(screen.getByTestId('navigate-workspace-b'));
    await waitFor(() => expect(getWorkspace).toHaveBeenCalledWith(workspaceB.id));
    fireEvent.click(screen.getByTestId('navigate-workspace-c'));
    await waitFor(() => expect((screen.getByLabelText('Workspace') as HTMLSelectElement).value).toBe(workspaceC.id));
    await act(async () => { pendingB.resolve({ workspace: workspaceB }); });
    expect((screen.getByLabelText('Workspace') as HTMLSelectElement).value).toBe(workspaceC.id);
    expect(screen.queryByText('Workspace B')).toBeNull();

    fireEvent.click(screen.getByTestId('navigate-workspace-d'));
    await waitFor(() => expect(getWorkspace).toHaveBeenCalledWith(workspaceDId));
    expect(await screen.findByText('Workspace not found or unavailable for this account.')).toBeDefined();
    expect((screen.getByLabelText('Workspace') as HTMLSelectElement).value).toBe('');
    expect((screen.getByTestId('launch-agent-btn') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('navigate-workspace-e'));
    await waitFor(() => expect(getWorkspace).toHaveBeenCalledWith(workspaceEId));
    expect(await screen.findByText('Workspace not found or unavailable for this account.')).toBeDefined();
    expect((screen.getByLabelText('Workspace') as HTMLSelectElement).value).toBe('');
  });

  it('fences run pages and cursors by workspace filter and deduplicates IDs within a page', async () => {
    const workspaceB = { ...workspace, id: '10000000-0000-4000-8000-000000000016', name: 'Workspace B' };
    const runA = { ...failedRun, id: '20000000-0000-4000-8000-000000000016', task: 'Workspace A first page' };
    const staleRunA = { ...failedRun, id: '20000000-0000-4000-8000-000000000017', task: 'Workspace A stale append' };
    const runB = { ...failedRun, id: '20000000-0000-4000-8000-000000000018', task: 'Workspace B first page' };
    const runC = { ...failedRun, id: '20000000-0000-4000-8000-000000000019', task: 'Workspace B next page' };
    const staleAppend = deferred<{ items: AgentRun[]; nextCursor: string | null }>();
    const failedBPage = deferred<{ items: AgentRun[]; nextCursor: string | null }>();
    const retryBPage = deferred<{ items: AgentRun[]; nextCursor: string | null }>();
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    vi.spyOn(realApiClient, 'listAgentWorkspaces').mockResolvedValue({ items: [workspace], nextCursor: null });
    vi.spyOn(realApiClient, 'getAgentWorkspace').mockResolvedValue({ workspace: workspaceB });
    const listRuns = vi.spyOn(realApiClient, 'listAgentRuns').mockImplementation((query) => {
      if (query?.workspaceId === workspace.id && query.cursor === 'cursor-a') return staleAppend.promise;
      if (query?.workspaceId === workspaceB.id && !query.cursor) {
        return listRuns.mock.calls.filter(([call]) => call?.workspaceId === workspaceB.id).length === 1
          ? failedBPage.promise
          : retryBPage.promise;
      }
      if (query?.workspaceId === workspaceB.id && query.cursor === 'cursor-b') {
        return Promise.resolve({ items: [runB, runC, runC], nextCursor: null });
      }
      return Promise.resolve({ items: [runA], nextCursor: 'cursor-a' });
    });

    function RouteControl() {
      const { navigate } = useRouter();
      return <button data-testid="navigate-workspace-b" onClick={() => navigate('/agent?workspace=' + workspaceB.id)}>Workspace B</button>;
    }

    renderReal(<><RouteControl /><AgentLauncherView /></>, '/agent?workspace=' + workspace.id);
    expect(await screen.findByText('Workspace A first page')).toBeDefined();
    fireEvent.click(screen.getByTestId('load-more-runs-btn'));
    await waitFor(() => expect(listRuns).toHaveBeenCalledWith({ limit: 20, cursor: 'cursor-a', workspaceId: workspace.id }));

    fireEvent.click(screen.getByTestId('navigate-workspace-b'));
    await waitFor(() => expect(listRuns).toHaveBeenCalledWith({ limit: 20, workspaceId: workspaceB.id }));
    expect(screen.queryByText('Workspace A first page')).toBeNull();
    expect((screen.getByTestId('load-more-runs-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('refresh-runs-btn') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('load-more-runs-btn'));
    expect(listRuns).toHaveBeenCalledTimes(3);
    expect(listRuns.mock.calls.some(([query]) => query?.workspaceId === workspaceB.id && query.cursor === 'cursor-a')).toBe(false);

    await act(async () => { failedBPage.reject(new TypeError('synthetic B page failure')); });
    expect(await screen.findByText(/service or network is unavailable/i)).toBeDefined();
    expect(screen.queryByText('Workspace A first page')).toBeNull();
    fireEvent.click(screen.getByTestId('refresh-runs-btn'));
    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(4));
    await act(async () => { retryBPage.resolve({ items: [runB], nextCursor: 'cursor-b' }); });
    expect(await screen.findByText('Workspace B first page')).toBeDefined();
    await act(async () => { staleAppend.resolve({ items: [staleRunA], nextCursor: 'stale-cursor-a' }); });
    expect(screen.queryByText('Workspace A stale append')).toBeNull();
    expect(screen.getByText('Workspace B first page')).toBeDefined();

    fireEvent.click(screen.getByTestId('load-more-runs-btn'));
    await waitFor(() => expect(listRuns).toHaveBeenCalledWith({ limit: 20, cursor: 'cursor-b', workspaceId: workspaceB.id }));
    expect(await screen.findByText('Workspace B next page')).toBeDefined();
    expect(screen.getAllByText('Workspace B first page')).toHaveLength(1);
    expect(screen.getAllByText('Workspace B next page')).toHaveLength(1);
  });

  it('prevents refresh and load-more overlap, clears pages on refresh, and clears filters for All Workspaces', async () => {
    const workspaceB = { ...workspace, id: '10000000-0000-4000-8000-000000000020', name: 'Workspace B' };
    const firstRun = { ...failedRun, id: '20000000-0000-4000-8000-000000000020', task: 'Before refresh' };
    const appendedRun = { ...failedRun, id: '20000000-0000-4000-8000-000000000021', task: 'Appended once' };
    const refreshedRun = { ...failedRun, id: '20000000-0000-4000-8000-000000000022', task: 'After refresh' };
    const allRun = { ...failedRun, id: '20000000-0000-4000-8000-000000000023', task: 'All workspace run' };
    const appendPage = deferred<{ items: AgentRun[]; nextCursor: string | null }>();
    const refreshedPage = deferred<{ items: AgentRun[]; nextCursor: string | null }>();
    vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(capabilities);
    vi.spyOn(realApiClient, 'listAgentWorkspaces').mockResolvedValue({ items: [workspace, workspaceB], nextCursor: null });
    const listRuns = vi.spyOn(realApiClient, 'listAgentRuns').mockImplementation((query) => {
      if (query?.cursor === 'cursor-before') return appendPage.promise;
      if (query?.workspaceId === workspaceB.id && query.cursor === undefined) {
        const matchingCalls = listRuns.mock.calls.filter(([call]) => call?.workspaceId === workspaceB.id).length;
        if (matchingCalls === 1) return Promise.resolve({ items: [firstRun], nextCursor: 'cursor-before' });
        return refreshedPage.promise;
      }
      if (!query?.workspaceId) return Promise.resolve({ items: [allRun], nextCursor: null });
      return Promise.resolve({ items: [], nextCursor: null });
    });

    function RouteControl() {
      const { navigate } = useRouter();
      return <button data-testid="clear-workspace-filter" onClick={() => navigate('/agent')}>All workspaces</button>;
    }

    renderReal(<><RouteControl /><AgentLauncherView /></>, '/agent?workspace=' + workspaceB.id);
    expect(await screen.findByText('Before refresh')).toBeDefined();
    expect(listRuns).toHaveBeenCalledWith({ limit: 20, workspaceId: workspaceB.id });
    fireEvent.click(screen.getByTestId('load-more-runs-btn'));
    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(2));
    expect((screen.getByTestId('refresh-runs-btn') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('refresh-runs-btn'));
    expect(listRuns).toHaveBeenCalledTimes(2);

    await act(async () => { appendPage.resolve({ items: [appendedRun], nextCursor: 'cursor-after' }); });
    expect(await screen.findByText('Appended once')).toBeDefined();
    fireEvent.click(screen.getByTestId('refresh-runs-btn'));
    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(3));
    expect(screen.queryByText('Before refresh')).toBeNull();
    expect(screen.queryByText('Appended once')).toBeNull();
    expect((screen.getByTestId('load-more-runs-btn') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { refreshedPage.resolve({ items: [refreshedRun], nextCursor: null }); });
    expect(await screen.findByText('After refresh')).toBeDefined();

    fireEvent.click(screen.getByTestId('clear-workspace-filter'));
    await waitFor(() => expect(listRuns).toHaveBeenLastCalledWith({ limit: 20 }));
    expect(await screen.findByText('All workspace run')).toBeDefined();
    expect(screen.queryByText('After refresh')).toBeNull();
  });
});
