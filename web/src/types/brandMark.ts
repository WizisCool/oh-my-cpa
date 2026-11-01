import { customIconID, resolveProviderArtwork, type CustomIcon } from './customIcons';
import { LOBE_ICON_CATALOG, lobeIconSlug } from './lobeIconCatalog';
import { credentialProviderIconId } from './providerMetadata';
import { DEFAULT_PROVIDER_ICON_ID, resolveProviderIcon as inferProviderIcon } from './providerIconIds';
import { resolveProviderIcon } from './providerIcons';
import { pluginLogoArtworks, pluginOAuthLogoFor, type PluginOAuthLogos } from './pluginOAuthProviders';

/** A brand's selected reference and its identity-preserving fallback, independent of React. */
export interface BrandMark {
  iconId?: string;
  logo?: string;
  fallbackIconId?: string;
  /** Keys proven to identify a plugin-owned provider; a protocol family alone is not proof. */
  providerKeys?: readonly string[];
  /** A projected connection has not yet been joined to the canonical provider catalog. */
  isIdentityUnknown?: boolean;
}

export interface ProviderBrandIdentity {
  id?: string;
  family?: string;
  name?: string;
  upstream_name?: string;
  base_url?: string;
  is_oauth?: boolean;
  /** An already persisted selection supplied by a server projection or an editor draft. */
  icon_id?: string;
  /** Other proven names carried by a historical record, never a guessed provider match. */
  aliases?: readonly string[];
}

export interface ProviderBrandSources {
  providerIcons?: Record<string, string>;
  pluginLogos?: PluginOAuthLogos;
  providersByID?: ReadonlyMap<string, ProviderBrandIdentity>;
  isProviderCatalogUnknown?: boolean;
}

function resolveLogo(keys: readonly string[], logos?: PluginOAuthLogos): string | undefined {
  for (const key of keys) {
    const logo = pluginOAuthLogoFor(logos, key);
    if (logo) return logo;
  }
  return undefined;
}

export function resolveProviderMark(provider: ProviderBrandIdentity, sources: ProviderBrandSources = {}): BrandMark & { iconId: string } {
  const canonical = provider.id ? sources.providersByID?.get(provider.id) : undefined;
  const hasCanonicalIdentity = !sources.isProviderCatalogUnknown && canonical && canonical.family === provider.family && canonical.name === provider.name;
  if (hasCanonicalIdentity) provider = { ...canonical, ...provider, base_url: provider.base_url ?? canonical.base_url };
  const logoKeys = [provider.family, provider.upstream_name, provider.name, provider.id, ...(provider.aliases ?? [])]
    .filter((key): key is string => Boolean(key));
  // A protocol family names how a connection speaks, not who owns its artwork. Only an
  // OAuth channel's family is a provider identity; an API-key family is not.
  const providerKeys = [
    provider.upstream_name,
    provider.id,
    ...(provider.is_oauth ? [provider.family, provider.name, ...(provider.aliases ?? [])] : []),
  ].filter((key): key is string => Boolean(key));
  const fallbackIconId = provider.is_oauth
    ? credentialProviderIconId(provider.family ?? '', provider.name)
    : inferProviderIcon(provider.family ?? '', provider.name, provider.base_url) ?? '';
  const icons = sources.providerIcons ?? {};
  const selected = resolveProviderIcon(icons, provider, provider.icon_id ?? '')
    || provider.aliases?.map((key) => icons[key]).find(Boolean);
  return {
    iconId: selected || fallbackIconId,
    logo: resolveLogo(logoKeys, sources.pluginLogos),
    fallbackIconId,
    providerKeys,
    isIdentityUnknown: Boolean(provider.id && (sources.isProviderCatalogUnknown || (sources.providersByID && provider.family === 'openai-compatibility' && !hasCanonicalIdentity))),
  };
}

/** A picker needs an initial catalog selection even when a display surface stays unbranded. */
export function resolveProviderPickerIcon(provider: ProviderBrandIdentity, sources: ProviderBrandSources = {}): string {
  return resolveProviderMark(provider, sources).iconId || DEFAULT_PROVIDER_ICON_ID;
}

/** A recorded label can select historical artwork without claiming a current connection. */
export function resolveRecordedProviderMark(providerKey: string, displayName: string, sources: ProviderBrandSources = {}): BrandMark & { iconId: string } {
  const fallbackIconId = inferProviderIcon(providerKey, displayName) ?? '';
  const icons = sources.providerIcons ?? {};
  const providerKeys = [providerKey];
  return {
    iconId: icons[providerKey] || icons[displayName] || fallbackIconId,
    fallbackIconId,
    logo: resolveLogo(providerKeys, sources.pluginLogos),
    providerKeys,
  };
}

/** An account label is a hint, not a provider-instance id on which to apply an override. */
export function resolveCredentialMark(provider: string, hint?: string, pluginLogos?: PluginOAuthLogos, aliases: readonly string[] = []): BrandMark & { iconId: string } {
  const providerKeys = [provider, ...aliases];
  const iconId = credentialProviderIconId(provider, hint);
  return { iconId, fallbackIconId: iconId, logo: resolveLogo(providerKeys, pluginLogos), providerKeys };
}

export interface MarkArtwork {
  url: string;
  isMono: boolean;
}

export interface MarkArtworkSources {
  baseURL: string;
  customIconURL: (id: string, revision: number) => string;
  customIcons?: readonly CustomIcon[];
  isPluginOwned?: boolean;
  isOwnershipUnknown?: boolean;
  variant?: 'color' | 'mono';
}

// Kimi's colour artwork is white on a transparent background; its silhouette follows the theme.
const WHITE_GLYPH_COLOR_ICONS = new Set(['Kimi']);
const CATALOG_BY_ID = new Map(LOBE_ICON_CATALOG.map((entry) => [entry.id, entry]));

/** Ordered candidates are shared by DOM rendering and image export, including failed-image fallback. */
export function resolveMarkArtworks(mark: BrandMark, sources: MarkArtworkSources): MarkArtwork[] {
  const artworks: MarkArtwork[] = pluginLogoArtworks(mark.logo);
  const selected = resolveProviderArtwork(mark.iconId, mark.fallbackIconId, Boolean(mark.logo), Boolean(sources.isPluginOwned), Boolean(mark.isIdentityUnknown || sources.isOwnershipUnknown));
  for (const reference of new Set([selected, mark.fallbackIconId])) {
    const customID = customIconID(reference);
    if (customID) {
      const icon = sources.customIcons?.find((item) => item.id === customID);
      if (icon) artworks.push({ url: sources.customIconURL(customID, icon.revision), isMono: false });
      continue;
    }
    const metadata = reference ? CATALOG_BY_ID.get(reference) : undefined;
    if (!metadata || !reference) continue;
    const isColor = sources.variant !== 'mono' && metadata.hasColor && !WHITE_GLYPH_COLOR_ICONS.has(reference);
    artworks.push({ url: `${sources.baseURL}lobe-icons/${lobeIconSlug(reference)}${isColor ? '-color' : ''}.svg`, isMono: !isColor });
  }
  return artworks;
}
