import React from 'react';
import type { AgentRunStatus } from '../lib/api/types.js';

export type BadgeStatus =
  | AgentRunStatus
  | 'demo'
  | 'real'
  | 'user'
  | 'assistant'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status?: BadgeStatus;
  children?: React.ReactNode;
  showDot?: boolean;
}

export const Badge: React.FC<BadgeProps> = ({
  status,
  children,
  showDot = true,
  className = '',
  style,
  ...props
}) => {
  const configs: Record<string, { bg: string; text: string; border: string; label: string; dot: string }> = {
    queued: { bg: 'var(--giga-surface-muted, #18263A)', text: 'var(--giga-text-muted, #94A3B8)', border: 'var(--giga-border, #334155)', label: 'Queued', dot: '#94A3B8' },
    running: { bg: 'rgba(59, 130, 246, 0.15)', text: 'var(--giga-primary, #3B82F6)', border: 'rgba(59, 130, 246, 0.35)', label: 'Running...', dot: '#3B82F6' },
    awaiting_approval: { bg: 'rgba(217, 119, 6, 0.15)', text: '#F59E0B', border: 'rgba(217, 119, 6, 0.35)', label: 'Awaiting Approval', dot: '#D97706' },
    applying: { bg: 'rgba(139, 92, 246, 0.15)', text: '#A78BFA', border: 'rgba(139, 92, 246, 0.35)', label: 'Applying Changes...', dot: '#8B5CF6' },
    completed: { bg: 'rgba(22, 163, 74, 0.15)', text: '#34D399', border: 'rgba(22, 163, 74, 0.35)', label: 'Completed', dot: '#16A34A' },
    failed: { bg: 'rgba(220, 38, 38, 0.15)', text: '#F87171', border: 'rgba(220, 38, 38, 0.35)', label: 'Failed', dot: '#DC2626' },
    cancelled: { bg: 'var(--giga-surface-muted, #18263A)', text: 'var(--giga-text-secondary, #94A3B8)', border: 'var(--giga-border, #334155)', label: 'Cancelled', dot: '#64748B' },
    demo: { bg: 'rgba(234, 88, 12, 0.15)', text: '#FB923C', border: 'rgba(234, 88, 12, 0.4)', label: 'Mock / Demo', dot: '#EA580C' },
    real: { bg: 'rgba(22, 163, 74, 0.15)', text: '#34D399', border: 'rgba(22, 163, 74, 0.4)', label: 'Live Backend', dot: '#16A34A' },
    user: { bg: 'rgba(59, 130, 246, 0.15)', text: '#93C5FD', border: 'rgba(59, 130, 246, 0.35)', label: 'You', dot: '#3B82F6' },
    assistant: { bg: 'rgba(14, 165, 233, 0.15)', text: '#38BDF8', border: 'rgba(14, 165, 233, 0.35)', label: 'Giga', dot: '#0EA5E9' },
    success: { bg: 'rgba(22, 163, 74, 0.15)', text: '#34D399', border: 'rgba(22, 163, 74, 0.35)', label: 'Success', dot: '#16A34A' },
    warning: { bg: 'rgba(217, 119, 6, 0.15)', text: '#FBBF24', border: 'rgba(217, 119, 6, 0.35)', label: 'Warning', dot: '#D97706' },
    danger: { bg: 'rgba(220, 38, 38, 0.15)', text: '#F87171', border: 'rgba(220, 38, 38, 0.35)', label: 'Error', dot: '#DC2626' },
    info: { bg: 'rgba(59, 130, 246, 0.15)', text: '#60A5FA', border: 'rgba(59, 130, 246, 0.35)', label: 'Info', dot: '#3B82F6' },
  };

  const key = status || 'queued';
  const cfg = configs[key] || configs.queued;

  return (
    <span
      className={`g-badge ${className}`.trim()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '3px 9px',
        fontSize: '11px',
        fontWeight: 600,
        borderRadius: '9999px',
        backgroundColor: cfg.bg,
        color: cfg.text,
        border: `1px solid ${cfg.border}`,
        letterSpacing: '0.02em',
        textTransform: 'uppercase',
        lineHeight: 1.2,
        ...style,
      }}
      {...props}
    >
      {showDot && (
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            backgroundColor: cfg.dot,
            flexShrink: 0,
          }}
          aria-hidden="true"
        />
      )}
      {children || cfg.label}
    </span>
  );
};
