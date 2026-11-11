import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentChangeReview, AgentRealChangeReviewPanel } from '../src/features/agent/AgentChangeReview.js';
import { getDemoAgentDiffFixtures } from '../src/features/agent/agent-diff-fixtures.js';
import { workspaceFixtureStore } from '../src/features/agent/workspace-fixtures.js';

describe('Agent change review integration', () => {
  it('keeps run summary information and shows deterministic labeled multi-file Demo review', () => {
    const run = workspaceFixtureStore.getRun('run-golden-react');
    expect(run).toBeDefined();
    if (!run) return;
    render(<AgentChangeReview fileChanges={run.fileChanges} fixtureValue={getDemoAgentDiffFixtures(run.id)} />);

    expect(screen.getByTestId('workspace-changes-section').textContent).toContain('Sandbox File Changes Summary');
    expect(screen.getByTestId('workspace-changes-section').textContent).toContain('Demo sample data');
    expect(screen.getByTestId('workspace-changes-section').textContent).toContain('does not describe a real Cloud Agent run');
    expect(screen.getByTestId('workspace-changes-section').textContent).toContain('counts unavailable for 2');
    expect(screen.getByTestId('file-diff-viewer').textContent).toContain('Reported +85 / −0 · excerpt +4 / −0');
    expect(screen.getByTestId('file-changes-list')).toBeDefined();
    expect(screen.getByTestId('file-item-src/components/index.ts')).toBeDefined();
    expect(screen.getByTestId('file-item-src/utils/index.ts')).toBeDefined();
    expect(screen.getByTestId('file-item-docs/Release notes à lire.md')).toBeDefined();
    expect(screen.getByTestId('file-item-docs/old setup guide.md')).toBeDefined();
    expect(screen.getByTestId('file-item-assets/logo.png')).toBeDefined();
  });

  it('switches changed files without mixing patch rows and keeps independent same-basename identities', () => {
    const run = workspaceFixtureStore.getRun('run-golden-react');
    if (!run) throw new Error('Golden Demo fixture missing');
    render(<AgentChangeReview fileChanges={run.fileChanges} fixtureValue={getDemoAgentDiffFixtures(run.id)} />);

    expect(screen.getByTestId('file-diff-viewer').textContent).toContain('TaskList');
    fireEvent.click(screen.getByTestId('file-item-src/utils/index.ts'));
    expect(screen.getByTestId('file-item-src/utils/index.ts').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('file-diff-viewer').textContent).toContain('retries');
    expect(screen.getByTestId('file-diff-viewer').textContent).not.toContain('TaskList');
    fireEvent.click(screen.getByTestId('file-item-src/components/index.ts'));
    expect(screen.getByTestId('file-diff-viewer').textContent).toContain('TaskList');
  });

  it('shows explicit partial, unavailable, deleted, binary, and too-large states with accurate copy behavior', () => {
    const run = workspaceFixtureStore.getRun('run-golden-react');
    if (!run) throw new Error('Golden Demo fixture missing');
    render(<AgentChangeReview fileChanges={run.fileChanges} fixtureValue={getDemoAgentDiffFixtures(run.id)} />);
    expect(screen.getByRole('button', { name: 'Copy excerpt' })).toBeDefined();

    fireEvent.click(screen.getByTestId('file-item-src/without-patch.ts'));
    expect(screen.getByTestId('diff-unavailable').textContent).toContain('not available');
    expect((screen.getByTestId('copy-diff-btn') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('file-item-docs/old setup guide.md'));
    expect(screen.getByText(/after file does not exist/i)).toBeDefined();
    expect(screen.getByTestId('file-diff-viewer').textContent).toContain('Old setup');

    fireEvent.click(screen.getByTestId('file-item-assets/logo.png'));
    expect(screen.getByTestId('diff-binary').textContent).toContain('binary');
    fireEvent.click(screen.getByTestId('file-item-src/large-preview.ts'));
    expect(screen.getByTestId('diff-too-large').textContent).toContain('budget');
  });

  it('clears selection when the parent changes run identity and prevents previous patch leakage', () => {
    const original = workspaceFixtureStore.getRun('run-golden-react');
    if (!original) throw new Error('Golden Demo fixture missing');
    const { rerender } = render(
      <AgentChangeReview key="workspace-a:run-a" fileChanges={original.fileChanges} fixtureValue={getDemoAgentDiffFixtures(original.id)} />,
    );
    fireEvent.click(screen.getByTestId('file-item-src/utils/index.ts'));
    expect(screen.getByTestId('file-diff-viewer').textContent).toContain('retries');

    rerender(<AgentChangeReview key="workspace-b:run-b" fileChanges={[{ path: 'docs/new.md', status: 'created', additions: 1, deletions: 0 }]} />);
    expect(screen.queryByText('retries')).toBeNull();
    expect(screen.getByTestId('file-diff-viewer').textContent).toContain('docs/new.md');
    expect(screen.getByTestId('diff-unavailable')).toBeDefined();
  });

  it('keeps an empty run state truthful and rejects invalid path metadata', () => {
    const { rerender } = render(<AgentChangeReview fileChanges={[]} />);
    expect(screen.getByTestId('empty-changes-message').textContent).toContain('No sandbox files');
    rerender(<AgentChangeReview fileChanges={[{ path: '../outside', status: 'created' }]} />);
    expect(screen.getByTestId('invalid-changes-message').textContent).toContain('invalid or conflicting');
    expect(screen.queryByTestId('file-diff-viewer')).toBeNull();
  });

  it('uses an own fixture registry lookup and never resolves inherited prototype properties', () => {
    expect(getDemoAgentDiffFixtures('run-golden-react')).toBeDefined();
    expect(getDemoAgentDiffFixtures('constructor')).toBeUndefined();
    expect(getDemoAgentDiffFixtures('toString')).toBeUndefined();
    expect(getDemoAgentDiffFixtures('__proto__')).toBeUndefined();
  });

  it('keeps Real mode unsupported without synthetic patches or action controls', () => {
    const { container } = render(<AgentRealChangeReviewPanel />);
    expect(screen.getByTestId('real-change-review-unavailable').textContent).toContain('does not currently provide a reviewed file diff endpoint');
    expect(screen.getByTestId('real-change-review-unavailable').textContent).toContain('No Demo patches are used for Real runs');
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelector('[data-testid="file-diff-viewer"]')).toBeNull();
  });
});
