import React, { useMemo, useState } from 'react';
import {
  alignAgentDiffHunk,
  buildCopyableAgentDiff,
  MAX_AGENT_DIFF_EXPANDED_CONTEXT,
  type AgentDiffPreview,
  type AgentChangeFile,
  type AgentDiffHunk,
  type AgentDiffLine,
  type AgentSplitRow,
} from './agent-diff-model.js';

type ViewMode = 'unified' | 'split';
type CopyState = 'idle' | 'copying' | 'success' | 'failure';

type VisualChunk =
  | { readonly kind: 'context'; readonly key: string; readonly lines: readonly AgentDiffLine[] }
  | { readonly kind: 'line'; readonly key: string; readonly line: AgentDiffLine }
  | { readonly kind: 'split-context'; readonly key: string; readonly rows: readonly AgentSplitRow[] }
  | { readonly kind: 'split-line'; readonly key: string; readonly row: AgentSplitRow };

function unifiedChunks(hunk: AgentDiffHunk): VisualChunk[] {
  const chunks: VisualChunk[] = [];
  let index = 0;
  while (index < hunk.lines.length) {
    const line = hunk.lines[index]!;
    if (line.kind !== 'context') {
      chunks.push({ kind: 'line', key: line.key, line });
      index++;
      continue;
    }
    const context: AgentDiffLine[] = [];
    while (index < hunk.lines.length && hunk.lines[index]!.kind === 'context') context.push(hunk.lines[index++]!);
    chunks.push({ kind: 'context', key: context[0]!.key, lines: context });
  }
  return chunks;
}

function splitChunks(hunk: AgentDiffHunk): VisualChunk[] {
  const chunks: VisualChunk[] = [];
  const rows = alignAgentDiffHunk(hunk);
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    if (row.before?.kind !== 'context' || row.after !== row.before) {
      chunks.push({ kind: 'split-line', key: row.key, row });
      index++;
      continue;
    }
    const context: AgentSplitRow[] = [];
    while (index < rows.length) {
      const candidate = rows[index]!;
      if (candidate.before?.kind !== 'context' || candidate.after !== candidate.before) break;
      context.push(candidate);
      index++;
    }
    chunks.push({ kind: 'split-context', key: context[0]!.key, rows: context });
  }
  return chunks;
}

function lineLabel(line: AgentDiffLine): string {
  if (line.kind === 'addition') return `Added, new line ${line.newLine}`;
  if (line.kind === 'deletion') return `Deleted, old line ${line.oldLine}`;
  if (line.kind === 'no-newline') return 'No newline at end of file marker';
  return `Context, old line ${line.oldLine}, new line ${line.newLine}`;
}

function symbolFor(line: AgentDiffLine): string {
  if (line.kind === 'addition') return '+';
  if (line.kind === 'deletion') return '−';
  if (line.kind === 'no-newline') return '↳';
  return ' ';
}

function splitCellClass(line: AgentDiffLine | null): string {
  if (!line) return 'g-agent-diff-row__cell is-empty';
  if (line.kind === 'addition') return 'g-agent-diff-row__cell is-addition';
  if (line.kind === 'deletion') return 'g-agent-diff-row__cell is-deletion';
  if (line.kind === 'no-newline') return 'g-agent-diff-row__cell is-marker';
  return 'g-agent-diff-row__cell is-context';
}

function unavailableMessage(preview: AgentDiffPreview): string | null {
  switch (preview.kind) {
    case 'complete':
    case 'partial':
      return null;
    case 'unavailable':
    case 'binary':
    case 'too-large':
      return preview.message;
  }
}

function previewCounts(file: AgentChangeFile): { additions: number; deletions: number } | null {
  if (file.preview.kind !== 'complete' && file.preview.kind !== 'partial') return null;
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.preview.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'addition') additions++;
      if (line.kind === 'deletion') deletions++;
    }
  }
  return { additions, deletions };
}

async function writeClipboardFromGesture(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = typeof document.execCommand === 'function' && document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    textarea.remove();
  }
  return copied;
}

const DiffLineText: React.FC<{ line: AgentDiffLine }> = ({ line }) => (
  <span className="g-agent-diff-row__text">{line.text}</span>
);

