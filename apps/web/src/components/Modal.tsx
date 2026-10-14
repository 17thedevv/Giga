import React, { useEffect } from 'react';
import { XIcon } from './Icons.js';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children }) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="g-modal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div
        className="g-modal"
        style={{
          backgroundColor: 'var(--giga-surface, #111C2D)',
          border: '1px solid var(--giga-border, #1E293B)',
          borderRadius: 'var(--giga-radius-lg, 12px)',
          width: '100%',
          maxWidth: '520px',
          boxShadow: 'var(--giga-shadow-lg, 0 20px 25px -5px rgba(0, 0, 0, 0.5))',
          overflow: 'hidden',
          padding: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid var(--giga-border, #1E293B)',
          }}
        >
          <h3 id="modal-title" style={{ fontSize: '16px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)', margin: 0 }}>
            {title}
          </h3>
          <button
            onClick={onClose}
            className="g-iconbtn"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--giga-text-secondary, #94A3B8)',
              cursor: 'pointer',
              padding: '6px',
              borderRadius: 'var(--giga-radius-md, 8px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            aria-label="Close modal"
          >
            <XIcon size={18} />
          </button>
        </div>
        <div style={{ padding: '20px' }}>{children}</div>
      </div>
    </div>
  );
};
