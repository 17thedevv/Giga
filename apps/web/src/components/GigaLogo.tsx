import React from 'react';

export type GigaLogoVariant = 'horizontal' | 'mark' | 'stacked' | 'wordmark';
export type GigaLogoTone = 'color' | 'dark' | 'white';

export interface GigaLogoProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  variant?: GigaLogoVariant;
  tone?: GigaLogoTone;
  outlined?: boolean;
  basePath?: string;
  alt?: string;
}

/**
 * Official GIGA Logo Component
 * Renders approved SVG variants from GIGA Design Assets v1.0.
 */
export const GigaLogo: React.FC<GigaLogoProps> = ({
  variant = 'horizontal',
  tone = 'color',
  outlined = false,
  basePath = '/giga',
  alt = 'GIGA AI Cloud',
  className = '',
  style,
  ...props
}) => {
  const suffix = outlined ? '-outlined' : '';
  const src = `${basePath}/brand/logo/svg/giga-${variant}-${tone}${suffix}.svg`;

  return (
    <img
      src={src}
      alt={alt}
      className={`giga-logo giga-logo--${variant} giga-logo--${tone} ${className}`.trim()}
      style={{
        display: 'inline-block',
        verticalAlign: 'middle',
        maxWidth: '100%',
        ...style,
      }}
      {...props}
    />
  );
};
