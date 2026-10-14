import React from 'react';
import { SpinnerIcon } from './Icons.js';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'ghost' | 'outline';
  size?: 'sm' | 'md' | 'lg' | 'default' | 'small';
  loading?: boolean;
  icon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    variant = 'primary',
    size = 'md',
    loading = false,
    disabled = false,
    icon,
    className = '',
    style,
    type = 'button',
    ...props
  },
  ref
) {
  const isSmall = size === 'sm' || size === 'small';
  const isLarge = size === 'lg';

  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    fontWeight: 600,
    fontFamily: 'var(--giga-font-sans, inherit)',
    borderRadius: 'var(--giga-radius-md, 8px)',
    border: '1px solid transparent',
    cursor: disabled || loading ? 'not-allowed' : 'pointer',
    opacity: disabled || loading ? 0.6 : 1,
    transition: 'background-color 0.14s ease, border-color 0.14s ease, transform 0.05s ease',
    whiteSpace: 'nowrap',
    lineHeight: 1.2,
  };

  const sizeStyles: Record<string, React.CSSProperties> = {
    sm: { padding: '6px 12px', fontSize: '12px', minHeight: '32px' },
    small: { padding: '6px 12px', fontSize: '12px', minHeight: '32px' },
    md: { padding: '9px 15px', fontSize: '14px', minHeight: '38px' },
    default: { padding: '9px 15px', fontSize: '14px', minHeight: '38px' },
    lg: { padding: '12px 22px', fontSize: '15px', minHeight: '44px' },
  };

  const variantStyles: Record<string, React.CSSProperties> = {
    primary: {
      backgroundColor: 'var(--giga-primary, #3B82F6)',
      color: '#ffffff',
      borderColor: 'var(--giga-primary, #3B82F6)',
    },
    secondary: {
      backgroundColor: 'var(--giga-surface, #FFFFFF)',
      color: 'var(--giga-text, #1F2937)',
      borderColor: 'var(--giga-border, #E5E7EB)',
    },
    danger: {
      backgroundColor: 'var(--giga-danger, #DC2626)',
      color: '#ffffff',
      borderColor: 'var(--giga-danger, #DC2626)',
    },
    success: {
      backgroundColor: 'var(--giga-success, #16A34A)',
      color: '#ffffff',
      borderColor: 'var(--giga-success, #16A34A)',
    },
    ghost: {
      backgroundColor: 'transparent',
      color: 'var(--giga-text-secondary, #475569)',
      borderColor: 'transparent',
    },
    outline: {
      backgroundColor: 'transparent',
      color: 'var(--giga-text, #1F2937)',
      borderColor: 'var(--giga-border, #E5E7EB)',
    },
  };

  const currentSizeKey = size in sizeStyles ? size : 'md';
  const currentVariantKey = variant in variantStyles ? variant : 'primary';

  return (
    <button
      ref={ref}
      type={type}
      style={{
        ...baseStyle,
        ...sizeStyles[currentSizeKey],
        ...variantStyles[currentVariantKey],
        ...style,
      }}
      disabled={disabled || loading}
      className={`g-btn g-btn--${currentVariantKey} ${isSmall ? 'g-btn--small' : isLarge ? 'g-btn--large' : ''} ${className}`.trim()}
      {...props}
    >
      {loading ? <SpinnerIcon size={16} /> : icon}
      {children}
    </button>
  );
});
