import React, { forwardRef } from 'react';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(({
  label,
  error,
  helperText,
  id,
  className = '',
  style,
  ...props
}, ref) => {
  const textareaId = id || props.name;

  return (
    <div className="g-field" style={{ width: '100%' }}>
      {label && (
        <label
          htmlFor={textareaId}
          className="g-label"
          style={{ color: 'var(--giga-text-secondary)' }}
        >
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={textareaId}
        className={`g-textarea ${className}`}
        style={{
          borderColor: error ? 'var(--giga-danger, #ef4444)' : undefined,
          ...style,
        }}
        {...props}
      />
      {error && (
        <span style={{ fontSize: '12px', color: 'var(--giga-danger, #ef4444)' }} role="alert">
          {error}
        </span>
      )}
      {!error && helperText && (
        <span className="g-help">{helperText}</span>
      )}
    </div>
  );
});

Textarea.displayName = 'Textarea';
