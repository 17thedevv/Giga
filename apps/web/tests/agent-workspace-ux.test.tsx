import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentLauncherView } from '../src/features/agent/AgentLauncherView.js';
import { AgentRunView } from '../src/features/agent/AgentRunView.js';
import { AppRoutes } from '../src/app/App.js';
import { ApiModeProvider, useApiMode } from '../src/app/context/ApiModeContext.js';
import { ThemeProvider } from '../src/app/context/ThemeContext.js';
import { AuthProvider } from '../src/app/context/AuthContext.js';
import { RouterProvider, useRouter } from '../src/app/router.js';
import { workspaceFixtureStore } from '../src/features/agent/workspace-fixtures.js';
import { mockDataAdapter, MOCK_USER } from '../src/lib/api/mock-adapter.js';
import { realApiClient } from '../src/lib/api/client.js';

function renderWithProviders(ui: React.ReactElement, initialPath = '/agent', mode: 'mock' | 'real' = 'mock') {
  return render(
    <ThemeProvider>
      <ApiModeProvider initialMode={mode}>
        <AuthProvider>
          <RouterProvider initialPath={initialPath}>
            {ui}
          </RouterProvider>
        </AuthProvider>
      </ApiModeProvider>
    </ThemeProvider>
  );
}

describe('Workspace-First GigaAgent UX (17T-40)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockDataAdapter.setMockSession(MOCK_USER);
    workspaceFixtureStore.resetToDefaults();
    vi.restoreAllMocks();
  });

  describe('Agent Launcher & Workspace Configuration', () => {
    it('Scenario 1: Blank Workspace is selected by default without requiring a GitHub repository or baseRef', async () => {
      renderWithProviders(<AgentLauncherView />);

      await waitFor(() => {
        expect(screen.getByTestId('agent-manager-view')).toBeDefined();
      });

      // Default runtime badge
      expect(screen.getByTestId('agent-runtime-badge').textContent).toContain('Cloud Workspace (Demo Simulation)');

      // Blank workspace option is rendered and marked DEFAULT
      const blankOption = screen.getByTestId('source-blank-workspace');
      expect(blankOption).toBeDefined();
      expect(blankOption.textContent).toContain('Blank Workspace');
      expect(blankOption.textContent).toContain('DEFAULT');
      expect(blankOption.textContent).toContain('No repository or GitHub account required');

      // Verify no GitHub repository, branch, or baseRef inputs exist
      expect(screen.queryByLabelText(/github repository/i)).toBeNull();
      expect(screen.queryByLabelText(/target repository/i)).toBeNull();
      expect(screen.queryByLabelText(/base branch/i)).toBeNull();
      expect(screen.queryByLabelText(/base ref/i)).toBeNull();

      // Launch button is enabled
      const launchBtn = screen.getByTestId('launch-agent-btn') as HTMLButtonElement;
      expect(launchBtn.disabled).toBe(false);
      expect(launchBtn.textContent).toContain('Launch Agent Task');
    });

    it('Scenario 2: Validates empty and too short task descriptions', async () => {
      renderWithProviders(<AgentLauncherView />);

      await waitFor(() => {
        expect(screen.getByTestId('launch-agent-btn')).toBeDefined();
      });

      // Empty submission
      const form = screen.getByTestId('task-composer-card');
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByTestId('agent-error-banner')).toBeDefined();
        expect(screen.getByTestId('agent-error-banner').textContent).toContain('Please describe what you want GigaAgent to do.');
      });

      // Short submission (< 10 chars)
      const input = screen.getByTestId('agent-task-input');
      fireEvent.change(input, { target: { value: 'Short' } });
      fireEvent.submit(form);

      await waitFor(() => {
        expect(screen.getByTestId('agent-error-banner').textContent).toContain('at least 10 characters long');
      });
    });

    it('Scenario 3: Future gated sources (Upload Files & Git Import) show "Coming later" and block launch', async () => {
      renderWithProviders(<AgentLauncherView />);

      await waitFor(() => {
        expect(screen.getByTestId('source-upload-files')).toBeDefined();
      });

      // Click Upload Files
      fireEvent.click(screen.getByTestId('source-upload-files'));

      expect(screen.getByTestId('source-placeholder-notice')).toBeDefined();
      expect(screen.getByTestId('source-placeholder-notice').textContent).toContain('Upload Files is a future capability placeholder ("Coming later")');

      // Type valid task and attempt submit
      const input = screen.getByTestId('agent-task-input');
      fireEvent.change(input, { target: { value: 'Process uploaded files into a summary.' } });
      fireEvent.submit(screen.getByTestId('task-composer-card'));

      await waitFor(() => {
        expect(screen.getByTestId('agent-error-banner').textContent).toContain('is not operational. Please select Blank Workspace');
      });

      // Click Git Import
      fireEvent.click(screen.getByTestId('source-import-git'));

      expect(screen.getByTestId('source-placeholder-notice').textContent).toContain('Git Repository Import is an optional future capability placeholder ("Coming later")');

      fireEvent.submit(screen.getByTestId('task-composer-card'));

      await waitFor(() => {
        expect(screen.getByTestId('agent-error-banner').textContent).toContain('is not operational. Please select Blank Workspace');
      });

      // Switching back to Blank Workspace clears notice and allows launch
      fireEvent.click(screen.getByTestId('source-blank-workspace'));
      expect(screen.queryByTestId('source-placeholder-notice')).toBeNull();
    });

    it('Scenario 4: Allows creating a new workspace in the modal and selecting it', async () => {
      renderWithProviders(<AgentLauncherView />);

      await waitFor(() => {
        expect(screen.getByTestId('create-workspace-btn')).toBeDefined();
      });

      // Click New Workspace button
      fireEvent.click(screen.getByTestId('create-workspace-btn'));

      expect(screen.getByTestId('new-workspace-modal')).toBeDefined();

      const nameInput = screen.getByTestId('new-workspace-name-input');
      fireEvent.change(nameInput, { target: { value: 'My Analytics Sandbox' } });

      fireEvent.click(screen.getByTestId('confirm-create-workspace-btn'));

      await waitFor(() => {
        expect(screen.queryByTestId('new-workspace-modal')).toBeNull();
      });

      // Check active workspace dropdown
      const select = screen.getByTestId('active-workspace-select') as HTMLSelectElement;
      expect(select.value).toBeDefined();

      // Workspace card appears in recent workspaces
      expect(screen.getAllByText('My Analytics Sandbox').length).toBeGreaterThanOrEqual(1);
    });

    it('Scenario 5: Suggestion pills populate the task description input', async () => {
      renderWithProviders(<AgentLauncherView />);

      await waitFor(() => {
        expect(screen.getByTestId('prompt-example-0')).toBeDefined();
      });

      fireEvent.click(screen.getByTestId('prompt-example-0'));

      const input = screen.getByTestId('agent-task-input') as HTMLTextAreaElement;
      expect(input.value).toContain('Build a responsive React task manager');
    });

    it('Scenario 6: Allows toggling between Ask, Plan, and Execute modes', async () => {
      renderWithProviders(<AgentLauncherView />);

      await waitFor(() => {
        expect(screen.getByTestId('radio-mode-execute')).toBeDefined();
      });

      // Default is execute
      const executeRadio = screen.getByTestId('radio-mode-execute') as HTMLInputElement;
      expect(executeRadio.checked).toBe(true);

      // Select Ask
      const askRadio = screen.getByTestId('radio-mode-ask') as HTMLInputElement;
      fireEvent.click(askRadio);
      expect(askRadio.checked).toBe(true);
      expect(executeRadio.checked).toBe(false);

      // Select Plan
      const planRadio = screen.getByTestId('radio-mode-plan') as HTMLInputElement;
      fireEvent.click(planRadio);
      expect(planRadio.checked).toBe(true);
      expect(askRadio.checked).toBe(false);
    });

    it('Scenario 7: Displays runtime boundary notice explaining sandbox isolation and local runner status', async () => {
      renderWithProviders(<AgentLauncherView />);

      await waitFor(() => {
        expect(screen.getByTestId('runtime-boundary-notice')).toBeDefined();
      });

      const notice = screen.getByTestId('runtime-boundary-notice');
      expect(notice.textContent).toContain('Target Runtime:');
      expect(notice.textContent).toContain('Cloud Workspace (Isolated Sandbox)');
      expect(notice.textContent).toContain('Local Runner: Coming later (not operational)');
      expect(notice.textContent).toContain('Ordinary sandbox edits do not alter external repositories');
    });
  });

  describe('Golden Flow: React Task Manager Execution', () => {
    it('Scenario 8: Golden Flow executes in Blank Workspace, passes verification, creates artifacts, and completes without GitHub PR', async () => {
      // Use the pre-seeded golden fixture run-golden-react
      renderWithProviders(<AgentRunView />, '/agent/runs/run-golden-react');

      await waitFor(() => {
        expect(screen.getByTestId('agent-run-view')).toBeDefined();
      });

      // Badges & Overview
      expect(screen.getByTestId('demo-run-badge').textContent).toContain('DEMO SIMULATION');
      expect(screen.getByTestId('run-status-badge').textContent?.toLowerCase()).toContain('completed');
      expect(screen.getByTestId('run-mode-badge').textContent?.toLowerCase()).toContain('execute');
      expect(screen.getByTestId('run-task-title').textContent).toContain('Build a responsive React task manager');

      // Verify no Pull Request button or PR creation UI is shown
      expect(screen.queryByText(/create pull request/i)).toBeNull();
      expect(screen.queryByText(/open pr/i)).toBeNull();
      expect(screen.queryByText(/github pull request/i)).toBeNull();

      // Check Plan Tab (Default)
      expect(screen.getByTestId('plan-section')).toBeDefined();
      expect(screen.getByText(/1\. Understand requirements/i)).toBeDefined();
      expect(screen.getByText(/2\. Inspect workspace/i)).toBeDefined();
      expect(screen.getByText(/3\. Create implementation/i)).toBeDefined();
      expect(screen.getByText(/4\. Run verification/i)).toBeDefined();
      expect(screen.getByText(/5\. Produce results/i)).toBeDefined();

      // Check Execution Timeline Tab
      fireEvent.click(screen.getByTestId('tab-timeline'));
      await waitFor(() => {
        expect(screen.getByTestId('timeline-section')).toBeDefined();
      });
      expect(screen.getByText(/Formulated 5-step structured execution plan/i)).toBeDefined();
      expect(screen.getByText(/Created src\/App\.tsx/i)).toBeDefined();
      expect(screen.getByText(/Created src\/components\/TaskList\.tsx/i)).toBeDefined();

      // Check Workspace Changes Tab
      fireEvent.click(screen.getByTestId('tab-changes'));
      await waitFor(() => {
        expect(screen.getByTestId('workspace-changes-section')).toBeDefined();
      });
      expect(screen.getByText('src/App.tsx')).toBeDefined();
      expect(screen.getByText('src/styles.css')).toBeDefined();
      expect(screen.getByText('src/components/TaskList.tsx')).toBeDefined();
      expect(screen.getByText('package.json')).toBeDefined();

      // Click on a file to view diff
      const appFileCard = screen.getByTestId('file-item-src/App.tsx');
      expect(appFileCard).toBeDefined();
      fireEvent.click(appFileCard);
      expect(screen.getByTestId('file-diff-viewer')).toBeDefined();
      expect(screen.getByTestId('file-diff-viewer').textContent).toContain('TaskList');

      // Check Verification Tab
      fireEvent.click(screen.getByTestId('tab-verification'));
      await waitFor(() => {
        expect(screen.getByTestId('verification-section')).toBeDefined();
      });
      expect(screen.getByText(/TypeScript Typecheck/i)).toBeDefined();
      expect(screen.getByText(/Production Build/i)).toBeDefined();
      expect(screen.getAllByText(/Unit Tests/i).length).toBeGreaterThanOrEqual(1);
      const passedBadges = screen.getAllByText('Passed');
      expect(passedBadges.length).toBe(3);

      // Check Artifacts Tab
      fireEvent.click(screen.getByTestId('tab-artifacts'));
      await waitFor(() => {
        expect(screen.getByTestId('artifacts-section')).toBeDefined();
      });
      expect(screen.getByText('react-task-manager-src.zip')).toBeDefined();
      expect(screen.getByText('build-summary.md')).toBeDefined();

      // Verify DEMO label and disabled download
      expect(screen.getByTestId('artifact-item-art-react-src').textContent).toContain('DEMO');
      const downloadBtn = screen.getByTestId('download-artifact-art-react-src') as HTMLButtonElement;
      expect(downloadBtn.disabled).toBe(true);
      expect(downloadBtn.textContent).toContain('Download (Demo)');
    });
  });

  describe('Ask Mode and Plan Mode Scenarios', () => {
    it('Scenario 9: Ask Mode generates an informational answer without workspace file modifications or PRs', async () => {
      renderWithProviders(<AgentRunView />, '/agent/runs/run-ask-demo');

      await waitFor(() => {
        expect(screen.getByTestId('agent-run-view')).toBeDefined();
      });

      expect(screen.getByTestId('run-mode-badge').textContent?.toLowerCase()).toContain('ask');
      expect(screen.getByTestId('run-status-badge').textContent?.toLowerCase()).toContain('completed');

      // Summary contains answer
      expect(screen.getByTestId('run-summary-text').textContent).toContain('React 18 concurrent features');

      // Plan has steps
      expect(screen.getByTestId('plan-section').textContent).toContain('Analyze question context');

      // Workspace changes tab has 0 files
      fireEvent.click(screen.getByTestId('tab-changes'));
      await waitFor(() => {
        expect(screen.getByTestId('empty-changes-message')).toBeDefined();
        expect(screen.getByTestId('empty-changes-message').textContent).toContain('No sandbox files were created or modified');
      });

      // Artifacts tab has 0 artifacts
      fireEvent.click(screen.getByTestId('tab-artifacts'));
      await waitFor(() => {
        expect(screen.getByTestId('empty-artifacts-message')).toBeDefined();
        expect(screen.getByTestId('empty-artifacts-message').textContent).toContain('No artifacts produced');
      });
    });

    it('Scenario 10: Plan Mode produces structured multi-step plan without file modifications', async () => {
      renderWithProviders(<AgentRunView />, '/agent/runs/run-plan-demo');

      await waitFor(() => {
        expect(screen.getByTestId('agent-run-view')).toBeDefined();
      });

      expect(screen.getByTestId('run-mode-badge').textContent?.toLowerCase()).toContain('plan');
      expect(screen.getByTestId('run-status-badge').textContent?.toLowerCase()).toContain('completed');

      // Plan has 3 architectural steps
      expect(screen.getByText(/1\. Audit existing REST endpoints/i)).toBeDefined();
      expect(screen.getByText(/2\. Draft GraphQL schema design/i)).toBeDefined();
      expect(screen.getByText(/3\. Define verification & rollout strategy/i)).toBeDefined();

      // Workspace changes tab has 0 files
      fireEvent.click(screen.getByTestId('tab-changes'));
      await waitFor(() => {
        expect(screen.getByTestId('empty-changes-message')).toBeDefined();
      });
    });
  });

  describe('Partial Failure and Cancellation', () => {
    it('Scenario 11: Failed execution run preserves partial plan, partial file changes, and failed verification', async () => {
      renderWithProviders(<AgentRunView />, '/agent/runs/run-failed-demo');

      await waitFor(() => {
        expect(screen.getByTestId('agent-run-view')).toBeDefined();
      });

      expect(screen.getByTestId('run-status-badge').textContent?.toLowerCase()).toContain('failed');

      // Error message is displayed prominently
      expect(screen.getByTestId('run-error-message')).toBeDefined();
      expect(screen.getByTestId('run-error-message').textContent).toContain('Sandbox build failed with 3 TypeScript compilation errors');

      // Plan steps show completed and failed steps
      expect(screen.getByText(/Install Prisma dependencies/i)).toBeDefined();
      expect(screen.getByText(/Run verification tests/i)).toBeDefined();

      // Changes tab preserves partial work
      fireEvent.click(screen.getByTestId('tab-changes'));
      await waitFor(() => {
        expect(screen.getByText('prisma/schema.prisma')).toBeDefined();
        expect(screen.getByText('src/lib/db.ts')).toBeDefined();
      });

      // Verification shows failed check
      fireEvent.click(screen.getByTestId('tab-verification'));
      await waitFor(() => {
        expect(screen.getByTestId('verification-status-0').textContent).toContain('Failed');
        expect(screen.getByText(/TypeScript Typecheck/i)).toBeDefined();
      });
    });

    it('Scenario 12: Active run can be cancelled via UI and transitions to cancelled status', async () => {
      // Create a temporary running run
      const runningRun = workspaceFixtureStore.createRun({
        workspaceId: 'ws-react-task-manager',
        task: 'Live active refactoring task to cancel',
        mode: 'execute',
      });
      workspaceFixtureStore.updateRunStatus(runningRun.id, 'running');

      renderWithProviders(<AgentRunView />, `/agent/runs/${runningRun.id}`);

      await waitFor(() => {
        expect(screen.getByTestId('cancel-run-btn')).toBeDefined();
      });

      // Click Cancel Run
      fireEvent.click(screen.getByTestId('cancel-run-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('run-status-badge').textContent?.toLowerCase()).toContain('cancelled');
      });

      // Cancel button is no longer rendered
      expect(screen.queryByTestId('cancel-run-btn')).toBeNull();
    });
  });

  describe('Sensitive External Action Approval Card', () => {
    it('Scenario 13: Approval Card renders ONLY when status === "awaiting_approval" with risk and action details', async () => {
      renderWithProviders(<AgentRunView />, '/agent/runs/run-approval-demo');

      await waitFor(() => {
        expect(screen.getByTestId('approval-action-card')).toBeDefined();
      });

      const card = screen.getByTestId('approval-action-card');
      expect(card.textContent).toContain('Approval Required: Sensitive External Action');
      expect(card.textContent).toContain('Publish to External Staging Host');
      expect(card.textContent).toContain('HIGH');
      expect(card.textContent).toContain('External network egress and publishing outside the isolated sandbox');

      expect(screen.getByTestId('confirm-approval-btn')).toBeDefined();
      expect(screen.getByTestId('reject-approval-btn')).toBeDefined();
    });

    it('Scenario 14: Sensitive approval card is NOT rendered for normal completed, failed, or cancelled runs', async () => {
      // Completed run
      const { unmount } = renderWithProviders(<AgentRunView />, '/agent/runs/run-golden-react');
      await waitFor(() => {
        expect(screen.getByTestId('agent-run-view')).toBeDefined();
      });
      expect(screen.queryByTestId('approval-action-card')).toBeNull();
      unmount();

      // Failed run
      renderWithProviders(<AgentRunView />, '/agent/runs/run-failed-demo');
      await waitFor(() => {
        expect(screen.getByTestId('agent-run-view')).toBeDefined();
      });
      expect(screen.queryByTestId('approval-action-card')).toBeNull();
    });

    it('Scenario 15: Approving external action transitions to applying and then completed', async () => {
      renderWithProviders(<AgentRunView />, '/agent/runs/run-approval-demo');

      await waitFor(() => {
        expect(screen.getByTestId('confirm-approval-btn')).toBeDefined();
      });

      fireEvent.click(screen.getByTestId('confirm-approval-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('run-status-badge').textContent?.toLowerCase()).toContain('completed');
      });

      expect(screen.queryByTestId('approval-action-card')).toBeNull();
    });

    it('Scenario 16: Rejecting external action transitions to cancelled', async () => {
      // Create a fresh awaiting_approval run
      const approvalRun = workspaceFixtureStore.createRun({
        workspaceId: 'ws-react-task-manager',
        task: 'Publish to staging server',
        mode: 'execute',
      });
      workspaceFixtureStore.updateRunStatus(approvalRun.id, 'awaiting_approval');

      renderWithProviders(<AgentRunView />, `/agent/runs/${approvalRun.id}`);

      await waitFor(() => {
        expect(screen.getByTestId('reject-approval-btn')).toBeDefined();
      });

      fireEvent.click(screen.getByTestId('reject-approval-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('run-status-badge').textContent?.toLowerCase()).toContain('cancelled');
      });

      expect(screen.queryByTestId('approval-action-card')).toBeNull();
    });
  });

  describe('Truthful Real Mode Handling', () => {
    it('Scenario 17: Real Mode disables execution launch and truthfully reports runtime unavailable without fallback', async () => {
      // Mock realApiClient.getAgentCapabilities to return runExecution = false
      vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue({
        capabilities: {
          chat: { enabled: true },
          agent: {
            enabled: true,
            features: {
              runAdmission: true,
              runExecution: false,
              workspaceFileChanges: false,
              verificationEvidence: false,
            },
          },
        },
      } as any);

      renderWithProviders(<AgentLauncherView />, '/agent', 'real');

      await waitFor(() => {
        expect(screen.getByTestId('real-mode-runtime-warning')).toBeDefined();
      });

      expect(screen.getByTestId('agent-runtime-badge').textContent).toContain('Real API Mode (Unavailable)');
      expect(screen.getByTestId('real-mode-runtime-warning').textContent).toContain('Cloud Execution Runtime Unavailable in Real Mode');

      // Launch button is disabled and labeled clearly
      const launchBtn = screen.getByTestId('launch-agent-btn') as HTMLButtonElement;
      expect(launchBtn.disabled).toBe(true);
      expect(launchBtn.textContent).toContain('Execution Unavailable (Real Mode)');

      // Verify no fake mock workspaces or runs are populated in Real mode
      expect(screen.queryByText('ws-react')).toBeNull();
      expect(screen.queryByText('ws-csv')).toBeNull();
    });

    it('Scenario 18: Real Mode run detail reflects backend admission status and does not invent fake files or artifacts', async () => {
      // Mock realApiClient.getAgentRun
      vi.spyOn(realApiClient, 'getAgentRun').mockResolvedValue({
        run: {
          id: 'real-run-999',
          task: 'Real Mode Test Execution',
          status: 'failed',
          workspaceId: 'ws-real-1',
          createdAt: '2026-10-19T08:00:00Z',
          finishedAt: '2026-10-19T08:00:05Z',
          error: {
            code: 'RUNTIME_UNAVAILABLE',
            message: 'Cloud sandbox runtime is not provisioned in this milestone',
          },
        } as any,
      });

      renderWithProviders(<AgentRunView />, '/agent/runs/real-run-999', 'real');

      await waitFor(() => {
        expect(screen.getByTestId('real-run-notice')).toBeDefined();
      });

      expect(screen.getByTestId('run-status-badge').textContent?.toLowerCase()).toContain('failed');
      expect(screen.getByTestId('run-error-message').textContent).toContain('RUNTIME_UNAVAILABLE');

      // File changes tab shows empty without fake mock files
      fireEvent.click(screen.getByTestId('tab-changes'));
      await waitFor(() => {
        expect(screen.getByTestId('empty-changes-message')).toBeDefined();
      });

      // Artifacts tab shows empty without fake artifacts
      fireEvent.click(screen.getByTestId('tab-artifacts'));
      await waitFor(() => {
        expect(screen.getByTestId('empty-artifacts-message')).toBeDefined();
      });
    });
  });

  describe('Routing and Workspace Scoping', () => {
    it('Scenario 19: Scoping to /agent/workspaces/:workspaceId pre-selects the workspace in the launcher', async () => {
      renderWithProviders(<AgentLauncherView />, '/agent/workspaces/ws-doc-site');

      await waitFor(() => {
        expect(screen.getByTestId('active-workspace-select')).toBeDefined();
      });

      const select = screen.getByTestId('active-workspace-select') as HTMLSelectElement;
      expect(select.value).toBe('ws-doc-site');
    });

    it('Scenario 20: Full App routing renders AgentLauncherView at /agent and AgentRunView at /agent/runs/:runId', async () => {
      const { unmount } = renderWithProviders(<AppRoutes />, '/agent');

      await waitFor(() => {
        expect(screen.getByTestId('agent-manager-view')).toBeDefined();
      });
      unmount();

      renderWithProviders(<AppRoutes />, '/agent/runs/run-golden-react');

      await waitFor(() => {
        expect(screen.getByTestId('agent-run-view')).toBeDefined();
      });
    });
  });

  describe('PR #36 Review Findings Regressions', () => {
    function ModeSwitcher() {
      const { mode, setMode } = useApiMode();
      return (
        <div>
          <span data-testid="current-api-mode">{mode}</span>
          <button data-testid="switch-to-real-btn" onClick={() => setMode('real')}>
            Switch to Real
          </button>
          <button data-testid="switch-to-mock-btn" onClick={() => setMode('mock')}>
            Switch to Mock
          </button>
        </div>
      );
    }

    function RouteSwitcher() {
      const { navigate } = useRouter();
      return (
        <div>
          <button data-testid="nav-to-run-1" onClick={() => navigate('/agent/runs/real-run-1')}>
            Run 1
          </button>
          <button data-testid="nav-to-run-2" onClick={() => navigate('/agent/runs/real-run-2')}>
            Run 2
          </button>
        </div>
      );
    }

    function createDeferred<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: any) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    const defaultUnavailableCaps = {
      schemaVersion: 1 as const,
      capabilities: {
        workspaceManagement: { available: true as const },
        runAdmission: { available: true as const },
        runHistory: { available: true as const },
        runExecution: { available: false as const, reason: 'runtime_unavailable' as const },
        ask: { available: true as const },
        plan: { available: true as const },
        execute: { available: false as const, reason: 'runtime_unavailable' as const },
        durableMessages: { available: true as const },
        followUp: { available: false as const, reason: 'runtime_unavailable' as const },
        eventReplay: { available: false as const, reason: 'runtime_unavailable' as const },
        cancellation: { available: false as const, reason: 'not_implemented' as const },
        sandboxFiles: { available: false as const, reason: 'runtime_unavailable' as const },
        artifacts: { available: false as const, reason: 'runtime_unavailable' as const },
        artifactDownload: { available: false as const, reason: 'runtime_unavailable' as const },
        externalApproval: { available: false as const, reason: 'not_implemented' as const },
        cloudRuntime: { available: false as const, reason: 'runtime_unavailable' as const },
      },
    };

    it('P1 Launcher: switching Mock -> Real clears mock workspaces immediately before capability request resolves', async () => {
      const deferredCaps = createDeferred<any>();
      vi.spyOn(realApiClient, 'getAgentCapabilities').mockImplementation(() => deferredCaps.promise);

      renderWithProviders(
        <>
          <ModeSwitcher />
          <AgentLauncherView />
        </>,
        '/agent',
        'mock'
      );

      // Verify Mock workspaces are initially present
      await waitFor(() => {
        expect(screen.getByRole('option', { name: 'React Task Manager' })).toBeDefined();
      });
      expect(screen.getByTestId('active-workspace-select')).toBeDefined();

      // Switch to Real mode
      fireEvent.click(screen.getByTestId('switch-to-real-btn'));
      expect(screen.getByTestId('current-api-mode').textContent).toBe('real');

      // Assert mock workspaces are immediately cleared WITHOUT waiting for deferredCaps to resolve
      expect(screen.queryByRole('option', { name: 'React Task Manager' })).toBeNull();
      expect(screen.queryByTestId('active-workspace-select')).toBeNull();

      // Now resolve deferredCaps
      deferredCaps.resolve(defaultUnavailableCaps);

      await waitFor(() => {
        expect(screen.getByTestId('real-mode-runtime-warning')).toBeDefined();
      });
      // Mock data was never leaked back
      expect(screen.queryByRole('option', { name: 'React Task Manager' })).toBeNull();
      expect(screen.queryByTestId('active-workspace-select')).toBeNull();
    });

    it('P1 Launcher: Real -> Mock before old Real request resolves prevents late Real response from clearing newly loaded Mock state', async () => {
      const deferredCaps1 = createDeferred<any>();
      vi.spyOn(realApiClient, 'getAgentCapabilities').mockImplementation(async () => deferredCaps1.promise);

      renderWithProviders(
        <>
          <ModeSwitcher />
          <AgentLauncherView />
        </>,
        '/agent',
        'real'
      );

      // In Real mode, initial capability request is pending
      expect(screen.getByTestId('current-api-mode').textContent).toBe('real');
      expect(screen.queryByRole('option', { name: 'React Task Manager' })).toBeNull();
      expect(screen.queryByTestId('active-workspace-select')).toBeNull();

      // Switch to Mock mode before deferredCaps1 resolves
      fireEvent.click(screen.getByTestId('switch-to-mock-btn'));
      expect(screen.getByTestId('current-api-mode').textContent).toBe('mock');

      // Mock mode loads fixture workspaces
      await waitFor(() => {
        expect(screen.getByRole('option', { name: 'React Task Manager' })).toBeDefined();
      });

      // Now late Real capability request resolves
      deferredCaps1.resolve(defaultUnavailableCaps);

      // Wait a tick and verify Mock workspaces are NOT cleared by late Real response
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.getByRole('option', { name: 'React Task Manager' })).toBeDefined();
      expect(screen.getByTestId('active-workspace-select')).toBeDefined();
    });

    it('P1 Launcher: Real capability rejection leaves Real mode isolated without uncaught errors or mock leakage', async () => {
      vi.spyOn(realApiClient, 'getAgentCapabilities').mockRejectedValue(new Error('Network error or 500'));

      renderWithProviders(
        <AgentLauncherView />,
        '/agent',
        'real'
      );

      await waitFor(() => {
        expect(screen.getByTestId('real-mode-runtime-warning')).toBeDefined();
      });

      // Execution button disabled
      const launchBtn = screen.getByTestId('launch-agent-btn') as HTMLButtonElement;
      expect(launchBtn.disabled).toBe(true);
      expect(launchBtn.textContent).toContain('Execution Unavailable (Real Mode)');

      // No mock data leak
      expect(screen.queryByRole('option', { name: 'React Task Manager' })).toBeNull();
      expect(screen.queryByTestId('active-workspace-select')).toBeNull();
    });

    it('P1 Launcher: unmount during pending capability request is safely ignored by request fencing', async () => {
      const deferredCaps = createDeferred<any>();
      vi.spyOn(realApiClient, 'getAgentCapabilities').mockImplementation(() => deferredCaps.promise);

      const { unmount } = renderWithProviders(<AgentLauncherView />, '/agent', 'real');
      unmount();

      // Resolve after unmount
      expect(() => {
        deferredCaps.resolve(defaultUnavailableCaps);
      }).not.toThrow();
    });

    it('P1 RunView: switching run IDs during delayed getAgentRun ignores stale older run response', async () => {
      const deferredRun1 = createDeferred<any>();
      const deferredRun2 = createDeferred<any>();

      vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(defaultUnavailableCaps as any);

      vi.spyOn(realApiClient, 'getAgentRun').mockImplementation(async (id: string) => {
        if (id === 'real-run-1') return deferredRun1.promise;
        if (id === 'real-run-2') return deferredRun2.promise;
        throw new Error('Unexpected run id: ' + id);
      });

      renderWithProviders(
        <>
          <RouteSwitcher />
          <AgentRunView />
        </>,
        '/agent/runs/real-run-1',
        'real'
      );

      // Loading state for run 1
      expect(screen.getByTestId('agent-run-loading')).toBeDefined();

      // Switch route to run 2 while run 1 is still pending
      fireEvent.click(screen.getByTestId('nav-to-run-2'));

      // Resolve run 2 first
      deferredRun2.resolve({
        run: {
          id: 'real-run-2',
          task: 'Task Number Two - Newer Request',
          status: 'running',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });

      await waitFor(() => {
        expect(screen.getByTestId('run-task-title')).toBeDefined();
      });
      expect(screen.getByTestId('run-task-title').textContent).toBe('Task Number Two - Newer Request');

      // Now resolve older run 1
      deferredRun1.resolve({
        run: {
          id: 'real-run-1',
          task: 'Task Number One - Stale Older Request',
          status: 'completed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });

      // Wait a tick and verify Run 2 is still shown, NOT overwritten by stale Run 1
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.getByTestId('run-task-title').textContent).toBe('Task Number Two - Newer Request');
    });

    it('P1 RunView: Real -> Mock with pending Real run fetch does not allow late Real response to overwrite Mock run', async () => {
      const deferredRealRun = createDeferred<any>();
      vi.spyOn(realApiClient, 'getAgentRun').mockImplementation(() => deferredRealRun.promise);
      vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(defaultUnavailableCaps as any);

      renderWithProviders(
        <>
          <ModeSwitcher />
          <AgentRunView />
        </>,
        '/agent/runs/run-golden-react',
        'real'
      );

      // In Real mode, run fetch is in-flight
      expect(screen.getByTestId('current-api-mode').textContent).toBe('real');
      expect(screen.getByTestId('agent-run-loading')).toBeDefined();

      // Switch to Mock mode before Real fetch resolves
      fireEvent.click(screen.getByTestId('switch-to-mock-btn'));
      expect(screen.getByTestId('current-api-mode').textContent).toBe('mock');

      // Mock run loads
      await waitFor(() => {
        expect(screen.getByTestId('agent-run-view')).toBeDefined();
        expect(screen.getByTestId('run-task-title').textContent).toContain('Build a responsive React task manager');
      });

      // Late Real run resolves with different data
      deferredRealRun.resolve({
        run: {
          id: 'run-golden-react',
          task: 'Stale Real Task That Should Be Ignored',
          status: 'failed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      // Mock run data remains active
      expect(screen.getByTestId('run-task-title').textContent).toContain('Build a responsive React task manager');
    });

    it('P1 RunView: Real mode disables Cancel and Approval controls when capabilities are unavailable', async () => {
      // Mock capabilities with cancellation: false and externalApproval: false
      vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(defaultUnavailableCaps as any);

      // 1. Running status -> Cancel button disabled
      vi.spyOn(realApiClient, 'getAgentRun').mockResolvedValue({
        run: {
          id: 'real-run-active',
          task: 'Active Real Run for Cancellation Gating',
          status: 'running',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as any,
      });

      const firstMount = renderWithProviders(<AgentRunView />, '/agent/runs/real-run-active', 'real');

      await waitFor(() => {
        expect(screen.getByTestId('cancel-run-btn')).toBeDefined();
      });

      const cancelBtn = screen.getByTestId('cancel-run-btn') as HTMLButtonElement;
      expect(cancelBtn.disabled).toBe(true);
      expect(cancelBtn.title).toBe('Run cancellation is unavailable in Real Mode');
      firstMount.unmount();

      // 2. Awaiting Approval status -> Approval action buttons disabled
      vi.spyOn(realApiClient, 'getAgentRun').mockResolvedValue({
        run: {
          id: 'real-run-approval',
          task: 'Approval Real Run for Approval Gating',
          status: 'awaiting_approval',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          approvalRequest: {
            id: 'appr-req-1',
            action: 'Execute Production Database Migration',
            target: 'postgres-primary.prod',
            risk: 'high',
            reason: 'Irreversible database mutation requires human confirmation',
            scope: 'database-migration',
          },
        } as any,
      });

      const secondMount = renderWithProviders(<AgentRunView />, '/agent/runs/real-run-approval', 'real');

      await waitFor(() => {
        expect(screen.getByTestId('approval-action-card')).toBeDefined();
      });

      const rejectBtn = screen.getByTestId('reject-approval-btn') as HTMLButtonElement;
      const confirmBtn = screen.getByTestId('confirm-approval-btn') as HTMLButtonElement;

      expect(rejectBtn.disabled).toBe(true);
      expect(rejectBtn.title).toBe('Action approval is unavailable in Real Mode');

      expect(confirmBtn.disabled).toBe(true);
      expect(confirmBtn.title).toBe('Action approval is unavailable in Real Mode');

      secondMount.unmount();
    });

    it('P2 Launcher: default blank workspace creates a fresh workspace on launch without mutating existing fixtures', async () => {
      const initialWsCount = workspaceFixtureStore.getWorkspaces().length;
      expect(initialWsCount).toBe(3); // React Task Manager, CSV Analytics, Doc Site

      renderWithProviders(<AgentLauncherView />);

      await waitFor(() => {
        expect(screen.getByTestId('active-workspace-select')).toBeDefined();
      });

      // Default selectedWorkspaceId is empty string ("New Blank Workspace (Default)")
      const select = screen.getByTestId('active-workspace-select') as HTMLSelectElement;
      expect(select.value).toBe('');

      // Enter a valid task
      const input = screen.getByTestId('agent-task-input');
      fireEvent.change(input, { target: { value: 'Create a brand new standalone utility script' } });

      // Submit launch
      const form = screen.getByTestId('task-composer-card');
      fireEvent.submit(form);

      // Verify a fresh workspace was created
      const currentWorkspaces = workspaceFixtureStore.getWorkspaces();
      expect(currentWorkspaces.length).toBe(initialWsCount + 1);

      // The new workspace is a blank workspace and was prepended to the fixtures list
      const newWs = currentWorkspaces[0];
      expect(newWs.id).not.toBe('ws-react-task-manager');
      expect(newWs.id).not.toBe('ws-csv-analytics');
      expect(newWs.id).not.toBe('ws-doc-site');
      expect(newWs.name).toContain('Blank Workspace');

      // The 3 initial fixtures remain unmutated
      expect(workspaceFixtureStore.getWorkspace('ws-react-task-manager')?.name).toBe('React Task Manager');
      expect(workspaceFixtureStore.getWorkspace('ws-csv-analytics')?.name).toBe('CSV Dataset Analytics');
      expect(workspaceFixtureStore.getWorkspace('ws-doc-site')?.name).toBe('Documentation Website');
    });

    it('Linear 17T-48 description: accurately describes 17T-48 as frontend control-plane integration and separates it from backend runtime readiness', async () => {
      vi.spyOn(realApiClient, 'getAgentCapabilities').mockResolvedValue(defaultUnavailableCaps as any);

      renderWithProviders(<AgentLauncherView />, '/agent', 'real');

      await waitFor(() => {
        expect(screen.getByTestId('real-mode-runtime-warning')).toBeDefined();
      });

      const warningText = screen.getByTestId('real-mode-runtime-warning').textContent;
      expect(warningText).toContain('Frontend control-plane integration is tracked under Linear 17T-48');
      expect(warningText).toContain('Cloud sandbox execution runtime requires separate backend infrastructure readiness');
    });
  });
});
