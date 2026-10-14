import React, { useState } from 'react';
import type { Conversation } from '../../lib/api/types.js';
import { PlusIcon, TrashIcon } from '../../components/Icons.js';
import { Modal } from '../../components/Modal.js';
import { Button } from '../../components/Button.js';

interface ConversationSidebarProps {
  conversations: Conversation[];
  activeId?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  isLoading?: boolean;
}

export const ConversationSidebar: React.FC<ConversationSidebarProps> = ({
  conversations,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  isLoading = false,
}) => {
  const [deleteCandidate, setDeleteCandidate] = useState<Conversation | null>(null);

  return (
    <aside
      style={{
        width: '280px',
        backgroundColor: 'var(--giga-surface, #111C2D)',
        borderRight: '1px solid var(--giga-border, #1E293B)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        flexShrink: 0,
      }}
    >
      {/* Header with New Chat CTA */}
      <div
        style={{
          padding: '16px',
          borderBottom: '1px solid var(--giga-border, #1E293B)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <h2 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)', margin: 0 }}>
          Discussions
        </h2>
        <Button size="sm" variant="primary" onClick={onCreate} icon={<PlusIcon size={16} />}>
          New Chat
        </Button>
      </div>

      {/* List Area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
        {isLoading && (
          <div style={{ padding: '16px', textAlign: 'center', color: 'var(--giga-text-muted, #94A3B8)', fontSize: '13px' }}>
            Loading conversations...
          </div>
        )}

        {!isLoading && conversations.length === 0 && (
          <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--giga-text-muted, #94A3B8)', fontSize: '13px' }}>
            No discussions yet. Click "New Chat" to begin.
          </div>
        )}

        {!isLoading &&
          conversations.map((conv) => {
            const isActive = conv.id === activeId;
            return (
              <div
                key={conv.id}
                onClick={() => onSelect(conv.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderRadius: 'var(--giga-radius-md, 8px)',
                  backgroundColor: isActive ? 'var(--giga-surface-muted, #18263A)' : 'transparent',
                  color: isActive ? 'var(--giga-text, #F8FAFC)' : 'var(--giga-text-secondary, #94A3B8)',
                  fontSize: '13px',
                  cursor: 'pointer',
                  marginBottom: '2px',
                  transition: 'background-color 0.15s ease',
                  border: `1px solid ${isActive ? 'var(--giga-border, #334155)' : 'transparent'}`,
                }}
              >
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, marginRight: '8px' }}>
                  {conv.title}
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteCandidate(conv);
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--giga-text-muted, #94A3B8)',
                    cursor: 'pointer',
                    padding: '2px',
                    borderRadius: 'var(--giga-radius-sm, 4px)',
                    display: 'flex',
                  }}
                  title="Delete conversation"
                  aria-label={`Delete ${conv.title}`}
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            );
          })}
      </div>

      {/* Delete Confirmation Dialog */}
      <Modal
        isOpen={Boolean(deleteCandidate)}
        onClose={() => setDeleteCandidate(null)}
        title="Delete Discussion"
      >
        <p style={{ fontSize: '14px', color: 'var(--giga-text-secondary, #94A3B8)', marginBottom: '20px', lineHeight: 1.5 }}>
          Are you sure you want to delete <strong>"{deleteCandidate?.title}"</strong>? All messages will be permanently removed.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <Button variant="ghost" onClick={() => setDeleteCandidate(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (deleteCandidate) {
                onDelete(deleteCandidate.id);
                setDeleteCandidate(null);
              }
            }}
          >
            Delete Permanently
          </Button>
        </div>
      </Modal>
    </aside>
  );
};
