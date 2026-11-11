import React, { useMemo, useState } from 'react';
import { AgentDiffFileList } from './AgentDiffFileList.js';
import { AgentDiffViewer } from './AgentDiffViewer.js';
import { projectDemoAgentChanges } from './agent-diff-model.js';

interface AgentChangeReviewProps {
  readonly fileChanges: unknown;
  readonly fixtureValue?: unknown;
}

export const AgentChangeReview: React.FC<AgentChangeReviewProps> = React.memo(({ fileChanges, fixtureValue }) => {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const projection = useMemo(() => projectDemoAgentChanges(fileChanges, fixtureValue), [fileChanges, fixtureValue]);
  const files = projection.ok ? projection.files : [];
  const selectedFile = files.find((file) => file.key === selectedKey) ?? files[0] ?? null;
  const countedFiles = files.filter((file) => file.additions !== null && file.deletions !== null);
  const additions = countedFiles.reduce((total, file) => total + file.additions!, 0);
  const deletions = countedFiles.reduce((total, file) => total + file.deletions!, 0);
  const summaryCounts = countedFiles.length === files.length
    ? `Reported +${additions} / −${deletions} lines`
    : `Known totals +${additions} / −${deletions} across ${countedFiles.length} of ${files.length} files; counts unavailable for ${files.length - countedFiles.length}`;

  return (
    <section className="g-agent-change-review" data-testid="workspace-changes-section" aria-labelledby="agent-change-review-heading">
      <header className="g-agent-change-review__header">
        <div>
          <h2 id="agent-change-review-heading">Sandbox File Changes Summary</h2>
          <p>{files.length} files changed in this Demo summary · {summaryCounts}</p>
        </div>
        <span className="g-agent-diff-demo-label">Demo sample data</span>
      </header>

      <p className="g-agent-change-review__description">
        Workspace file review does not require a GitHub repository or pull request. This read-only sample is synthetic and does not describe a real Cloud Agent run, persisted snapshot, commit, or applied change.
      </p>

      {!projection.ok && (
        <p role="alert" data-testid="invalid-changes-message">
          {projection.reason === 'too-many-files'
            ? 'This change set exceeds the safe file-list limit and cannot be displayed.'
            : 'This change set contains invalid or conflicting file metadata and cannot be displayed.'}
        </p>
      )}

      {projection.ok && files.length === 0 && (
        <div className="g-agent-change-review__empty" data-testid="empty-changes-message">
          No sandbox files were created or modified for this run.
        </div>
      )}

      {projection.ok && files.length > 0 && (
        <div className="g-agent-change-review__body" data-testid="file-changes-list">
          <AgentDiffFileList files={files} selectedKey={selectedFile?.key ?? null} onSelect={setSelectedKey} />
          {selectedFile
            ? <AgentDiffViewer key={selectedFile.key} file={selectedFile} />
            : <p role="status">Select a changed file to inspect its Demo sample.</p>}
        </div>
      )}

      <p className="g-agent-change-review__footer">
        Reviewing changes is informational only. No code is executed, written, applied, committed, pushed, approved, or deployed here.
      </p>
    </section>
  );
});

AgentChangeReview.displayName = 'AgentChangeReview';

export const AgentRealChangeReviewPanel: React.FC = () => (
  <section className="g-agent-real-change-review" aria-labelledby="agent-real-change-review-heading" data-testid="real-change-review-unavailable">
    <header>
      <h2 id="agent-real-change-review-heading">Code change review <span className="g-agent-file-real-badge">Real API</span></h2>
    </header>
    <p>
      Code change review is not available for this Real workspace yet. The Agent API does not currently provide a reviewed file diff endpoint. No Demo patches are used for Real runs.
    </p>
  </section>
);
