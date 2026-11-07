import type { Lang } from '../../i18n/language';
import { selectInstalledPluginMetadata, selectStorePluginMetadata } from '../../types/pluginStoreMetadata';
import type { MessageKey } from '../../i18n/catalog';
import type {
  PluginItem,
  PluginStoreAuthRule,
  PluginStoreAuthTarget,
  PluginStoreAuthType,
  PluginStoreResponse,
  StorePluginItem,
} from '../../types/plugin';

export type PluginStoreFilter = 'all' | 'installed' | 'available' | 'updates';

export const PLUGIN_STORE_FILTERS: readonly PluginStoreFilter[] = ['all', 'installed', 'available', 'updates'];

function matchesQuery(haystack: Array<string | undefined>, query: string): boolean {
  if (!query) return true;
  return haystack.some((value) => (value ?? '').toLowerCase().includes(query));
}

/**
 * The store entries a search, a filter chip and a tag leave, in the registry's own order.
 * The tag is compared as the card shows it, in the console's language, without case.
 */
export function filterStorePlugins(
  entries: readonly StorePluginItem[],
  query: string,
  filter: PluginStoreFilter,
  lang: Lang,
  tag?: string,
): StorePluginItem[] {
  const needle = query.trim().toLowerCase();
  const wantedTag = tag?.trim().toLowerCase();
  return entries.filter((entry) => {
    if (filter === 'installed' && !entry.installed) return false;
    if (filter === 'available' && entry.installed) return false;
    if (filter === 'updates' && !(entry.installed && entry.update_available)) return false;
    const metadata = selectStorePluginMetadata(entry, lang);
    if (wantedTag && !metadata.tags.some((candidate) => candidate.trim().toLowerCase() === wantedTag)) return false;
    return matchesQuery(
      [entry.id, metadata.name, metadata.description, metadata.author, entry.source_name, ...metadata.tags],
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
  lang: Lang,
): PluginItem[] {
  const needle = query.trim().toLowerCase();
  return plugins.filter((plugin) => {
    const metadata = selectInstalledPluginMetadata(plugin, catalog.get(plugin.id), lang);
    return matchesQuery(
      [
        plugin.id, metadata.name, metadata.author, plugin.oauth_provider, metadata.description,
        ...(plugin.oauth_providers ?? []),
        ...metadata.tags, ...(plugin.pages ?? []).map((page) => page.label),
      ],
      needle,
    );
  });
}

/** Whether an installed plugin runs; one switched on that the host has not loaded counts as stopped. */
export type InstalledStateFilter = 'all' | 'running' | 'stopped';

export function matchesInstalledState(plugin: PluginItem, filter: InstalledStateFilter): boolean {
  if (filter === 'running') return plugin.effective_enabled;
  if (filter === 'stopped') return !plugin.effective_enabled;
  return true;
}

/**
 * The store listing that describes each installed plugin, by plugin id.
 *
 * CPA's installed list carries what the plugin registered - name, version, author - but
 * not the description, tags or homepage a registry publishes, so an installed card
 * borrows them from the store when the store has been read. When two registries list
 * the same id, the one the plugin was installed from wins, then Oh My CPA's, then the official one.
 */
export function storeListingsByPluginId(entries: readonly StorePluginItem[] | undefined): Map<string, StorePluginItem> {
  const listings = new Map<string, StorePluginItem>();
  const rank = (entry: StorePluginItem) => (entry.install_source_status === 'matched' ? 4 : 0) + (entry.is_omc ? 2 : 0) + (entry.is_official ? 1 : 0);
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

/**
 * Where a store entry stands, from two facts the server reports separately: which
 * registry listed it and whose code its repository holds.
 *
 * Both first-party registries are catalogues as well as publishers: Oh My CPA's lists
 * the plugins it maintains in its own organization beside community plugins it curates,
 * and CPA's lists community authors' repositories beside the vendor's. Only a first-party
 * registry naming its own publisher's code reads as that publisher's plugin.
 */
export type StorePluginOrigin = 'omc' | 'omc-community' | 'official' | 'official-source' | 'third-party';

export function storePluginOrigin(entry: StorePluginItem): StorePluginOrigin {
  if (entry.is_omc) return entry.is_omc_repository ? 'omc' : 'omc-community';
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
  omc: undefined,
  'omc-community': { title: 'plugin.omc_community_plugin_title', description: 'plugin.omc_community_plugin_desc' },
  official: undefined,
  'official-source': { title: 'plugin.official_source_plugin_title', description: 'plugin.official_source_plugin_desc' },
  'third-party': { title: 'plugin.third_party_title', description: 'plugin.third_party_desc' },
};

/**
 * One registry's part of the store: Oh My CPA's own plugins first, then CPA's built-in
 * registry, then the community plugins Oh My CPA curates, then the others in the order
 * they are configured.
 *
 * Oh My CPA's registry is split in two because its two halves are not the same promise:
 * the plugins its organization maintains are the console's featured set, while the ones
 * it curates are community code and sit with the other catalogues. A section exists for
 * every registry the store read or failed to read, so a registry that lists nothing, or
 * could not be read, still has a place to say so.
 */
export interface StoreSection {
  kind: 'omc' | 'official' | 'omc-community' | 'custom';
  /** Unique per section; Oh My CPA's curated half carries its registry's id with a suffix. */
  sourceId: string;
  name: string;
  url?: string;
  entries: StorePluginItem[];
  error?: string;
}

const CURATED_SUFFIX = '#community';

export function storeSections(store: PluginStoreResponse | undefined, entries: readonly StorePluginItem[]): StoreSection[] {
  const sections = new Map<string, StoreSection>();
  const kindOf = (isOMC: boolean, isOfficial: boolean): StoreSection['kind'] => (isOMC ? 'omc' : isOfficial ? 'official' : 'custom');
  const sectionFor = (sourceId: string, seed: () => Omit<StoreSection, 'entries' | 'sourceId'>) => {
    let section = sections.get(sourceId);
    if (!section) {
      section = { sourceId, entries: [], ...seed() };
      sections.set(sourceId, section);
    }
    return section;
  };
  for (const source of store?.sources ?? []) {
    sectionFor(source.id, () => ({ kind: kindOf(source.is_omc, source.is_official), name: source.name, url: source.url }));
  }
  for (const failure of store?.source_errors ?? []) {
    const section = sectionFor(failure.source_id || failure.source_url, () => ({
      kind: 'custom',
      name: failure.source_name || failure.source_url,
      url: failure.source_url,
    }));
    section.error = failure.message;
  }
  for (const entry of entries) {
    if (storePluginOrigin(entry) === 'omc-community') {
      const home = sections.get(entry.source_id);
      sectionFor(`${entry.source_id}${CURATED_SUFFIX}`, () => ({ kind: 'omc-community', name: entry.source_name, url: home?.url })).entries.push(entry);
      continue;
    }
    sectionFor(entry.source_id, () => ({ kind: kindOf(entry.is_omc, entry.is_official), name: entry.source_name })).entries.push(entry);
  }
  const kindOrder: Record<StoreSection['kind'], number> = { omc: 0, official: 1, 'omc-community': 2, custom: 3 };
  return [...sections.values()].sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind]);
}

/** How many cards a registry shows while the whole store is in view; the rest are a click away. */
export const STORE_SECTION_PREVIEW = 6;

/** The cards one section shows: all of them once its registry is chosen or a search narrows the store. */
export function storeSectionPreview(section: StoreSection, isWholeStore: boolean): StorePluginItem[] {
  return isWholeStore ? section.entries.slice(0, STORE_SECTION_PREVIEW) : section.entries;
}

/** The registry an entry was listed by, as the console names it. */
export function storeSourceLabel(entry: StorePluginItem, t: (key: 'plugin.source_omc' | 'plugin.source_official') => string): string {
  if (entry.is_omc) return t('plugin.source_omc');
  return entry.is_official ? t('plugin.source_official') : entry.source_name;
}

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
