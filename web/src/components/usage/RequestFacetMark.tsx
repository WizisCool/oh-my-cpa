import React from 'react';

import { ModelMark } from '../ModelMark';
import type { PluginOAuthLogos } from '../../types/pluginOAuthProviders';
import {
  resolveProviderInfo,
  type CredentialIndex,
  type ProviderLookupEntry,
} from '../../types/usageEventIdentity';
import type { EventFilterKey } from '../../types/usageEventQuery';
import type { UsageEvent } from '../../types/usageEvents';
import { ProviderBrandIcon, getProviderDefaultIcon } from '../LobeIcon';

const MARK_SIZE = 16;

export interface FacetMarkSources {
  credentials: CredentialIndex;
  providerIcons: Record<string, string>;
  configuredProviders?: ProviderLookupEntry[];
  pluginLogos: PluginOAuthLogos;
}

export type FacetMarkRenderer = (key: EventFilterKey, value: string) => React.ReactNode;

/**
 * The mark beside a filter option, for the three dimensions that have one.
 *
 * A model takes its maker's mark by the rule Model Square uses. A provider and a
 * credential are resolved as the record that carried them would be, through the
 * request row's own resolver, so the option a reader picks and the rows it
 * leaves on screen show the same picture - including a custom icon set on the
 * providers page and a plugin's logo. Every other dimension is a closed
 * vocabulary of words and gets no mark.
 */
export function createFacetMarkRenderer(sources: FacetMarkSources): FacetMarkRenderer {
  const providerMark = (record: Partial<UsageEvent>) => {
    const provider = resolveProviderInfo(
      record as UsageEvent,
      sources.credentials,
      sources.providerIcons,
      sources.configuredProviders,
      getProviderDefaultIcon,
      sources.pluginLogos,
    );
    return <ProviderBrandIcon iconId={provider.iconId} logo={provider.logo} size={MARK_SIZE} />;
  };

  return (key, value) => {
    if (key === 'model') {
      return <ModelMark model={value} size={MARK_SIZE} className="req-facet-model-mark" />;
    }
    if (key === 'provider') return providerMark({ provider: value });
    if (key === 'auth_index') {
      const file = sources.credentials.get(value);
      return providerMark({ auth_index: value, provider: file?.provider || file?.type || '' });
    }
    return null;
  };
}

/** One option row: the mark, then the label the control already searches by. */
export function renderFacetOption(
  renderMark: FacetMarkRenderer,
  key: EventFilterKey,
  option: { value?: string | number | null; label?: React.ReactNode },
): React.ReactNode {
  const mark = renderMark(key, String(option.value ?? ''));
  if (!mark) return option.label;
  return (
    <span className="req-facet-option">
      <span className="req-facet-option-mark">{mark}</span>
      <span className="req-facet-option-label">{option.label}</span>
    </span>
  );
}
