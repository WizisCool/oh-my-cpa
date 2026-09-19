import type { ManagementOverviewBucket, ManagementOverviewProvider, ManagementOverviewTypeCount } from '../../types/management';
import type { ProviderItem } from '../../types/providers';
import { getProviderDefaultIcon } from '../../types/providerIconIds';
import { resolveProviderIcon } from '../../types/providerIcons';
import { pluginOAuthLogoFor, type PluginOAuthLogos } from '../../types/pluginOAuthProviders';

export type ProviderKind = 'oauth' | 'ai_provider';

export interface AggregatedProvider {
  /** Stable unique key for React lists, e.g. "oauth:codex" or "configured:openai-compat-0" */
  key: string;
  /** Raw id from overview or provider item, e.g. "codex", "cline", "antigravity" */
  id: string;
  /** Configured provider id from settings if matched, e.g. "openai-compat-0" */
  providerId?: string;
  /** Display title, e.g. "CodeX", "Meta", "Devin", "Cline", "Inception", "DeepSeek" */
  name: string;
  /** Whether this is an OAuth channel or a configured AI provider */
  kind: ProviderKind;
  /** Provider family, e.g. "codex", "meta", "openai-compatibility", "claude", "gemini" */
  family: string;
  /** Brand icon id resolved for LobeIcon */
  iconId: string;
  /** Logo the plugin owning this provider publishes. Outranks `iconId`, including a
   *  stored icon override: the console does not own a plugin provider's identity. */
  logo?: string;
  /** Number of credentials / API keys / accounts */
  credentials: number;
  /** Total requests in window */
  total: number;
  /** Successful requests */
  success: number;
  /** Failed requests */
  failure: number;
  /** Success rate (0 - 100), or null if no requests */
  successRate: number | null;
  /** Time buckets of requests for sparklines / charts */
  buckets: ManagementOverviewBucket[];
  /** Whether the channel is disabled: its own toggle is off, or the gateway
   *  holds no enabled credential for it */
  disabled: boolean;
  /** Number of models configured on this provider, if known */
  modelsCount?: number;
  /** List of model names configured, if known */
  models?: string[];
  /** Base URL if known */
  baseUrl?: string;
  /** Protocol label, e.g. "OAuth", "OpenAI Chat Completions", "Anthropic Messages" */
  protocol?: string;
}

export interface ProviderSummaryStats {
  totalProviders: number;
  totalCredentials: number;
  totalRequests: number;
  totalSuccess: number;
  totalFailure: number;
  overallSuccessRate: number | null;
  oauthCount: number;
  aiProviderCount: number;
}

export interface WindowProviderTraffic {
  id: string;
  total: number;
  success: number;
  failure: number;
  success_rate: number | null;
  buckets: ManagementOverviewBucket[];
}

/**
 * Built-in and known OAuth channels and their display channel names, brand icon IDs, and protocols.
 * As requested, CodeX, Meta, Devin, Codebuddy, etc. use their official channel titles rather than raw IDs.
 */
export const OAUTH_CHANNEL_META: Record<string, { name: string; iconId: string; protocol: string }> = {
  codex: { name: 'CodeX', iconId: 'Codex', protocol: 'OpenAI Responses (OAuth)' },
  meta: { name: 'Meta', iconId: 'Meta', protocol: 'Meta Muse (OAuth)' },
  devin: { name: 'Devin', iconId: 'Devin', protocol: 'Cognition Devin (OAuth)' },
  antigravity: { name: 'Antigravity', iconId: 'Antigravity', protocol: 'Antigravity (OAuth)' },
  kimi: { name: 'Kimi', iconId: 'Kimi', protocol: 'Moonshot Kimi (OAuth)' },
  anthropic: { name: 'Anthropic', iconId: 'Claude', protocol: 'Anthropic Claude (OAuth)' },
  claude: { name: 'Claude', iconId: 'Claude', protocol: 'Anthropic Claude (OAuth)' },
  xai: { name: 'xAI', iconId: 'XAI', protocol: 'xAI Grok (OAuth)' },
  codebuddy: { name: 'Codebuddy', iconId: 'CodeBuddy', protocol: 'Codebuddy (OAuth)' },
};

