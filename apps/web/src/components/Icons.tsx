import React from 'react';
export { GigaIcon } from './GigaIcon.js';
export type { GigaIconName } from './GigaIcon.js';
export { GigaLogo } from './GigaLogo.js';

export interface IconProps extends React.SVGProps<SVGSVGElement> {
  size?: number;
}

/**
 * Official GIGA Logo Mark vector icon
 */
export function LogoIcon({ size = 28, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" fill="none" className={className} aria-label="GIGA Logo" {...props}>
      <g transform="translate(2 2)">
        <path
          d="M72 24C65 14 55 10 45 12C34 14 26 23 24 34C13 34 7 42 7 52C7 63 15 70 27 70H49"
          fill="none"
          stroke="var(--giga-primary, #3B82F6)"
          strokeWidth="11"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          d="M42 50H67C76 50 82 56 82 64C82 69 80 73 76 76"
          fill="none"
          stroke="var(--giga-primary, #3B82F6)"
          strokeWidth="11"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx="64" cy="80" r="8" fill="var(--giga-primary, #3B82F6)" />
      </g>
    </svg>
  );
}

export function ChatIcon({ size = 20, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function AgentIcon({ size = 20, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <rect x="2" y="3" width="7" height="6" rx="1" />
      <rect x="15" y="3" width="7" height="6" rx="1" />
      <rect x="9" y="16" width="7" height="6" rx="1" />
      <path d="M5.5 9v4h7v3m6-7v4h-6" />
    </svg>
  );
}

export function SendIcon({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

export function StopIcon({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
    </svg>
  );
}

export function PlusIcon({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M12 4v16M4 12h16" />
    </svg>
  );
}

export function TrashIcon({ size = 16, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

export function CheckIcon({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="m4 12 5 5L20 6" />
    </svg>
  );
}

export function XIcon({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M5 5 19 19M19 5 5 19" />
    </svg>
  );
}

export function AlertTriangleIcon({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="m12 2 10 18H2L12 2Zm0 7v5m0 3h.01" />
    </svg>
  );
}

export function ArrowLeftIcon({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

export function ExternalLinkIcon({ size = 16, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

export function CopyIcon({ size = 16, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </svg>
  );
}

export function MenuIcon({ size = 20, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 16, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 16, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

export function SpinnerIcon({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={`animate-spin ${className ?? ''}`} {...props}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" />
    </svg>
  );
}

export function SunIcon({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41" />
    </svg>
  );
}

export function MoonIcon({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

export function LogoutIcon({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5m5-4 5-5-5-5m5 5H9" />
    </svg>
  );
}

export function TerminalIcon({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

export function SlidersIcon({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  );
}

export function WorkflowIcon({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <rect x="2" y="3" width="7" height="6" rx="1" />
      <rect x="15" y="3" width="7" height="6" rx="1" />
      <rect x="9" y="16" width="7" height="6" rx="1" />
      <path d="M5.5 9v4h7v3m6-7v4h-6" />
    </svg>
  );
}

export function EditIcon({ size = 16, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

export function SearchIcon({ size = 18, className, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

