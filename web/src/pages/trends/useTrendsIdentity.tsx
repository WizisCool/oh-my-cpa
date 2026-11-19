import React from 'react';
import clsx from 'clsx';
import { useT } from '../../i18n';
import { useProviderBranding } from '../../hooks/useProviderBranding';
import { createFacetMarkRenderer } from '../../components/usage/RequestFacetMark';
import { ClientMark } from '../../components/common/ClientMark';
import { CodeOutlined, KeyOutlined } from '../../components/icons';
import { clientDisplayName } from '../../types/clientAgents';
import { createInsightsLabelResolver } from '../../hooks/useInsightsLabels';
import type { CredentialIndex, ProviderLookupEntry } from '../../types/usageEventIdentity';
import styles from './trends.module.css';

/** Where an operator manages a live provider or credential from Trends. */
export interface TrendsManageTarget {
  target: 'provider' | 'oauth';
  href: string;
}

/**
 * Resolves a live management link for a provider or credential, returning null for archived,
 * unassigned, redacted, or ambiguous identities so the console never draws a dead shortcut.
 */
export function resolveTrendsManagementTarget(
  dimension: 'provider' | 'credential',
  rawId: string,
  credentials: CredentialIndex,
  configuredProviders: readonly ProviderLookupEntry[],
): TrendsManageTarget | null {
  const id = rawId.trim();
  if (!id || id.startsWith('redacted:')) return null;
  if (dimension === 'credential') {
    const file = credentials.get(id);
    if (file && !file.is_archived) {
      return { target: 'oauth', href: `/oauth-management?q=${encodeURIComponent(id)}` };
    }
    const claiming = configuredProviders.filter(
      (entry) => entry.auth_index === id || entry.auth_indexes?.includes(id),
    );
    if (claiming.length === 1 && claiming[0]!.id) {
      return { target: 'provider', href: `/ai-providers?provider=${encodeURIComponent(claiming[0]!.id)}` };
    }
    return null;
  }
  const norm = id.toLowerCase();
  const byId = configuredProviders.filter((entry) => entry.id.toLowerCase() === norm);
  if (byId.length === 1 && byId[0]!.id) {
    return { target: 'provider', href: `/ai-providers?provider=${encodeURIComponent(byId[0]!.id)}` };
  }
  if (byId.length > 1) return null;
  const byName = configuredProviders.filter((entry) => {
    const upstream = entry.upstream_name?.trim().toLowerCase();
    return (
      entry.name?.trim().toLowerCase() === norm ||
      (upstream !== undefined && (upstream === norm || `openai-compatible-${upstream}` === norm))
    );
  });
  if (byName.length === 1 && byName[0]!.id) {
    return { target: 'provider', href: `/ai-providers?provider=${encodeURIComponent(byName[0]!.id)}` };
  }
  if (byName.length > 1) return null;
  const familyMatches = configuredProviders.filter((entry) => entry.family?.toLowerCase() === norm);
  if (familyMatches.length === 1 && familyMatches[0]!.id) {
    return { target: 'provider', href: `/ai-providers?provider=${encodeURIComponent(familyMatches[0]!.id)}` };
  }
  if (familyMatches.length > 1) return null;
  const oauthNorm = norm === 'anthropic' ? 'claude' : norm;
  for (const file of credentials.values()) {
    if (!file || file.is_archived) continue;
    const candidates = [file.oauth_provider, file.provider, file.type]
      .map((value) => value?.trim().toLowerCase())
      .filter((value): value is string => Boolean(value));
    if (candidates.includes(norm) || candidates.includes(oauthNorm)) {
      return { target: 'oauth', href: `/oauth-management?provider=${encodeURIComponent(oauthNorm)}` };
    }
  }
  return null;
}

/**
 * Every name a trends value arrives under: the server's `group_by` (`call_point`, `credential`, …)
 * and the filter it narrows by (`model_alias`, `auth_index`, …) name the same things.
 */
export type TrendsDimension =
  | 'model' | 'call_point' | 'model_alias'
  | 'key' | 'api_key'
  | 'client_agent'
  | 'provider'
  | 'credential' | 'auth_index';

/** A value as a read names it; a bare id when only the id is known. */
export type TrendsNamed = string | { id: string; label?: string; alias?: string; mask?: string };

