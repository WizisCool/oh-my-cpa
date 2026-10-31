import type { MessageKey } from '../../i18n/catalog';
import type { Lang } from '../../i18n/language';
import type {
  PluginItem,
  PluginStoreSource,
  PluginStoreAuthRule,
  PluginStoreAuthTarget,
  PluginStoreAuthType,
  StorePluginItem,
} from '../../types/plugin';

import { pluginDescription } from './pluginDescription';

export type PluginStoreFilter = 'all' | 'recommended' | 'installed' | 'available' | 'updates';

export const PLUGIN_STORE_FILTERS: readonly PluginStoreFilter[] = ['all', 'recommended', 'installed', 'available', 'updates'];

/**
 * The registry tag a community author sets to say a plugin is adapted for Oh My CPA.
 *
 * Matched exactly. It earns the entry a place in the recommended section and nothing
 * else: the plugin is still third-party code, installed with the same acknowledgement,
 * and never joins the built-in catalog or its automation.
 */
export const OMC_RECOMMENDED_TAG = 'OMC';

export function isOmcRecommended(entry: StorePluginItem): boolean {
  return entry.tags.includes(OMC_RECOMMENDED_TAG);
}

/** Recommended entries first, each group in the registry's own order. */
export function sortRecommendedFirst(entries: readonly StorePluginItem[]): StorePluginItem[] {
  return [...entries.filter(isOmcRecommended), ...entries.filter((entry) => !isOmcRecommended(entry))];
}

/**
 * A store card's identity: the registry that listed it and the entry. Two registries may
 * list the same plugin id, and each is a card of its own that installs from its registry.
 */
export function storeEntryKey(entry: Pick<StorePluginItem, 'source_id' | 'id'>): string {
  return `${entry.source_id}\n${entry.id}`;
}

function matchesQuery(haystack: Array<string | undefined>, query: string): boolean {
  if (!query) return true;
  return haystack.some((value) => (value ?? '').toLowerCase().includes(query));
}

/**
 * The store entries a search and a filter chip leave, in the registry's own order. The
 * search reads the description the card shows as well as the registry's own, so a reader
 * finds a plugin by either.
 */
export function filterStorePlugins(
  entries: readonly StorePluginItem[],
  query: string,
  filter: PluginStoreFilter,
  lang: Lang,
): StorePluginItem[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (filter === 'recommended' && !isOmcRecommended(entry)) return false;
    if (filter === 'installed' && !entry.installed) return false;
    if (filter === 'available' && entry.installed) return false;
    if (filter === 'updates' && !(entry.installed && entry.update_available)) return false;
    return matchesQuery(
      [entry.id, entry.name, pluginDescription(lang, entry), entry.description, entry.author, entry.source_name, ...entry.tags],
      needle,
    );
  });
}

export function storeFilterCounts(entries: readonly StorePluginItem[]): Record<PluginStoreFilter, number> {
  return {
    all: entries.length,
    recommended: entries.filter(isOmcRecommended).length,
    installed: entries.filter((entry) => entry.installed).length,
    available: entries.filter((entry) => !entry.installed).length,
    updates: entries.filter((entry) => entry.installed && entry.update_available).length,
  };
}

/**
 * The registry sources CPA's store offers: CPA's official registry and the operator's
 * own. Oh My CPA's built-in catalog and its community registry each have a page of their
 * own, so neither is a choice in the store's source picker.
 */
export function cpaStoreSources(sources: readonly PluginStoreSource[] | undefined): PluginStoreSource[] {
  return (sources ?? []).filter((source) => source.source_kind === 'official' || source.source_kind === 'community');
}

/**
 * The description an installed row shows: the plugin's own, then the listing of the
 * registry it was installed from. Another registry listing the same id never describes it.
 */
