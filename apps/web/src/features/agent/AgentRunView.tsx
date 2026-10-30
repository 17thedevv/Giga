import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from '../../app/router.js';
import { useApiMode } from '../../app/context/ApiModeContext.js';
import { AgentRealRunView } from './AgentRealViews.js';
import { realApiClient, ApiException } from '../../lib/api/client.js';
import { isAgentCapabilityAvailable } from '../../lib/api/agent-contract.js';
import {
  workspaceFixtureStore,
  type AgentRunDetail,
} from './workspace-fixtures.js';
import { Badge } from '../../components/Badge.js';
import { Button } from '../../components/Button.js';
import { Alert } from '../../components/Alert.js';
import {
  ArrowLeftIcon,
  CheckIcon,
  XIcon,
  SpinnerIcon,
  ShieldIcon,
  DownloadIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '../../components/Icons.js';

const DemoAgentRunView: React.FC = () => {
  const { params, navigate } = useRouter();
  const { mode: apiMode } = useApiMode();
  const runId = params.runId;

  const [run, setRun] = useState<AgentRunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'plan' | 'timeline' | 'files' | 'verification' | 'artifacts'>('plan');
  const [expandedDiffs, setExpandedDiffs] = useState<Record<string, boolean>>({});

  // Real Mode Capabilities for Action Buttons
  const [canCancel, setCanCancel] = useState<boolean>(true);
  const [canApprove, setCanApprove] = useState<boolean>(true);

  // Request Fencing Ref for Run Loading
  const activeRunRequestIdRef = useRef<number>(0);

  const loadRunData = useCallback(() => {
    if (!runId) {
      setRun(null);
      setIsLoading(false);
      return;
    }

    const requestId = ++activeRunRequestIdRef.current;
    // 1. Immediately clear outdated run data & error banner on change
    setRun(null);
    setIsLoading(true);
    setErrorBanner(null);

    if (apiMode === 'real') {
      setCanCancel(false);
      setCanApprove(false);

      Promise.allSettled([
        realApiClient.getAgentRun(runId),
        realApiClient.getAgentCapabilities(),
      ])
        .then(([runResult, capsResult]) => {
          if (activeRunRequestIdRef.current !== requestId) return;

          if (capsResult.status === 'fulfilled') {
            const caps = capsResult.value;
            setCanCancel(isAgentCapabilityAvailable(caps, 'cancellation'));
            setCanApprove(isAgentCapabilityAvailable(caps, 'externalApproval'));
          } else {
            setCanCancel(false);
            setCanApprove(false);
          }

          if (runResult.status === 'fulfilled') {
            const res = runResult.value;
            // Convert to AgentRunDetail without fabricating files or artifacts
            const realRun: AgentRunDetail = {
              id: res.run.id,
              workspaceId: res.run.workspaceId,
              workspaceName: 'Real Workspace',
              task: res.run.task,
              mode: res.run.mode,
              runtime: res.run.runtime,
              modelId: res.run.modelId,
              status: res.run.status,
              phase: res.run.phase,
              createdAt: res.run.createdAt,
              updatedAt: res.run.updatedAt,
              finishedAt: res.run.finishedAt,
              error: res.run.error,
              result: res.run.result,
              plan: [],
              timeline: [],
              fileChanges: [],
              verifications: [],
              artifacts: [],
              isDemo: false,
            };
            setRun(realRun);
          } else {
            const err = runResult.reason;
            if (err instanceof ApiException && err.status === 404) {
              setErrorBanner('Run not found on real backend.');
            } else {
              setErrorBanner(
                'Real Cloud execution runtime is unavailable (Frontend control-plane integration is tracked under Linear 17T-48; Cloud sandbox runtime requires separate backend readiness). Run data cannot be loaded in Real Mode without an admitted run.'
              );
            }
            setRun(null);
          }
        })
        .finally(() => {
          if (activeRunRequestIdRef.current !== requestId) return;
          setIsLoading(false);
        });
    } else {
      // Demo Mock Mode
      setCanCancel(true);
      setCanApprove(true);
      const found = workspaceFixtureStore.getRun(runId);
      if (found) {
        setRun(found);
      } else {
        setErrorBanner('Run not found in workspace session.');
        setRun(null);
      }
      setIsLoading(false);
    }
  }, [runId, apiMode]);

  useEffect(() => {
    loadRunData();
    return () => {
      activeRunRequestIdRef.current++;
    };
  }, [loadRunData]);

  // Handle Cancel Run
  const handleCancel = () => {
    if (!run) return;
    if (apiMode === 'real') {
      setErrorBanner('Durable cancellation API is not operational in Real Mode (Linear 17T-56).');
      return;
    }
    const updated = workspaceFixtureStore.cancelDemoRun(run.id);
    if (updated) {
      setRun({ ...updated });
    }
  };

  // Handle Approval Decision (Simulated in Demo Mode)
  const handleApprovalDecision = (decision: 'approve' | 'reject') => {
    if (!run || !run.approvalRequest) return;
    if (apiMode === 'real') {
      setErrorBanner('External approval API is not operational in Real Mode (Linear 17T-56).');
      return;
    }
    const updated = workspaceFixtureStore.decideApproval(run.id, decision);
    if (updated) {
      setRun({ ...updated });
    }
  };

  const toggleDiff = (path: string) => {
    setExpandedDiffs((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  if (isLoading) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--giga-text-muted, #94A3B8)',
          gap: '12px',
        }}
        data-testid="agent-run-loading"
      >
        <SpinnerIcon size={24} />
        <span style={{ fontSize: '14px' }}>Loading workspace run...</span>
      </div>
    );
  }

  if (!run) {
    return (
      <div
        style={{
          padding: '32px 24px',
          maxWidth: '800px',
          margin: '0 auto',
          width: '100%',
        }}
        data-testid="agent-run-not-found"
      >
        <div style={{ marginBottom: '20px' }}>
          <Alert
            type="error"
            title="Run Not Found"
            message={errorBanner || 'The requested agent run could not be found.'}
          />
        </div>
        <Button
          variant="secondary"
          onClick={() => navigate('/agent')}
          icon={<ArrowLeftIcon size={16} />}
          data-testid="back-to-agent-manager-btn"
        >
          Back to Agent Manager
        </Button>
      </div>
    );
  }

  const isTerminal = ['completed', 'failed', 'cancelled'].includes(run.status);
  const isAwaitingApproval = run.status === 'awaiting_approval';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        overflowY: 'auto',
        backgroundColor: 'var(--giga-bg, #0B1220)',
        padding: '24px 20px',
      }}
      data-testid="agent-run-view"
    >
      <div style={{ maxWidth: '980px', margin: '0 auto', width: '100%' }}>
        {/* Navigation & Header Actions */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px',
            marginBottom: '20px',
          }}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/agent')}
            icon={<ArrowLeftIcon size={16} />}
            data-testid="back-to-agent-btn"
          >
            Back to Agent Manager
          </Button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {run.isDemo && (
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  backgroundColor: 'rgba(234, 88, 12, 0.15)',
                  color: '#FB923C',
                  border: '1px solid rgba(234, 88, 12, 0.4)',
                  padding: '2px 8px',
                  borderRadius: '9999px',
                  letterSpacing: '0.05em',
                }}
                data-testid="demo-run-badge"
              >
                DEMO SIMULATION
              </span>
            )}

            <Badge status={run.status} data-testid="run-status-badge" />

            {!isTerminal && (
              <Button
                size="sm"
                variant="danger"
                onClick={handleCancel}
                disabled={apiMode === 'real' && !canCancel}
                title={apiMode === 'real' && !canCancel ? 'Run cancellation is unavailable in Real Mode' : undefined}
                data-testid="cancel-run-btn"
              >
                Cancel Run
              </Button>
            )}
          </div>
        </div>

        {/* Real Mode Error Alert */}
        {apiMode === 'real' && (
          <div style={{ marginBottom: '20px' }} data-testid="real-run-notice">
            <Alert
              type="error"
              title="Cloud Sandbox Execution Unavailable"
              message="Backend Cloud runtime is unavailable. This run was persisted via admission but cannot execute tasks or produce verified sandbox files in Real Mode."
            />
          </div>
        )}

        {/* Global Error Banner */}
        {errorBanner && apiMode !== 'real' && (
          <div style={{ marginBottom: '20px' }}>
            <Alert type="error" message={errorBanner} onDismiss={() => setErrorBanner(null)} />
          </div>
        )}

        {/* A. Task Overview Card */}
        <div
          className="g-card"
          style={{
            backgroundColor: 'var(--giga-surface, #111C2D)',
            border: '1px solid var(--giga-border, #1E293B)',
            borderRadius: 'var(--giga-radius-lg, 12px)',
            padding: '20px 24px',
            marginBottom: '24px',
          }}
          data-testid="task-overview-card"
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '14px' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <span style={{ fontSize: '13px', color: 'var(--giga-text-secondary, #94A3B8)' }}>Workspace:</span>
                <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }} data-testid="run-workspace-name">
                  {run.workspaceName}
                </span>
                <span style={{ color: 'var(--giga-border, #334155)' }}>•</span>
                <span style={{ fontSize: '12px', textTransform: 'uppercase', color: 'var(--giga-primary, #3B82F6)', fontWeight: 700 }} data-testid="run-mode-badge">
                  {run.mode} Mode
                </span>
                {run.phase && (
                  <>
                    <span style={{ color: 'var(--giga-border, #334155)' }}>•</span>
                    <span style={{ fontSize: '11px', color: 'var(--giga-text-secondary, #94A3B8)', fontStyle: 'italic' }} data-testid="run-phase-indicator">
                      phase: {run.phase}
                    </span>
                  </>
                )}
              </div>
              <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)', margin: 0, lineHeight: 1.4 }} data-testid="run-task-title">
                {run.task}
              </h2>
            </div>

            <div style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)', textAlign: 'right' }}>
              <div>Created: {new Date(run.createdAt).toLocaleTimeString()}</div>
              {run.finishedAt && <div>Finished: {new Date(run.finishedAt).toLocaleTimeString()}</div>}
            </div>
          </div>

          {/* Safe Summary / Error */}
          {run.error && (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 'var(--giga-radius-md, 8px)',
                backgroundColor: 'rgba(220, 38, 38, 0.12)',
                border: '1px solid rgba(220, 38, 38, 0.35)',
                color: 'var(--giga-danger, #F87171)',
                fontSize: '13px',
                marginTop: '10px',
              }}
              data-testid="run-error-message"
            >
              <strong>Error ({run.error.code}):</strong> {run.error.message}
            </div>
          )}

          {run.result && (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 'var(--giga-radius-md, 8px)',
                backgroundColor: 'var(--giga-surface-muted, #18263A)',
                border: '1px solid var(--giga-border, #1E293B)',
                fontSize: '13px',
                color: 'var(--giga-text-secondary, #CBD5E1)',
                marginTop: '10px',
                lineHeight: 1.5,
              }}
              data-testid="run-summary-text"
            >
              <strong>Summary:</strong> {run.result.summary}
            </div>
          )}
        </div>

        {/* Sensitive External Action Approval Card (when awaiting_approval) */}
        {isAwaitingApproval && run.approvalRequest && (
          <div
            className="g-card"
            style={{
              backgroundColor: 'rgba(217, 119, 6, 0.12)',
              border: '1px solid var(--giga-warning, #D97706)',
              borderRadius: 'var(--giga-radius-lg, 12px)',
              padding: '20px 24px',
              marginBottom: '24px',
            }}
            data-testid="approval-action-card"
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
              <ShieldIcon size={20} style={{ color: '#F59E0B' }} />
              <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#F59E0B', margin: 0 }}>
                Approval Required: Sensitive External Action
              </h3>
            </div>
            <p style={{ fontSize: '13px', color: 'var(--giga-text-secondary, #CBD5E1)', marginBottom: '14px', lineHeight: 1.5 }}>
              Ordinary sandbox file edits execute automatically. The agent is requesting permission for an <strong>external out-of-sandbox side effect</strong>.
            </p>

            <div
              style={{
                backgroundColor: 'var(--giga-surface, #111C2D)',
                border: '1px solid var(--giga-border, #1E293B)',
                borderRadius: 'var(--giga-radius-md, 8px)',
                padding: '14px',
                fontSize: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                marginBottom: '16px',
                fontFamily: 'var(--giga-font-mono, monospace)',
              }}
            >
              <div>Action: <strong>{run.approvalRequest.action}</strong></div>
              <div>Target: <strong>{run.approvalRequest.target}</strong></div>
              <div>Risk Level: <strong style={{ color: '#F59E0B' }}>{run.approvalRequest.risk.toUpperCase()}</strong></div>
              <div>Reason: <span>{run.approvalRequest.reason}</span></div>
              <div>Scope: <span>{run.approvalRequest.scope}</span></div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleApprovalDecision('reject')}
                disabled={apiMode === 'real' && !canApprove}
                title={apiMode === 'real' && !canApprove ? 'Action approval is unavailable in Real Mode' : undefined}
                data-testid="reject-approval-btn"
              >
                Reject Action
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => handleApprovalDecision('approve')}
                disabled={apiMode === 'real' && !canApprove}
                title={apiMode === 'real' && !canApprove ? 'Action approval is unavailable in Real Mode' : undefined}
                data-testid="confirm-approval-btn"
              >
                Approve Action
              </Button>
            </div>
          </div>
        )}

        {/* Section Navigation Tabs */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            borderBottom: '1px solid var(--giga-border, #1E293B)',
            marginBottom: '20px',
            overflowX: 'auto',
          }}
          data-testid="run-detail-tabs"
        >
          <button
            type="button"
            onClick={() => setActiveTab('plan')}
            style={{
              padding: '10px 16px',
              border: 'none',
              borderBottom: `2px solid ${activeTab === 'plan' ? 'var(--giga-primary, #3B82F6)' : 'transparent'}`,
              backgroundColor: 'transparent',
              color: activeTab === 'plan' ? 'var(--giga-text, #F8FAFC)' : 'var(--giga-text-secondary, #94A3B8)',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
            data-testid="tab-plan"
          >
            Plan ({run.plan.length})
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('timeline')}
            style={{
              padding: '10px 16px',
              border: 'none',
              borderBottom: `2px solid ${activeTab === 'timeline' ? 'var(--giga-primary, #3B82F6)' : 'transparent'}`,
              backgroundColor: 'transparent',
              color: activeTab === 'timeline' ? 'var(--giga-text, #F8FAFC)' : 'var(--giga-text-secondary, #94A3B8)',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
            data-testid="tab-timeline"
          >
            Execution Timeline ({run.timeline.length})
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('files')}
            style={{
              padding: '10px 16px',
              border: 'none',
              borderBottom: `2px solid ${activeTab === 'files' ? 'var(--giga-primary, #3B82F6)' : 'transparent'}`,
              backgroundColor: 'transparent',
              color: activeTab === 'files' ? 'var(--giga-text, #F8FAFC)' : 'var(--giga-text-secondary, #94A3B8)',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
            data-testid="tab-changes"
          >
            Workspace Changes ({run.fileChanges.length})
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('verification')}
            style={{
              padding: '10px 16px',
              border: 'none',
              borderBottom: `2px solid ${activeTab === 'verification' ? 'var(--giga-primary, #3B82F6)' : 'transparent'}`,
              backgroundColor: 'transparent',
              color: activeTab === 'verification' ? 'var(--giga-text, #F8FAFC)' : 'var(--giga-text-secondary, #94A3B8)',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
            data-testid="tab-verification"
          >
            Verification ({run.verifications.length})
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('artifacts')}
            style={{
              padding: '10px 16px',
              border: 'none',
              borderBottom: `2px solid ${activeTab === 'artifacts' ? 'var(--giga-primary, #3B82F6)' : 'transparent'}`,
              backgroundColor: 'transparent',
              color: activeTab === 'artifacts' ? 'var(--giga-text, #F8FAFC)' : 'var(--giga-text-secondary, #94A3B8)',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
            data-testid="tab-artifacts"
          >
            Artifacts ({run.artifacts.length})
          </button>
        </div>

        {/* Tab Content 1: Plan */}
        {activeTab === 'plan' && (
          <div
            className="g-card"
            style={{
              backgroundColor: 'var(--giga-surface, #111C2D)',
              border: '1px solid var(--giga-border, #1E293B)',
              borderRadius: 'var(--giga-radius-lg, 12px)',
              padding: '20px',
            }}
            data-testid="plan-section"
          >
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)', marginBottom: '14px' }}>
              Structured Plan & Progress
            </h3>

            {run.plan.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px', color: 'var(--giga-text-secondary, #94A3B8)', fontSize: '13px' }} data-testid="empty-plan-message">
                No structured plan available for this run.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }} data-testid="plan-steps-list">
                {run.plan.map((step) => (
                  <div
                    key={step.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '12px',
                      padding: '12px 14px',
                      backgroundColor: 'var(--giga-surface-muted, #18263A)',
                      borderRadius: 'var(--giga-radius-md, 8px)',
                      border: '1px solid var(--giga-border, #1E293B)',
                    }}
                    data-testid={`plan-step-${step.stepNumber}`}
                  >
                    <div style={{ marginTop: '2px' }}>
                      {step.status === 'completed' && <CheckIcon size={16} style={{ color: 'var(--giga-success, #16A34A)' }} />}
                      {step.status === 'running' && <SpinnerIcon size={16} style={{ color: 'var(--giga-primary, #3B82F6)' }} />}
                      {step.status === 'failed' && <XIcon size={16} style={{ color: 'var(--giga-danger, #EF4444)' }} />}
                      {step.status === 'pending' && <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', backgroundColor: 'var(--giga-text-secondary, #94A3B8)', margin: '4px' }} />}
                    </div>
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                        {step.stepNumber}. {step.title}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)', marginTop: '2px' }}>
                        {step.description}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tab Content 2: Execution Timeline */}
        {activeTab === 'timeline' && (
          <div
            className="g-card"
            style={{
              backgroundColor: 'var(--giga-surface, #111C2D)',
              border: '1px solid var(--giga-border, #1E293B)',
              borderRadius: 'var(--giga-radius-lg, 12px)',
              padding: '20px',
            }}
            data-testid="timeline-section"
          >
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)', marginBottom: '14px' }}>
              Activity Timeline & Generic Tool Actions
            </h3>

            {run.timeline.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px', color: 'var(--giga-text-secondary, #94A3B8)', fontSize: '13px' }} data-testid="empty-timeline-message">
                No activity events recorded yet.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }} data-testid="timeline-events-list">
                {run.timeline.map((evt) => (
                  <div
                    key={evt.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                      padding: '12px 14px',
                      backgroundColor: 'var(--giga-surface-muted, #18263A)',
                      borderRadius: 'var(--giga-radius-md, 8px)',
                      border: '1px solid var(--giga-border, #1E293B)',
                    }}
                    data-testid={`timeline-event-${evt.id}`}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span
                          style={{
                            fontSize: '11px',
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: '4px',
                            backgroundColor: 'rgba(59, 130, 246, 0.15)',
                            color: 'var(--giga-primary, #3B82F6)',
                            fontFamily: 'monospace',
                          }}
                        >
                          {evt.category}
                        </span>
                        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                          {evt.label}
                        </span>
                      </div>
                      <span style={{ fontSize: '11px', color: 'var(--giga-text-secondary, #94A3B8)', fontFamily: 'monospace' }}>
                        {evt.timestamp} {evt.durationMs ? `(${evt.durationMs}ms)` : ''}
                      </span>
                    </div>

                    {evt.detail && (
                      <p style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)', margin: '4px 0 0', lineHeight: 1.4 }}>
                        {evt.detail}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tab Content 3: Workspace Changes (Sandbox Files) */}
        {activeTab === 'files' && (
          <div
            className="g-card"
            style={{
              backgroundColor: 'var(--giga-surface, #111C2D)',
              border: '1px solid var(--giga-border, #1E293B)',
              borderRadius: 'var(--giga-radius-lg, 12px)',
              padding: '20px',
            }}
            data-testid="workspace-changes-section"
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)', margin: 0 }}>
                Sandbox File Changes Summary
              </h3>
              <span style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)' }}>
                {run.fileChanges.length} files modified in sandbox
              </span>
            </div>

            <p style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)', margin: '0 0 14px', lineHeight: 1.4 }}>
              Ordinary sandbox file edits occur inside the isolated workspace container. No external GitHub repository or PR is required.
            </p>

            {run.fileChanges.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px', color: 'var(--giga-text-secondary, #94A3B8)', fontSize: '13px' }} data-testid="empty-changes-message">
                No sandbox files were created or modified for this run.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }} data-testid="file-changes-list">
                {run.fileChanges.map((file) => {
                  const isExpanded = Boolean(expandedDiffs[file.path]);

                  return (
                    <div
                      key={file.path}
                      style={{
                        backgroundColor: 'var(--giga-surface-muted, #18263A)',
                        border: '1px solid var(--giga-border, #1E293B)',
                        borderRadius: 'var(--giga-radius-md, 8px)',
                        overflow: 'hidden',
                        cursor: 'pointer',
                      }}
                      onClick={() => toggleDiff(file.path)}
                      data-testid={`file-item-${file.path}`}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '10px 14px',
                          userSelect: 'none',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <span style={{ color: 'var(--giga-text-secondary, #94A3B8)' }}>
                            {isExpanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
                          </span>
                          <span
                            style={{
                              fontSize: '11px',
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              backgroundColor:
                                file.status === 'created'
                                  ? 'rgba(22, 163, 74, 0.15)'
                                  : file.status === 'deleted'
                                  ? 'rgba(220, 38, 38, 0.15)'
                                  : 'rgba(59, 130, 246, 0.15)',
                              color:
                                file.status === 'created'
                                  ? 'var(--giga-success, #16A34A)'
                                  : file.status === 'deleted'
                                  ? 'var(--giga-danger, #EF4444)'
                                  : 'var(--giga-primary, #3B82F6)',
                            }}
                          >
                            {file.status}
                          </span>
                          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)', fontFamily: 'monospace' }}>
                            {file.path}
                          </span>
                        </div>

                        {file.additions !== undefined && (
                          <div style={{ fontSize: '12px', fontFamily: 'monospace' }}>
                            <span style={{ color: 'var(--giga-success, #16A34A)' }}>+{file.additions}</span>{' '}
                            <span style={{ color: 'var(--giga-danger, #EF4444)' }}>-{file.deletions || 0}</span>
                          </div>
                        )}
                      </div>

                      {/* Diff Preview */}
                      {isExpanded && file.diffPreview && (
                        <div
                          style={{
                            padding: '10px 14px',
                            borderTop: '1px solid var(--giga-border, #1E293B)',
                            backgroundColor: '#070D18',
                            fontSize: '12px',
                            fontFamily: 'monospace',
                            color: 'var(--giga-text-secondary, #CBD5E1)',
                            whiteSpace: 'pre-wrap',
                            overflowX: 'auto',
                          }}
                          data-testid="file-diff-viewer"
                        >
                          {file.diffPreview}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Tab Content 4: Verification Evidence */}
        {activeTab === 'verification' && (
          <div
            className="g-card"
            style={{
              backgroundColor: 'var(--giga-surface, #111C2D)',
              border: '1px solid var(--giga-border, #1E293B)',
              borderRadius: 'var(--giga-radius-lg, 12px)',
              padding: '20px',
            }}
            data-testid="verification-section"
          >
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)', marginBottom: '14px' }}>
              Verification Evidence
            </h3>

            {run.verifications.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px', color: 'var(--giga-text-secondary, #94A3B8)', fontSize: '13px' }} data-testid="empty-verification-message">
                No verification evidence recorded for this task.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }} data-testid="verification-checks-list">
                {run.verifications.map((chk, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 14px',
                      backgroundColor: 'var(--giga-surface-muted, #18263A)',
                      borderRadius: 'var(--giga-radius-md, 8px)',
                      border: '1px solid var(--giga-border, #1E293B)',
                    }}
                    data-testid={`verification-check-${i}`}
                  >
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                        {chk.name}
                      </div>
                      {chk.summary && (
                        <div style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)', marginTop: '2px' }}>
                          {chk.summary}
                        </div>
                      )}
                    </div>

                    <span
                      style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        padding: '3px 8px',
                        borderRadius: '9999px',
                        backgroundColor:
                          chk.outcome === 'passed'
                            ? 'rgba(22, 163, 74, 0.15)'
                            : chk.outcome === 'failed'
                            ? 'rgba(220, 38, 38, 0.15)'
                            : 'var(--giga-surface-muted, #18263A)',
                        color:
                          chk.outcome === 'passed'
                            ? 'var(--giga-success, #16A34A)'
                            : chk.outcome === 'failed'
                            ? 'var(--giga-danger, #EF4444)'
                            : 'var(--giga-text-secondary, #94A3B8)',
                        border: `1px solid ${
                          chk.outcome === 'passed'
                            ? 'rgba(22, 163, 74, 0.35)'
                            : chk.outcome === 'failed'
                            ? 'rgba(220, 38, 38, 0.35)'
                            : 'var(--giga-border, #1E293B)'
                        }`,
                      }}
                      data-testid={`verification-status-${i}`}
                    >
                      {chk.outcome === 'passed' ? 'Passed' : chk.outcome === 'failed' ? 'Failed' : 'Not Run'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tab Content 5: Artifacts */}
        {activeTab === 'artifacts' && (
          <div
            className="g-card"
            style={{
              backgroundColor: 'var(--giga-surface, #111C2D)',
              border: '1px solid var(--giga-border, #1E293B)',
              borderRadius: 'var(--giga-radius-lg, 12px)',
              padding: '20px',
            }}
            data-testid="artifacts-section"
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)', margin: 0 }}>
                Generated Artifacts
              </h3>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  backgroundColor: 'rgba(234, 88, 12, 0.15)',
                  color: '#FB923C',
                  border: '1px solid rgba(234, 88, 12, 0.4)',
                  padding: '2px 8px',
                  borderRadius: '9999px',
                }}
              >
                DEMO LABELED
              </span>
            </div>

            <p style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)', marginBottom: '14px' }}>
              Simulated artifact metadata only. File downloads are not supported or advertised in Demo Mode.
            </p>

            {run.artifacts.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px', color: 'var(--giga-text-secondary, #94A3B8)', fontSize: '13px' }} data-testid="empty-artifacts-message">
                No artifacts produced for this run.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }} data-testid="artifacts-list">
                {run.artifacts.map((art) => (
                  <div
                    key={art.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: '12px',
                      padding: '14px',
                      backgroundColor: 'var(--giga-surface-muted, #18263A)',
                      borderRadius: 'var(--giga-radius-md, 8px)',
                      border: '1px solid var(--giga-border, #1E293B)',
                    }}
                    data-testid={`artifact-item-${art.id}`}
                  >
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)', fontFamily: 'monospace' }}>
                          {art.name}
                        </span>
                        <span
                          style={{
                            fontSize: '10px',
                            fontWeight: 700,
                            padding: '1px 5px',
                            borderRadius: '3px',
                            backgroundColor: 'rgba(234, 88, 12, 0.2)',
                            color: '#FB923C',
                          }}
                        >
                          DEMO
                        </span>
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)', marginTop: '2px' }}>
                        {art.type} • {art.size} • {art.summary}
                      </div>
                    </div>

                    <Button
                      variant="outline"
                      size="sm"
                      disabled
                      title="Download unavailable — Demo artifact simulation only"
                      icon={<DownloadIcon size={14} />}
                      data-testid={`download-artifact-${art.id}`}
                    >
                      Download (Demo)
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export const AgentRunView: React.FC = () => {
  const { mode } = useApiMode();
  return mode === 'real' ? <AgentRealRunView /> : <DemoAgentRunView />;
};
