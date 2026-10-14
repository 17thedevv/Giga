import React from 'react';

export type GigaIconName =
  | 'activity'
  | 'alert-triangle'
  | 'arrow-up-right'
  | 'bell'
  | 'box'
  | 'brain'
  | 'calendar'
  | 'chart'
  | 'check-circle'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-up'
  | 'clock'
  | 'cloud'
  | 'code'
  | 'copy'
  | 'cpu'
  | 'database'
  | 'download'
  | 'edit'
  | 'external-link'
  | 'eye'
  | 'file-text'
  | 'filter'
  | 'folder'
  | 'git-branch'
  | 'github'
  | 'globe'
  | 'hard-drive'
  | 'home'
  | 'info'
  | 'key'
  | 'layers'
  | 'link'
  | 'lock'
  | 'log-out'
  | 'mail'
  | 'menu'
  | 'message-square'
  | 'minus'
  | 'monitor'
  | 'moon'
  | 'more-horizontal'
  | 'network'
  | 'play'
  | 'plus'
  | 'refresh-cw'
  | 'rocket'
  | 'search'
  | 'server'
  | 'settings'
  | 'shield'
  | 'sliders'
  | 'sparkles'
  | 'sun'
  | 'terminal'
  | 'trash'
  | 'upload'
  | 'user'
  | 'users'
  | 'workflow'
  | 'x-circle'
  | 'x'
  | 'zap';

export interface GigaIconProps extends React.SVGProps<SVGSVGElement> {
  name: GigaIconName;
  size?: number | string;
  className?: string;
  basePath?: string;
}

/**
 * Official GIGA 44 SVG Line Icons component
 * Renders SVG symbols from GIGA Design Assets v1.0.
 */
export const GigaIcon: React.FC<GigaIconProps> = ({
  name,
  size = 18,
  className = '',
  basePath = '/giga',
  style,
  ...props
}) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`g-icon ${className}`.trim()}
      style={{
        flexShrink: 0,
        verticalAlign: 'middle',
        ...style,
      }}
      aria-hidden="true"
      {...props}
    >
      <use href={`${basePath}/icons/icons-sprite.svg#icon-${name}`} />
    </svg>
  );
};
