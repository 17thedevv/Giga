import React, { useState } from 'react';
import type { AgentRun, ApiMode } from '../../lib/api/types.js';
import { useApiMode } from '../../app/context/ApiModeContext.js';
import { Button } from '../../components/Button.js';
import { Modal } from '../../components/Modal.js';
import { Alert } from '../../components/Alert.js';
import { CheckIcon, ExternalLinkIcon, XIcon } from '../../components/Icons.js';

interface ApprovalBarProps {
  run: AgentRun;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
  isApplying: boolean;
  mode?: ApiMode;
}

export const ApprovalBar: React.FC<ApprovalBarProps> = ({
  run,
  onApprove,
  onReject,
  isApplying,
  mode: propMode,
}) => {
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  let contextMode: ApiMode = 'mock';
  try {
    const apiModeContext = useApiMode();
    contextMode = apiModeContext.mode;
  } catch {
    contextMode = 'mock';
  }
  const mode = propMode ?? contextMode;

  const handleConfirmApproval = async () => {
    setConfirmModalOpen(false);
    await onApprove();
  };

  const handleRejectClick = async () => {
    setRejecting(true);
    try {
      await onReject();
    } finally {
      setRejecting(false);
    }
  };

  // Completed State: Handle MOCK vs REAL mode distinctly
  if (run.status === 'completed') {
    if (mode === 'mock') {
      return (
        <div
          data-testid="mock-approval-completed"
          style={{
            marginTop: '20px',
            padding: '16px 20px',
            backgroundColor: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '8px',
            color: '#e2e8f0',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <span
              style={{
                display: 'inline-block',
                padding: '2px 8px',
                borderRadius: '4px',
                fontSize: '11px',
                fontWeight: 700,
                backgroundColor: '#ea580c',
                color: '#ffffff',
                letterSpacing: '0.05em',
              }}
            >
              DEMO / SIMULATED
            </span>
            <strong style={{ fontSize: '15px', color: '#f8fafc' }}>
              Approval Flow Simulation Finished
            </strong>
          </div>
          <p style={{ fontSize: '13px', marginBottom: '12px', color: '#94a3b8', lineHeight: 1.5 }}>
            Approval lifecycle successfully simulated. In Mock Mode, <strong>no real Pull Request was created</strong> on GitHub, and <strong>no files were modified</strong> in the remote repository.
          </p>
          <div
            style={{
              padding: '10px 14px',
              backgroundColor: '#090d16',
              borderRadius: '6px',
              border: '1px solid #1e293b',
              fontSize: '12px',
              fontFamily: 'monospace',
              color: '#cbd5e1',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            }}
          >
            <div>Target Repository: <strong>{run.repository}</strong></div>
            <div>Simulated PR Payload: <strong>#{run.result?.prNumber || '9999'} (Sample Fixture)</strong></div>
            <div>Simulated Branch: <strong>{run.result?.branch || 'agent/simulated-branch'}</strong></div>
          </div>
        </div>
      );
    }

    // REAL mode: Authenticated server confirmed remote write
    if (run.result?.prUrl) {
      const handleCopy = () => {
        navigator.clipboard.writeText(run.result?.prUrl || '');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      };

      return (
        <div
          data-testid="real-approval-completed"
          style={{
            marginTop: '20px',
            padding: '16px 20px',
            backgroundColor: '#064e3b',
            border: '1px solid #059669',
            borderRadius: '8px',
            color: '#d1fae5',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <CheckIcon size={20} />
            <strong style={{ fontSize: '15px' }}>Pull Request Created on GitHub</strong>
          </div>
          <p style={{ fontSize: '13px', marginBottom: '12px', color: '#a7f3d0' }}>
            Autonomous coding agent finished execution and opened Pull Request #{run.result.prNumber} on {run.repository}.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <a
              href={run.result.prUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                backgroundColor: '#10b981',
                color: '#ffffff',
                padding: '6px 14px',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: 500,
                textDecoration: 'none',
              }}
            >
              <span>View PR on GitHub</span>
              <ExternalLinkIcon size={14} />
            </a>
            <Button size="sm" variant="outline" onClick={handleCopy}>
              {copied ? 'Copied Link' : 'Copy PR URL'}
            </Button>
          </div>
        </div>
      );
    }
  }

  // Applying State: Server write in flight
  if (run.status === 'applying' || isApplying) {
    return (
      <div
        style={{
          marginTop: '20px',
          padding: '16px 20px',
          backgroundColor: '#3b0764',
          border: '1px solid #7e22ce',
          borderRadius: '8px',
          color: '#f3e8ff',
        }}
      >
        <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '4px' }}>
          Applying remote changes...
        </div>
        <p style={{ fontSize: '13px', color: '#d8b4fe' }}>
          The server is applying the unified diff and creating a branch and Pull Request on GitHub. Controls are locked until confirmed.
        </p>
      </div>
    );
  }

  // Cancelled State
  if (run.status === 'cancelled') {
    return (
      <div style={{ marginTop: '20px' }}>
        <Alert type="info" message="This proposal was rejected or cancelled. No changes were committed to GitHub." />
      </div>
    );
  }

  // Failed State
  if (run.status === 'failed') {
    return (
      <div style={{ marginTop: '20px' }}>
        <Alert
          type="error"
          title="Run Failed"
          message={run.error?.message || 'Agent failed to complete reasoning or tool execution.'}
        />
      </div>
    );
  }

  // Default Awaiting Approval Gate
  return (
    <>
      <div
        style={{
          marginTop: '20px',
          padding: '16px 20px',
          backgroundColor: '#182234',
          border: '1px solid #334155',
          borderRadius: '8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div>
          <div style={{ fontWeight: 600, color: '#f1f5f9', fontSize: '14px' }}>
            Human Approval Gate (Invariant INV-07)
          </div>
          <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px' }}>
            Review the proposed diff above. Remote GitHub write occurs only upon your explicit confirmation.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Button
            variant="danger"
            size="md"
            onClick={handleRejectClick}
            loading={rejecting}
            disabled={isApplying}
            icon={<XIcon size={16} />}
          >
            Reject Proposal
          </Button>

          <Button
            variant="success"
            size="md"
            onClick={() => setConfirmModalOpen(true)}
            disabled={isApplying}
            icon={<CheckIcon size={16} />}
          >
            Approve & Open Pull Request
          </Button>
        </div>
      </div>

      {/* Confirmation Modal */}
      <Modal
        isOpen={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
        title={mode === 'mock' ? 'Confirm Simulated Approval (Demo)' : 'Confirm Remote Repository Write'}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '14px', color: '#cbd5e1' }}>
          <p>
            {mode === 'mock'
              ? 'You are simulating human approval for this demo proposal. In Mock Mode, no real branch or Pull Request will be created on GitHub:'
              : 'You are about to authorize the Giga backend to create a branch and open a Pull Request on:'}
          </p>
          <div style={{ padding: '10px 14px', backgroundColor: '#090d16', borderRadius: '6px', fontFamily: 'monospace' }}>
            <div>Repository: <strong>{run.repository}</strong></div>
            <div>Base branch: <strong>{run.baseRef || 'main'}</strong></div>
          </div>
          <p style={{ fontSize: '12px', color: '#94a3b8' }}>
            {mode === 'mock'
              ? 'Notice: In Mock Mode, this simulates the Invariant INV-07 approval lifecycle without modifying any remote GitHub repositories.'
              : 'Notice: This action creates authenticated writes on GitHub. It cannot be undone without closing the resulting PR.'}
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
            <Button variant="ghost" onClick={() => setConfirmModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="success" onClick={handleConfirmApproval}>
              {mode === 'mock' ? 'Simulate Approval' : 'Confirm & Create PR'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
};
