import React from 'react';
import type { ModelMetadata, ReasoningEffort } from '../../lib/api/types.js';
import { isReasoningSupported, getSupportedReasoningEfforts } from './model-capabilities.js';

export interface ReasoningSelectorProps {
  model?: ModelMetadata;
  value?: ReasoningEffort;
  onChange: (effort: ReasoningEffort | undefined) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export const ReasoningSelector: React.FC<ReasoningSelectorProps> = ({
  model,
  value,
  onChange,
  disabled = false,
  id = 'composer-reasoning-select',
  className = '',
}) => {
  const supported = isReasoningSupported(model);
  const efforts = getSupportedReasoningEfforts(model);
  const isSelectDisabled = disabled || !supported;

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextVal = e.target.value;
    if (!nextVal) {
      onChange(undefined);
    } else if (efforts.includes(nextVal as ReasoningEffort)) {
      onChange(nextVal as ReasoningEffort);
    } else {
      onChange(undefined);
    }
  };

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
      }}
    >
      <label
        htmlFor={id}
        style={{
          fontSize: '12px',
          fontWeight: 500,
          color: supported ? 'var(--giga-text-secondary, #94A3B8)' : 'var(--giga-text-muted, #64748B)',
          whiteSpace: 'nowrap',
          cursor: isSelectDisabled ? 'not-allowed' : 'pointer',
        }}
      >
        Reasoning:
      </label>
      <select
        id={id}
        aria-label="Reasoning effort"
        value={supported && value && efforts.includes(value) ? value : ''}
        onChange={handleChange}
        disabled={isSelectDisabled}
        className={`g-select ${className}`}
        style={{
          minHeight: '30px',
          height: '30px',
          padding: '3px 8px',
          fontSize: '12px',
          backgroundColor: 'var(--giga-surface-muted, #18263A)',
          color: supported ? 'var(--giga-text, #F8FAFC)' : 'var(--giga-text-muted, #64748B)',
          border: '1px solid var(--giga-border, #334155)',
          borderRadius: 'var(--giga-radius-md, 8px)',
          width: 'auto',
          opacity: supported ? 1 : 0.65,
          cursor: isSelectDisabled ? 'not-allowed' : 'pointer',
        }}
        data-testid="composer-reasoning-select"
        title={
          supported
            ? 'Adjust reasoning effort for the current model'
            : 'Reasoning controls are not supported by the selected model'
        }
      >
        {!supported ? (
          <option value="">Not supported</option>
        ) : (
          <>
            <option value="">Default</option>
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {EFFORT_LABELS[effort] || effort}
              </option>
            ))}
          </>
        )}
      </select>
    </div>
  );
};
