import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useT } from '../../i18n';
import { usePreference } from '../../hooks/usePreference';
import { usePluginOAuthLogos } from '../../hooks/usePluginOAuthLogos';
import { resolveChannelName } from '../../components/dashboard/dashboardProvidersLogic';
import { CREDENTIAL_FILES_QUERY_KEY } from '../../components/dashboard/CredentialQuota';
import { createFacetMarkRenderer } from '../../components/usage/RequestFacetMark';
import { EMPTY_PROVIDER_ICONS, PROVIDER_ICONS_PREFERENCE, parseProviderIcons } from '../../types/providerIcons';
import { createProviderNameResolver, credentialFileName, credentialTitle, indexCredentialFiles } from '../../types/usageEventIdentity';
import type { EventFilterKey } from '../../types/usageEventQuery';
import { FOLDED_ID, type InsightsCube, type InsightsDimension } from './insightsCube';

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
  const { data: authFiles } = useQuery({
    queryKey: [CREDENTIAL_FILES_QUERY_KEY],
    queryFn: () => api.getManagementAuthFiles(),
    staleTime: 60_000,
  });
  const { data: providers } = useQuery({
    // The request list's sanitized entry: this page never reads the one carrying key material.
    queryKey: ['management-providers-sanitized'],
    queryFn: () => api.getManagementProviders(false),
    staleTime: 60_000,
  });
  const { value: providerIcons } = usePreference<Record<string, string>>(PROVIDER_ICONS_PREFERENCE, EMPTY_PROVIDER_ICONS, parseProviderIcons);
  const pluginLogos = usePluginOAuthLogos();

  const keys = React.useMemo(() => new Map((cube?.keys ?? []).map((key) => [key.id, key])), [cube?.keys]);
  const credentialFiles = React.useMemo(() => indexCredentialFiles(authFiles?.files ?? []), [authFiles]);
  const configuredProviders = providers?.providers;
  const providerName = React.useMemo(() => createProviderNameResolver(configuredProviders), [configuredProviders]);
  const renderMark = React.useMemo(
    () => createFacetMarkRenderer({ credentials: credentialFiles, providerIcons, configuredProviders, pluginLogos }),
    [configuredProviders, credentialFiles, pluginLogos, providerIcons],
  );
  const credentials = React.useMemo(() => {
    const names = new Map<string, { name: string; provider?: string }>();
    // The indexed read is the one that refuses to guess: an index two files claim maps to
    // null, and the raw index stays the label rather than either file's name.
    for (const [index, file] of credentialFiles) {
      names.set(index, file
        ? { name: credentialTitle(file) || credentialFileName(file), provider: file.provider || file.type }
        : { name: index });
    }
    for (const provider of configuredProviders ?? []) {
      const indexes = provider.auth_indexes?.length ? provider.auth_indexes : provider.auth_index ? [provider.auth_index] : [];
      indexes.forEach((index, position) => {
        if (!names.has(index)) {
          names.set(index, { name: indexes.length > 1 ? `${provider.name} #${position + 1}` : provider.name, provider: provider.name });
        }
      });
    }
    return names;
  }, [credentialFiles, configuredProviders]);

  return React.useMemo<InsightsLabels>(() => {
    const nameProvider = (id: string) => {
      const named = providerName(id);
      return named && named !== id ? named : resolveChannelName(id);
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
          case 'credential':
            return id ? (credentials.get(id)?.name ?? id) : t('insights.no_credential');
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
          const provider = credentials.get(id)?.provider;
          return provider ? nameProvider(provider) : undefined;
        }
        return undefined;
      },
      mark: (dimension, id) => {
        const key = MARK_KEYS[dimension];
        if (!key || id === FOLDED_ID || !id) return null;
        return renderMark(key, id);
      },
      isNonKey: (id) => keys.get(id)?.is_client_key === false,
    };
  }, [credentials, keys, providerName, renderMark, t]);
}
