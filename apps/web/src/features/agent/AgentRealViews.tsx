import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from '../../app/router.js';
import { realApiClient, ApiException } from '../../lib/api/client.js';
import {
  isAgentCapabilityAvailable,
  readAgentCapabilities,
  type AgentCapabilities,
  type AgentMode,
  type AgentRun,
  type AgentWorkspace,
  type CreateAgentRun,
} from '../../lib/api/agent-contract.js';
import { Alert } from '../../components/Alert.js';
import { Badge } from '../../components/Badge.js';
import { Button } from '../../components/Button.js';
import { Input } from '../../components/Input.js';
import { Modal } from '../../components/Modal.js';
import { Textarea } from '../../components/Textarea.js';
import { AgentMessageThread } from './AgentMessageThread.js';

const modes: readonly { value: AgentMode; title: string; detail: string }[] = [
  { value: 'ask', title: 'Ask', detail: 'Answer a question without changing workspace files.' },
  { value: 'plan', title: 'Plan', detail: 'Inspect and plan without making workspace changes.' },
  { value: 'execute', title: 'Execute', detail: 'Make authorized changes in an isolated runtime.' },
];

function safeAgentError(error: unknown, resource: 'workspace' | 'run' | 'request'): string {
  if (error instanceof ApiException) {
    if (error.status === 401) return 'Your session has expired. Sign in again to continue.';
    if (error.status === 403) return 'This request is not permitted for the current account.';
    if (error.status === 404) return resource === 'workspace'
      ? 'Workspace not found or unavailable for this account.'
      : 'Run not found or unavailable for this account.';
    if (error.status === 409) return 'This run conflicts with an earlier admission. Submit again to start a new attempt or change the task.';
    if (error.status === 400) return 'The request was rejected. Check the task and workspace details, then try again.';
    if (error.status >= 500) return 'The Agent service could not complete this request. Try again shortly.';
    return error.message || 'The Agent request could not be completed.';
  }
  return resource === 'request'
    ? 'The request could not be confirmed because the Agent service or network is unavailable. Retry to reuse this submission safely.'
    : 'The Agent service or network is unavailable. Try again shortly.';
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function capabilityReason(capabilities: AgentCapabilities, name: 'workspaceManagement' | 'runHistory' | 'runAdmission' | 'runExecution'): string {
  const entry = readAgentCapabilities(capabilities).capabilities[name];
  if (entry.available) return '';
  if (entry.reason === 'runtime_unavailable') return 'The backend runtime is not available.';
  if (entry.reason === 'not_implemented') return 'This capability is not implemented by the backend.';
  return 'The backend has not confirmed this capability.';
}

export const AgentRealLauncherView: React.FC = () => {
  const { path, params, navigate } = useRouter();
  const linkedWorkspaceId = params.workspaceId ||
    new URLSearchParams(path.includes('?') ? path.slice(path.indexOf('?') + 1) : '').get('workspace') || '';
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<AgentWorkspace[]>([]);
  const [workspaceCursor, setWorkspaceCursor] = useState<string | null>(null);
  const [isLoadingCapabilities, setIsLoadingCapabilities] = useState(true);
  const [isLoadingWorkspaces, setIsLoadingWorkspaces] = useState(false);
  const [isLoadingMoreWorkspaces, setIsLoadingMoreWorkspaces] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [runCursor, setRunCursor] = useState<string | null>(null);
  const [isLoadingRuns, setIsLoadingRuns] = useState(false);
  const [isLoadingMoreRuns, setIsLoadingMoreRuns] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<AgentMode | null>(null);
  const [task, setTask] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false);

  const generationRef = useRef(0);
  const workspaceRequestRef = useRef(0);
  const runRequestRef = useRef(0);
  const workspaceDetailRequestRef = useRef(0);
  const hasLoadedWorkspacesRef = useRef(false);
  const resolvingWorkspaceRef = useRef<string | null>(null);
  const workspaceRouteRef = useRef(linkedWorkspaceId);
  const activeRunFilterRef = useRef(linkedWorkspaceId);
  const runFirstPagePendingRef = useRef(false);
  const runMorePendingRef = useRef(false);
  const [runsForQuery, setRunsForQuery] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const createWorkspaceRef = useRef(false);
  const pendingAdmissionRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const fetchWorkspaces = useCallback(async (cursor?: string, append = false) => {
    const requestId = ++workspaceRequestRef.current;
    if (append) setIsLoadingMoreWorkspaces(true);
    else {
      setIsLoadingWorkspaces(true);
      setWorkspaceError(null);
    }
    try {
      const page = await realApiClient.listAgentWorkspaces({ limit: 20, ...(cursor ? { cursor } : {}) });
      if (workspaceRequestRef.current !== requestId) return;
      setWorkspaces((current) => {
        if (!append) return [...page.items];
        const known = new Set(current.map((workspace) => workspace.id));
        return [...current, ...page.items.filter((workspace) => !known.has(workspace.id))];
      });
      setWorkspaceCursor(page.nextCursor);
    } catch (error) {
      if (workspaceRequestRef.current !== requestId) return;
      setWorkspaceError(safeAgentError(error, 'workspace'));
    } finally {
      hasLoadedWorkspacesRef.current = true;
      if (workspaceRequestRef.current === requestId) {
        setIsLoadingWorkspaces(false);
        setIsLoadingMoreWorkspaces(false);
      }
    }
  }, []);

  const fetchRuns = useCallback(async (
    cursor?: string,
    append = false,
    workspaceId = activeRunFilterRef.current || undefined
  ) => {
    const filterKey = workspaceId ?? '';
    if (filterKey !== activeRunFilterRef.current) return;
    if (append && (runFirstPagePendingRef.current || runMorePendingRef.current || !cursor)) return;
    if (!append && runFirstPagePendingRef.current) return;

    const requestId = ++runRequestRef.current;
    if (append) {
      runMorePendingRef.current = true;
      setIsLoadingMoreRuns(true);
    } else {
      // A refresh supersedes any append already in flight. Its response is
      // fenced by requestId and cannot be joined to this first page.
      runMorePendingRef.current = false;
      runFirstPagePendingRef.current = true;
      setRunsForQuery(filterKey);
      setRuns([]);
      setRunCursor(null);
      setIsLoadingRuns(true);
      setRunError(null);
      setIsLoadingMoreRuns(false);
    }
    try {
      const page = await realApiClient.listAgentRuns({
        limit: 20,
        ...(cursor ? { cursor } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      });
      if (runRequestRef.current !== requestId || activeRunFilterRef.current !== filterKey) return;
      setRuns((current) => {
        if (!append) return [...page.items];
        const known = new Set(current.map((run) => run.id));
        const additions: AgentRun[] = [];
        for (const run of page.items) {
          if (known.has(run.id)) continue;
          known.add(run.id);
          additions.push(run);
        }
        return [...current, ...additions];
      });
      setRunCursor(page.nextCursor);
      setRunsForQuery(filterKey);
    } catch (error) {
      if (runRequestRef.current !== requestId || activeRunFilterRef.current !== filterKey) return;
      setRunError(safeAgentError(error, 'run'));
    } finally {
      if (runRequestRef.current === requestId && activeRunFilterRef.current === filterKey) {
        if (append) runMorePendingRef.current = false;
        else runFirstPagePendingRef.current = false;
        setIsLoadingRuns(false);
        setIsLoadingMoreRuns(false);
      }
    }
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    let active = true;
    setCapabilities(null);
    setCapabilityError(null);
    setIsLoadingCapabilities(true);
    setWorkspaces([]);
    setRuns([]);
    setWorkspaceCursor(null);
    setRunCursor(null);
    hasLoadedWorkspacesRef.current = false;

    realApiClient.getAgentCapabilities()
      .then((result) => {
        if (!active || generationRef.current !== generation) return;
        setCapabilities(result);
      })
      .catch((error) => {
        if (!active || generationRef.current !== generation) return;
        setCapabilityError(safeAgentError(error, 'request'));
      })
      .finally(() => {
        if (!active || generationRef.current !== generation) return;
        setIsLoadingCapabilities(false);
      });

    return () => {
      active = false;
      generationRef.current++;
      workspaceRequestRef.current++;
      runRequestRef.current++;
      workspaceDetailRequestRef.current++;
      runFirstPagePendingRef.current = false;
      runMorePendingRef.current = false;
    };
  }, []);

  const canManageWorkspaces = Boolean(capabilities && isAgentCapabilityAvailable(capabilities, 'workspaceManagement'));
  const canReadRuns = Boolean(capabilities && isAgentCapabilityAvailable(capabilities, 'runHistory'));
  const canAdmitRuns = Boolean(capabilities && isAgentCapabilityAvailable(capabilities, 'runAdmission'));
  const availableModes = modes.filter((mode) => capabilities && isAgentCapabilityAvailable(capabilities, mode.value));

  useEffect(() => {
    if (!capabilities) return;
    if (canManageWorkspaces) void fetchWorkspaces();
    else {
      hasLoadedWorkspacesRef.current = true;
      setIsLoadingWorkspaces(false);
    }
  }, [capabilities, canManageWorkspaces, fetchWorkspaces]);

  useLayoutEffect(() => {
    if (activeRunFilterRef.current !== linkedWorkspaceId) {
      activeRunFilterRef.current = linkedWorkspaceId;
      runRequestRef.current++;
      runFirstPagePendingRef.current = false;
      runMorePendingRef.current = false;
      setRunsForQuery(linkedWorkspaceId);
      setRuns([]);
      setRunCursor(null);
      setRunError(null);
      setIsLoadingRuns(false);
      setIsLoadingMoreRuns(false);
    }
    if (workspaceRouteRef.current !== linkedWorkspaceId) {
      workspaceRouteRef.current = linkedWorkspaceId;
      workspaceDetailRequestRef.current++;
      resolvingWorkspaceRef.current = null;
      setWorkspaceError(null);
    }
  }, [linkedWorkspaceId]);

  useEffect(() => {
    if (!capabilities) return;
    if (canReadRuns) void fetchRuns(undefined, false, linkedWorkspaceId || undefined);
    else {
      setRuns([]);
      setRunCursor(null);
      setIsLoadingRuns(false);
    }
  }, [capabilities, canReadRuns, linkedWorkspaceId, fetchRuns]);

  useEffect(() => {
    if (selectedMode && !availableModes.some((mode) => mode.value === selectedMode)) setSelectedMode(null);
  }, [availableModes, selectedMode]);

  useEffect(() => {
    if (!linkedWorkspaceId) {
      setWorkspaceError(null);
      resolvingWorkspaceRef.current = null;
      return;
    }

    if (workspaces.some((workspace) => workspace.id === linkedWorkspaceId)) {
      setWorkspaceError(null);
      resolvingWorkspaceRef.current = null;
      return;
    }

    if (!canManageWorkspaces || isLoadingWorkspaces || !hasLoadedWorkspacesRef.current ||
        resolvingWorkspaceRef.current === linkedWorkspaceId) return;

    resolvingWorkspaceRef.current = linkedWorkspaceId;
    const requestId = ++workspaceDetailRequestRef.current;
    realApiClient.getAgentWorkspace(linkedWorkspaceId)
      .then(({ workspace }) => {
        if (workspaceDetailRequestRef.current !== requestId || resolvingWorkspaceRef.current !== linkedWorkspaceId) return;
        if (workspace.id !== linkedWorkspaceId) {
          setWorkspaceError('Workspace not found or unavailable for this account.');
          resolvingWorkspaceRef.current = null;
          return;
        }
        setWorkspaces((current) => current.some((item) => item.id === workspace.id) ? current : [workspace, ...current]);
        setWorkspaceError(null);
        resolvingWorkspaceRef.current = null;
      })
      .catch((error) => {
        if (workspaceDetailRequestRef.current !== requestId || resolvingWorkspaceRef.current !== linkedWorkspaceId) return;
        setWorkspaceError(safeAgentError(error, 'workspace'));
        resolvingWorkspaceRef.current = null;
      });
  }, [linkedWorkspaceId, workspaces, canManageWorkspaces, isLoadingWorkspaces]);

  const selectWorkspace = (workspaceId: string) => {
    setWorkspaceError(null);
    navigate(workspaceId ? '/agent?workspace=' + encodeURIComponent(workspaceId) : '/agent');
  };

  const handleCreateWorkspace = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canManageWorkspaces || createWorkspaceRef.current) return;
    const generation = generationRef.current;
    createWorkspaceRef.current = true;
    setIsCreatingWorkspace(true);
    setWorkspaceError(null);
    const trimmedName = newWorkspaceName.trim();
    try {
      const input = {
        source: { kind: 'blank' as const },
        ...(trimmedName ? { name: trimmedName } : {}),
      };
      const { workspace } = await realApiClient.createAgentWorkspace(input);
      if (generationRef.current !== generation) return;
      setWorkspaces((current) => [workspace, ...current.filter((item) => item.id !== workspace.id)]);
      setNewWorkspaceName('');
      setIsCreateModalOpen(false);
      selectWorkspace(workspace.id);
    } catch (error) {
      if (generationRef.current !== generation) return;
      setWorkspaceError(safeAgentError(error, 'workspace'));
    } finally {
      createWorkspaceRef.current = false;
      if (generationRef.current === generation) setIsCreatingWorkspace(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submittingRef.current || isSubmitting) return;
    const normalizedTask = task.trim();
    if (!normalizedTask) {
      setActionError('Enter a task before admitting a run.');
      return;
    }
    const workspaceId = linkedWorkspaceId && workspaces.some((item) => item.id === linkedWorkspaceId)
      ? linkedWorkspaceId
      : '';
    if (!workspaceId) {
      setActionError('Select or create an owned workspace first.');
      return;
    }
    if (!canAdmitRuns) {
      setActionError('The backend has not enabled run admission.');
      return;
    }
    if (availableModes.length > 0 && (!selectedMode || !availableModes.some((mode) => mode.value === selectedMode))) {
      setActionError('Choose a mode the backend currently advertises.');
      return;
    }

    submittingRef.current = true;
    const generation = generationRef.current;
    setIsSubmitting(true);
    setActionError(null);
    const input: CreateAgentRun = {
      workspaceId,
      task: normalizedTask,
      ...(selectedMode ? { mode: selectedMode } : {}),
    };
    const fingerprint = JSON.stringify(input);
    if (!pendingAdmissionRef.current || pendingAdmissionRef.current.fingerprint !== fingerprint) {
      const key = typeof crypto !== 'undefined' && crypto.randomUUID
        ? 'agent-' + crypto.randomUUID()
        : 'agent-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
      pendingAdmissionRef.current = { fingerprint, key };
    }

    try {
      const { run } = await realApiClient.createAgentRun(input, {
        idempotencyKey: pendingAdmissionRef.current.key,
      });
      if (generationRef.current !== generation) return;
      pendingAdmissionRef.current = null;
      setTask('');
      navigate('/agent/runs/' + encodeURIComponent(run.id));
    } catch (error) {
      if (generationRef.current !== generation) return;
      // Only uncertain transport/server failures should replay the same logical
      // request. A definite 4xx (including an idempotency conflict) needs a new key.
      if (error instanceof ApiException && error.status < 500) pendingAdmissionRef.current = null;
      setActionError(safeAgentError(error, 'request'));
    } finally {
      submittingRef.current = false;
      if (generationRef.current === generation) setIsSubmitting(false);
    }
  };

  const activeWorkspaceId = linkedWorkspaceId && workspaces.some((workspace) => workspace.id === linkedWorkspaceId)
    ? linkedWorkspaceId
    : '';
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const isResolvingLinkedWorkspace = Boolean(linkedWorkspaceId && canManageWorkspaces && !activeWorkspaceId && !workspaceError);
  const runFilterKey = linkedWorkspaceId;
  const visibleRuns = runsForQuery === runFilterKey ? runs : [];
  const visibleRunCursor = runsForQuery === runFilterKey ? runCursor : null;
  const visibleRunError = runsForQuery === runFilterKey ? runError : null;
  const runtimeAvailable = Boolean(capabilities && isAgentCapabilityAvailable(capabilities, 'runExecution'));
  const cannotSubmit = isLoadingCapabilities || !canAdmitRuns || !activeWorkspaceId || isResolvingLinkedWorkspace ||
    isSubmitting || (availableModes.length > 0 && selectedMode === null);

  return (
    <main data-testid="agent-manager-view" style={{ height: '100%', overflowY: 'auto', padding: '32px 24px', background: 'var(--giga-bg, #0B1220)' }}>
      <div style={{ maxWidth: 1040, margin: '0 auto', width: '100%' }}>
        <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 24 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
              <h1 style={{ margin: 0, fontSize: 26, color: 'var(--giga-text, #F8FAFC)' }}>GigaAgent</h1>
              <Badge status="real" data-testid="agent-runtime-badge">Real API</Badge>
            </div>
            <p style={{ color: 'var(--giga-text-secondary, #94A3B8)', lineHeight: 1.5, maxWidth: 700 }}>
              Workspaces and run history are loaded from the authenticated Agent API. A blank workspace is a durable metadata record; file storage and Cloud execution depend on backend capabilities.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => setIsCreateModalOpen(true)}
            disabled={!canManageWorkspaces || isLoadingCapabilities}
            data-testid="create-workspace-btn"
          >
            New Workspace
          </Button>
        </header>

        {isLoadingCapabilities && <p role="status" aria-live="polite" data-testid="agent-capabilities-loading">Checking Agent capabilities…</p>}
        {capabilityError && <div style={{ marginBottom: 16 }}><Alert type="error" title="Agent API unavailable" message={capabilityError} /></div>}

        {capabilities && !runtimeAvailable && canAdmitRuns && (
          <div style={{ marginBottom: 20 }} data-testid="real-mode-runtime-warning">
            <Alert
              type="warning"
              title="Cloud execution runtime unavailable"
              message="The backend accepts durable run admissions but does not advertise execution. The UI will show the saved backend status, including RUNTIME_UNAVAILABLE, and will not simulate a run."
            />
          </div>
        )}
        {capabilities && !canManageWorkspaces && (
          <div style={{ marginBottom: 20 }} data-testid="workspace-capability-warning">
            <Alert type="info" title="Workspace management unavailable" message={capabilityReason(capabilities, 'workspaceManagement')} />
          </div>
        )}
        {workspaceError && <div style={{ marginBottom: 16 }}><Alert type="error" message={workspaceError} /></div>}
        {actionError && <div style={{ marginBottom: 16 }}><Alert type="error" message={actionError} /></div>}

        <section
          aria-labelledby="agent-workspaces-heading"
          data-testid="real-workspaces-section"
          style={{ background: 'var(--giga-surface, #111C2D)', border: '1px solid var(--giga-border, #1E293B)', borderRadius: 12, padding: 20, marginBottom: 20 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <h2 id="agent-workspaces-heading" style={{ margin: 0, color: 'var(--giga-text, #F8FAFC)', fontSize: 18 }}>Your workspaces</h2>
              <p style={{ marginBottom: 0, color: 'var(--giga-text-secondary, #94A3B8)', fontSize: 13 }}>Owned workspace records from the backend.</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void fetchWorkspaces()} disabled={!canManageWorkspaces || isLoadingWorkspaces} data-testid="refresh-workspaces-btn">
              Refresh
            </Button>
          </div>

          {isResolvingLinkedWorkspace && <p role="status" aria-live="polite" data-testid="workspace-selection-pending">Resolving linked workspace…</p>}
          {isLoadingWorkspaces && <p role="status" aria-live="polite" data-testid="workspaces-loading">Loading workspaces…</p>}
          {!isLoadingWorkspaces && canManageWorkspaces && workspaces.length === 0 && (
            <p data-testid="workspaces-empty" style={{ color: 'var(--giga-text-secondary, #94A3B8)' }}>No workspaces yet. Create a blank workspace to admit a task.</p>
          )}
          {workspaces.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 12, marginTop: 16 }}>
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  onClick={() => selectWorkspace(workspace.id)}
                  aria-pressed={workspace.id === activeWorkspaceId}
                  disabled={isResolvingLinkedWorkspace}
                  data-testid={'workspace-card-' + workspace.id}
                  style={{
                    textAlign: 'left',
                    padding: 14,
                    borderRadius: 8,
                    border: '1px solid ' + (workspace.id === activeWorkspaceId ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-border, #1E293B)'),
                    background: workspace.id === activeWorkspaceId ? 'rgba(59, 130, 246, 0.10)' : 'var(--giga-surface-muted, #18263A)',
                    color: 'var(--giga-text, #F8FAFC)',
                    cursor: 'pointer',
                  }}
                >
                  <strong>{workspace.name}</strong>
                  <span style={{ display: 'block', marginTop: 8, color: 'var(--giga-text-secondary, #94A3B8)', fontSize: 12 }}>
                    Blank workspace · Revision {workspace.revision}
                  </span>
                  <span style={{ display: 'block', marginTop: 4, color: 'var(--giga-text-secondary, #94A3B8)', fontSize: 12 }}>
                    Created {dateLabel(workspace.createdAt)}
                  </span>
                  <span style={{ display: 'block', marginTop: 4, color: 'var(--giga-text-secondary, #94A3B8)', fontSize: 12 }}>
                    Updated {dateLabel(workspace.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
          {workspaceCursor && (
            <div style={{ marginTop: 14 }}>
              <Button variant="outline" size="sm" onClick={() => void fetchWorkspaces(workspaceCursor, true)} loading={isLoadingMoreWorkspaces} data-testid="load-more-workspaces-btn">
                Load more workspaces
              </Button>
            </div>
          )}
        </section>

        <form
          onSubmit={handleSubmit}
          data-testid="real-agent-task-form"
          style={{ background: 'var(--giga-surface, #111C2D)', border: '1px solid var(--giga-border, #1E293B)', borderRadius: 12, padding: 20, marginBottom: 20 }}
        >
          <h2 style={{ marginTop: 0, fontSize: 18, color: 'var(--giga-text, #F8FAFC)' }}>Admit a task</h2>
          <label htmlFor="real-agent-workspace" style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>Workspace</label>
          <select
            id="real-agent-workspace"
            aria-label="Workspace"
            value={activeWorkspaceId}
            onChange={(event) => selectWorkspace(event.target.value)}
            disabled={!canManageWorkspaces || isLoadingWorkspaces || isSubmitting || isResolvingLinkedWorkspace}
            data-testid="active-workspace-select"
            style={{ width: '100%', minHeight: 40, marginBottom: 8, padding: '8px 10px', borderRadius: 6 }}
          >
            <option value="">Select a workspace</option>
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
          {selectedWorkspace && (
            <p data-testid="selected-workspace-metadata" style={{ marginTop: 4, marginBottom: 16, color: 'var(--giga-text-secondary, #94A3B8)', fontSize: 12 }}>
              Blank source · Revision {selectedWorkspace.revision} · Updated {dateLabel(selectedWorkspace.updatedAt)}
            </p>
          )}
          <Textarea
            id="real-agent-task-input"
            label="Task"
            value={task}
            onChange={(event) => setTask(event.target.value)}
            rows={4}
            maxLength={16384}
            disabled={isSubmitting || !canAdmitRuns}
            placeholder="Describe the task to record with this workspace."
            data-testid="agent-task-input"
          />

          <fieldset style={{ border: 0, padding: 0, margin: '18px 0 0' }}>
            <legend style={{ fontWeight: 600, marginBottom: 8 }}>Mode capabilities</legend>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: 10 }}>
              {modes.map((mode) => {
                const available = availableModes.some((item) => item.value === mode.value);
                return (
                  <label
                    key={mode.value}
                    data-testid={'mode-option-' + mode.value}
                    style={{ display: 'block', border: '1px solid var(--giga-border, #1E293B)', borderRadius: 8, padding: 12, opacity: available ? 1 : 0.58 }}
                  >
                    <input
                      type="radio"
                      name="agent-mode"
                      value={mode.value}
                      checked={selectedMode === mode.value}
                      disabled={!available || isSubmitting}
                      onChange={() => setSelectedMode(mode.value)}
                    />{' '}
                    <strong>{mode.title}</strong>
                    <span style={{ display: 'block', marginTop: 5, fontSize: 12, color: 'var(--giga-text-secondary, #94A3B8)' }}>
                      {available ? mode.detail : 'Not enabled by the backend.'}
                    </span>
                  </label>
                );
              })}
            </div>
            {availableModes.length === 0 && canAdmitRuns && (
              <p data-testid="admission-only-notice" style={{ fontSize: 13, color: 'var(--giga-text-secondary, #94A3B8)' }}>
                No execution mode is currently enabled. The API defaults an admitted run to Ask and returns its real persisted status.
              </p>
            )}
          </fieldset>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 18, alignItems: 'center' }}>
            <Button type="submit" disabled={cannotSubmit} loading={isSubmitting} data-testid="launch-agent-btn">
              {runtimeAvailable ? 'Launch Agent Task' : 'Admit Run (Execution Unavailable)'}
            </Button>
            {!activeWorkspaceId && <span style={{ fontSize: 12, color: 'var(--giga-text-secondary, #94A3B8)' }}>Choose or create a workspace first.</span>}
          </div>
        </form>

        <section aria-labelledby="agent-run-history-heading" data-testid="real-run-history-section" style={{ background: 'var(--giga-surface, #111C2D)', border: '1px solid var(--giga-border, #1E293B)', borderRadius: 12, padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h2 id="agent-run-history-heading" style={{ margin: 0, fontSize: 18, color: 'var(--giga-text, #F8FAFC)' }}>Recent runs</h2>
              <p style={{ marginBottom: 0, fontSize: 13, color: 'var(--giga-text-secondary, #94A3B8)' }}>
                {selectedWorkspace ? 'Filtered to ' + selectedWorkspace.name : 'Owned runs from the backend.'}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void fetchRuns(undefined, false, runFilterKey || undefined)} disabled={!canReadRuns || isLoadingRuns || isLoadingMoreRuns} data-testid="refresh-runs-btn">
              Refresh
            </Button>
          </div>
          {capabilities && !canReadRuns && <p data-testid="run-history-unavailable">{capabilityReason(capabilities, 'runHistory')}</p>}
          {isLoadingRuns && <p role="status" aria-live="polite" data-testid="runs-loading">Loading runs…</p>}
          {visibleRunError && <div style={{ marginTop: 12 }}><Alert type="error" message={visibleRunError} /></div>}
          {!isLoadingRuns && canReadRuns && visibleRuns.length === 0 && <p data-testid="runs-empty" style={{ color: 'var(--giga-text-secondary, #94A3B8)' }}>No runs for this view yet.</p>}
          {visibleRuns.length > 0 && (
            <ul data-testid="real-runs-list" style={{ listStyle: 'none', padding: 0, margin: '14px 0 0', display: 'grid', gap: 10 }}>
              {visibleRuns.map((run) => (
                <li key={run.id} style={{ border: '1px solid var(--giga-border, #1E293B)', borderRadius: 8, padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <button type="button" onClick={() => navigate('/agent/runs/' + encodeURIComponent(run.id))} style={{ padding: 0, border: 0, background: 'transparent', color: 'var(--giga-primary, #60A5FA)', textAlign: 'left', cursor: 'pointer', font: 'inherit' }}>
                      {run.task}
                    </button>
                    <div style={{ color: 'var(--giga-text-secondary, #94A3B8)', fontSize: 12, marginTop: 5 }}>
                      {run.mode.toUpperCase()} · {dateLabel(run.createdAt)}
                    </div>
                  </div>
                  <Badge status={run.status} data-testid={'run-list-status-' + run.id}>{run.status}</Badge>
                </li>
              ))}
            </ul>
          )}
          {(visibleRunCursor || (runsForQuery === runFilterKey && isLoadingRuns)) && (
            <div style={{ marginTop: 14 }}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { if (visibleRunCursor) void fetchRuns(visibleRunCursor, true, runFilterKey || undefined); }}
                disabled={isLoadingRuns || isLoadingMoreRuns || !visibleRunCursor}
                loading={isLoadingMoreRuns}
                data-testid="load-more-runs-btn"
              >
                Load more runs
              </Button>
            </div>
          )}
        </section>
      </div>

      <Modal isOpen={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)} title="Create blank workspace">
        <form onSubmit={handleCreateWorkspace} style={{ padding: 20 }}>
          <p style={{ color: 'var(--giga-text-secondary, #94A3B8)', marginTop: 0 }}>
            This creates an owned workspace record. It does not create files or start a runtime.
          </p>
          <Input
            id="new-real-workspace-name"
            label="Workspace name (optional)"
            value={newWorkspaceName}
            maxLength={255}
            onChange={(event) => setNewWorkspaceName(event.target.value)}
            disabled={isCreatingWorkspace}
            data-testid="new-workspace-name-input"
          />
          {workspaceError && <div style={{ marginTop: 12 }}><Alert type="error" message={workspaceError} /></div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
            <Button variant="ghost" onClick={() => setIsCreateModalOpen(false)} disabled={isCreatingWorkspace}>Cancel</Button>
            <Button type="submit" loading={isCreatingWorkspace} disabled={!canManageWorkspaces} data-testid="confirm-create-workspace-btn">Create workspace</Button>
          </div>
        </form>
      </Modal>
    </main>
  );
};

