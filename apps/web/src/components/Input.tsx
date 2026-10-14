import React, { forwardRef } from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(({
  label,
  error,
  helperText,
  id,
  className = '',
  style,
  ...props
}, ref) => {
  const inputId = id || props.name;

  return (
    <div className="g-field" style={{ width: '100%' }}>
      {label && (
        <label
          htmlFor={inputId}
          className="g-label"
          style={{ color: 'var(--giga-text-secondary)' }}
        >
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        className={`g-input ${className}`}
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

Input.displayName = 'Input';