export function installedPluginDescription(
  lang: Lang,
  plugin: PluginItem,
  listing: StorePluginItem | undefined,
): string {
  // The plugin's own declaration is one source: taking its plain text from itself and
  // its translations from the listing would let a registry's newer wording describe the
  // installed copy. The listing describes the entry only when the plugin declared nothing.
  const declared = plugin.description?.trim() || plugin.description_i18n;
  const source = declared ? plugin : listing;
  return pluginDescription(lang, {
    description: source?.description,
    description_i18n: source?.description_i18n,
  });
}

/** The installed plugins a search leaves, matched on what the card shows. */
export function filterInstalledPlugins(
  plugins: readonly PluginItem[],
  query: string,
  catalog: ReadonlyMap<string, StorePluginItem>,
  lang: Lang,
): PluginItem[] {
  const needle = query.trim().toLowerCase();
  return plugins.filter((plugin) => {
    const listing = installedListing(catalog, plugin);
    return matchesQuery(
      [
        plugin.id, plugin.metadata?.name, plugin.metadata?.author, plugin.oauth_provider,
        installedPluginDescription(lang, plugin, listing),
        ...(listing?.tags ?? []), ...(plugin.pages ?? []).map((page) => page.label),
      ],
      needle,
    );
  });
}

/**
 * The store listings that were read, by registry and plugin id.
 *
 * An installed row borrows tags, a homepage and update news from the listing of the
 * registry its install record names, and only that one: another registry listing the same
 * id says nothing about the copy that is installed.
 */
export function storeListingsBySource(entries: readonly StorePluginItem[]): Map<string, StorePluginItem> {
  return new Map(entries.map((entry) => [storeEntryKey(entry), entry]));
}

/** The listing of the registry an installed plugin came from, when that registry was read. */
export function installedListing(catalog: ReadonlyMap<string, StorePluginItem>, plugin: PluginItem): StorePluginItem | undefined {
  return plugin.source_id ? catalog.get(storeEntryKey({ source_id: plugin.source_id, id: plugin.id })) : undefined;
}

/** Whether the store's installed/update state for an entry can be acted on. */
export function isStoreInstallBlocked(entry: StorePluginItem): 'auth' | undefined {
  return entry.auth_required && !entry.auth_configured ? 'auth' : undefined;
}

/**
 * Where a store entry stands, from two facts the server reports separately: which
 * registry listed it and whose code its repository holds.
 *
 * `official` is the only combination whose code the gateway vendor publishes itself.
 * The official registry is a catalogue, and most of what it lists lives in the authors'
 * own repositories, so a listing alone never reads as reviewed code. The OMC community
 * registry is hosted by Oh My CPA but lists other authors' plugins: it is named for
 * where it lives, and installs as third-party code.
 */
export type StorePluginOrigin = 'omc-community' | 'official' | 'official-source' | 'third-party';

export function storePluginOrigin(entry: StorePluginItem): StorePluginOrigin {
  if (entry.source_kind === 'omc_community') return 'omc-community';
  if (!entry.is_official) return 'third-party';
  return entry.is_official_repository ? 'official' : 'official-source';
}

/**
 * The acknowledgement installing an entry of this origin requires, or `undefined` when it
 * requires none.
 *
 * One record rather than a predicate beside a presentation table: the warning block *is*
 * the confirmation, so the dialog cannot ask for an acknowledgement it never renders, nor
 * render a warning the install button then ignores.
 */
export interface StoreInstallWarning {
  title: MessageKey;
  description: MessageKey;
}

export const STORE_INSTALL_WARNINGS: Record<StorePluginOrigin, StoreInstallWarning | undefined> = {
  'omc-community': { title: 'plugin.omc_plugin_title', description: 'plugin.omc_plugin_desc' },
  official: undefined,
  'official-source': { title: 'plugin.official_source_plugin_title', description: 'plugin.official_source_plugin_desc' },
  'third-party': { title: 'plugin.third_party_title', description: 'plugin.third_party_desc' },
};

/** The text an operator retypes to confirm an install that needs acknowledging: the plugin id. */
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
