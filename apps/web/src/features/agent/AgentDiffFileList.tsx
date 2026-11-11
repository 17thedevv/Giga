import React from 'react';
import { safeAgentFileDisplayText } from './agent-file-model.js';
import type { AgentChangeFile } from './agent-diff-model.js';

interface AgentDiffFileListProps {
  readonly files: readonly AgentChangeFile[];
  readonly selectedKey: string | null;
  readonly onSelect: (key: string) => void;
}

function previewLabel(file: AgentChangeFile): string {
  switch (file.preview.kind) {
    case 'complete': return 'Diff available';
    case 'partial': return 'Excerpt available';
    case 'binary': return 'Binary preview';
    case 'too-large': return 'Preview too large';
    case 'unavailable': return 'Preview unavailable';
  }
}

export const AgentDiffFileList: React.FC<AgentDiffFileListProps> = React.memo(({ files, selectedKey, onSelect }) => (
  <nav className="g-agent-diff-files" aria-label="Changed files" data-testid="agent-diff-file-list">
    <h3>Changed files <span>({files.length})</span></h3>
    <ul>
      {files.map((file) => (
        <li key={file.key}>
          <button
            type="button"
            className={`g-agent-diff-files__item${selectedKey === file.key ? ' is-selected' : ''}`}
            aria-pressed={selectedKey === file.key}
            aria-label={`${file.status} ${file.path}; ${previewLabel(file)}`}
            onClick={() => onSelect(file.key)}
            data-testid={`file-item-${file.path}`}
          >
            <span className={`g-agent-diff-files__status is-${file.status}`}>
              <span aria-hidden="true">{file.status === 'created' ? '+' : file.status === 'deleted' ? '−' : '±'}</span>
              {file.status}
            </span>
            <span className="g-agent-diff-files__path" title={safeAgentFileDisplayText(file.path)}>
              {safeAgentFileDisplayText(file.path)}
            </span>
            <span className="g-agent-diff-files__counts" aria-label={`${file.additions ?? 'unknown'} additions, ${file.deletions ?? 'unknown'} deletions`}>
              {file.additions === null ? '＋—' : `＋${file.additions}`}
              {' '}
              {file.deletions === null ? '−—' : `−${file.deletions}`}
            </span>
            <span className="g-agent-diff-files__availability">{previewLabel(file)}</span>
          </button>
        </li>
      ))}
    </ul>
  </nav>
));

AgentDiffFileList.displayName = 'AgentDiffFileList';
