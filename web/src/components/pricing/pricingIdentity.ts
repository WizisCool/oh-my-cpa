/**
 * How a channel or an OpenRouter model is named and drawn. A channel is the provider label CPA
 * recorded on the request, which for an OpenAI-compatible upstream carries a technical prefix the
 * operator never typed; the label drops it so the row reads as the name they configured.
 */
import { PROVIDER_KEY_PREFIX } from '../../types/usageEventIdentity';
import { resolveProviderMark, type BrandMark, type ProviderBrandSources } from '../../types/brandMark';
import { getCredentialProviderMetadata } from '../../types/providerMetadata';
import type { PricingProvider } from '../../types/pricing';
export interface ChannelIdentity extends BrandMark {
  label: string;
  iconId?: string;
}

export function channelIdentity(channel: string, providers: readonly PricingProvider[] = [], sources: ProviderBrandSources = {}): ChannelIdentity {
  const matching = providers.filter((provider) => provider.channel === channel);
  if (matching.length > 0) {
    const identities = matching.map((provider) => pricingProviderIdentity(provider, sources));
    return { ...(identities.length === 1 ? identities[0] : resolveProviderMark({ family: channel, name: channel }, sources)), label: [...new Set(identities.map((identity) => identity.label))].join(' / ') };
  }
  if (channel.startsWith(PROVIDER_KEY_PREFIX)) {
    const name = channel.slice(PROVIDER_KEY_PREFIX.length);
    return { label: name, ...resolveProviderMark({ family: 'openai-compatibility', name, aliases: [channel] }, sources) };
  }
  return { label: channel, ...resolveProviderMark({ family: channel, name: channel }, sources) };
}

/** Model identity metadata can supply an icon when the model directory owns it. */
export interface PricingModelIdentity {
  label: string;
  iconId?: string;
}

export function pricingModelIdentity(model: string): PricingModelIdentity {
  return { label: model };
}

export function pricingProviderIdentity(provider: PricingProvider, sources: ProviderBrandSources = {}): ChannelIdentity {
  const metadata = getCredentialProviderMetadata(provider.family);
  return {
    label: provider.is_oauth && provider.name === provider.family ? metadata.label : provider.name,
    ...resolveProviderMark({ ...provider, base_url: provider.endpoint_host }, sources),
  };
}