export const AgentDiffViewer: React.FC<{ file: AgentChangeFile }> = React.memo(({ file }) => {
  const [mode, setMode] = useState<ViewMode>('unified');
  const [expandedContextKey, setExpandedContextKey] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const chunksByHunk = useMemo(() => file.preview.kind === 'complete' || file.preview.kind === 'partial'
    ? file.preview.hunks.map((hunk) => mode === 'unified' ? unifiedChunks(hunk) : splitChunks(hunk))
    : [], [file.preview, mode]);
  const copyable = useMemo(() => buildCopyableAgentDiff(file), [file]);
  const unavailable = unavailableMessage(file.preview);
  const displayedCounts = useMemo(() => previewCounts(file), [file]);

  const copy = async () => {
    if (!copyable || copyState === 'copying') return;
    setCopyState('copying');
    const succeeded = await writeClipboardFromGesture(copyable.text);
    setCopyState(succeeded ? 'success' : 'failure');
  };

  const renderUnifiedLine = (line: AgentDiffLine, key: string) => (
    <div className={`g-agent-diff-row is-${line.kind}`} key={key} data-testid="agent-diff-row" aria-label={`${lineLabel(line)}: ${line.text}`}>
      <span className="g-agent-diff-row__number" aria-hidden="true">{line.oldLine ?? ''}</span>
      <span className="g-agent-diff-row__number" aria-hidden="true">{line.newLine ?? ''}</span>
      <span className="g-agent-diff-row__symbol" aria-hidden="true">{symbolFor(line)}</span>
      <DiffLineText line={line} />
    </div>
  );

  const renderSplitRow = (row: AgentSplitRow) => (
    <div className="g-agent-diff-split-row" key={row.key} data-testid="agent-diff-split-row">
      <div className={splitCellClass(row.before)} data-side="Before" aria-label={row.before ? `${lineLabel(row.before)}: ${row.before.text}` : 'No before content for this change'}>
        <span className="g-agent-diff-row__number" aria-hidden="true">{row.before?.oldLine ?? ''}</span>
        <span className="g-agent-diff-row__symbol" aria-hidden="true">{row.before ? symbolFor(row.before) : ''}</span>
        {row.before && <DiffLineText line={row.before} />}
      </div>
      <div className={splitCellClass(row.after)} data-side="After" aria-label={row.after ? `${lineLabel(row.after)}: ${row.after.text}` : 'No after content for this change'}>
        <span className="g-agent-diff-row__number" aria-hidden="true">{row.after?.newLine ?? ''}</span>
        <span className="g-agent-diff-row__symbol" aria-hidden="true">{row.after ? symbolFor(row.after) : ''}</span>
        {row.after && <DiffLineText line={row.after} />}
      </div>
    </div>
  );

  const renderChunks = (hunkIndex: number, chunks: readonly VisualChunk[]) => chunks.map((chunk, chunkIndex) => {
    if (chunk.kind === 'context' || chunk.kind === 'split-context') {
      const lines = chunk.kind === 'context' ? chunk.lines : null;
      const rows = chunk.kind === 'split-context' ? chunk.rows : null;
      const length = lines?.length ?? rows?.length ?? 0;
      if (length <= 6) return lines
        ? lines.map((line) => renderUnifiedLine(line, line.key))
        : rows!.map(renderSplitRow);

      const contextKey = `${file.key}\u0000${hunkIndex}\u0000${chunkIndex}`;
      const expanded = expandedContextKey === contextKey;
      const indices = expanded
        ? Array.from({ length: Math.min(length, MAX_AGENT_DIFF_EXPANDED_CONTEXT) }, (_, index) => index)
        : [...Array.from({ length: 3 }, (_, index) => index), ...Array.from({ length: 3 }, (_, index) => length - 3 + index)];
      const uniqueIndices = [...new Set(indices)];
      const visible = uniqueIndices.map((index) => lines ? lines[index]! : rows![index]!);
      const hiddenCount = Math.max(0, length - visible.length);
      const controlId = `diff-context-${hunkIndex}-${chunkIndex}`;
      return (
        <React.Fragment key={contextKey}>
          <button
            className="g-agent-diff-context-toggle"
            type="button"
            aria-expanded={expanded}
            aria-controls={controlId}
            onClick={() => setExpandedContextKey(expanded ? null : contextKey)}
            data-testid={`fold-context-${hunkIndex}-${chunkIndex}`}
          >
            {expanded ? 'Collapse unchanged context' : `Show ${hiddenCount} hidden unchanged lines`}
          </button>
          <div id={controlId} className="g-agent-diff-context-lines">
            {visible.map((item) => lines ? renderUnifiedLine(item as AgentDiffLine, (item as AgentDiffLine).key) : renderSplitRow(item as AgentSplitRow))}
          </div>
          {expanded && hiddenCount > 0 && (
            <p className="g-agent-diff-context-limit" role="status">
              Showing at most {MAX_AGENT_DIFF_EXPANDED_CONTEXT} context lines here; {hiddenCount} remain folded for performance.
            </p>
          )}
        </React.Fragment>
      );
    }
    if (chunk.kind === 'line') return renderUnifiedLine(chunk.line, chunk.key);
    return renderSplitRow(chunk.row);
  });

  return (
    <section className="g-agent-diff-viewer" aria-label={`Read-only diff for ${file.path}`} data-testid="file-diff-viewer">
      <header className="g-agent-diff-viewer__header">
        <div className="g-agent-diff-viewer__title">
          <h3 title={file.path}>{file.path}</h3>
          <div className="g-agent-diff-viewer__meta">
            <span className={`g-agent-diff-files__status is-${file.status}`}>{file.status}</span>
            <span className="g-agent-diff-demo-label">{file.provenance} · read-only</span>
            {file.preview.kind === 'partial' && displayedCounts && (
              <span className="g-agent-diff-counts">Reported +{file.additions ?? '—'} / −{file.deletions ?? '—'} · excerpt +{displayedCounts.additions} / −{displayedCounts.deletions}</span>
            )}
            {file.preview.kind === 'complete' && displayedCounts && (
              <span className="g-agent-diff-counts">Complete sample +{displayedCounts.additions} / −{displayedCounts.deletions}</span>
            )}
          </div>
        </div>
        <div className="g-agent-diff-viewer__controls">
          <div className="g-agent-diff-view-toggle" role="group" aria-label="Diff view mode">
            <button type="button" aria-pressed={mode === 'unified'} onClick={() => setMode('unified')} data-testid="diff-view-unified">Unified</button>
            <button type="button" aria-pressed={mode === 'split'} onClick={() => setMode('split')} data-testid="diff-view-split">Side by side</button>
          </div>
          <button type="button" className="g-agent-diff-copy" onClick={() => void copy()} disabled={!copyable || copyState === 'copying'} data-testid="copy-diff-btn">
            {copyState === 'copying' ? 'Copying…' : copyable?.kind === 'excerpt' ? 'Copy excerpt' : 'Copy patch'}
          </button>
        </div>
      </header>

      <div className="g-agent-diff-revisions" aria-label="Demo revision labels">
        <div><span>Before</span><strong>{file.beforeRevision}</strong></div>
        <div><span>After</span><strong>{file.afterRevision}</strong></div>
      </div>

      {file.status === 'created' && <p className="g-agent-diff-file-state" role="status">The before file does not exist in this Demo sample.</p>}
      {file.status === 'deleted' && <p className="g-agent-diff-file-state" role="status">The after file does not exist in this Demo sample; this path is not a current file.</p>}

      {(file.preview.kind === 'complete' || file.preview.kind === 'partial') ? (
        <div className={`g-agent-diff-content is-${mode}`} data-testid="agent-diff-content">
          {file.preview.kind === 'partial' && (
            <p className="g-agent-diff-notice" role="note">Partial Demo excerpt. It omits source lines and is not a complete or applicable patch.</p>
          )}
          {file.preview.kind === 'complete' && (
            <p className="g-agent-diff-notice" role="note">Complete structured Demo sample for this file; it does not represent a persisted Cloud Agent result.</p>
          )}
          {mode === 'split' && <div className="g-agent-diff-split-headings"><strong>Before</strong><strong>After</strong></div>}
          {file.preview.hunks.map((hunk, index) => (
            <div className="g-agent-diff-hunk" key={hunk.key} data-testid={`diff-hunk-${index}`}>
              <div className="g-agent-diff-hunk__heading">@@ −{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@</div>
              <div className={mode === 'split' ? 'g-agent-diff-hunk__rows is-split' : 'g-agent-diff-hunk__rows'}>
                {renderChunks(index, chunksByHunk[index] ?? [])}
              </div>
            </div>
          ))}
        </div>
      ) : unavailable !== null ? (
        <p className="g-agent-diff-unavailable" role="status" data-testid={`diff-${file.preview.kind}`}>
          {unavailable}
        </p>
      ) : null}

      <p className="g-agent-diff-copy-status" role="status" aria-live="polite" data-testid="copy-diff-status">
        {copyState === 'success' && (copyable?.kind === 'excerpt' ? 'Copied a labeled partial Demo excerpt.' : 'Copied the validated Demo patch snippet.')}
        {copyState === 'failure' && 'Copy was unavailable. Clipboard permission may be denied or unsupported.'}
      </p>
    </section>
  );
});

AgentDiffViewer.displayName = 'AgentDiffViewer';

export { writeClipboardFromGesture };
