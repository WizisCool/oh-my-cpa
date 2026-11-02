import type { Lang } from '../i18n/language';
import { pluginDisplayName, type PluginItem, type StorePluginItem } from './plugin';

// OMC's stored `zh` means Simplified; bare `zh` must never supply Traditional.
// Prefer the console's regional reading, then an explicit same-script catalog.
const STORE_LOCALES: Record<Lang, readonly string[]> = {
  zh: ['zh-CN', 'zh-Hans', 'zh'],
  'zh-Hant': ['zh-HK', 'zh-Hant', 'zh-TW'],
  en: ['en'],
  ms: ['ms-MY', 'ms'],
};

type StoreMetadata = Pick<StorePluginItem, 'name' | 'description' | 'author' | 'homepage' | 'license' | 'tags'>;

/** Choose one publisher translation and fall back per field, never across scripts. */
export function selectStorePluginMetadata(entry: StorePluginItem, lang: Lang): StoreMetadata {
  const locale = STORE_LOCALES[lang].map((key) => entry.locales?.[key]).find((value) => value !== undefined);
  const tags = locale?.tags?.map((tag) => tag.trim()).filter(Boolean);
  return {
    name: locale?.name?.trim() || entry.name,
    description: locale?.description?.trim() || entry.description,
    author: locale?.author?.trim() || entry.author,
    homepage: locale?.homepage?.trim() || entry.homepage,
    license: locale?.license?.trim() || entry.license,
    tags: tags?.length ? tags : entry.tags,
  };
}

/** Only a source-matched listing may translate the installed copy's registered identity. */
export function selectInstalledPluginMetadata(plugin: PluginItem, listing: StorePluginItem | undefined, lang: Lang): StoreMetadata {
  if (!listing) return { name: pluginDisplayName(plugin), author: plugin.metadata?.author, tags: [] };
  const metadata = selectStorePluginMetadata({
    ...listing,
    name: plugin.metadata?.name?.trim() || listing.name || plugin.id,
    author: plugin.metadata?.author?.trim() || listing.author,
  }, lang);
  const hasMatchingSource = listing.id === plugin.id && listing.installed && listing.install_source_status === 'matched';
  return hasMatchingSource ? metadata : { ...metadata, name: pluginDisplayName(plugin), author: plugin.metadata?.author };
}
