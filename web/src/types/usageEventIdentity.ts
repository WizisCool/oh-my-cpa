import {
  NEUTRAL_PROVIDER_ICON_ID,
  providerIconId,
} from './providerIconIds';
import {
  resolveProviderIcon,
} from './providerIcons';
import type {
  UsageEvent,
} from './usageEvents';

export type CredentialFile = {
  name: string;
  auth_index?: string;
  provider?: string;
  type?: string;
  email?: string;
  project_id?: string;
};

export type CredentialIndex = ReadonlyMap<string, CredentialFile | null>;

export type CredentialIdentity = {
  name?: string;
  kind: 'resource' | 'current_file' | 'source' | 'index' | 'unknown';
};

/** Ambiguous indexes must never be guessed, even if one filename looks likely. */
export function indexCredentialFiles(files: readonly CredentialFile[]): CredentialIndex {
  const index = new Map<string, CredentialFile | null>();
  for (const file of files) {
    if (!file.auth_index || !file.name) continue;
    index.set(file.auth_index, index.has(file.auth_index) ? null : file);
  }
  return index;
}

export function resolveCredential(event: UsageEvent, files: CredentialIndex): CredentialIdentity {
  if (event.resource_name?.trim()) return { name: event.resource_name.trim(), kind: 'resource' };
  const file = event.auth_index ? files.get(event.auth_index) : undefined;
  const provider = (file?.provider || file?.type || '').toLowerCase();
  // Never assign a current file belonging to a different provider to history.
  if (file && (!provider || !event.provider || provider === event.provider.toLowerCase()))
    return { name: file.name, kind: 'current_file' };
  if (event.auth_index?.trim()) return { name: event.auth_index.trim(), kind: 'index' };
  if (event.source?.trim()) return { name: event.source.trim(), kind: 'source' };
  return { kind: 'unknown' };
}

export interface ProviderLookupEntry {
  id: string;
  name: string;
  /** The provider's name as CPA records it, before a local custom name replaced
   *  it. This is the identity a stored provider key is built from. */
  upstream_name?: string;
  family?: string;
  auth_index?: string;
  base_url?: string;
}

/**
 * PROVIDER_KEY_PREFIX is the namespace CPA puts in front of an OpenAI-compatible
 * provider's upstream name when it labels a request record.
 */
export const PROVIDER_KEY_PREFIX = 'openai-compatible-';

/**
 * createProviderNameResolver maps one stored provider key to the name the operator
 * gave that provider.
 *
 * CPA's usage records carry its own provider key, typically
 * "openai-compatible-<upstream name>". Resolving that to the configured name is a
 * lookup, never a prettification: guessing a name from the key would print
 * something the operator never wrote and would disagree with the providers page
 * for the same line.
 *
 * The match is exact and is tried against the fields that actually carry
 * identity, in order of how much they prove:
 *
 *   1. the recorded upstream name (`upstream_name`), which is exactly the text
 *      CPA embeds in the key, and survives a local custom name;
 *   2. the key with the openai-compatible- prefix removed, against the same field;
 *   3. the local provider id.
 *
 * No substring or containment matching: a name that merely appears inside the key
 * is not proof the key denotes that provider. An identity two providers both claim
 * is treated as unresolved rather than silently assigned to whichever was listed
 * first - the custom name is what differs between them, so a name that matches two
 * entries cannot be the identity of either. Anything unresolved falls back to the
 * raw key, which is still the record's true identity and never an invention.
 *
 * auth_index is not consulted: a provider facet does not carry one.
 */
export function createProviderNameResolver(
  configured: readonly ProviderLookupEntry[] = [],
): (providerKey: string | null | undefined) => string {
  // Identity -> display name, or null once a second claimant makes the identity
  // ambiguous. Storing null rather than overwriting is the point: a duplicate
  // cannot be resolved by list order.
  const claimants = new Map<string, string | null>();
  const claim = (identity: string | undefined, name: string) => {
    const key = identity?.trim().toLowerCase();
    if (!key) return;
    if (!claimants.has(key)) claimants.set(key, name);
    else if (claimants.get(key) !== name) claimants.set(key, null);
  };
  for (const provider of configured) {
    const name = provider.name?.trim();
    if (!name) continue;
    claim(provider.upstream_name, name);
    claim(provider.id, name);
  }

  const lookup = (identity: string | undefined): string | undefined => {
    const key = identity?.trim().toLowerCase();
    if (!key) return undefined;
    return claimants.get(key) ?? undefined;
  };

  return (providerKey) => {
    const raw = providerKey?.trim();
    if (!raw) return '';
    const lowered = raw.toLowerCase();
    const stripped = lowered.startsWith(PROVIDER_KEY_PREFIX)
      ? lowered.slice(PROVIDER_KEY_PREFIX.length)
      : lowered;
    return lookup(stripped) ?? lookup(lowered) ?? raw;
  };
}