export interface TrendsIdentity {
  /** The value's mark: a model's maker, a provider's or credential's brand, a client's logo, the key glyph. */
  mark: (dimension: string, id: string) => React.ReactNode;
  /** The name a reader knows the value by, the same one the request list and Insights print. */
  label: (dimension: string, value: TrendsNamed) => string;
  /** Live management shortcut for a provider or credential, when the target is currently configured. */
  manage: (dimension: 'provider' | 'credential', id: string) => TrendsManageTarget | null;
}

function shortIndexTag(id: string): string {
  const trimmed = id.trim();
  return /^[0-9a-f]{12,}$/i.test(trimmed) ? `#${trimmed.slice(0, 8)}` : trimmed;
}

/**
 * Names and marks for the values the trends reads group and filter by, from the console's shared
 * identity sources - the same directory query, mark renderer and provider resolver the request list
 * and Insights use - so a model, provider or credential looks the same on every page.
 */
export function useTrendsIdentity(): TrendsIdentity {
  const t = useT();
  const {
    credentials,
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
    () => createFacetMarkRenderer({ credentials, providerIcons, configuredProviders, pluginLogos, multiPortalKeys, isProviderCatalogUnknown, archive }),
    [archive, configuredProviders, credentials, isProviderCatalogUnknown, multiPortalKeys, pluginLogos, providerIcons],
  );
  // Insights' resolver without a cube: a provider by its configured or archived name, a credential
  // by its OAuth file, the API-key provider that claims its index, or its archived key.
  const names = React.useMemo(
    () => createInsightsLabelResolver({
      cube: undefined,
      credentialFiles: credentials,
      configuredProviders,
      pluginTitles,
      archivedCredentialsByIndex,
      archivedProvidersByKey,
      t,
    }),
    [archivedCredentialsByIndex, archivedProvidersByKey, configuredProviders, credentials, pluginTitles, t],
  );

  return React.useMemo<TrendsIdentity>(() => {
    return {
      mark: (dimension, id) => {
        if (!id) return null;
        switch (dimension) {
          case 'model':
          case 'call_point':
          case 'model_alias':
            return renderMark('model', id);
          case 'provider':
            return renderMark('provider', id);
          case 'credential':
          case 'auth_index':
            return renderMark('auth_index', id);
          case 'key':
          case 'api_key':
            return <KeyOutlined aria-hidden="true" />;
          case 'client_agent':
            return <ClientMark id={id} fallback={<CodeOutlined />} />;
          default:
            return null;
        }
      },
      label: (dimension, value) => {
        const item = typeof value === 'string' ? { id: value } : value;
        const given = item.label?.trim();
        switch (dimension) {
          case 'provider': {
            const namedProvider = names.label('provider', item.id);
            return namedProvider === item.id && given && given !== item.id ? given : namedProvider;
          }
          case 'credential':
          case 'auth_index': {
            // An index nothing in the directory claims falls back to the name the read carried.
            const named = names.label('credential', item.id);
            return named === shortIndexTag(item.id) && given && given !== item.id ? given : named;
          }
          case 'client_agent':
            return item.id ? clientDisplayName(item.id, t) : given || item.id;
          case 'key':
          case 'api_key':
            return item.alias?.trim() || given || item.mask || item.id;
          default:
            return item.alias?.trim() || given || item.id;
        }
      },
      manage: (dimension, id) => resolveTrendsManagementTarget(dimension, id, credentials, configuredProviders ?? []),
    };
  }, [configuredProviders, credentials, names, renderMark, t]);
}

/** One value as the page prints it: its mark in a fixed box, then its name, truncated alone. */
export const TrendsValue: React.FC<{
  mark: React.ReactNode;
  name: string;
  className?: string;
  /** The whole name on hover when the row cuts it short. */
  isTipOnOverflow?: boolean;
}> = ({ mark, name, className, isTipOnOverflow = true }) => (
  <span className={clsx(styles.value, className)}>
    {mark !== null && mark !== undefined && <span className={styles['value-mark']} aria-hidden="true" data-value-mark="">{mark}</span>}
    <span className={styles['value-name']} data-tip={isTipOnOverflow ? name : undefined} data-tip-overflow={isTipOnOverflow ? '' : undefined}>{name}</span>
  </span>
);
