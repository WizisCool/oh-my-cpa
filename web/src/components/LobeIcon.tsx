import React, { memo } from 'react';
import { LOBE_ICON_CATALOG, lobeIconSlug } from '../types/lobeIconCatalog';
import { CloudServerOutlined } from '@ant-design/icons';

export { getProviderDefaultIcon } from '../types/providerIconIds';

interface LobeIconProps {
  iconId?: string;
  size?: number | string;
  className?: string;
  style?: React.CSSProperties;
  variant?: 'color' | 'mono';
  loading?: 'eager' | 'lazy';
}

// Kimi's Color variant draws a fixed white glyph, which is invisible on light
// surfaces. Use its monochrome mark so the icon inherits the theme foreground.
const WHITE_GLYPH_COLOR_ICONS = new Set(['Kimi']);

const TOC_BY_ID = new Map(LOBE_ICON_CATALOG.map((item) => [item.id, item]));

export const LobeIcon: React.FC<LobeIconProps> = memo(({
  iconId,
  size = 24,
  className,
  style,
  variant = 'color',
  loading = 'eager',
}) => {
  const metadata = iconId ? TOC_BY_ID.get(iconId) : undefined;
  if (!iconId || !metadata) {
    return <CloudServerOutlined style={{ fontSize: size, ...style }} className={className} />;
  }

  const slug = lobeIconSlug(iconId);
  const colorUrl = `${import.meta.env.BASE_URL}lobe-icons/${slug}-color.svg`;
  const monoUrl = `${import.meta.env.BASE_URL}lobe-icons/${slug}.svg`;
  const useColor = variant !== 'mono'
    && metadata.hasColor
    && !WHITE_GLYPH_COLOR_ICONS.has(iconId);

  if (useColor) {
    return (
      <img
        src={colorUrl}
        width={size}
        height={size}
        className={className}
        style={{ display: 'block', objectFit: 'contain', ...style }}
        loading={loading}
        decoding="async"
        alt=""
      />
    );
  }

  const { color, ...restStyle } = style ?? {};
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        flex: 'none',
        backgroundColor: color ?? 'var(--fg)',
        mask: `url("${monoUrl}") center / contain no-repeat`,
        WebkitMask: `url("${monoUrl}") center / contain no-repeat`,
        ...restStyle,
      }}
    />
  );
});

