import React from 'react';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export const Textarea: React.FC<TextareaProps> = ({
  label,
  error,
  helperText,
  id,
  className = '',
  style,
  ...props
}) => {
  const textareaId = id || props.name;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%' }}>
      {label && (
        <label
          htmlFor={textareaId}
          style={{ fontSize: '13px', fontWeight: 500, color: '#94a3b8' }}
        >
          {label}
        </label>
      )}
      <textarea
        id={textareaId}
        style={{
          width: '100%',
          padding: '10px 12px',
          backgroundColor: '#0f172a',
          color: '#f1f5f9',
          border: `1px solid ${error ? '#f43f5e' : '#334155'}`,
          borderRadius: '6px',
          fontSize: '14px',
          outline: 'none',
          fontFamily: 'inherit',
          resize: 'vertical',
          minHeight: '80px',
          ...style,
        }}
        className={className}
        {...props}
      />
      {error && <span style={{ fontSize: '12px', color: '#f43f5e' }} role="alert">{error}</span>}
      {!error && helperText && <span style={{ fontSize: '12px', color: '#64748b' }}>{helperText}</span>}
    </div>
  );
};
