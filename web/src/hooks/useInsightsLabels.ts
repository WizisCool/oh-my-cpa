import React from 'react';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n/catalog';
import { useProviderBranding } from './useProviderBranding';
import { resolveChannelName } from '../components/dashboard/dashboardProvidersLogic';
import { createFacetMarkRenderer } from '../components/usage/RequestFacetMark';
import type { ArchivedCredentialItem, ArchivedProviderItem } from '../types/identityDirectory';
import {
  createProviderNameResolver,
  credentialFileName,
  credentialTitle,
  type CredentialIndex,
  type ProviderLookupEntry,
} from '../types/usageEventIdentity';
import type { EventFilterKey } from '../types/usageEventQuery';
import { FOLDED_ID, type InsightsCube, type InsightsDimension } from '../types/insightsCube';

export interface InsightsLabels {
  /** The name a reader knows a value by. */
  label: (dimension: InsightsDimension, id: string) => string;
  /** A secondary line: a key's mask under its alias, a credential's provider. */
  detail: (dimension: InsightsDimension, id: string) => string | undefined;
  /** The value's mark - a model's maker, a provider's or credential's brand - or null for a key. */
  mark: (dimension: InsightsDimension, id: string) => React.ReactNode;
  /** Traffic that reached the gateway without a client key. */
  isNonKey: (id: string) => boolean;
}

/** The request list's filter vocabulary, which the shared mark renderer is keyed by. */
const MARK_KEYS: Partial<Record<InsightsDimension, EventFilterKey>> = {
  call_point: 'model', model: 'model', provider: 'provider', credential: 'auth_index',
};

