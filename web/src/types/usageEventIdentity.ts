import { resolveCredentialMark, resolveProviderMark, resolveRecordedProviderMark, type BrandMark } from './brandMark';
import type { PluginOAuthLogos } from './pluginOAuthProviders';
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
  /** The operator's own name for the credential, kept by Oh My CPA. */
  display_name?: string;
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
  // Each candidate is trimmed before it is chosen, so a blank address cannot shadow the
  // project id beside it.
  const account = file?.email?.trim() || file?.project_id?.trim() || '';
  return account ? maskAccount(account) : '';
}

/**
 * The name a surface prints for a credential: the operator's own name when it has
 * one, otherwise the masked account.
 *
 * The operator chose the name and it is not identity material, so it is printed
 * whole; the account behind it keeps the mask wherever it still appears.
 */
export function credentialTitle(file: CredentialFile | null | undefined): string {
  return file?.display_name?.trim() || credentialAccount(file);
}

/**
 * Every identity CPA reports for one credential file: the account address and, for a
 * service account, the project it belongs to.
 */
function credentialIdentities(file: CredentialFile | null | undefined): string[] {
  return [file?.email, file?.project_id]
    .map((value) => (value || '').trim())
    .filter(Boolean);
}

/**
 * Masks each reported identity wherever a display label repeats it.
 *
 * A file can report both an address and a project id (a Vertex service account does),
 * and its name may repeat either or both - `vertex-acme-prod.json` is named after the
 * project. Masking only the first reported value would leave the other printed. The
 * address goes first because a project id can be part of it; masking the whole address
 * before the project id keeps one replacement from breaking the other's match.
 */
export function maskCredentialIdentities(text: string, file: CredentialFile | null | undefined): string {
  return credentialIdentities(file).reduce((masked, identity) => maskAccountIn(masked, identity), text);
}

/**
 * A credential file's name with every reported identity masked wherever the name
 * repeats one.
 *
 * Codex names an auth file after the account, and a Vertex file after its project, so
 * the file name is a second place the same identity appears. A name that contains none
 * of them is left whole: it is the operator's or CPA's own label, not identity material.
 */
export function credentialFileName(file: CredentialFile | null | undefined): string {
  const name = (file?.name || '').trim();
  if (!name) return '';
  return maskCredentialIdentities(name, file);
}

/** How a filter option names a credential: the operator's name, else its masked file name. */
export function credentialOptionLabel(file: CredentialFile | null | undefined): string {
  return credentialTitle(file) || credentialFileName(file);
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
 * surface prints when it differs, which happens when a resource or file name repeats
 * an identity CPA reports for the credential. The two are separate on purpose: a mask
 * is not unique, so making it the bucket would merge two accounts into one group.
 */
function matchingCredential(event: UsageEvent, files: CredentialIndex): CredentialFile | undefined {
  const file = event.auth_index ? files.get(event.auth_index) : undefined;
  if (!file) return undefined;
  const provider = (file.provider || (file.type?.toLowerCase() === 'oauth' ? '' : file.type) || '').toLowerCase();
  return !provider || !event.provider || provider === event.provider.toLowerCase() ? file : undefined;
}

export function resolveCredential(event: UsageEvent, files: CredentialIndex): CredentialIdentity {
  const file = matchingCredential(event, files);
  // Masking is not attribution: whatever the index resolves to can repeat an identity the
  // resource or file name also prints, so it is applied whenever a file exists for the
  // index. A name is attribution, and only a file that names this record may supply one.
  const maskFile = event.auth_index ? files.get(event.auth_index) : undefined;
  // A discovered resource is named after the auth file CPA saw, so its name repeats the
  // same identities the live file reports; mask it through the same projection. The
  // stored name stays the bucket, even when masking changes what a surface prints.
  // The operator's own name for the file, when it has one, is what every surface prints.
  // An operator name, or the account the file reports, replaces the label; the account branch
  // keeps one mask and one shape for a named and an unnamed credential. Without either, the
  // label is the name itself, masked in place, which is what every surface prints for a resource.
  const identity = (name: string, kind: CredentialIdentity['kind'], shownName: string): CredentialIdentity => {
    const displayName = shownName || maskCredentialIdentities(name, maskFile);
    return { name, ...(displayName !== name ? { displayName } : {}), kind };
  };
  const resourceName = event.resource_name?.trim();
  const isFileOfResource = Boolean(file?.name.trim() && file.name.trim() === resourceName);
  if (resourceName)
    // A resource names the file CPA recorded, so the live file's own name must match it
    // before the operator's name for that file can stand in for the resource's label.
    return identity(resourceName, 'resource', isFileOfResource ? credentialTitle(file) : '');
  if (file)
    return identity(file.name, 'current_file', credentialTitle(file));
  if (event.auth_index?.trim()) return identity(event.auth_index.trim(), 'index', '');
  if (event.source?.trim()) return identity(event.source.trim(), 'source', '');
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

export interface ResolvedProviderInfo extends BrandMark {
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
  pluginLogos: PluginOAuthLogos = {},
  /** The provider catalog could not be read, so a recorded label is not yet proven either way. */
  isProviderCatalogUnknown = false,
): ResolvedProviderInfo {
  const file = matchingCredential(event, credentials);
  const isOAuth =
    event.auth_type?.toLowerCase() === 'oauth' ||
    file?.type?.toLowerCase() === 'oauth' ||
    Boolean(file?.email || file?.project_id);

  if (isOAuth) {
    // A credential file may say only that it is an OAuth file. That is how it
    // authenticates, not who it belongs to, so the record's own provider names
    // the cell before it does.
    const fileType = file?.type?.toLowerCase() === 'oauth' ? '' : file?.type;
    const providerFamily = (file?.provider || fileType || event.provider || file?.type || 'oauth').toLowerCase();
    const mark = resolveCredentialMark(providerFamily, file?.name, pluginLogos, [file?.provider, file?.type, event.provider].filter((key): key is string => Boolean(key)));
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
    const credential = credentialTitle(file) || fileName || event.resource_name?.trim() || event.auth_index?.trim() || undefined;

    return {
      isOAuth: true,
      ...mark,
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

  const sources = { providerIcons, pluginLogos, isProviderCatalogUnknown };
  if (matched) {
    return {
      isOAuth: false,
      ...resolveProviderMark({ ...matched, family: matched.family || event.provider || '', name: providerName, aliases: [event.provider] }, sources),
      title: providerName,
      authFile: fileName,
    };
  }

  // A record left without a configured provider is ambiguous in two different ways, and a
  // reader has to be able to tell them apart. Its own label is the truth when the catalog was
  // read and does not claim the record - a provider someone deleted, or a request the console
  // never configured. It is only unproven when the catalog could not be read at all: then the
  // name printed is a placeholder until the read settles, and an export must not save it.
  const recorded = resolveRecordedProviderMark(event.provider || '', providerName, sources);

  return {
    isOAuth: false,
    ...recorded,
    isIdentityUnknown: isProviderCatalogUnknown || recorded.isIdentityUnknown,
    title: providerName,
    authFile: fileName,
  };
}
