import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApprovalBar } from '../src/features/agent/ApprovalBar.js';
import type { AgentRun } from '../src/lib/api/types.js';

describe('ApprovalBar Component Regression Tests', () => {
  const baseRun: AgentRun = {
    id: 'run_test_1234',
    status: 'awaiting_approval',
    task: 'Refactor database pool',
    repository: '17thedevv/Giga',
    baseRef: 'main',
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
  };

  describe('Mock Mode (Invariant INV-07 Demo Integrity)', () => {
    it('displays DEMO / SIMULATED badge and disclaims remote writes when completed', () => {
      const completedRun: AgentRun = {
        ...baseRun,
        status: 'completed',
        result: {
          prUrl: 'https://demo.giga.dev/simulated-pr',
          prNumber: 9999,
          branch: 'agent/simulated-branch-1234',
        },
      };

      render(
        <ApprovalBar
          run={completedRun}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          isApplying={false}
          mode="mock"
        />
      );

      // Verify simulated labels
      expect(screen.getByTestId('mock-approval-completed')).toBeDefined();
      expect(screen.getByText('DEMO / SIMULATED')).toBeDefined();
      expect(screen.getByText('Approval Flow Simulation Finished')).toBeDefined();

      // Verify explicit disclaimer that NO real PR or writes occurred
      expect(
        screen.getByText(/no real Pull Request was created/i)
      ).toBeDefined();
      expect(
        screen.getByText(/no files were modified/i)
      ).toBeDefined();

      // Verify that no deceptive "View PR on GitHub" link exists in mock mode
      expect(screen.queryByText('View PR on GitHub')).toBeNull();
      expect(screen.queryByText('Pull Request Created Successfully')).toBeNull();

      // Sample data clearly labeled
      expect(screen.getByText(/Sample Fixture/i)).toBeDefined();
    });

    it('renders simulated approval modal with clear demo disclosures', () => {
      render(
        <ApprovalBar
          run={baseRun}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          isApplying={false}
          mode="mock"
        />
      );

      // Open approval modal
      fireEvent.click(screen.getByRole('button', { name: /Approve & Open Pull Request/i }));

      expect(screen.getByText('Confirm Simulated Approval (Demo)')).toBeDefined();
      expect(screen.getByText(/simulating human approval for this demo proposal/i)).toBeDefined();
      expect(screen.getByRole('button', { name: /Simulate Approval/i })).toBeDefined();
    });
  });

  describe('Real Mode (Backend & GitHub Remote Integration)', () => {
    it('renders verified GitHub PR link only when server confirms real completed run', () => {
      const completedRealRun: AgentRun = {
        ...baseRun,
        status: 'completed',
        result: {
          prUrl: 'https://github.com/17thedevv/Giga/pull/99',
          prNumber: 99,
          branch: 'agent/verified-fix-99',
          commitSha: 'a1b2c3d4e5f6',
        },
      };

      render(
        <ApprovalBar
          run={completedRealRun}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          isApplying={false}
          mode="real"
        />
      );

      expect(screen.getByTestId('real-approval-completed')).toBeDefined();
      expect(screen.getByText('Pull Request Created on GitHub')).toBeDefined();

      const link = screen.getByRole('link', { name: /View PR on GitHub/i }) as HTMLAnchorElement;
      expect(link).toBeDefined();
      expect(link.href).toBe('https://github.com/17thedevv/Giga/pull/99');
      expect(link.target).toBe('_blank');
    });
  });

  describe('Lifecycle States Handling', () => {
    it('renders applying state and locks interactions while server write is in progress', () => {
      render(
        <ApprovalBar
          run={{ ...baseRun, status: 'applying' }}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          isApplying={true}
          mode="mock"
        />
      );

      expect(screen.getByText('Applying remote changes...')).toBeDefined();
      expect(screen.queryByRole('button', { name: /Approve/i })).toBeNull();
    });

    it('renders cancelled alert when proposal is rejected', () => {
      render(
        <ApprovalBar
          run={{ ...baseRun, status: 'cancelled' }}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          isApplying={false}
          mode="mock"
        />
      );

      expect(screen.getByText(/This proposal was rejected or cancelled/i)).toBeDefined();
    });

    it('renders error alert when run failed', () => {
      render(
        <ApprovalBar
          run={{
            ...baseRun,
            status: 'failed',
            error: { code: 'TOOL_ERROR', message: 'GitHub API rate limit exceeded' },
          }}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          isApplying={false}
          mode="mock"
        />
      );

      expect(screen.getByText('Run Failed')).toBeDefined();
      expect(screen.getByText('GitHub API rate limit exceeded')).toBeDefined();
    });

    it('executes reject callback when user clicks Reject Proposal', async () => {
      const rejectSpy = vi.fn().mockResolvedValue(undefined);

      render(
        <ApprovalBar
          run={baseRun}
          onApprove={vi.fn()}
          onReject={rejectSpy}
          isApplying={false}
          mode="mock"
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /Reject Proposal/i }));

      await waitFor(() => {
        expect(rejectSpy).toHaveBeenCalledTimes(1);
      });
    });
  });
});