/** Capitalize first letter of a string safely. */
export function capitalize(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/** Normalize provider keys for robust matching across CPA prefix variants. */
export function normalizeProviderKey(str: string | undefined): string {
  return (str || '')
    .toLowerCase()
    .trim()
    .replace(/^openai-compat(ibility|ible)?-/, '')
    .replace(/[\s\-_.:/]/g, '');
}

/** Judge whether an ID or account type represents an OAuth channel. */
export function isOAuthChannel(id: string, accountType?: string, pluginOAuthIds?: Set<string>): boolean {
  const norm = normalizeProviderKey(id);
  if (accountType && accountType.toLowerCase().trim() === 'oauth') return true;
  if (OAUTH_CHANNEL_META[norm]) return true;
  if (pluginOAuthIds && (pluginOAuthIds.has(norm) || pluginOAuthIds.has((id || '').toLowerCase().trim()))) return true;
  return false;
}

/** Resolve user-friendly channel name for an OAuth channel or provider. */
export function resolveChannelName(id: string, fallbackName?: string): string {
  const norm = normalizeProviderKey(id);
  if (OAUTH_CHANNEL_META[norm]) {
    return OAUTH_CHANNEL_META[norm].name;
  }
  if (fallbackName && fallbackName.trim()) {
    return fallbackName.trim();
  }
  return capitalize(id);
}

export interface AggregateProvidersOptions {
  overviewProviders?: ManagementOverviewProvider[];
  windowProviders?: WindowProviderTraffic[];
  configuredProviders?: ProviderItem[];
  customIcons?: Record<string, string>;
  authFilesByType?: ManagementOverviewTypeCount[];
  pluginOAuthIds?: Set<string>;
  pluginLogos?: PluginOAuthLogos;
}

/**
 * aggregateProviders merges live traffic/credentials with all active configured AI providers.
 *
 * Rules:
 * 1. ONLY active channels currently configured in CPA or possessing valid credentials are displayed.
 *    Deleted channels (those removed from settings and lacking any active credentials) are NEVER displayed.
 * 2. Each channel is unified under its canonical identity; no channel is ever displayed twice.
 * 3. OAuth channels (CodeX, Meta, Devin, Antigravity, Kimi, Codebuddy, etc.) use their proper channel names and icons.
 * 4. If windowProviders is supplied (from the dashboard time-range selector), traffic stats reflect that exact window.
 * 5. All active configured AI providers are displayed (including disabled ones), even if 0 requests in the
 *    window. A row reads as disabled when its own toggle is off, or when the gateway reports every
 *    credential of its type disabled.
 * 6. Enabled rows always precede disabled ones; inside each group rows sort by request volume
 *    descending, then credentials descending, then name ascending. A disabled channel's requests are
 *    history rather than capacity in play, so its volume never lifts it above one that still serves.
 */
export function aggregateProviders({
  overviewProviders = [],
  windowProviders,
  configuredProviders = [],
  customIcons = {},
  authFilesByType = [],
  pluginOAuthIds,
  pluginLogos = {},
}: AggregateProvidersOptions): AggregatedProvider[] {
  const result: AggregatedProvider[] = [];
  const claimedKeys = new Set<string>();

  // The plugin that registers a provider is the authority on its artwork, so its
  // logo is found by every key the row carries before the console uses its own mark.
  const resolvePluginLogo = (...keys: (string | undefined)[]): string | undefined => {
    for (const key of keys) {
      const logo = pluginOAuthLogoFor(pluginLogos, key);
      if (logo) return logo;
    }
    return undefined;
  };

  // 1. Build unified traffic lookup map (windowProviders overrides overviewProviders for the window)
  const trafficMap = new Map<string, {
    total: number;
    success: number;
    failure: number;
    successRate: number | null;
    buckets: ManagementOverviewBucket[];
  }>();
  const consumedTrafficKeys = new Set<string>();

  const hasWindowData = Array.isArray(windowProviders);
  if (hasWindowData) {
    for (const wp of windowProviders!) {
      const key = normalizeProviderKey(wp.id);
      trafficMap.set(key, {
        total: wp.total,
        success: wp.success,
        failure: wp.failure,
        successRate: wp.success_rate,
        buckets: wp.buckets || [],
      });
    }
  } else {
    for (const op of overviewProviders) {
      const key = normalizeProviderKey(op.id);
      trafficMap.set(key, {
        total: op.total,
        success: op.success,
        failure: op.failure,
        successRate: op.success_rate,
        buckets: op.buckets || [],
      });
    }
  }

  // Helper to resolve traffic for any candidate keys (ensures each traffic record is assigned to at most one provider)
  const resolveTraffic = (candidateKeys: (string | undefined)[]) => {
    // Exact match first
    for (const candidate of candidateKeys) {
      if (!candidate) continue;
      const key = normalizeProviderKey(candidate);
      if (trafficMap.has(key) && !consumedTrafficKeys.has(key)) {
        consumedTrafficKeys.add(key);
        return trafficMap.get(key)!;
      }
    }
    // Substring / containment match
    for (const candidate of candidateKeys) {
      if (!candidate) continue;
      const cleanCandidate = normalizeProviderKey(candidate);
      if (!cleanCandidate || cleanCandidate.length < 3) continue;
      for (const [trafficKey, stats] of trafficMap.entries()) {
        if (!consumedTrafficKeys.has(trafficKey) && (trafficKey === cleanCandidate || trafficKey.includes(cleanCandidate) || cleanCandidate.includes(trafficKey))) {
          consumedTrafficKeys.add(trafficKey);
          return stats;
        }
      }
    }
    return {
      total: 0,
      success: 0,
      failure: 0,
      successRate: null,
      buckets: [],
    };
  };

  // 2. Build credentials lookup map. The gateway's own per-type tally - how many
  //    credentials a type holds and how many of them are switched off - is kept
  //    beside it, because that tally is what tells a channel switched off
  //    wholesale from one whose remaining credentials still serve.
  const credsMap = new Map<string, number>();
  const authFileCredsMap = new Map<string, { count: number; disabled: number }>();
  for (const item of authFilesByType) {
    if (item.type && item.count > 0) {
      const key = normalizeProviderKey(item.type);
      credsMap.set(key, item.count);
      authFileCredsMap.set(key, { count: item.count, disabled: item.disabled || 0 });
    }
  }
  for (const op of overviewProviders) {
    if (op.credentials > 0) {
      const key = normalizeProviderKey(op.id);
      if (!credsMap.has(key)) {
        credsMap.set(key, op.credentials);
      }
    }
  }

  const resolveCredentials = (candidateKeys: (string | undefined)[], fallback = 0): number => {
    for (const candidate of candidateKeys) {
      if (!candidate) continue;
      const key = normalizeProviderKey(candidate);
      if (credsMap.has(key)) {
        return credsMap.get(key)!;
      }
    }
    return fallback;
  };

  /**
   * areAllCredentialsDisabled answers "does the gateway hold no enabled
   * credential for this provider?"
   *
   * Exact normalized keys only. Unlike traffic, which falls back to containment
   * matching because CPA labels a queue by upstream name, this claim rests on the
   * credentials of one auth-file type; a looser match would read a channel as off
   * on another channel's evidence. The keys are ordered by how directly they name
   * the row's own credentials, and the first type CPA actually holds credentials
   * for is the one that answers: summing a second, different type would let one
   * channel's live file vouch for another channel's switched-off set.
   */
  const areAllCredentialsDisabled = (candidateKeys: (string | undefined)[]): boolean => {
    for (const candidate of candidateKeys) {
      if (!candidate) continue;
      const health = authFileCredsMap.get(normalizeProviderKey(candidate));
      if (health) return health.disabled >= health.count;
    }
    return false;
  };

  /**
   * ownedCredentialKeys names the auth-file types a configured provider may take
   * its disabled state from.
   *
   * A configured provider is not itself a credential type, and the tally covers
   * every auth-file type: matching on the provider's names alone would let an
   * openai-compatibility relay that happens to be called "gemini" read as off
   * while its own key still serves. A `{family}-api-key` provider's family names
   * the credentials it holds, and a row the console presents as a channel (a
   * plugin OAuth id, or a channel CPA names itself) holds that channel's files;
   * no other name of a configured row does.
   */
  const ownedCredentialKeys = (provider: ProviderItem, isOAuth: boolean): string[] => {
    const keys = [normalizeProviderKey(provider.family)];
    if (!isOAuth) return keys;
    for (const candidate of [provider.upstream_name, provider.name, provider.id]) {
      if (candidate && isOAuthChannel(candidate, undefined, pluginOAuthIds)) {
        keys.push(normalizeProviderKey(candidate));
      }
    }
    return keys;
  };

  // Helper to register all aliases of a provider as claimed
  const markClaimed = (...keys: (string | undefined)[]) => {
    for (const k of keys) {
      if (!k) continue;
      const norm = normalizeProviderKey(k);
      if (norm) claimedKeys.add(norm);
    }
  };

  const isClaimed = (...keys: (string | undefined)[]) => {
    for (const k of keys) {
      if (!k) continue;
      const norm = normalizeProviderKey(k);
      if (norm && claimedKeys.has(norm)) return true;
    }
    return false;
  };

  // 3. Primary pass: process all active configured AI providers from settings
  for (const cp of configuredProviders) {
    if (isClaimed(cp.id, cp.name, cp.upstream_name)) continue;

    const normName = normalizeProviderKey(cp.name);
    const normUpstream = normalizeProviderKey(cp.upstream_name);
    const normId = normalizeProviderKey(cp.id);

    const isOAuth =
      isOAuthChannel(cp.family, undefined, pluginOAuthIds) ||
      isOAuthChannel(cp.name, undefined, pluginOAuthIds) ||
      (cp.upstream_name ? isOAuthChannel(cp.upstream_name, undefined, pluginOAuthIds) : false);

    const meta = isOAuth ? (OAUTH_CHANNEL_META[normId] || OAUTH_CHANNEL_META[normUpstream] || OAUTH_CHANNEL_META[normName]) : undefined;
    const name = isOAuth && meta ? meta.name : (cp.name || cp.upstream_name || cp.id);

    const defaultIcon = isOAuth && meta
      ? meta.iconId
      : getProviderDefaultIcon(cp.family, cp.name, cp.base_url);
    const iconId = resolveProviderIcon(customIcons, { id: cp.id, name: cp.name }, defaultIcon);

    let configuredCreds = 0;
    if (cp.key_entries && cp.key_entries.length > 0) {
      configuredCreds = cp.key_entries.length;
    } else if (cp.key_configured || cp.api_key) {
      configuredCreds = 1;
    }
    const credentials = resolveCredentials([cp.upstream_name, cp.name, cp.id, cp.family], configuredCreds);
    const disabled = cp.disabled || areAllCredentialsDisabled(ownedCredentialKeys(cp, isOAuth));

    const traffic = resolveTraffic([cp.upstream_name, cp.name, cp.id, cp.family]);

    markClaimed(cp.id, cp.name, cp.upstream_name, normName, normUpstream, normId);

    const oauthChannelId = isOAuth
      ? (OAUTH_CHANNEL_META[normUpstream] ? normUpstream : OAUTH_CHANNEL_META[normName] ? normName : OAUTH_CHANNEL_META[normId] ? normId : (normUpstream || normName || cp.id))
      : cp.id;

    result.push({
      key: `configured:${cp.id}`,
      id: isOAuth ? oauthChannelId : cp.id,
      providerId: cp.id,
      name,
      kind: isOAuth ? 'oauth' : 'ai_provider',
      family: cp.family,
      iconId,
      logo: resolvePluginLogo(cp.family, cp.upstream_name, cp.name, cp.id),
      credentials,
      total: traffic.total,
      success: traffic.success,
      failure: traffic.failure,
      successRate: traffic.successRate,
      buckets: traffic.buckets,
      disabled,
      models: cp.models,
      modelsCount: cp.models?.length,
      baseUrl: cp.base_url,
      protocol: cp.protocol,
    });
  }

  // 4. Secondary pass: process active OAuth channels that possess valid credentials
  for (const item of authFilesByType) {
    if (!item.type || item.count <= 0) continue;
    if (isClaimed(item.type)) continue;

    const normType = normalizeProviderKey(item.type);
    const isOAuth = isOAuthChannel(item.type, undefined, pluginOAuthIds);
    if (!isOAuth) continue;

    const meta = OAUTH_CHANNEL_META[normType];
    const name = meta ? meta.name : capitalize(item.type);
    const defaultIcon = meta ? meta.iconId : getProviderDefaultIcon(item.type, item.type);
    const iconId = resolveProviderIcon(customIcons, { id: item.type, name: item.type }, defaultIcon);

    const traffic = resolveTraffic([item.type]);

    markClaimed(item.type, normType);

    result.push({
      key: `oauth:${normType}`,
      id: item.type,
      name,
      kind: 'oauth',
      family: item.type,
      iconId,
      logo: resolvePluginLogo(item.type, normType),
      credentials: item.count,
      total: traffic.total,
      success: traffic.success,
      failure: traffic.failure,
      successRate: traffic.successRate,
      buckets: traffic.buckets,
      disabled: areAllCredentialsDisabled([item.type]),
      protocol: meta?.protocol || 'OAuth',
    });
  }

  // 5. Tertiary pass: any remaining active live providers in overviewProviders with credentials > 0
  // Notice: Providers with 0 credentials that are not configured in settings were DELETED and are skipped!
  for (const op of overviewProviders) {
    if (op.credentials <= 0) continue;
    if (isClaimed(op.id)) continue;

    const normId = normalizeProviderKey(op.id);
    const isOAuth = isOAuthChannel(op.id, undefined, pluginOAuthIds);
    const meta = isOAuth ? OAUTH_CHANNEL_META[normId] : undefined;
    const name = isOAuth && meta ? meta.name : capitalize(op.id);
    const defaultIcon = isOAuth && meta ? meta.iconId : getProviderDefaultIcon(normId, op.id);
    const iconId = resolveProviderIcon(customIcons, { id: op.id, name: op.id }, defaultIcon);

    const traffic = resolveTraffic([op.id]);

    markClaimed(op.id, normId);

    result.push({
      key: isOAuth ? `oauth:${normId}` : `traffic:${op.id}`,
      id: op.id,
      name,
      kind: isOAuth ? 'oauth' : 'ai_provider',
      family: normId,
      iconId,
      logo: resolvePluginLogo(op.id, normId),
      credentials: op.credentials,
      total: traffic.total,
      success: traffic.success,
      failure: traffic.failure,
      successRate: traffic.successRate,
      buckets: traffic.buckets,
      disabled: areAllCredentialsDisabled([op.id]),
      protocol: isOAuth ? (meta?.protocol || 'OAuth') : undefined,
    });
  }

  // 6. Two-level stable sort: enabled rows always precede disabled ones, then
  //    request volume descending inside each group. A disabled channel's requests
  //    are history rather than capacity in play, so its volume never lifts it
  //    above a channel that can still serve.
  result.sort((a, b) => {
    if (a.disabled !== b.disabled) {
      return a.disabled ? 1 : -1;
    }
    if (a.total !== b.total) {
      return b.total - a.total;
    }
    if (a.credentials !== b.credentials) {
      return b.credentials - a.credentials;
    }
    return a.name.localeCompare(b.name);
  });

  return result;
}

/** Compute high-level summary statistics from aggregated providers. */
export function computeProviderSummary(providers: AggregatedProvider[]): ProviderSummaryStats {
  let totalCredentials = 0;
  let totalRequests = 0;
  let totalSuccess = 0;
  let totalFailure = 0;
  let oauthCount = 0;
  let aiProviderCount = 0;

  for (const p of providers) {
    totalCredentials += p.credentials;
    totalRequests += p.total;
    totalSuccess += p.success;
    totalFailure += p.failure;
    if (p.kind === 'oauth') {
      oauthCount++;
    } else {
      aiProviderCount++;
    }
  }

  const overallSuccessRate = totalRequests > 0 ? (totalSuccess / totalRequests) * 100 : null;

  return {
    totalProviders: providers.length,
    totalCredentials,
    totalRequests,
    totalSuccess,
    totalFailure,
    overallSuccessRate,
    oauthCount,
    aiProviderCount,
  };
}
