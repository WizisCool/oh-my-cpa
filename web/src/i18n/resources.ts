import type { Catalog } from './catalog';
import type { Lang } from './language';
import en from './locales/en';
import zh from './locales/zh';

/**
 * Where each registered language's copy comes from.
 *
 * Simplified Chinese and English are bundled with the entry: Simplified Chinese is the built-in
 * default and the fallback when another catalog cannot be fetched, and English is what most
 * readers outside it choose, so neither waits on a second request before the first paint. The
 * other catalogs are large enough that bundling them would make every reader pay for languages
 * they did not choose, so each is its own chunk, fetched when selected.
 *
 * `Record<Lang, ...>` is what turns a new registry row into a compile error here until its
 * catalog is supplied.
 */
export const CATALOGS: Record<Lang, Catalog | (() => Promise<Catalog>)> = {
  zh,
  en,
  'zh-Hant': () => import('./locales/zh-Hant').then((module) => module.default),
  ms: () => import('./locales/ms').then((module) => module.default),
};
