import type {
  PluginItem,
  PluginStoreAuthRule,
  PluginStoreAuthTarget,
  PluginStoreAuthType,
  StorePluginItem,
} from '../../types/plugin';

export type PluginStoreFilter = 'all' | 'installed' | 'available' | 'updates';

export const PLUGIN_STORE_FILTERS: readonly PluginStoreFilter[] = ['all', 'installed', 'available', 'updates'];

function matchesQuery(haystack: Array<string | undefined>, query: string): boolean {
  if (!query) return true;
  return haystack.some((value) => (value ?? '').toLowerCase().includes(query));
}

/** The store entries a search and a filter chip leave, in the registry's own order. */
export function filterStorePlugins(
  entries: readonly StorePluginItem[],
  query: string,
  filter: PluginStoreFilter,
): StorePluginItem[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (filter === 'installed' && !entry.installed) return false;
    if (filter === 'available' && entry.installed) return false;
    if (filter === 'updates' && !(entry.installed && entry.update_available)) return false;
    return matchesQuery(
      [entry.id, entry.name, entry.description, entry.author, entry.source_name, ...entry.tags],
      needle,
    );
  });
}

export function storeFilterCounts(entries: readonly StorePluginItem[]): Record<PluginStoreFilter, number> {
  return {
    all: entries.length,
    installed: entries.filter((entry) => entry.installed).length,
    available: entries.filter((entry) => !entry.installed).length,
    updates: entries.filter((entry) => entry.installed && entry.update_available).length,
  };
}

/** The installed plugins a search leaves, matched on what the card shows. */
export function filterInstalledPlugins(
  plugins: readonly PluginItem[],
  query: string,
  catalog: ReadonlyMap<string, StorePluginItem>,
): PluginItem[] {
  const needle = query.trim().toLowerCase();
  return plugins.filter((plugin) => {
    const listing = catalog.get(plugin.id);
    return matchesQuery(
      [plugin.id, plugin.metadata?.name, plugin.metadata?.author, plugin.oauth_provider, listing?.description, ...(listing?.tags ?? [])],
      needle,
    );
  });
}

/**
 * The store listing that describes each installed plugin, by plugin id.
 *
 * CPA's installed list carries what the plugin registered - name, version, author - but
 * not the description, tags or homepage a registry publishes, so an installed card
 * borrows them from the store when the store has been read. When two registries list
 * the same id, the one the plugin was installed from wins, then the official one.
 */
export function storeListingsByPluginId(entries: readonly StorePluginItem[] | undefined): Map<string, StorePluginItem> {
  const listings = new Map<string, StorePluginItem>();
  const rank = (entry: StorePluginItem) => (entry.install_source_status === 'matched' ? 2 : 0) + (entry.is_official ? 1 : 0);
  for (const entry of entries ?? []) {
    const existing = listings.get(entry.id);
    if (!existing || rank(entry) > rank(existing)) listings.set(entry.id, entry);
  }
  return listings;
}

/** Whether the store's installed/update state for an entry can be acted on. */
export function isStoreInstallBlocked(entry: StorePluginItem): 'auth' | undefined {
  return entry.auth_required && !entry.auth_configured ? 'auth' : undefined;
}

/** The text an operator retypes to confirm a third-party install: the plugin id. */
export function storeInstallConfirmToken(entry: StorePluginItem): string {
  return entry.id;
}

// ── store settings ──────────────────────────────────────────────────────────

export const PLUGIN_STORE_AUTH_TYPES: readonly PluginStoreAuthType[] = ['bearer', 'github-token', 'basic', 'header', 'none'];
export const PLUGIN_STORE_AUTH_TARGETS: readonly PluginStoreAuthTarget[] = ['registry', 'metadata', 'artifact'];

export type PluginSettingsIssue =
  | { kind: 'source-url'; index: number }
  | { kind: 'source-duplicate'; index: number }
  | { kind: 'rule-match'; index: number }
  | { kind: 'rule-env'; index: number; field: 'token_env' | 'username_env' | 'password_env' | 'header_value_env' }
  | { kind: 'rule-header'; index: number };

const ENVIRONMENT_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

export function isRegistryURL(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim());
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname !== '' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** The environment variables a rule's type reads; the others are not written. */
export function authRuleEnvFields(type: PluginStoreAuthType): Array<'token_env' | 'username_env' | 'password_env' | 'header_value_env'> {
  if (type === 'bearer' || type === 'github-token') return ['token_env'];
  if (type === 'basic') return ['username_env', 'password_env'];
  if (type === 'header') return ['header_value_env'];
  return [];
}

/**
 * The problems the server would refuse a settings save for, found before it is sent so
 * each one is shown beside the field it concerns. Empty source rows are ignored: they are
 * how the list offers a new line, not a value.
 */
export function validatePluginSettingsDraft(sources: readonly string[], rules: readonly PluginStoreAuthRule[]): PluginSettingsIssue[] {
  const issues: PluginSettingsIssue[] = [];
  const seen = new Set<string>();
  sources.forEach((source, index) => {
    const trimmed = source.trim();
    if (!trimmed) return;
    if (!isRegistryURL(trimmed)) issues.push({ kind: 'source-url', index });
    else if (seen.has(trimmed)) issues.push({ kind: 'source-duplicate', index });
    seen.add(trimmed);
  });
  rules.forEach((rule, index) => {
    if (!rule.match.trim()) issues.push({ kind: 'rule-match', index });
    for (const field of authRuleEnvFields(rule.type)) {
      if (!ENVIRONMENT_VARIABLE.test((rule[field] ?? '').trim())) issues.push({ kind: 'rule-env', index, field });
    }
    if (rule.type === 'header' && !HEADER_NAME.test((rule.header_name ?? '').trim())) {
      issues.push({ kind: 'rule-header', index });
    }
  });
  return issues;
}

/** The settings payload a draft saves: empty source rows dropped, unused variables cleared. */
export function normalizePluginSettingsDraft(sources: readonly string[], rules: readonly PluginStoreAuthRule[]) {
  const storeSources = [...new Set(sources.map((source) => source.trim()).filter(Boolean))];
  const storeAuth = rules.map((rule): PluginStoreAuthRule => {
    const used = new Set(authRuleEnvFields(rule.type));
    return {
      match: rule.match.trim(),
      apply_to: PLUGIN_STORE_AUTH_TARGETS.filter((target) => rule.apply_to.includes(target)),
      type: rule.type,
      token_env: used.has('token_env') ? rule.token_env?.trim() : undefined,
      username_env: used.has('username_env') ? rule.username_env?.trim() : undefined,
      password_env: used.has('password_env') ? rule.password_env?.trim() : undefined,
      header_name: rule.type === 'header' ? rule.header_name?.trim() : undefined,
      header_value_env: used.has('header_value_env') ? rule.header_value_env?.trim() : undefined,
      allow_insecure: rule.allow_insecure,
    };
  });
  return { storeSources, storeAuth };
}
