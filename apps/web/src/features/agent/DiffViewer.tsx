import React, { useState } from 'react';
import type { ChangeProposal, ChangedFile } from '../../lib/api/types.js';

interface DiffViewerProps {
  proposal: ChangeProposal;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({ proposal }) => {
  const [selectedPath, setSelectedPath] = useState<string>(
    proposal.files[0]?.path || ''
  );

  const activeFile: ChangedFile | undefined =
    proposal.files.find((f) => f.path === selectedPath) || proposal.files[0];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#0f172a',
        border: '1px solid #1e293b',
        borderRadius: '8px',
        overflow: 'hidden',
        marginTop: '16px',
      }}
    >
      {/* Diff Header Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          backgroundColor: '#182234',
          borderBottom: '1px solid #1e293b',
          fontSize: '13px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontWeight: 600, color: '#f1f5f9' }}>Proposed Unified Diff</span>
          <span style={{ color: '#64748b' }}>
            Base SHA: <code>{proposal.baseCommitSha.slice(0, 7)}</code>
          </span>
        </div>
        <div style={{ display: 'flex', gap: '8px', fontSize: '12px', color: '#94a3b8' }}>
          <span>{proposal.files.length} files changed</span>
        </div>
      </div>

      {/* File Navigation Tabs */}
      <div
        style={{
          display: 'flex',
          overflowX: 'auto',
          backgroundColor: '#0b1120',
          borderBottom: '1px solid #1e293b',
          padding: '4px 8px 0',
        }}
      >
        {proposal.files.map((file) => {
          const isSelected = file.path === selectedPath;
          const statusBadgeColor =
            file.status === 'added' ? '#34d399' : file.status === 'deleted' ? '#f43f5e' : '#38bdf8';
          const statusLetter = file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M';

          return (
            <button
              key={file.path}
              onClick={() => setSelectedPath(file.path)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 14px',
                fontSize: '13px',
                fontFamily: 'inherit',
                border: 'none',
                borderBottom: `2px solid ${isSelected ? '#6366f1' : 'transparent'}`,
                backgroundColor: isSelected ? '#182234' : 'transparent',
                color: isSelected ? '#f1f5f9' : '#94a3b8',
                cursor: 'pointer',
                borderRadius: '6px 6px 0 0',
                whiteSpace: 'nowrap',
              }}
            >
              <span
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  color: statusBadgeColor,
                  border: `1px solid ${statusBadgeColor}`,
                  borderRadius: '3px',
                  padding: '1px 3px',
                }}
              >
                {statusLetter}
              </span>
              <span>{file.path}</span>
              {(file.additions !== undefined || file.deletions !== undefined) && (
                <span style={{ fontSize: '11px', color: '#64748b' }}>
                  <span style={{ color: '#34d399' }}>+{file.additions ?? 0}</span>{' '}
                  <span style={{ color: '#f43f5e' }}>-{file.deletions ?? 0}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Unified Diff Content Viewer */}
      <div
        style={{
          padding: '12px',
          overflowX: 'auto',
          backgroundColor: '#090d16',
          fontFamily: 'monospace',
          fontSize: '13px',
          lineHeight: 1.5,
          maxHeight: '380px',
          overflowY: 'auto',
        }}
      >
        {activeFile ? (
          activeFile.unifiedDiff.split('\n').map((line, idx) => {
            const isAdd = line.startsWith('+') && !line.startsWith('+++');
            const isDel = line.startsWith('-') && !line.startsWith('---');
            const isHeader = line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++');

            const bg = isAdd ? 'rgba(16, 185, 129, 0.15)' : isDel ? 'rgba(244, 63, 94, 0.15)' : 'transparent';
            const text = isAdd ? '#34d399' : isDel ? '#f87171' : isHeader ? '#38bdf8' : '#cbd5e1';

            return (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  backgroundColor: bg,
                  color: text,
                  padding: '1px 8px',
                  borderRadius: '2px',
                }}
              >
                <span style={{ width: '36px', userSelect: 'none', color: '#475569', textAlign: 'right', marginRight: '12px' }}>
                  {idx + 1}
                </span>
                <span style={{ whiteSpace: 'pre', flex: 1 }}>{line}</span>
              </div>
            );
          })
        ) : (
          <div style={{ color: '#64748b', padding: '16px', textAlign: 'center' }}>No diff available.</div>
        )}
      </div>
    </div>
  );
};
