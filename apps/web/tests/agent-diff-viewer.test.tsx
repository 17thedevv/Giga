import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentDiffViewer } from '../src/features/agent/AgentDiffViewer.js';
import { projectDemoAgentChanges } from '../src/features/agent/agent-diff-model.js';

function makeFile(path: string, status: 'created' | 'modified' | 'deleted', hunks: unknown[], additions: number, deletions: number, kind: 'complete' | 'partial' = 'complete') {
  const result = projectDemoAgentChanges(
    [{ path, status, additions, deletions }],
    { provenance: 'demo-fixture', files: [{ path, status, beforeRevision: status === 'created' ? 'No before file (Demo)' : 'Demo revision A', afterRevision: status === 'deleted' ? 'No after file (Demo)' : 'Demo revision B', preview: { kind, hunks } }] },
  );
  if (!result.ok) throw new Error('Expected a valid fixture');
  return result.files[0]!;
}

function hunk(oldStart: number, oldCount: number, newStart: number, newCount: number, lines: unknown[]) {
  return { oldStart, oldCount, newStart, newCount, lines };
}

function clearClipboard() {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined });
}

afterEach(() => {
  clearClipboard();
  vi.restoreAllMocks();
});

describe('AgentDiffViewer', () => {
  it('renders unified additions, deletions, context, line numbers, and multiple hunk headers', () => {
    const file = makeFile('src/multi.ts', 'modified', [
      hunk(2, 2, 2, 2, [
        { kind: 'context', text: 'before' },
        { kind: 'deletion', text: 'oldValue' },
        { kind: 'addition', text: 'newValue' },
      ]),
      hunk(12, 1, 12, 1, [{ kind: 'context', text: 'after' }]),
    ], 1, 1);
    const { container } = render(<AgentDiffViewer file={file} />);
    expect(container.querySelectorAll('[data-testid="diff-hunk-0"], [data-testid="diff-hunk-1"]')).toHaveLength(2);
    expect(screen.getByText('oldValue')).toBeDefined();
    expect(screen.getByText('newValue')).toBeDefined();
    expect(screen.getByText('before')).toBeDefined();
    expect(screen.getByText('after')).toBeDefined();
    const added = container.querySelector('.g-agent-diff-row.is-addition');
    expect(added?.textContent).toContain('3');
    expect(added?.getAttribute('aria-label')).toContain('Added, new line 3');
  });

  it('renders HTML-like source as inert text and preserves Unicode and whitespace', () => {
    const file = makeFile('docs/名字.md', 'created', [hunk(0, 0, 1, 2, [
      { kind: 'addition', text: '  <script>window.__xss = true</script>  ' },
      { kind: 'addition', text: 'Chào 👋' },
    ])], 2, 0);
    const { container } = render(<AgentDiffViewer file={file} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>window.__xss = true</script>');
    expect(container.textContent).toContain('  <script>');
    expect(container.textContent).toContain('Chào 👋');
  });

  it('switches to aligned side-by-side rows with empty counterparts rather than fabricated text', () => {
    const file = makeFile('src/changed.ts', 'modified', [hunk(1, 3, 1, 4, [
      { kind: 'context', text: 'head' },
      { kind: 'deletion', text: 'old' },
      { kind: 'addition', text: 'new' },
      { kind: 'addition', text: 'second new' },
      { kind: 'context', text: 'tail' },
    ])], 2, 1);
    const { container } = render(<AgentDiffViewer file={file} />);
    fireEvent.click(screen.getByTestId('diff-view-split'));
    expect(container.querySelector('.g-agent-diff-split-headings')?.textContent).toContain('Before');
    expect(container.querySelector('.g-agent-diff-split-headings')?.textContent).toContain('After');
    expect(screen.getByText('old')).toBeDefined();
    expect(screen.getByText('new')).toBeDefined();
    const emptyBefore = container.querySelector('.g-agent-diff-row__cell.is-empty');
    expect(emptyBefore?.getAttribute('aria-label')).toBe('No before content for this change');
    expect(container.querySelectorAll('[data-testid="agent-diff-split-row"]')).toHaveLength(4);
  });

  it('states when before or after file does not exist for added and deleted files', () => {
    const added = makeFile('src/new.ts', 'created', [hunk(0, 0, 1, 1, [{ kind: 'addition', text: 'new' }])], 1, 0);
    const addedView = render(<AgentDiffViewer file={added} />);
    expect(screen.getByText(/before file does not exist/i)).toBeDefined();
    expect(screen.getByText(/No before file \(Demo\)/)).toBeDefined();
    addedView.unmount();

    const deleted = makeFile('src/old.ts', 'deleted', [hunk(1, 1, 0, 0, [{ kind: 'deletion', text: 'old' }])], 0, 1);
    render(<AgentDiffViewer file={deleted} />);
    expect(screen.getByText(/after file does not exist/i)).toBeDefined();
    expect(screen.getByText(/No after file \(Demo\)/)).toBeDefined();
  });

  it('keeps created and deleted status consistent in unified and side-by-side rows', () => {
    const created = makeFile('src/new.ts', 'created', [hunk(0, 0, 1, 1, [
      { kind: 'addition', text: 'new only' },
    ])], 1, 0);
    const createdView = render(<AgentDiffViewer file={created} />);
    expect(createdView.container.querySelector('.g-agent-diff-row.is-addition .g-agent-diff-row__number')?.textContent).toBe('');
    expect(createdView.container.querySelector('.g-agent-diff-row.is-addition .g-agent-diff-row__number + .g-agent-diff-row__number')?.textContent).toBe('1');
    fireEvent.click(screen.getByTestId('diff-view-split'));
    const createdCells = createdView.container.querySelectorAll('.g-agent-diff-split-row .g-agent-diff-row__cell');
    expect(createdCells[0]?.classList.contains('is-empty')).toBe(true);
    expect(createdCells[0]?.textContent).not.toContain('new only');
    expect(createdCells[1]?.textContent).toContain('new only');
    createdView.unmount();

    const deleted = makeFile('src/old.ts', 'deleted', [hunk(1, 1, 0, 0, [
      { kind: 'deletion', text: 'old only' },
    ])], 0, 1);
    const deletedView = render(<AgentDiffViewer file={deleted} />);
    expect(deletedView.container.querySelector('.g-agent-diff-row.is-deletion .g-agent-diff-row__number')?.textContent).toBe('1');
    expect(deletedView.container.querySelector('.g-agent-diff-row.is-deletion .g-agent-diff-row__number + .g-agent-diff-row__number')?.textContent).toBe('');
    fireEvent.click(screen.getByTestId('diff-view-split'));
    const deletedCells = deletedView.container.querySelectorAll('.g-agent-diff-split-row .g-agent-diff-row__cell');
    expect(deletedCells[0]?.textContent).toContain('old only');
    expect(deletedCells[1]?.classList.contains('is-empty')).toBe(true);
    expect(deletedCells[1]?.textContent).not.toContain('old only');
  });

  it('preserves shifted multi-hunk line numbers in unified and split views', () => {
    const file = makeFile('src/shifted.ts', 'modified', [
      hunk(1, 1, 1, 2, [
        { kind: 'context', text: 'before' },
        { kind: 'addition', text: 'inserted' },
      ]),
      hunk(5, 1, 6, 1, [{ kind: 'context', text: 'later' }]),
    ], 1, 0);
    const { container } = render(<AgentDiffViewer file={file} />);
    const unifiedLater = container.querySelector('[data-testid="diff-hunk-1"] .g-agent-diff-row');
    expect(unifiedLater?.getAttribute('aria-label')).toContain('old line 5, new line 6');

    fireEvent.click(screen.getByTestId('diff-view-split'));
    const splitCells = container.querySelectorAll('[data-testid="diff-hunk-1"] .g-agent-diff-row__cell');
    expect(splitCells[0]?.querySelector('.g-agent-diff-row__number')?.textContent).toBe('5');
    expect(splitCells[1]?.querySelector('.g-agent-diff-row__number')?.textContent).toBe('6');
    expect(splitCells[0]?.textContent).toContain('later');
    expect(splitCells[1]?.textContent).toContain('later');
  });

  it('folds unchanged context without putting the hidden rows into the DOM and can expand/collapse it', () => {
    const lines = Array.from({ length: 12 }, (_, index) => ({ kind: 'context', text: `line-${index + 1}` }));
    const file = makeFile('src/context.ts', 'modified', [hunk(1, 12, 1, 12, lines)], 0, 0);
    render(<AgentDiffViewer file={file} />);
    expect(screen.queryByText('line-4')).toBeNull();
    const fold = screen.getByTestId('fold-context-0-0');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(fold);
    expect(screen.getByText('line-4')).toBeDefined();
    expect(screen.getByTestId('fold-context-0-0').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByTestId('fold-context-0-0'));
    expect(screen.queryByText('line-4')).toBeNull();
  });

  it('folds a large context group to a bounded expanded window', () => {
    const lines = Array.from({ length: 500 }, (_, index) => ({ kind: 'context', text: `context-${index}` }));
    const file = makeFile('src/large-context.ts', 'modified', [hunk(1, 500, 1, 500, lines)], 0, 0);
    const { container } = render(<AgentDiffViewer file={file} />);
    expect(container.querySelectorAll('[data-testid="agent-diff-row"]')).toHaveLength(6);
    fireEvent.click(screen.getByTestId('fold-context-0-0'));
    expect(container.querySelectorAll('[data-testid="agent-diff-row"]')).toHaveLength(200);
    expect(screen.getByText(/300 remain folded/i)).toBeDefined();
  });

  it('announces a successful explicit copy and includes provenance in the copied text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const file = makeFile('src/copy.ts', 'created', [hunk(0, 0, 1, 1, [{ kind: 'addition', text: 'const safe = true;' }])], 1, 0);
    render(<AgentDiffViewer file={file} />);
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('copy-diff-btn'));
    await waitFor(() => expect(screen.getByTestId('copy-diff-status').textContent).toContain('Copied the validated Demo patch snippet'));
    expect(writeText.mock.calls[0]?.[0]).toContain('Demo sample patch');
    expect(writeText.mock.calls[0]?.[0]).toContain('const safe = true;');
  });

  it('labels partial clipboard content as an excerpt, not a complete patch', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const file = makeFile('src/partial.ts', 'created', [hunk(0, 0, 1, 1, [{ kind: 'addition', text: 'one line' }])], 50, 0, 'partial');
    render(<AgentDiffViewer file={file} />);
    expect(screen.getByText(/Partial Demo excerpt/)).toBeDefined();
    fireEvent.click(screen.getByTestId('copy-diff-btn'));
    await waitFor(() => expect(screen.getByTestId('copy-diff-status').textContent).toContain('labeled partial Demo excerpt'));
    expect(writeText.mock.calls[0]?.[0]).toContain('not a complete or applicable patch');
  });

  it('announces clipboard denial without pretending a copy succeeded', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    const file = makeFile('src/copy.ts', 'created', [hunk(0, 0, 1, 1, [{ kind: 'addition', text: 'line' }])], 1, 0);
    render(<AgentDiffViewer file={file} />);
    fireEvent.click(screen.getByTestId('copy-diff-btn'));
    await waitFor(() => expect(screen.getByTestId('copy-diff-status').textContent).toContain('Copy was unavailable'));
    expect(screen.getByTestId('copy-diff-status').textContent).not.toContain('Copied');
  });

  it('uses the explicit-action fallback when Clipboard API is absent', async () => {
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    const file = makeFile('src/fallback.ts', 'created', [hunk(0, 0, 1, 1, [{ kind: 'addition', text: 'fallback' }])], 1, 0);
    render(<AgentDiffViewer file={file} />);
    fireEvent.click(screen.getByTestId('copy-diff-btn'));
    await waitFor(() => expect(screen.getByTestId('copy-diff-status').textContent).toContain('Copied the validated'));
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('disables copy and shows explicit placeholders for binary and oversized previews', () => {
    const binaryResult = projectDemoAgentChanges([{ path: 'assets/a.bin', status: 'modified' }], {
      provenance: 'demo-fixture', files: [{ path: 'assets/a.bin', status: 'modified', beforeRevision: 'Demo A', afterRevision: 'Demo B', preview: { kind: 'binary' } }],
    });
    if (!binaryResult.ok) throw new Error('Expected valid binary summary');
    const { rerender } = render(<AgentDiffViewer file={binaryResult.files[0]!} />);
    expect(screen.getByTestId('diff-binary').textContent).toContain('Binary');
    expect((screen.getByTestId('copy-diff-btn') as HTMLButtonElement).disabled).toBe(true);

    const largeResult = projectDemoAgentChanges([{ path: 'src/large.ts', status: 'modified' }], {
      provenance: 'demo-fixture', files: [{ path: 'src/large.ts', status: 'modified', beforeRevision: 'Demo A', afterRevision: 'Demo B', preview: { kind: 'too-large' } }],
    });
    if (!largeResult.ok) throw new Error('Expected valid large summary');
    rerender(<AgentDiffViewer file={largeResult.files[0]!} />);
    expect(screen.getByTestId('diff-too-large').textContent).toContain('safe preview');
    expect((screen.getByTestId('copy-diff-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps view controls keyboard-operable native buttons and exposes the selected mode', () => {
    const file = makeFile('src/keyboard.ts', 'created', [hunk(0, 0, 1, 1, [{ kind: 'addition', text: 'line' }])], 1, 0);
    render(<AgentDiffViewer file={file} />);
    const split = screen.getByTestId('diff-view-split') as HTMLButtonElement;
    split.focus();
    expect(document.activeElement).toBe(split);
    fireEvent.click(split);
    expect(split.getAttribute('aria-pressed')).toBe('true');
    expect(split.tagName).toBe('BUTTON');
  });
});
