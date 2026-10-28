import {
  NEUTRAL_PROVIDER_ICON_ID,
  providerIconId,
} from './providerIconIds';
import {
  resolveProviderIcon,
} from './providerIcons';
import {
  pluginOAuthLogoFor,
  type PluginOAuthLogos,
} from './pluginOAuthProviders';
import type {
  UsageEvent,
} from './usageEvents';
import { maskAccount, maskAccountIn } from '../utils/maskAccount';

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
  /** The stored identity. It buckets records, so it stays unmasked even when two
   *  accounts would render the same label. */
  name?: string;
  /** The form a surface prints, when masking changes it: an account and any file
   *  name built from it. Absent means `name` is already the display form. */
  displayName?: string;
  kind: 'resource' | 'current_file' | 'source' | 'index' | 'unknown';
};

/**
 * The account a credential file reports, masked for display.
 *
 * Request records travel further than the page they are read on - a screenshot, a
 * shared screen, an exported sheet - so the account is masked everywhere it is
 * printed, exactly as the OAuth workspace masks it until its own reveal. The mask
 * keeps the first letters and the domain, which is what tells an operator's own
 * accounts apart.
 */
export function credentialAccount(file: CredentialFile | null | undefined): string {
  const account = (file?.email || file?.project_id || '').trim();
  return account ? maskAccount(account) : '';
}

/**
 * A credential file's name with the account masked wherever the name repeats it.
 *
 * Codex names an auth file after the account, so the same address appears a second
 * time in the file name. A name that does not contain the account is left whole: it
 * is the operator's or CPA's own label, not identity material.
 */
export function credentialFileName(file: CredentialFile | null | undefined): string {
  const name = (file?.name || '').trim();
  if (!name) return '';
  const account = (file?.email || file?.project_id || '').trim();
  return account ? maskAccountIn(name, account) : name;
}

/** Ambiguous indexes must never be guessed, even if one filename looks likely. */
export function indexCredentialFiles(files: readonly CredentialFile[]): CredentialIndex {
  const index = new Map<string, CredentialFile | null>();
  for (const file of files) {
    if (!file.auth_index || !file.name) continue;
    index.set(file.auth_index, index.has(file.auth_index) ? null : file);
  }
  return index;
}

/**
 * resolveCredential names the credential a record ran on, preferring the operator's
 * own resource name over the live auth file.
 *
 * `name` is the identity a header or filter buckets by; `displayName` is the form a
 * surface prints when it differs, which happens only for a live file whose name
 * repeats its account. The two are separate on purpose: a mask is not unique, so
 * making it the bucket would merge two accounts into one group.
 */
export function resolveCredential(event: UsageEvent, files: CredentialIndex): CredentialIdentity {
  if (event.resource_name?.trim()) return { name: event.resource_name.trim(), kind: 'resource' };
  const file = event.auth_index ? files.get(event.auth_index) : undefined;
  const provider = (file?.provider || file?.type || '').toLowerCase();
  // Never assign a current file belonging to a different provider to history.
  if (file && (!provider || !event.provider || provider === event.provider.toLowerCase())) {
    const displayName = credentialFileName(file);
    return {
      name: file.name,
      ...(displayName !== file.name ? { displayName } : {}),
      kind: 'current_file',
    };
  }
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
  /** Every key's runtime auth index; `auth_index` is only the first key's. */
  auth_indexes?: string[];
  base_url?: string;
}

/**
 * PROVIDER_KEY_PREFIX is the namespace CPA puts in front of an OpenAI-compatible
 * provider's upstream name when it labels a request record.
 */
export const PROVIDER_KEY_PREFIX = 'openai-compatible-';

/**
 * Rows and facets share the same identity claims. Display names and resource
 * names are presentation, not proof that a current provider served a request.
 */
