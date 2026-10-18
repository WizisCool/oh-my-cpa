import { getProviderDefaultIcon } from '../../LobeIcon';
import type { PluginOAuthLogos } from '../../../types/pluginOAuthProviders';
import {
  resolveProviderInfo,
  type CredentialIndex,
  type ProviderLookupEntry,
} from '../../../types/usageEventIdentity';
import type { UsageEvent } from '../../../types/usageEvents';
import { maskKeyText } from '../../../utils/maskKey';

export interface IdentitySources {
  credentials: CredentialIndex;
  providerIcons: Record<string, string>;
  configuredProviders?: ProviderLookupEntry[];
  pluginLogos: PluginOAuthLogos;
}

export interface TargetIdentity {
  title: string;
  /** Which credential of the provider answered; empty when the record cannot say. */
  credential: string;
  iconId: string;
  logo?: string;
}

/**
 * Names a credential the way the request list's provider cell does, through the
 * same resolver, so a row on the map and the records it links to agree. The key
 * mask is re-rendered from what arrived, as the request row does, so this surface
 * cannot print a credential even if a response someday carried one.
 */
export function targetIdentity(event: UsageEvent, sources: IdentitySources): TargetIdentity {
  const info = resolveProviderInfo(
    event,
    sources.credentials,
    sources.providerIcons,
    sources.configuredProviders,
    getProviderDefaultIcon,
    sources.pluginLogos,
  );
  const credential = info.isOAuth
    ? info.credential ?? ''
    : maskKeyText(event.provider_key_mask) || event.auth_index?.trim() || '';
  return { title: info.title || event.provider || '—', credential, iconId: info.iconId, logo: info.logo };
}

/** The CSS colour of a model's lane slot: an identity hue, never a status hue. */
export function routeColor(slot: number): string {
  return `var(--route-${slot + 1})`;
}

export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** A remaining duration as the shortest honest reading: "21 s", "4 min", "2 h". */
export function formatRemaining(ms: number): { value: number; unit: 's' | 'min' | 'h' } {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 120) return { value: seconds, unit: 's' };
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 120) return { value: minutes, unit: 'min' };
  return { value: Math.ceil(minutes / 60), unit: 'h' };
}