export const AgentRealRunView: React.FC = () => {
  const { params, navigate } = useRouter();
  const runId = params.runId;
  const [run, setRun] = useState<AgentRun | null>(null);
  const [workspace, setWorkspace] = useState<AgentWorkspace | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const loadRun = useCallback(async () => {
    const requestId = ++requestRef.current;
    setRun(null);
    setWorkspace(null);
    setError(null);
    setWorkspaceError(null);
    if (!runId) {
      setError('Run not found or unavailable for this account.');
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const response = await realApiClient.getAgentRun(runId);
      if (requestRef.current !== requestId) return;
      if (response.run.id !== runId) {
        setError('The Agent API returned a different run than requested.');
        return;
      }
      setRun(response.run);
      try {
        const workspaceResponse = await realApiClient.getAgentWorkspace(response.run.workspaceId);
        if (requestRef.current !== requestId) return;
        setWorkspace(workspaceResponse.workspace);
      } catch (workspaceFailure) {
        if (requestRef.current !== requestId) return;
        setWorkspaceError(safeAgentError(workspaceFailure, 'workspace'));
      }
    } catch (failure) {
      if (requestRef.current !== requestId) return;
      setError(safeAgentError(failure, 'run'));
    } finally {
      if (requestRef.current === requestId) setIsLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void loadRun();
    return () => { requestRef.current++; };
  }, [loadRun]);

  if (isLoading) {
    return <main role="status" aria-live="polite" data-testid="agent-run-loading" style={{ padding: 32 }}>Loading run from the Agent API…</main>;
  }

  if (error || !run) {
    return (
      <main data-testid="agent-run-not-found" style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
        <Alert type="error" title="Run unavailable" message={error ?? 'Run not found or unavailable for this account.'} />
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <Button variant="outline" onClick={() => navigate('/agent')}>Back to Agent</Button>
          <Button variant="outline" onClick={() => void loadRun()}>Retry</Button>
        </div>
      </main>
    );
  }

  return (
    <main data-testid="agent-run-view" style={{ height: '100%', overflowY: 'auto', padding: '28px 24px', background: 'var(--giga-bg, #0B1220)' }}>
      <div style={{ maxWidth: 1000, margin: '0 auto', width: '100%' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 18 }}>
          <Button variant="outline" onClick={() => navigate('/agent?workspace=' + encodeURIComponent(run.workspaceId))}>Back to workspace</Button>
          <Button variant="outline" onClick={() => void loadRun()} data-testid="refresh-run-btn">Refresh run</Button>
          <Badge status="real" data-testid="real-run-badge">Real API</Badge>
          <Badge status={run.status} data-testid="run-status-badge">{run.status}</Badge>
        </div>

        <section style={{ background: 'var(--giga-surface, #111C2D)', border: '1px solid var(--giga-border, #1E293B)', borderRadius: 12, padding: 22 }}>
          <h1 data-testid="run-task-title" style={{ marginTop: 0, color: 'var(--giga-text, #F8FAFC)', fontSize: 22, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{run.task}</h1>
          <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 210px), 1fr))', gap: 12 }}>
            <div><dt style={{ color: 'var(--giga-text-secondary, #94A3B8)' }}>Mode</dt><dd data-testid="run-mode-badge">{run.mode}</dd></div>
            <div><dt style={{ color: 'var(--giga-text-secondary, #94A3B8)' }}>Runtime</dt><dd>{run.runtime}</dd></div>
            <div><dt style={{ color: 'var(--giga-text-secondary, #94A3B8)' }}>Model</dt><dd>{run.modelId}</dd></div>
            <div><dt style={{ color: 'var(--giga-text-secondary, #94A3B8)' }}>Created</dt><dd>{dateLabel(run.createdAt)}</dd></div>
            <div><dt style={{ color: 'var(--giga-text-secondary, #94A3B8)' }}>Updated</dt><dd>{dateLabel(run.updatedAt)}</dd></div>
            {run.finishedAt && <div><dt style={{ color: 'var(--giga-text-secondary, #94A3B8)' }}>Finished</dt><dd>{dateLabel(run.finishedAt)}</dd></div>}
            <div>
              <dt style={{ color: 'var(--giga-text-secondary, #94A3B8)' }}>Workspace</dt>
              <dd>
                <button type="button" onClick={() => navigate('/agent/workspaces/' + encodeURIComponent(run.workspaceId))} style={{ padding: 0, border: 0, background: 'transparent', color: 'var(--giga-primary, #60A5FA)', cursor: 'pointer', font: 'inherit' }}>
                  {workspace?.name ?? run.workspaceId}
                </button>
                {workspace && <span> · Revision {workspace.revision}</span>}
              </dd>
            </div>
          </dl>
          {workspaceError && <p data-testid="run-workspace-warning" style={{ color: 'var(--giga-text-secondary, #94A3B8)' }}>{workspaceError}</p>}
          {run.error && (
            <div data-testid="real-run-notice" style={{ marginTop: 16 }}>
              <Alert type="error" title={run.error.code} message={run.error.message} />
              <p data-testid="run-error-message" style={{ marginBottom: 0, overflowWrap: 'anywhere' }}>{run.error.code}: {run.error.message}</p>
            </div>
          )}
          {run.result && (
            <section aria-labelledby="run-result-heading" data-testid="real-run-result" style={{ marginTop: 20 }}>
              <h2 id="run-result-heading" style={{ fontSize: 17 }}>Backend result</h2>
              <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{run.result.summary}</p>
              <h3 style={{ fontSize: 14 }}>Verified checks</h3>
              {run.result.verifiedChecks.length ? (
                <ul>{run.result.verifiedChecks.map((check, index) => (
                  <li key={check.name + '-' + index}>
                    {check.name}: {check.outcome}{check.summary ? ' — ' + check.summary : ''}
                  </li>
                ))}</ul>
              ) : <p>No verification checks were reported.</p>}
              {run.result.artifactIds.length > 0 && (
                <div data-testid="real-artifact-references">
                  <h3 style={{ fontSize: 14 }}>Artifact references</h3>
                  <ul>{run.result.artifactIds.map((artifactId) => <li key={artifactId}>{artifactId}</li>)}</ul>
                  <p>Artifact download is not available through the current API.</p>
                </div>
              )}
            </section>
          )}
          {!run.error && !run.result && (
            <p data-testid="real-run-no-output" style={{ color: 'var(--giga-text-secondary, #94A3B8)' }}>
              No result has been returned by the backend. This page does not synthesize plans, files, checks or artifacts.
            </p>
          )}
          {run.error?.code === 'RUNTIME_UNAVAILABLE' && (
            <p data-testid="runtime-unavailable-state" style={{ color: 'var(--giga-text-secondary, #94A3B8)' }}>
              The admission is recorded, but no Cloud execution was performed.
            </p>
          )}
        </section>
        <AgentMessageThread
          key={run.id}
          run={run}
          onStartNewRun={() => navigate('/agent?workspace=' + encodeURIComponent(run.workspaceId))}
          onRefreshRun={loadRun}
        />
      </div>
    </main>
  );
};
