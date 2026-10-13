import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from '../../app/router.js';
import { useApiMode } from '../../app/context/ApiModeContext.js';
import type { AgentRun, ChangeProposal, ToolCallStep } from '../../lib/api/types.js';
import { mockDataAdapter } from '../../lib/api/mock-adapter.js';
import { Timeline } from './Timeline.js';
import { DiffViewer } from './DiffViewer.js';
import { ApprovalBar } from './ApprovalBar.js';
import { Badge } from '../../components/Badge.js';
import { Button } from '../../components/Button.js';
import { ArrowLeftIcon } from '../../components/Icons.js';
import { Alert } from '../../components/Alert.js';

export const AgentRunView: React.FC = () => {
  const { params, navigate } = useRouter();
  const { mode } = useApiMode();
  const runId = params.runId;

  const [run, setRun] = useState<AgentRun | null>(null);
  const [proposal, setProposal] = useState<ChangeProposal | null>(null);
  const [steps, setSteps] = useState<ToolCallStep[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isApplying, setIsApplying] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const loadRunData = useCallback(async () => {
    if (!runId) return;
    setIsLoading(true);
    try {
      if (mode === 'real') {
        setErrorBanner('Backend Agent Run API (/api/v1/agent/runs/:id) is currently in development under Linear 17T-8. Toggle to MOCK mode for the live interactive demo.');
        setRun(null);
      } else {
        const runRes = await mockDataAdapter.getRun(runId);
        setRun(runRes.run);

        // Populate sample tool steps
        setSteps([
          {
            id: 'step_1',
            tool: 'github_read_file',
            status: 'success',
            stepNumber: 1,
            path: 'apps/api/src/db/client.ts',
            durationMs: 120,
            summary: 'Read 48 lines of database client connection initialization',
            outputPreview: 'Found unhandled error events and unbounded pool creation.',
          },
          {
            id: 'step_2',
            tool: 'github_search_code',
            status: 'success',
            stepNumber: 2,
            query: 'new Pool(',
            durationMs: 340,
            summary: 'Searched repository for pool creation points',
            outputPreview: 'Matched 2 pool initialization points in apps/api/src/db.',
          },
          {
            id: 'step_3',
            tool: 'github_prepare_diff',
            status: 'success',
            stepNumber: 3,
            durationMs: 450,
            summary: 'Synthesized unified diff against baseCommitSha 4aff648',
            outputPreview: 'Diff ready: 2 files changed (+24, -6 lines).',
          },
        ]);

        if (['awaiting_approval', 'applying', 'completed'].includes(runRes.run.status)) {
          const propRes = await mockDataAdapter.getProposal(runId);
          setProposal(propRes.proposal);
        }
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to load agent run');
    } finally {
      setIsLoading(false);
    }
  }, [runId, mode]);

  useEffect(() => {
    loadRunData();
  }, [loadRunData]);

  const handleApprove = async () => {
    if (!run || !proposal) return;
    setIsApplying(true);
    try {
      // 1. Submit approval -> transitions to applying
      const res = await mockDataAdapter.submitDecision(run.id, proposal.id, 'approve');
      setRun(res.run);

      // 2. Server processes write and creates PR
      const completedRun = await mockDataAdapter.finalizeApprovedRun(run.id);
      setRun(completedRun);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setIsApplying(false);
    }
  };

  const handleReject = async () => {
    if (!run || !proposal) return;
    try {
      const res = await mockDataAdapter.submitDecision(run.id, proposal.id, 'reject');
      setRun(res.run);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Rejection failed');
    }
  };

  const handleCancelRun = async () => {
    if (!run) return;
    try {
      const res = await mockDataAdapter.cancelRun(run.id);
      setRun(res.run);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Cancel failed');
    }
  };

  if (isLoading) {
    return (
      <div style={{ padding: '32px', color: '#94a3b8', textAlign: 'center' }}>
        Loading execution timeline...
      </div>
    );
  }

  if (errorBanner && !run) {
    return (
      <div style={{ padding: '32px', maxWidth: '800px', margin: '0 auto' }}>
        <Alert type="warning" title="Notice" message={errorBanner} />
        <Button variant="secondary" onClick={() => navigate('/agent')} style={{ marginTop: '16px' }} icon={<ArrowLeftIcon size={16} />}>
          Back to Agent Launcher
        </Button>
      </div>
    );
  }

  if (!run) {
    return (
      <div style={{ padding: '32px', textAlign: 'center', color: '#64748b' }}>
        Run not found.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', overflowY: 'auto', backgroundColor: '#090d16', padding: '24px 32px' }}>
      <div style={{ maxWidth: '1000px', margin: '0 auto', width: '100%' }}>
        {/* Navigation & Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <Button variant="ghost" size="sm" onClick={() => navigate('/agent')} icon={<ArrowLeftIcon size={16} />}>
            Back to Agent Runs
          </Button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Badge status={run.status} />
            {['queued', 'running', 'awaiting_approval'].includes(run.status) && (
              <Button size="sm" variant="danger" onClick={handleCancelRun}>
                Cancel Run
              </Button>
            )}
          </div>
        </div>

        {/* Run Details Banner */}
        <div
          style={{
            backgroundColor: '#0f172a',
            border: '1px solid #1e293b',
            borderRadius: '8px',
            padding: '20px',
            marginBottom: '20px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
            <span style={{ fontSize: '16px', fontWeight: 700, color: '#f1f5f9' }}>
              Run #{run.id.slice(-6)}
            </span>
            <span style={{ color: '#64748b', fontSize: '13px' }}>
              on <code>{run.repository}</code> ({run.baseRef || 'main'})
            </span>
          </div>
          <p style={{ fontSize: '14px', color: '#cbd5e1', lineHeight: 1.5 }}>
            <strong>Task:</strong> {run.task}
          </p>
        </div>

        {/* Execution Steps Timeline */}
        <Timeline steps={steps} />

        {/* Change Proposal Diff and Approval Gate */}
        {proposal && (
          <div style={{ marginTop: '24px' }}>
            <DiffViewer proposal={proposal} />
            <ApprovalBar
              run={run}
              onApprove={handleApprove}
              onReject={handleReject}
              isApplying={isApplying}
              mode={mode}
            />
          </div>
        )}
      </div>
    </div>
  );
};
