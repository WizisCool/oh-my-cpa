import type { ConfigProviderProps } from 'antd';
import enUS from 'antd/locale/en_US';
import msMY from 'antd/locale/ms_MY';
import zhCN from 'antd/locale/zh_CN';
import zhHK from 'antd/locale/zh_HK';
import type { Catalog } from './catalog';
import type { Lang } from './language';
import en from './locales/en';
import zh from './locales/zh';

type AntdLocale = NonNullable<ConfigProviderProps['locale']>;

/**
 * Where each registered language's copy comes from.
 *
 * Simplified Chinese and English are bundled with the entry: Simplified Chinese is the default
 * reading and the fallback when another catalog cannot be fetched, and English is what most
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

/**
 * Ant Design's own strings and date-picker conventions for each reading language. These ship in
 * antd's vendor chunk whichever way they are imported, so they are not deferred. Traditional
 * Chinese takes antd's Hong Kong locale, the variety the catalog is written in.
 */
export const ANTD_LOCALES: Record<Lang, AntdLocale> = {
  zh: zhCN,
  'zh-Hant': zhHK,
  en: enUS,
  ms: msMY,
};
