import { usePluginProviderOwnership } from '../hooks/usePluginOAuthLogos';
import { api } from '../api/client';
import { useCustomIcons } from '../hooks/useCustomIcons';
import { customIconID, resolveProviderArtwork, type CustomIcon } from '../types/customIcons';
import React, { memo, useEffect, useState } from 'react';
import { LOBE_ICON_CATALOG, lobeIconSlug } from '../types/lobeIconCatalog';
import { isRenderableLogoURL } from '../types/pluginOAuthProviders';
import { CloudServerOutlined } from './icons';

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
  const customID = customIconID(iconId);
  if (customID) return <CustomIconImage id={customID} size={size} className={className} style={style} loading={loading} />;
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

/**
 * The artwork behind a provider mark as a URL, for a surface that draws marks
 * itself instead of rendering this component - the exported request sheet.
 *
 * It follows the component's own order - a plugin's logo, then custom artwork,
 * then the catalog - so a mark is the same picture wherever it appears. `isMono`
 * marks a silhouette the caller has to fill with the foreground colour.
 */
export function resolveMarkArtwork(
  iconId: string | undefined,
  logo: string | undefined,
  customIcons: readonly CustomIcon[] = [],
): { url: string; isMono: boolean } | null {
  const trimmedLogo = (logo || '').trim();
  if (trimmedLogo && isRenderableLogoURL(trimmedLogo)) return { url: trimmedLogo, isMono: false };
  const customID = customIconID(iconId);
  if (customID) {
    const icon = customIcons.find((item) => item.id === customID);
    return icon ? { url: api.customIconURL(customID, icon.revision), isMono: false } : null;
  }
  const metadata = iconId ? TOC_BY_ID.get(iconId) : undefined;
  if (!iconId || !metadata) return null;
  const slug = lobeIconSlug(iconId);
  const isColor = metadata.hasColor && !WHITE_GLYPH_COLOR_ICONS.has(iconId);
  return {
    url: `${import.meta.env.BASE_URL}lobe-icons/${slug}${isColor ? '-color' : ''}.svg`,
    isMono: !isColor,
  };
}

const CustomIconImage: React.FC<LobeIconProps & { id: string }> = ({ id, size, className, style, loading }) => {
  const { data } = useCustomIcons();
  const icon = data?.find((item) => item.id === id);
  const [brokenURL, setBrokenURL] = useState('');
  const url = icon ? api.customIconURL(id, icon.revision) : '';
  if (!url || brokenURL === url) return <CloudServerOutlined style={{ fontSize: size, ...style }} className={className} />;
  return <img src={url} width={size} height={size} className={className} style={{ display: 'block', objectFit: 'contain', ...style }} alt="" loading={loading} decoding="async" onError={() => setBrokenURL(url)} />;
};

export interface ProviderBrandIconProps {
  providerKeys?: (string | undefined)[];
  fallbackIconId?: string;
  /** Brand mark reference from the vendored catalog or deployment custom icon library. Empty renders a neutral placeholder. */
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
 * nothing is worse than one rendering the known brand. Deployment custom artwork
 * is never the fallback for a plugin-owned identity, even without a usable logo.
 *
 * It lives beside the catalog renderer rather than in a component of its own for two
 * reasons: they answer the same question, and two modules answering it is how a
 * surface ends up drawing a mark the others do not. A separate module also renames
 * the shared chunk this code is bundled into, and the bundle budget pins that chunk
 * by name (`Lobe icon JS`, derived from this file).
 */
export const ProviderBrandIcon: React.FC<ProviderBrandIconProps> = ({
  providerKeys = [],
  fallbackIconId,
  iconId,
  logo,
  size,
  className,
  style,
}) => {
  const isCustom = Boolean(customIconID(iconId));
  const ownership = usePluginProviderOwnership(providerKeys, isCustom && providerKeys.length > 0);
  const fallback = resolveProviderArtwork(iconId, fallbackIconId, Boolean(logo), ownership.isOwned, ownership.isUnknown);
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

  return <LobeIcon iconId={fallback} size={size} className={className} style={style} />;
};
