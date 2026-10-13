import React from 'react';
import { SpinnerIcon } from './Icons.js';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'ghost' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  icon,
  className = '',
  ...props
}) => {
  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    fontWeight: 500,
    fontFamily: 'inherit',
    borderRadius: '6px',
    border: '1px solid transparent',
    cursor: disabled || loading ? 'not-allowed' : 'pointer',
    opacity: disabled || loading ? 0.65 : 1,
    transition: 'background-color 0.15s ease, border-color 0.15s ease, transform 0.05s ease',
  };

  const sizeStyles: Record<string, React.CSSProperties> = {
    sm: { padding: '4px 10px', fontSize: '13px', height: '30px' },
    md: { padding: '8px 16px', fontSize: '14px', height: '38px' },
    lg: { padding: '12px 24px', fontSize: '15px', height: '46px' },
  };

  const variantStyles: Record<string, React.CSSProperties> = {
    primary: {
      backgroundColor: '#6366f1',
      color: '#ffffff',
      borderColor: '#4f46e5',
    },
    secondary: {
      backgroundColor: '#1e293b',
      color: '#f1f5f9',
      borderColor: '#334155',
    },
    danger: {
      backgroundColor: '#dc2626',
      color: '#ffffff',
      borderColor: '#b91c1c',
    },
    success: {
      backgroundColor: '#059669',
      color: '#ffffff',
      borderColor: '#047857',
    },
    ghost: {
      backgroundColor: 'transparent',
      color: '#94a3b8',
      borderColor: 'transparent',
    },
    outline: {
      backgroundColor: 'transparent',
      color: '#f1f5f9',
      borderColor: '#334155',
    },
  };

  return (
    <button
      style={{
        ...baseStyle,
        ...sizeStyles[size],
        ...variantStyles[variant],
      }}
      disabled={disabled || loading}
      className={className}
      {...props}
    >
      {loading ? <SpinnerIcon size={16} /> : icon}
      {children}
    </button>
  );
};
