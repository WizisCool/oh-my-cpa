import React, { memo } from 'react';
import { api } from '../api/client';
import { useCustomIcons } from '../hooks/useCustomIcons';
import { usePluginProviderOwnership } from '../hooks/usePluginOAuthLogos';
import { customIconID, resolveProviderArtwork, type CustomIcon } from '../types/customIcons';
import { resolveMarkArtworks, resolveProviderMark, resolveCredentialMark, type ProviderBrandIdentity, type ProviderBrandSources, type BrandMark } from '../types/brandMark';
import { MarkArtwork } from './common/MarkArtwork';
import { CloudServerOutlined } from './icons';

interface LobeIconProps {
  iconId?: string;
  size?: number | string;
  className?: string;
  style?: React.CSSProperties;
  variant?: 'color' | 'mono';
  loading?: 'eager' | 'lazy';
}

export const LobeIcon = memo(function LobeIcon({ iconId, ...props }: LobeIconProps) {
  return <BrandArtwork mark={{ iconId }} {...props} />;
});

export interface ProviderBrandIconProps extends Omit<LobeIconProps, 'iconId'> {
  mark: BrandMark;
}

/** Semantic resolvers carry identity evidence alongside the selected artwork. */
export function ProviderBrandIcon(props: ProviderBrandIconProps) {
  const needsOwnership = Boolean(customIconID(props.mark.iconId)) && Boolean(props.mark.providerKeys?.length);
  return needsOwnership ? <PluginAwareBrandIcon {...props} /> : <BrandArtwork {...props} />;
}

/** A configured connection, distinct from the protocol or a credential-provider identity. */
export function ProviderMark({ provider, sources, ...props }: Omit<ProviderBrandIconProps, 'mark'> & { provider: ProviderBrandIdentity; sources: ProviderBrandSources }) {
  return <ProviderBrandIcon mark={resolveProviderMark(provider, sources)} {...props} />;
}

export function CredentialMark({ provider, hint, pluginLogos, ...props }: Omit<ProviderBrandIconProps, 'mark'> & { provider: string; hint?: string; pluginLogos?: ProviderBrandSources['pluginLogos'] }) {
  return <ProviderBrandIcon mark={resolveCredentialMark(provider, hint, pluginLogos)} {...props} />;
}

function PluginAwareBrandIcon(props: ProviderBrandIconProps) {
  const ownership = usePluginProviderOwnership(props.mark.providerKeys ?? [], true);
  return <BrandArtwork {...props} isPluginOwned={ownership.isOwned} isOwnershipUnknown={ownership.isUnknown} />;
}

function BrandArtwork(props: ProviderBrandIconProps & { isPluginOwned?: boolean; isOwnershipUnknown?: boolean }) {
  // The library is needed only for a selected custom reference, not for every catalog mark.
  const selected = resolveProviderArtwork(props.mark.iconId, props.mark.fallbackIconId, Boolean(props.mark.logo), Boolean(props.isPluginOwned), Boolean(props.mark.isIdentityUnknown || props.isOwnershipUnknown));
  return customIconID(selected) || customIconID(props.mark.fallbackIconId)
    ? <CustomBrandArtwork {...props} />
    : <ResolvedBrandArtwork {...props} />;
}

function CustomBrandArtwork(props: React.ComponentProps<typeof BrandArtwork>) {
  const { data } = useCustomIcons();
  return <ResolvedBrandArtwork {...props} customIcons={data} />;
}

function ResolvedBrandArtwork({ mark, size = 24, className, style, loading, variant, customIcons, isPluginOwned, isOwnershipUnknown }: React.ComponentProps<typeof BrandArtwork> & { customIcons?: CustomIcon[] }) {
  const artworks = resolveMarkArtworks(mark, { baseURL: import.meta.env.BASE_URL, customIconURL: api.customIconURL, customIcons, variant, isPluginOwned, isOwnershipUnknown });
  return <MarkArtwork artworks={artworks} size={size} className={className} style={style} loading={loading}
    fallback={<CloudServerOutlined style={{ fontSize: size, ...style }} className={className} />} />;
}
