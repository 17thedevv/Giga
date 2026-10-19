import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from '../../app/router.js';
import { useApiMode } from '../../app/context/ApiModeContext.js';
import { realApiClient } from '../../lib/api/client.js';
import { isAgentCapabilityAvailable } from '../../lib/api/agent-contract.js';
import type { AgentMode, AgentWorkspace } from '../../lib/api/agent-contract.js';
import {
  workspaceFixtureStore,
  type AgentRunDetail,
} from './workspace-fixtures.js';
import { Textarea } from '../../components/Textarea.js';
import { Input } from '../../components/Input.js';
import { Button } from '../../components/Button.js';
import { Badge } from '../../components/Badge.js';
import { Alert } from '../../components/Alert.js';
import { Modal } from '../../components/Modal.js';
import {
  PlusIcon,
  PlayIcon,
  ArrowRightIcon,
} from '../../components/Icons.js';

const PROMPT_EXAMPLES = [
  'Build a responsive React task manager with add, edit, complete and delete functionality.',
  'Analyze a CSV dataset and summarize findings with statistical distributions.',
  'Create a project documentation website with responsive navigation and search.',
  'Review a codebase and suggest improvements for performance and error handling.',
];

export const AgentLauncherView: React.FC = () => {
  const { params, navigate } = useRouter();
  const { mode: apiMode } = useApiMode();

  const [task, setTask] = useState('');
  const [selectedMode, setSelectedMode] = useState<AgentMode>('execute');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('');
  const [workspaceSourceKind, setWorkspaceSourceKind] = useState<'blank' | 'upload' | 'import'>('blank');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [workspaces, setWorkspaces] = useState<AgentWorkspace[]>([]);
  const [runs, setRuns] = useState<AgentRunDetail[]>([]);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [sourceNotice, setSourceNotice] = useState<string | null>(null);

  // New Workspace Modal State
  const [isNewWsModalOpen, setIsNewWsModalOpen] = useState(false);
  const [newWsName, setNewWsName] = useState('');

  // Real Mode Capabilities State
  const [realExecutionAvailable, setRealExecutionAvailable] = useState<boolean>(false);
  const [isLoadingCapabilities, setIsLoadingCapabilities] = useState<boolean>(false);

  // Request Fencing Ref for Real/Mock Isolation
  const activeRequestIdRef = useRef<number>(0);

  // Load Workspaces and Runs with generation fencing
  const loadData = useCallback(() => {
    const requestId = ++activeRequestIdRef.current;

    if (apiMode === 'real') {
      // 1. Immediately clear Mock/Demo data upon entering Real mode (before awaiting)
      setWorkspaces([]);
      setRuns([]);
      setSelectedWorkspaceId('');
      setRealExecutionAvailable(false);
      setIsLoadingCapabilities(true);

      realApiClient
        .getAgentCapabilities()
        .then((caps) => {
          if (activeRequestIdRef.current !== requestId) return;
          const available = isAgentCapabilityAvailable(caps, 'runExecution');
          setRealExecutionAvailable(available);
        })
        .catch(() => {
          if (activeRequestIdRef.current !== requestId) return;
          setRealExecutionAvailable(false);
        })
        .finally(() => {
          if (activeRequestIdRef.current !== requestId) return;
          setIsLoadingCapabilities(false);
        });
    } else {
      // Mock / Demo mode
      setRealExecutionAvailable(false);
      setIsLoadingCapabilities(false);
      const wsList = workspaceFixtureStore.getWorkspaces();
      setWorkspaces(wsList);
      const targetWsId = params?.workspaceId || (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('workspace') : null);
      if (targetWsId && wsList.some((w) => w.id === targetWsId)) {
        setSelectedWorkspaceId(targetWsId);
      } else {
        // P2: Default new-task flow clearly starts from a new blank workspace ('')
        setSelectedWorkspaceId('');
      }
      setRuns(workspaceFixtureStore.getRuns());
    }
  }, [apiMode, params?.workspaceId]);

  useEffect(() => {
    loadData();
    return () => {
      // Invalidate pending in-flight requests on unmount or deps change
      activeRequestIdRef.current++;
    };
  }, [loadData]);

  // Handle Workspace Source Switching (Blank vs Upload vs Import)
  const handleSelectSourceKind = (kind: 'blank' | 'upload' | 'import') => {
    setWorkspaceSourceKind(kind);
    if (kind === 'upload') {
      setSourceNotice(
        'Upload Files is a future capability placeholder ("Coming later"). Workspace upload is currently not operational in this milestone.'
      );
    } else if (kind === 'import') {
      setSourceNotice(
        'Git Repository Import is an optional future capability placeholder ("Coming later"). A GitHub repository is never required to use GigaAgent.'
      );
    } else {
      setSourceNotice(null);
    }
  };

  // Handle Task Launch
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    const trimmedTask = task.trim();
    if (!trimmedTask) {
      setErrorBanner('Please describe what you want GigaAgent to do.');
      return;
    }

    if (trimmedTask.length < 10) {
      setErrorBanner('Task description must be at least 10 characters long.');
      return;
    }

    if (workspaceSourceKind !== 'blank') {
      setErrorBanner(
        `Selected workspace source "${workspaceSourceKind}" is not operational. Please select Blank Workspace.`
      );
      return;
    }

    if (apiMode === 'real') {
      setErrorBanner(
        'Cloud execution runtime is currently unavailable in Real Mode. Run launching is disabled. Toggle to Demo Mode (Mock) to experience the full interactive workspace-first Agent lifecycle.'
      );
      return;
    }

    setIsSubmitting(true);
    setErrorBanner(null);

    try {
      let activeWsId = selectedWorkspaceId;
      if (!activeWsId) {
        // Starts from a fresh blank workspace!
        const freshWs = workspaceFixtureStore.createWorkspace();
        activeWsId = freshWs.id;
      }
      const newRun = workspaceFixtureStore.createDemoRun({
        workspaceId: activeWsId,
        task: trimmedTask,
        mode: selectedMode,
      });

      // Navigate to the newly launched run
      navigate(`/agent/runs/${newRun.id}`);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to launch agent run');
      setIsSubmitting(false);
    }
  };

  // Handle Create Workspace
  const handleCreateWorkspace = () => {
    const newWs = workspaceFixtureStore.createWorkspace(newWsName);
    setWorkspaces(workspaceFixtureStore.getWorkspaces());
    setSelectedWorkspaceId(newWs.id);
    setIsNewWsModalOpen(false);
    setNewWsName('');
  };

  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId) || null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        overflowY: 'auto',
        backgroundColor: 'var(--giga-bg, #0B1220)',
        padding: '32px 24px',
      }}
      data-testid="agent-manager-view"
    >
      <div style={{ maxWidth: '980px', margin: '0 auto', width: '100%' }}>
        {/* Page Header */}
        <div style={{ marginBottom: '28px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <h1 style={{ fontSize: '26px', fontWeight: 700, color: 'var(--giga-text, #F8FAFC)', margin: 0 }}>
                GigaAgent
              </h1>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                  padding: '3px 8px',
                  borderRadius: '9999px',
                  backgroundColor: apiMode === 'real' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(59, 130, 246, 0.15)',
                  color: apiMode === 'real' ? 'var(--giga-danger, #EF4444)' : 'var(--giga-primary, #3B82F6)',
                  border: `1px solid ${apiMode === 'real' ? 'rgba(239, 68, 68, 0.35)' : 'rgba(59, 130, 246, 0.35)'}`,
                }}
                data-testid="agent-runtime-badge"
              >
                {apiMode === 'real' ? 'Real API Mode (Unavailable)' : 'Cloud Workspace (Demo Simulation)'}
              </span>
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsNewWsModalOpen(true)}
                icon={<PlusIcon size={14} />}
                disabled={apiMode === 'real'}
                data-testid="create-workspace-btn"
              >
                New Workspace
              </Button>
            </div>
          </div>
          <p style={{ fontSize: '14px', color: 'var(--giga-text-secondary, #94A3B8)', margin: 0, maxWidth: '680px', lineHeight: 1.5 }}>
            Work with an AI agent in a dedicated workspace to plan, build, analyze and verify tasks.
          </p>
        </div>

        {/* Real Mode Notice */}
        {apiMode === 'real' && !realExecutionAvailable && (
          <div style={{ marginBottom: '24px' }} data-testid="real-mode-runtime-warning">
            <Alert
              type="error"
              title="Cloud Execution Runtime Unavailable in Real Mode"
              message={
                isLoadingCapabilities
                  ? 'Checking Real Mode agent capabilities...'
                  : 'Backend Agent execution is currently unavailable in Real Mode (Frontend control-plane integration is tracked under Linear 17T-48; Cloud sandbox execution runtime requires separate backend infrastructure readiness). Run launching is disabled. Switch to Demo Mode (Mock) in the header to interact with the workspace-first agent experience.'
              }
            />
          </div>
        )}

        {/* Global Error Banner */}
        {errorBanner && (
          <div style={{ marginBottom: '20px' }} data-testid="agent-error-banner">
            <Alert type="error" message={errorBanner} onDismiss={() => setErrorBanner(null)} />
          </div>
        )}

        {/* Source Placeholder Notice */}
        {sourceNotice && (
          <div style={{ marginBottom: '20px' }} data-testid="source-placeholder-notice">
            <Alert type="warning" message={sourceNotice} onDismiss={() => setSourceNotice(null)} />
          </div>
        )}

        {/* Main Task Composer & Workspace Launcher Form */}
        <form
          onSubmit={handleSubmit}
          className="g-card"
          style={{
            backgroundColor: 'var(--giga-surface, #111C2D)',
            border: '1px solid var(--giga-border, #1E293B)',
            borderRadius: 'var(--giga-radius-lg, 12px)',
            padding: '24px',
            marginBottom: '36px',
            boxShadow: 'var(--giga-shadow-sm, 0 1px 3px rgba(0,0,0,0.1))',
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
          }}
          data-testid="task-composer-card"
        >
          {/* Section 1: Workspace Selection */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
              <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                1. Select Workspace Type
              </label>
              {workspaces.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)' }}>Target:</span>
                  <select
                    value={selectedWorkspaceId}
                    onChange={(e) => setSelectedWorkspaceId(e.target.value)}
                    style={{
                      backgroundColor: 'var(--giga-surface-muted, #18263A)',
                      color: 'var(--giga-text, #F8FAFC)',
                      border: '1px solid var(--giga-border, #1E293B)',
                      borderRadius: '6px',
                      padding: '4px 8px',
                      fontSize: '12px',
                    }}
                    data-testid="active-workspace-select"
                  >
                    <option value="">New Blank Workspace (Default)</option>
                    {workspaces.map((ws) => (
                      <option key={ws.id} value={ws.id}>
                        {ws.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* 3 Source Options */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: '12px',
              }}
              data-testid="workspace-source-options"
            >
              {/* Option 1: Blank Workspace (Default) */}
              <button
                type="button"
                onClick={() => handleSelectSourceKind('blank')}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  padding: '14px',
                  borderRadius: 'var(--giga-radius-md, 8px)',
                  border: `1px solid ${workspaceSourceKind === 'blank' ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-border, #1E293B)'}`,
                  backgroundColor: workspaceSourceKind === 'blank' ? 'rgba(59, 130, 246, 0.08)' : 'var(--giga-surface-muted, #18263A)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 0.15s ease',
                }}
                data-testid="source-blank-workspace"
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: '4px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                    Blank Workspace
                  </span>
                  <span style={{ fontSize: '10px', color: 'var(--giga-primary, #3B82F6)', fontWeight: 700 }}>
                    DEFAULT
                  </span>
                </div>
                <span style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)' }}>
                  Fresh isolated directory. No repository or GitHub account required.
                </span>
              </button>

              {/* Option 2: Upload Files (Placeholder) */}
              <button
                type="button"
                onClick={() => handleSelectSourceKind('upload')}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  padding: '14px',
                  borderRadius: 'var(--giga-radius-md, 8px)',
                  border: `1px solid ${workspaceSourceKind === 'upload' ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-border, #1E293B)'}`,
                  backgroundColor: workspaceSourceKind === 'upload' ? 'rgba(59, 130, 246, 0.08)' : 'var(--giga-surface-muted, #18263A)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  opacity: 0.85,
                  transition: 'all 0.15s ease',
                }}
                data-testid="source-upload-files"
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: '4px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                    Upload Files
                  </span>
                  <span style={{ fontSize: '10px', color: 'var(--giga-text-secondary, #94A3B8)', fontStyle: 'italic' }}>
                    Coming later
                  </span>
                </div>
                <span style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)' }}>
                  Upload a ZIP or folder to initialize a workspace.
                </span>
              </button>

              {/* Option 3: Import Git Repository (Placeholder) */}
              <button
                type="button"
                onClick={() => handleSelectSourceKind('import')}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  padding: '14px',
                  borderRadius: 'var(--giga-radius-md, 8px)',
                  border: `1px solid ${workspaceSourceKind === 'import' ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-border, #1E293B)'}`,
                  backgroundColor: workspaceSourceKind === 'import' ? 'rgba(59, 130, 246, 0.08)' : 'var(--giga-surface-muted, #18263A)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  opacity: 0.85,
                  transition: 'all 0.15s ease',
                }}
                data-testid="source-import-git"
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: '4px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                    Import Git Repository
                  </span>
                  <span style={{ fontSize: '10px', color: 'var(--giga-text-secondary, #94A3B8)', fontStyle: 'italic' }}>
                    Optional / Coming later
                  </span>
                </div>
                <span style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)' }}>
                  Optional integration for authorized Git sources.
                </span>
              </button>
            </div>
          </div>

          {/* Section 2: Task Instruction Input */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <label htmlFor="agent-task-input" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                2. Describe Task
              </label>
              <span style={{ fontSize: '11px', color: 'var(--giga-text-secondary, #94A3B8)' }}>
                Minimum 10 characters
              </span>
            </div>

            <Textarea
              id="agent-task-input"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Describe what you want GigaAgent to do..."
              rows={4}
              required
              disabled={isSubmitting || apiMode === 'real'}
              data-testid="agent-task-input"
            />

            {/* Prompt Suggestion Pills */}
            <div style={{ marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              <span style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)', alignSelf: 'center' }}>
                Examples:
              </span>
              {PROMPT_EXAMPLES.map((example, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setTask(example)}
                  style={{
                    backgroundColor: 'var(--giga-surface-muted, #18263A)',
                    border: '1px solid var(--giga-border, #1E293B)',
                    borderRadius: '9999px',
                    padding: '4px 10px',
                    fontSize: '11px',
                    color: 'var(--giga-text-secondary, #CBD5E1)',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  data-testid={`prompt-example-${i}`}
                >
                  {example.slice(0, 36)}...
                </button>
              ))}
            </div>
          </div>

          {/* Section 3: Agent Mode Selection */}
          <div data-testid="agent-mode-selector">
            <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)', display: 'block', marginBottom: '8px' }}>
              3. Agent Mode
            </label>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: '10px',
              }}
            >
              {/* Ask Mode */}
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  padding: '12px',
                  borderRadius: 'var(--giga-radius-md, 8px)',
                  border: `1px solid ${selectedMode === 'ask' ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-border, #1E293B)'}`,
                  backgroundColor: selectedMode === 'ask' ? 'rgba(59, 130, 246, 0.08)' : 'var(--giga-surface-muted, #18263A)',
                  cursor: 'pointer',
                }}
                data-testid="mode-card-ask"
              >
                <input
                  type="radio"
                  name="agent-mode"
                  value="ask"
                  checked={selectedMode === 'ask'}
                  onChange={() => setSelectedMode('ask')}
                  style={{ marginTop: '3px' }}
                  data-testid="radio-mode-ask"
                />
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                    Ask
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--giga-text-secondary, #94A3B8)', marginTop: '2px' }}>
                    Explore and answer questions. No workspace modifications.
                  </div>
                </div>
              </label>

              {/* Plan Mode */}
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  padding: '12px',
                  borderRadius: 'var(--giga-radius-md, 8px)',
                  border: `1px solid ${selectedMode === 'plan' ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-border, #1E293B)'}`,
                  backgroundColor: selectedMode === 'plan' ? 'rgba(59, 130, 246, 0.08)' : 'var(--giga-surface-muted, #18263A)',
                  cursor: 'pointer',
                }}
                data-testid="mode-card-plan"
              >
                <input
                  type="radio"
                  name="agent-mode"
                  value="plan"
                  checked={selectedMode === 'plan'}
                  onChange={() => setSelectedMode('plan')}
                  style={{ marginTop: '3px' }}
                  data-testid="radio-mode-plan"
                />
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                    Plan
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--giga-text-secondary, #94A3B8)', marginTop: '2px' }}>
                    Analyze the task and propose a structured plan. No file modifications.
                  </div>
                </div>
              </label>

              {/* Execute Mode */}
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  padding: '12px',
                  borderRadius: 'var(--giga-radius-md, 8px)',
                  border: `1px solid ${selectedMode === 'execute' ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-border, #1E293B)'}`,
                  backgroundColor: selectedMode === 'execute' ? 'rgba(59, 130, 246, 0.08)' : 'var(--giga-surface-muted, #18263A)',
                  cursor: 'pointer',
                }}
                data-testid="mode-card-execute"
              >
                <input
                  type="radio"
                  name="agent-mode"
                  value="execute"
                  checked={selectedMode === 'execute'}
                  onChange={() => setSelectedMode('execute')}
                  style={{ marginTop: '3px' }}
                  data-testid="radio-mode-execute"
                />
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                    Execute
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--giga-text-secondary, #94A3B8)', marginTop: '2px' }}>
                    Perform permitted sandbox work, create files and verify outcomes.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Section 4: Runtime Environment & Security Boundaries */}
          <div
            style={{
              padding: '14px',
              backgroundColor: 'var(--giga-surface-muted, #18263A)',
              borderRadius: 'var(--giga-radius-md, 8px)',
              border: '1px solid var(--giga-border, #1E293B)',
              fontSize: '12px',
            }}
            data-testid="runtime-boundary-notice"
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>Target Runtime:</span>
                <span style={{ color: 'var(--giga-primary, #3B82F6)', fontWeight: 600 }}>Cloud Workspace (Isolated Sandbox)</span>
              </div>
              <span style={{ color: 'var(--giga-text-muted, #94A3B8)', fontStyle: 'italic' }}>
                Local Runner: Coming later (not operational)
              </span>
            </div>
            <p style={{ color: 'var(--giga-text-secondary, #94A3B8)', margin: 0, lineHeight: 1.4 }}>
              Code executes in an isolated sandbox with memory, CPU, and network boundaries. Ordinary sandbox edits do not alter external repositories or host systems.
            </p>
          </div>

          {/* Submit Action */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginTop: '6px' }}>
            <span style={{ fontSize: '12px', color: 'var(--giga-text-muted, #94A3B8)' }}>
              Workspace Target: <strong style={{ color: 'var(--giga-text, #F8FAFC)' }} data-testid="target-workspace-label">{selectedWorkspace ? `${selectedWorkspace.name} (Existing)` : 'New Blank Workspace'}</strong>
            </span>

            <Button
              type="submit"
              variant="primary"
              loading={isSubmitting || isLoadingCapabilities}
              disabled={isSubmitting || (apiMode === 'real' && !realExecutionAvailable)}
              icon={<PlayIcon size={16} />}
              data-testid="launch-agent-btn"
            >
              {apiMode === 'real' && !realExecutionAvailable ? 'Execution Unavailable (Real Mode)' : 'Launch Agent Task'}
            </Button>
          </div>
        </form>

        {/* Section: Workspaces Overview */}
        <div style={{ marginBottom: '36px' }} data-testid="workspaces-section">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
            <h2 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)', margin: 0 }}>
              Recent Workspaces
            </h2>
            <span style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)' }}>
              {workspaces.length} available
            </span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: '14px',
            }}
          >
            {workspaces.map((ws) => {
              const wsRuns = runs.filter((r) => r.workspaceId === ws.id);
              const isSelected = ws.id === selectedWorkspaceId;

              return (
                <div
                  key={ws.id}
                  onClick={() => setSelectedWorkspaceId(isSelected ? '' : ws.id)}
                  style={{
                    backgroundColor: isSelected ? 'rgba(59, 130, 246, 0.08)' : 'var(--giga-surface, #111C2D)',
                    border: `1px solid ${isSelected ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-border, #1E293B)'}`,
                    borderRadius: 'var(--giga-radius-md, 8px)',
                    padding: '16px',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  data-testid={`workspace-card-${ws.id}`}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                      {ws.name}
                    </span>
                    <span
                      style={{
                        fontSize: '11px',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        backgroundColor: isSelected ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-surface-muted, #18263A)',
                        color: isSelected ? '#FFFFFF' : 'var(--giga-text-secondary, #94A3B8)',
                        fontWeight: isSelected ? 700 : 500,
                      }}
                    >
                      {isSelected ? 'ACTIVE' : `rev ${ws.revision}`}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)' }}>
                    <span>Source: {ws.sourceKind}</span>
                    <span>{wsRuns.length} runs</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Section: Recent Agent Executions History */}
        <div data-testid="recent-runs-section">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
            <h2 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)', margin: 0 }}>
              Recent Agent Executions
            </h2>
            <span style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)' }}>
              {runs.length} recorded runs
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }} data-testid="recent-runs-list">
            {runs.length === 0 ? (
              <div
                style={{
                  padding: '32px',
                  textAlign: 'center',
                  color: 'var(--giga-text-muted, #94A3B8)',
                  backgroundColor: 'var(--giga-surface, #111C2D)',
                  border: '1px solid var(--giga-border, #1E293B)',
                  borderRadius: 'var(--giga-radius-md, 8px)',
                  fontSize: '14px',
                }}
                data-testid="no-runs-state"
              >
                No past runs recorded. Create a task above to start an agent execution.
              </div>
            ) : (
              runs.map((r) => (
                <div
                  key={r.id}
                  style={{
                    backgroundColor: 'var(--giga-surface, #111C2D)',
                    border: '1px solid var(--giga-border, #1E293B)',
                    borderRadius: 'var(--giga-radius-md, 8px)',
                    padding: '16px 20px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: '12px',
                  }}
                  data-testid={`run-item-${r.id}`}
                >
                  <div style={{ flex: 1, minWidth: '240px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                        {r.task}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)' }}>
                      <span>Workspace: <strong>{r.workspaceName || r.workspaceId}</strong></span>
                      <span>•</span>
                      <span style={{ textTransform: 'uppercase', fontSize: '11px', fontWeight: 600 }}>{r.mode}</span>
                      <span>•</span>
                      <span>{new Date(r.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <Badge status={r.status} />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(`/agent/runs/${r.id}`)}
                      icon={<ArrowRightIcon size={14} />}
                      data-testid={`open-run-${r.id}`}
                    >
                      Open Run
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* New Workspace Modal */}
      <Modal
        isOpen={isNewWsModalOpen}
        onClose={() => setIsNewWsModalOpen(false)}
        title="Create Blank Workspace"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }} data-testid="new-workspace-modal">
          <p style={{ fontSize: '13px', color: 'var(--giga-text-secondary, #94A3B8)', margin: 0 }}>
            Create a clean, isolated workspace for your AI agent. No Git repository or remote credentials required.
          </p>

          <Input
            label="Workspace Name"
            placeholder="e.g. Next.js Dashboard or PyTorch Experiment"
            value={newWsName}
            onChange={(e) => setNewWsName(e.target.value)}
            autoFocus
            data-testid="new-workspace-name-input"
          />

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
            <Button variant="ghost" onClick={() => setIsNewWsModalOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreateWorkspace}
              data-testid="confirm-create-workspace-btn"
            >
              Create Blank Workspace
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
