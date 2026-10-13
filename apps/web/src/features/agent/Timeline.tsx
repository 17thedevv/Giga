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
      <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#f1f5f9', marginBottom: '4px' }}>
        Execution Steps & Tool Invocations
      </h3>

      {steps.length === 0 && (
        <div style={{ padding: '16px', textAlign: 'center', color: '#64748b', fontSize: '13px', backgroundColor: '#0f172a', borderRadius: '6px' }}>
          No tools executed yet.
        </div>
      )}

      {steps.map((step) => {
        const isExpanded = Boolean(expandedIds[step.id]);

        return (
          <div
            key={step.id}
            style={{
              backgroundColor: '#0f172a',
              border: '1px solid #1e293b',
              borderRadius: '6px',
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
                <span style={{ color: '#64748b' }}>
                  {isExpanded ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}
                </span>

                {/* Status icon */}
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  {step.status === 'running' && <SpinnerIcon size={16} className="text-cyan-400" />}
                  {step.status === 'success' && <span style={{ color: '#34d399' }}><CheckIcon size={16} /></span>}
                  {step.status === 'error' && <span style={{ color: '#f43f5e' }}><XIcon size={16} /></span>}
                  {step.status === 'pending' && <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#64748b' }} />}
                </div>

                <span style={{ fontSize: '13px', fontWeight: 600, color: '#f1f5f9', fontFamily: 'monospace' }}>
                  {step.stepNumber}. {step.tool}
                </span>

                {step.path && (
                  <span style={{ fontSize: '12px', color: '#38bdf8', fontFamily: 'monospace' }}>
                    {step.path}
                  </span>
                )}
                {step.query && (
                  <span style={{ fontSize: '12px', color: '#a78bfa', fontFamily: 'monospace' }}>
                    "{step.query}"
                  </span>
                )}
              </div>

              {step.durationMs !== undefined && (
                <span style={{ fontSize: '11px', color: '#64748b' }}>
                  {step.durationMs}ms
                </span>
              )}
            </div>

            {/* Expandable Payload & Output */}
            {isExpanded && (
              <div
                style={{
                  padding: '10px 14px',
                  backgroundColor: '#090d16',
                  borderTop: '1px solid #1e293b',
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  color: '#cbd5e1',
                }}
              >
                {step.summary && (
                  <div style={{ marginBottom: '8px', color: '#94a3b8' }}>
                    Summary: {step.summary}
                  </div>
                )}
                {step.outputPreview && (
                  <div>
                    <div style={{ color: '#64748b', marginBottom: '4px' }}>Result:</div>
                    <pre style={{ whiteSpace: 'pre-wrap', color: '#34d399', margin: 0 }}>
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