export interface ResolvedProviderInfo {
  isOAuth: boolean;
  iconId: string;
  title: string;
  subtitle?: string;
  authFile?: string;
  accountIdentity?: string;
}

export function resolveProviderInfo(
  event: UsageEvent,
  credentials: CredentialIndex,
  providerIcons: Record<string, string> = {},
  configuredProviders: ProviderLookupEntry[] = [],
  fallbackIconResolver?: (family: string, name?: string, url?: string) => string,
): ResolvedProviderInfo {
  const file = event.auth_index ? credentials.get(event.auth_index) : undefined;
  const isOAuth =
    event.auth_type?.toLowerCase() === 'oauth' ||
    file?.type?.toLowerCase() === 'oauth' ||
    Boolean(file?.email || file?.project_id);

  const resolveIcon = (family: string, name?: string, url?: string): string => {
    if (fallbackIconResolver) return fallbackIconResolver(family, name, url);
    return providerIconId(family) || NEUTRAL_PROVIDER_ICON_ID;
  };

  if (isOAuth) {
    const providerFamily = (file?.provider || file?.type || event.provider || 'oauth').toLowerCase();
    const iconId = resolveIcon(providerFamily, file?.name);
    const account = file?.email || file?.project_id;
    const credIdentity = resolveCredential(event, credentials);
    const fileName = credIdentity.name || file?.name || event.source || '';

    // For OAuth: display account identity prominently (e.g. email / project_id / file name)
    const displayName = account || fileName || event.resource_name || event.auth_index || providerFamily;
    const providerLabel = providerFamily ? providerFamily.charAt(0).toUpperCase() + providerFamily.slice(1) : 'OAuth';
    const secondary = `${providerLabel} OAuth`;

    return {
      isOAuth: true,
      iconId,
      title: displayName,
      subtitle: secondary,
      authFile: fileName,
      accountIdentity: account || undefined,
    };
  }

  // AI Provider flow
  // 1. Try exact matches first: auth_index, resource_id, resource_name, id, or name
  let matched = configuredProviders.find(
    (p) =>
      (event.auth_index && p.auth_index === event.auth_index) ||
      (event.resource_id && p.id === event.resource_id) ||
      (event.resource_name && p.name.toLowerCase() === event.resource_name.toLowerCase()) ||
      (p.id && p.id.toLowerCase() === (event.provider || '').toLowerCase()) ||
      (p.name && p.name.toLowerCase() === (event.provider || '').toLowerCase()),
  );

  // 2. If no exact match, check if any unique configured provider's name is contained in event.provider or event.resource_name
  if (!matched && configuredProviders.length > 0) {
    const candidateText = `${event.provider || ''} ${event.resource_name || ''}`.toLowerCase();
    const candidateMatches = configuredProviders.filter(
      (p) => p.name && candidateText.includes(p.name.toLowerCase()),
    );
    if (candidateMatches.length === 1) {
      matched = candidateMatches[0];
    }
  }

  const credIdentity = resolveCredential(event, credentials);
  const fileName = credIdentity.name || event.source || '';

  // Determine clean display name: configured name -> resource name -> cleaned provider text
  let providerName = matched?.name;
  if (!providerName && event.resource_name?.trim()) {
    providerName = event.resource_name.trim();
  }
  if (!providerName && event.provider) {
    // Strip technical prefixes like openai-compatible- and trailing -go/ go
    let cleaned = event.provider.trim().replace(/^openai-compat(ibility|ible)?[-/_\s]*/i, '');
    cleaned = cleaned.replace(/[-_\s]+go$/i, '');
    if (cleaned) {
      providerName = cleaned === cleaned.toLowerCase() ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : cleaned;
    } else {
      providerName = event.provider;
    }
  }
  if (!providerName) {
    providerName = 'Unknown';
  }

  const providerFamily = (matched?.family || event.provider || '').toLowerCase();
  // The matched provider's own override resolves through the same order the
  // provider table uses, so a mark stored for one surface cannot apply on another.
  // The rest are the request record's own fallbacks: the provider label CPA wrote
  // on the record, then the display name this page derived for it.
  const iconId =
    (matched && resolveProviderIcon(providerIcons, matched, '')) ||
    providerIcons[event.provider] ||
    providerIcons[providerName] ||
    resolveIcon(providerFamily, providerName, matched?.base_url);

  // For AI Providers, show only the clean Name (no technical driver subtitle)
  return {
    isOAuth: false,
    iconId,
    title: providerName,
    subtitle: undefined,
    authFile: fileName,
  };
}
