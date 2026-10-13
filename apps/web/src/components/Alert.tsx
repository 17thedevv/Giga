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
      bg: '#4c0519',
      border: '#be123c',
      text: '#fecdd3',
      icon: <AlertTriangleIcon size={18} />,
    },
    warning: {
      bg: '#451a03',
      border: '#b45309',
      text: '#fef3c7',
      icon: <AlertTriangleIcon size={18} />,
    },
    info: {
      bg: '#082f49',
      border: '#0284c7',
      text: '#e0f2fe',
      icon: <AlertTriangleIcon size={18} />,
    },
    success: {
      bg: '#064e3b',
      border: '#059669',
      text: '#d1fae5',
      icon: <CheckIcon size={18} />,
    },
  };

  const current = styles[type] || styles.error;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        padding: '12px 16px',
        backgroundColor: current.bg,
        border: `1px solid ${current.border}`,
        borderRadius: '8px',
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
