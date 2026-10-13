import React from 'react';
import type { AgentRunStatus } from '../lib/api/types.js';

export interface BadgeProps {
  status?: AgentRunStatus | 'demo' | 'real' | 'user' | 'assistant';
  children?: React.ReactNode;
}

export const Badge: React.FC<BadgeProps> = ({ status, children }) => {
  const configs: Record<string, { bg: string; text: string; border: string; label: string }> = {
    queued: { bg: '#1f2937', text: '#9ca3af', border: '#374151', label: 'Queued' },
    running: { bg: '#083344', text: '#22d3ee', border: '#0e7490', label: 'Running...' },
    awaiting_approval: { bg: '#451a03', text: '#fbbf24', border: '#b45309', label: 'Awaiting Approval' },
    applying: { bg: '#3b0764', text: '#c084fc', border: '#7e22ce', label: 'Applying Changes...' },
    completed: { bg: '#064e3b', text: '#34d399', border: '#059669', label: 'Completed' },
    failed: { bg: '#4c0519', text: '#f43f5e', border: '#be123c', label: 'Failed' },
    cancelled: { bg: '#1e293b', text: '#94a3b8', border: '#334155', label: 'Cancelled' },
    demo: { bg: '#431407', text: '#fb923c', border: '#c2410c', label: 'Mock / Demo' },
    real: { bg: '#022c22', text: '#34d399', border: '#059669', label: 'Live Backend' },
    user: { bg: '#1e1b4b', text: '#a5b4fc', border: '#4338ca', label: 'You' },
    assistant: { bg: '#0f172a', text: '#38bdf8', border: '#0284c7', label: 'Giga' },
  };

  const key = status || 'queued';
  const cfg = configs[key] || configs.queued;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        fontSize: '11px',
        fontWeight: 600,
        borderRadius: '9999px',
        backgroundColor: cfg.bg,
        color: cfg.text,
        border: `1px solid ${cfg.border}`,
        letterSpacing: '0.02em',
        textTransform: 'uppercase',
      }}
    >
      {children || cfg.label}
    </span>
  );
};
