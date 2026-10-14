import React from 'react';
import { AlertTriangleIcon, CheckIcon, XIcon } from './Icons.js';

export interface AlertProps {
  type?: 'error' | 'warning' | 'info' | 'success';
  title?: string;
  message: string;
  onDismiss?: () => void;
  action?: React.ReactNode;
}

export const Alert: React.FC<AlertProps> = ({
  type = 'error',
  title,
  message,
  onDismiss,
  action,
}) => {
  const styles: Record<string, { bg: string; border: string; text: string; icon: React.ReactNode }> = {
    error: {
      bg: 'rgba(220, 38, 38, 0.12)',
      border: 'rgba(220, 38, 38, 0.35)',
      text: '#F87171',
      icon: <AlertTriangleIcon size={18} />,
    },
    warning: {
      bg: 'rgba(217, 119, 6, 0.12)',
      border: 'rgba(217, 119, 6, 0.35)',
      text: '#FBBF24',
      icon: <AlertTriangleIcon size={18} />,
    },
    info: {
      bg: 'rgba(59, 130, 246, 0.12)',
      border: 'rgba(59, 130, 246, 0.35)',
      text: '#60A5FA',
      icon: <AlertTriangleIcon size={18} />,
    },
    success: {
      bg: 'rgba(22, 163, 74, 0.12)',
      border: 'rgba(22, 163, 74, 0.35)',
      text: '#4ADE80',
      icon: <CheckIcon size={18} />,
    },
  };

  const current = styles[type] || styles.error;

  return (
    <div
      className={`g-alert g-alert--${type}`}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        padding: '12px 16px',
        backgroundColor: current.bg,
        border: `1px solid ${current.border}`,
        borderRadius: 'var(--giga-radius-md, 8px)',
        color: current.text,
        fontSize: '14px',
        width: '100%',
      }}
      role="alert"
    >
      <div style={{ flexShrink: 0, marginTop: '2px' }}>{current.icon}</div>
      <div style={{ flex: 1 }}>
        {title && <div style={{ fontWeight: 600, marginBottom: '2px' }}>{title}</div>}
        <div>{message}</div>
        {action && <div style={{ marginTop: '8px' }}>{action}</div>}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            opacity: 0.7,
            cursor: 'pointer',
            padding: '2px',
          }}
          aria-label="Dismiss alert"
        >
          <XIcon size={16} />
        </button>
      )}
    </div>
  );
};
