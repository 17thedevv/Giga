import React, { useState } from 'react';
import type { ToolCallStep } from '../../lib/api/types.js';
import { SpinnerIcon, CheckIcon, XIcon, ChevronRightIcon, ChevronDownIcon } from '../../components/Icons.js';

interface TimelineProps {
  steps: ToolCallStep[];
}

export const Timeline: React.FC<TimelineProps> = ({ steps }) => {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px' }}>
      <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)', marginBottom: '4px' }}>
        Execution Steps & Tool Invocations
      </h3>

      {steps.length === 0 && (
        <div
          style={{
            padding: '16px',
            textAlign: 'center',
            color: 'var(--giga-text-muted, #94A3B8)',
            fontSize: '13px',
            backgroundColor: 'var(--giga-surface, #111C2D)',
            border: '1px solid var(--giga-border, #1E293B)',
            borderRadius: 'var(--giga-radius-md, 8px)',
          }}
        >
          No tools executed yet.
        </div>
      )}

      {steps.map((step) => {
        const isExpanded = Boolean(expandedIds[step.id]);

        return (
          <div
            key={step.id}
            style={{
              backgroundColor: 'var(--giga-surface, #111C2D)',
              border: '1px solid var(--giga-border, #1E293B)',
              borderRadius: 'var(--giga-radius-md, 8px)',
              overflow: 'hidden',
            }}
          >
            <div
              onClick={() => toggleExpand(step.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 14px',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ color: 'var(--giga-text-muted, #94A3B8)' }}>
                  {isExpanded ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}
                </span>

                {/* Status icon */}
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  {step.status === 'running' && <SpinnerIcon size={16} style={{ color: 'var(--giga-primary, #3B82F6)' }} />}
                  {step.status === 'success' && <span style={{ color: 'var(--giga-success, #16A34A)' }}><CheckIcon size={16} /></span>}
                  {step.status === 'error' && <span style={{ color: 'var(--giga-danger, #DC2626)' }}><XIcon size={16} /></span>}
                  {step.status === 'pending' && <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: 'var(--giga-text-muted, #94A3B8)' }} />}
                </div>

                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)', fontFamily: 'var(--giga-font-mono, monospace)' }}>
                  {step.stepNumber}. {step.tool}
                </span>

                {step.path && (
                  <span style={{ fontSize: '12px', color: 'var(--giga-primary, #3B82F6)', fontFamily: 'var(--giga-font-mono, monospace)' }}>
                    {step.path}
                  </span>
                )}
                {step.query && (
                  <span style={{ fontSize: '12px', color: '#a78bfa', fontFamily: 'var(--giga-font-mono, monospace)' }}>
                    "{step.query}"
                  </span>
                )}
              </div>

              {step.durationMs !== undefined && (
                <span style={{ fontSize: '11px', color: 'var(--giga-text-muted, #94A3B8)' }}>
                  {step.durationMs}ms
                </span>
              )}
            </div>

            {/* Expandable Payload & Output */}
            {isExpanded && (
              <div
                style={{
                  padding: '10px 14px',
                  backgroundColor: 'var(--giga-surface-muted, #18263A)',
                  borderTop: '1px solid var(--giga-border, #1E293B)',
                  fontSize: '12px',
                  fontFamily: 'var(--giga-font-mono, monospace)',
                  color: 'var(--giga-text-secondary, #CBD5E1)',
                }}
              >
                {step.summary && (
                  <div style={{ marginBottom: '8px', color: 'var(--giga-text-secondary, #94A3B8)' }}>
                    Summary: {step.summary}
                  </div>
                )}
                {step.outputPreview && (
                  <div>
                    <div style={{ color: 'var(--giga-text-muted, #94A3B8)', marginBottom: '4px' }}>Result:</div>
                    <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--giga-success, #16A34A)', margin: 0 }}>
                      {step.outputPreview}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
