import React, { memo, useEffect, useState } from 'react';
import { LOBE_ICON_CATALOG, lobeIconSlug } from '../types/lobeIconCatalog';
import { isRenderableLogoURL } from '../types/pluginOAuthProviders';
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

export interface ProviderBrandIconProps {
  /** Brand mark id from the vendored icon catalog. Empty renders a neutral placeholder. */
  iconId?: string;
  /** Logo published by the plugin that owns this provider, when there is one. */
  logo?: string;
  size: number;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * The mark for one provider, wherever a provider is shown.
 *
 * A plugin's own logo wins over the catalog mark: a plugin knows what its provider
 * looks like, and installing a plugin cannot update the console's catalog. The
 * catalog mark is the fallback rather than the default, because a plugin logo is a
 * network fetch that can fail or be withdrawn, and a provider row that renders
 * nothing is worse than one rendering the known brand.
 *
 * It lives beside the catalog renderer rather than in a component of its own for two
 * reasons: they answer the same question, and two modules answering it is how a
 * surface ends up drawing a mark the others do not. A separate module also renames
 * the shared chunk this code is bundled into, and the bundle budget pins that chunk
 * by name (`Lobe icon JS`, derived from this file).
 */
export const ProviderBrandIcon: React.FC<ProviderBrandIconProps> = ({
  iconId,
  logo,
  size,
  className,
  style,
}) => {
  const [isLogoBroken, setIsLogoBroken] = useState(false);

  // A swapped logo (a plugin upgrade, or a provider whose plugin changed) starts
  // from a clean slate, so one broken URL cannot mask the next one forever.
  useEffect(() => {
    setIsLogoBroken(false);
  }, [logo]);

  // Validated here as well as where the value is resolved: this component is the last
  // place before a source reaches the DOM, and a caller that hands it a URL straight out
  // of a manifest must not be able to make the browser load a plugin's host.
  const trimmedLogo = (logo || '').trim();
  if (trimmedLogo && !isLogoBroken && isRenderableLogoURL(trimmedLogo)) {
    return (
      <img
        src={trimmedLogo}
        alt=""
        width={size}
        height={size}
        className={className}
        style={{ display: 'block', objectFit: 'contain', borderRadius: 4, ...style }}
        loading="eager"
        decoding="async"
        onError={() => setIsLogoBroken(true)}
      />
    );
  }

  return <LobeIcon iconId={iconId} size={size} className={className} style={style} />;
};
