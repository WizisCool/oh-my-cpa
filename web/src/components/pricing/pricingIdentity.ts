/**
 * How a channel or an OpenRouter model is named and drawn. A channel is the provider label CPA
 * recorded on the request, which for an OpenAI-compatible upstream carries a technical prefix the
 * operator never typed; the label drops it so the row reads as the name they configured.
 */
import { PROVIDER_KEY_PREFIX } from '../../types/usageEventIdentity';
import { resolveProviderIcon, getProviderDefaultIcon } from '../../types/providerIconIds';
import { getCredentialProviderMetadata, credentialProviderIconId } from '../common/providerMetadata';
import type { PricingProvider } from '../../types/pricing';
export interface ChannelIdentity {
  label: string;
  iconId?: string;
}

export function channelIdentity(channel: string, providers: readonly PricingProvider[] = []): ChannelIdentity {
  const matching = providers.filter((provider) => provider.channel === channel);
  if (matching.length > 0) {
    const identities = matching.map(pricingProviderIdentity);
    return { label: [...new Set(identities.map((identity) => identity.label))].join(' / '), iconId: identities.length === 1 ? identities[0].iconId : resolveProviderIcon(channel, channel) };
  }
  if (channel.startsWith(PROVIDER_KEY_PREFIX)) {
    const name = channel.slice(PROVIDER_KEY_PREFIX.length);
    return { label: name, iconId: resolveProviderIcon('openai-compatibility', name) };
  }
  return { label: channel, iconId: resolveProviderIcon(channel, channel) };
}

/** Model identity metadata can supply an icon when the model directory owns it. */
export interface PricingModelIdentity {
  label: string;
  iconId?: string;
}

export function pricingModelIdentity(model: string): PricingModelIdentity {
  return { label: model };
}

export function pricingProviderIdentity(provider: PricingProvider): ChannelIdentity {
  const metadata = getCredentialProviderMetadata(provider.family);
  return {
    label: provider.is_oauth && provider.name === provider.family ? metadata.label : provider.name,
    iconId: provider.icon_id || (provider.is_oauth ? credentialProviderIconId(provider.family, provider.name) : getProviderDefaultIcon(provider.family, provider.name, provider.endpoint_host)),
  };
}