function createProviderResolver(configured: readonly ProviderLookupEntry[]) {
  const providerClaims = new Map<string, ProviderLookupEntry | null>();
  const credentialClaims = new Map<string, ProviderLookupEntry | null>();
  const claim = (claims: Map<string, ProviderLookupEntry | null>, key: string, provider: ProviderLookupEntry) => {
    if (!key) return;
    const current = claims.get(key);
    if (current === undefined) claims.set(key, provider);
    else if (current !== provider) claims.set(key, null);
  };
  for (const provider of configured) {
    claim(providerClaims, provider.id.trim().toLowerCase(), provider);
    const upstreamName = provider.upstream_name?.trim().toLowerCase();
    if (upstreamName) claim(providerClaims, `${PROVIDER_KEY_PREFIX}${upstreamName}`, provider);
    for (const authIndex of [provider.auth_index, ...(provider.auth_indexes ?? [])]) {
      claim(credentialClaims, authIndex?.trim() || '', provider);
    }
  }

  return (providerKey: string | null | undefined, authIndex?: string): ProviderLookupEntry | undefined => {
    // A missing or ambiguous credential cannot be replaced by a weaker label:
    // that would transfer history after deletion, rotation or name reuse.
    const credentialKey = authIndex?.trim();
    if (credentialKey) return credentialClaims.get(credentialKey) ?? undefined;

    const rawKey = providerKey?.trim().toLowerCase() || '';
    return providerClaims.get(rawKey) ?? undefined;
  };
}

/** Provider facets have no credential index, so only exact provider keys resolve. */
export function createProviderNameResolver(
  configured: readonly ProviderLookupEntry[] = [],
): (providerKey: string | null | undefined) => string {
  const resolveProvider = createProviderResolver(configured);
  return (providerKey) => resolveProvider(providerKey)?.name.trim() || providerKey?.trim() || '';
}

export interface ResolvedProviderInfo {
  isOAuth: boolean;
  iconId: string;
  /** Logo the plugin owning this provider publishes, which outranks the catalog mark. */
  logo?: string;
  /** The provider's name, for every credential type. */
  title: string;
  /**
   * Which OAuth credential answered, as the line under the provider: the masked
   * account, else its file. An API-key provider's credential is the masked key the
   * record carries, which the surfaces render from the record themselves.
   */
  credential?: string;
  authFile?: string;
  /**
   * The account behind the credential, unmasked. Only an export the operator has
   * explicitly unredacted may print it; a display surface uses `credential`.
   */
  accountIdentity?: string;
}

export function resolveProviderInfo(
  event: UsageEvent,
  credentials: CredentialIndex,
  providerIcons: Record<string, string> = {},
  configuredProviders: ProviderLookupEntry[] = [],
  fallbackIconResolver?: (family: string, name?: string, url?: string) => string,
  pluginLogos: PluginOAuthLogos = {},
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

  // The plugin that registers a provider is the authority on its artwork, so its
  // logo is looked up by every key the record carries for that provider before the
  // row falls back to the console's own catalog mark.
  const resolveLogo = (...keys: (string | undefined)[]): string | undefined => {
    for (const key of keys) {
      const logo = pluginOAuthLogoFor(pluginLogos, key);
      if (logo) return logo;
    }
    return undefined;
  };

  if (isOAuth) {
    // A credential file may say only that it is an OAuth file. That is how it
    // authenticates, not who it belongs to, so the record's own provider names
    // the cell before it does.
    const fileType = file?.type?.toLowerCase() === 'oauth' ? '' : file?.type;
    const providerFamily = (file?.provider || fileType || event.provider || file?.type || 'oauth').toLowerCase();
    const iconId = resolveIcon(providerFamily, file?.name);
    const account = file?.email || file?.project_id;
    const credIdentity = resolveCredential(event, credentials);
    const fileName = credIdentity.displayName || credIdentity.name || event.source || '';

    // Both credential types read the same way: the provider is the title and the
    // credential that answered is the line under it. Leading with the account
    // here made an OAuth cell answer a different question from the API-key cell
    // beside it.
    const providerLabel = providerFamily.charAt(0).toUpperCase() + providerFamily.slice(1);
    // The account is the one display value masking must reach here: the API-key half
    // of the same line is already a server-side mask, and a request record carries no
    // reveal, so this is the only form the row can print.
    const credential = credentialAccount(file) || fileName || event.resource_name?.trim() || event.auth_index?.trim() || undefined;

    return {
      isOAuth: true,
      iconId,
      logo: resolveLogo(file?.provider, file?.type, event.provider),
      title: providerLabel,
      credential,
      authFile: fileName,
      accountIdentity: account || undefined,
    };
  }

  const matched = createProviderResolver(configuredProviders)(event.provider, event.auth_index);
  const credIdentity = resolveCredential(event, credentials);
  const fileName = credIdentity.name || event.source || '';
  const providerName = matched?.name.trim() || event.resource_name?.trim() || event.provider?.trim() || 'Unknown';

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

  return {
    isOAuth: false,
    iconId,
    logo: resolveLogo(matched?.family, matched?.upstream_name, event.provider),
    title: providerName,
    authFile: fileName,
  };
}