export interface InsightsLabelResolverInput {
  cube: InsightsCube | undefined;
  credentialFiles: CredentialIndex;
  configuredProviders?: readonly ProviderLookupEntry[];
  pluginTitles?: ReadonlyMap<string, string>;
  archivedCredentialsByIndex?: ReadonlyMap<string, ArchivedCredentialItem>;
  archivedProvidersByKey?: ReadonlyMap<string, ArchivedProviderItem>;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

export interface PureInsightsLabelResolver {
  label: (dimension: InsightsDimension, id: string) => string;
  detail: (dimension: InsightsDimension, id: string) => string | undefined;
  isNonKey: (id: string) => boolean;
  cubeCredentialProviders: ReadonlyMap<string, string>;
}

/**
 * Pure framework-free label and detail derivation for Insights dimensions,
 * covering live catalogs, archived deleted identities, and ambiguity refusal.
 */
export function createInsightsLabelResolver(input: InsightsLabelResolverInput): PureInsightsLabelResolver {
  const {
    cube,
    credentialFiles,
    configuredProviders,
    pluginTitles,
    archivedCredentialsByIndex,
    archivedProvidersByKey,
    t,
  } = input;

  const keys = new Map((cube?.keys ?? []).map((key) => [key.id, key]));
  const providerName = createProviderNameResolver(configuredProviders, pluginTitles, archivedProvidersByKey);

  const cubeCredentialProviders = new Map<string, string>();
  if (cube) {
    for (const row of [...cube.rows, ...cube.previous]) {
      const credIdx = cube.values.credential[row.dims[4]] ?? '';
      const provKey = cube.values.provider[row.dims[3]] ?? '';
      if (!credIdx || !provKey) continue;
      const existing = cubeCredentialProviders.get(credIdx);
      if (existing === undefined) cubeCredentialProviders.set(credIdx, provKey);
      else if (existing !== provKey) cubeCredentialProviders.set(credIdx, '');
    }
  }

  const credentials = new Map<string, { name: string; provider?: string }>();
  for (const [index, file] of credentialFiles) {
    credentials.set(index, file
      ? { name: credentialTitle(file) || credentialFileName(file), provider: file.provider || file.type }
      : { name: index });
  }

  const claims = new Map<string, { name: string; provider?: string } | null>();
  for (const provider of configuredProviders ?? []) {
    const indexes = provider.auth_indexes?.length ? provider.auth_indexes : provider.auth_index ? [provider.auth_index] : [];
    indexes.forEach((index, position) => {
      const name = indexes.length > 1 ? `${provider.name} #${position + 1}` : provider.name;
      claims.set(index, claims.has(index) ? null : { name, provider: provider.name });
    });
  }
  for (const [index, claim] of claims) {
    if (!credentials.has(index)) {
      credentials.set(index, claim ?? { name: index });
    }
  }
  for (const [index, arch] of archivedCredentialsByIndex ?? []) {
    if (credentials.has(index) || arch.is_ambiguous) continue;
    if (arch.kind === 'apikey') {
      const label = [arch.provider_name || arch.upstream_name, arch.key_mask].filter(Boolean).join(' ');
      if (label) {
        credentials.set(index, { name: label, provider: arch.provider_name || arch.provider_key });
      }
    }
  }

  const nameProvider = (id: string) => {
    const named = providerName(id);
    return named && named !== id ? named : resolveChannelName(id, pluginTitles);
  };
  const shortIndexTag = (id: string) => {
    const trimmed = id.trim();
    return /^[0-9a-f]{12,}$/i.test(trimmed) ? `#${trimmed.slice(0, 8)}` : trimmed;
  };

  return {
    label: (dimension, id) => {
      if (id === FOLDED_ID) return t('insights.folded');
      switch (dimension) {
        case 'key': {
          const key = keys.get(id);
          if (key && !key.is_client_key) return t('insights.non_key', { label: id });
          return key?.alias || key?.mask || (id.startsWith('hmac:') ? `#${id.slice(5, 13)}` : id);
        }
        case 'provider':
          return nameProvider(id);
        case 'credential': {
          if (!id) return t('insights.no_credential');
          const entry = credentials.get(id);
          if (entry) {
            return entry.name === id ? shortIndexTag(id) : entry.name;
          }
          const provKey = cubeCredentialProviders.get(id);
          if (provKey) {
            return `${nameProvider(provKey)} (${shortIndexTag(id)})`;
          }
          return shortIndexTag(id);
        }
        default:
          return id || t('insights.unknown');
      }
    },
    detail: (dimension, id) => {
      if (dimension === 'key') {
        const key = keys.get(id);
        return key?.alias ? key.mask : undefined;
      }
      if (dimension === 'credential') {
        const provider = credentials.get(id)?.provider || cubeCredentialProviders.get(id);
        return provider ? nameProvider(provider) : undefined;
      }
      return undefined;
    },
    isNonKey: (id) => keys.get(id)?.is_client_key === false,
    cubeCredentialProviders,
  };
}

/**
 * Names and marks for the cube's values.
 *
 * A key is named by the operator's alias, then by the mask its last request carried, then by its
 * fingerprint; the key itself is never in the browser. Providers and credentials are named and marked
 * the way the request list names and marks them - the configured provider name, the masked account
 * behind an auth file, the provider's brand or a plugin's logo - from the same queries, so one value
 * reads the same on both pages. A credential keeps its runtime index when it has since been removed,
 * because its usage outlives it.
 */
export function useInsightsLabels(cube: InsightsCube | undefined): InsightsLabels {
  const t = useT();
  const {
    credentials: credentialFiles,
    providerIcons,
    pluginLogos,
    multiPortalKeys,
    pluginTitles,
    configuredProviders,
    archivedCredentialsByIndex,
    archivedProvidersByKey,
    archive,
    isProviderCatalogUnknown,
  } = useProviderBranding();

  const renderMark = React.useMemo(
    () => createFacetMarkRenderer({ credentials: credentialFiles, providerIcons, configuredProviders, pluginLogos, multiPortalKeys, isProviderCatalogUnknown, archive }),
    [configuredProviders, credentialFiles, pluginLogos, multiPortalKeys, providerIcons, isProviderCatalogUnknown, archive],
  );

  const resolver = React.useMemo(
    () => createInsightsLabelResolver({
      cube,
      credentialFiles,
      configuredProviders,
      pluginTitles,
      archivedCredentialsByIndex,
      archivedProvidersByKey,
      t,
    }),
    [cube, credentialFiles, configuredProviders, pluginTitles, archivedCredentialsByIndex, archivedProvidersByKey, t],
  );

  return React.useMemo<InsightsLabels>(() => ({
    label: resolver.label,
    detail: resolver.detail,
    isNonKey: resolver.isNonKey,
    mark: (dimension, id) => {
      const key = MARK_KEYS[dimension];
      if (!key || id === FOLDED_ID || !id) return null;
      if (key === 'auth_index' && !credentialFiles.has(id)) {
        const provKey = resolver.cubeCredentialProviders.get(id);
        if (provKey) return renderMark('provider', provKey);
      }
      return renderMark(key, id);
    },
  }), [credentialFiles, renderMark, resolver]);
}
