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
        backgroundColor: 'var(--giga-surface, #111C2D)',
        border: '1px solid var(--giga-border, #1E293B)',
        borderRadius: 'var(--giga-radius-md, 8px)',
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
          backgroundColor: 'var(--giga-surface-muted, #18263A)',
          borderBottom: '1px solid var(--giga-border, #1E293B)',
          fontSize: '13px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>Proposed Unified Diff</span>
          <span style={{ color: 'var(--giga-text-muted, #94A3B8)' }}>
            Base SHA: <code>{proposal.baseCommitSha.slice(0, 7)}</code>
          </span>
        </div>
        <div style={{ display: 'flex', gap: '8px', fontSize: '12px', color: 'var(--giga-text-secondary, #94A3B8)' }}>
          <span>{proposal.files.length} files changed</span>
        </div>
      </div>

      {/* File Navigation Tabs */}
      <div
        style={{
          display: 'flex',
          overflowX: 'auto',
          backgroundColor: 'var(--giga-surface, #111C2D)',
          borderBottom: '1px solid var(--giga-border, #1E293B)',
          padding: '4px 8px 0',
        }}
      >
        {proposal.files.map((file) => {
          const isSelected = file.path === selectedPath;
          const statusBadgeColor =
            file.status === 'added'
              ? 'var(--giga-success, #16A34A)'
              : file.status === 'deleted'
              ? 'var(--giga-danger, #DC2626)'
              : 'var(--giga-primary, #3B82F6)';
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
                borderBottom: `2px solid ${isSelected ? 'var(--giga-primary, #3B82F6)' : 'transparent'}`,
                backgroundColor: isSelected ? 'var(--giga-surface-muted, #18263A)' : 'transparent',
                color: isSelected ? 'var(--giga-text, #F8FAFC)' : 'var(--giga-text-muted, #94A3B8)',
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
                <span style={{ fontSize: '11px', color: 'var(--giga-text-muted, #94A3B8)' }}>
                  <span style={{ color: 'var(--giga-success, #16A34A)' }}>+{file.additions ?? 0}</span>{' '}
                  <span style={{ color: 'var(--giga-danger, #DC2626)' }}>-{file.deletions ?? 0}</span>
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
          backgroundColor: 'var(--giga-bg, #0B1220)',
          fontFamily: 'var(--giga-font-mono, monospace)',
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

            const bg = isAdd ? 'rgba(22, 163, 74, 0.15)' : isDel ? 'rgba(220, 38, 38, 0.15)' : 'transparent';
            const text = isAdd
              ? 'var(--giga-success, #16A34A)'
              : isDel
              ? 'var(--giga-danger, #DC2626)'
              : isHeader
              ? 'var(--giga-primary, #3B82F6)'
              : 'var(--giga-text-secondary, #CBD5E1)';

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
                <span style={{ width: '36px', userSelect: 'none', color: 'var(--giga-text-muted, #94A3B8)', textAlign: 'right', marginRight: '12px' }}>
                  {idx + 1}
                </span>
                <span style={{ whiteSpace: 'pre', flex: 1 }}>{line}</span>
              </div>
            );
          })
        ) : (
          <div style={{ color: 'var(--giga-text-muted, #94A3B8)', padding: '16px', textAlign: 'center' }}>No diff available.</div>
        )}
      </div>
    </div>
  );
};
