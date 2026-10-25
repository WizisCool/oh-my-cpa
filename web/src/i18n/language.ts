/**
 * The console's reading-language registry.
 *
 * Kept in its own module because language identity is read by non-React code too:
 * the token display layer, the heatmap's date formatter, the HTML `lang`
 * attribute, and the catalogs. A registry buried in the React provider would force
 * those modules to import a component file just to answer "is this language
 * Chinese?".
 *
 * `name` is the language's **endonym** - its own name in its own script - and is
 * deliberately not translated. A switcher that renamed 简体中文 to "Simplified
 * Chinese" would be unusable by exactly the reader who needs it: someone who
 * cannot read the console's current language cannot recognize their own behind a
 * translation of it, and would have no way back out. `id` and `code` are likewise
 * stable in every reading, which is what lets the header's trigger - a flag and a
 * two-glyph code - be the same width in every language.
 *
 * `locale` is the BCP 47 tag used for `Intl` and `document.documentElement.lang`.
 * It is separate from `id` because a stored id is a stable internal key, not a
 * locale tag: `zh` means Simplified Chinese in every existing browser profile, so
 * an id never changes once shipped even when its locale tag is refined.
 *
 * Adding a row here is the first step of adding a language; the compiler then
 * names every other place that must learn about it (`resources.ts`).
 */
export interface LanguageOption {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly country: string;
  readonly locale: string;
}

export const LANGUAGES = [
  { id: 'zh', name: '简体中文', code: '中', country: 'CN', locale: 'zh-CN' },
  // Hong Kong usage (軟件, 網絡, 密鑰, 帳戶). The id stays `zh-Hant` because stored preferences
  // already name it; the locale says which Traditional Chinese the catalog is written in.
  { id: 'zh-Hant', name: '繁體中文', code: '繁', country: 'HK', locale: 'zh-HK' },
  { id: 'en', name: 'English', code: 'EN', country: 'US', locale: 'en' },
  { id: 'ms', name: 'Bahasa Melayu', code: 'MS', country: 'MY', locale: 'ms-MY' },
] as const satisfies readonly LanguageOption[];

export type Lang = (typeof LANGUAGES)[number]['id'];

/** The language a first visit reads, and the one a catalog that cannot be fetched falls back to. */
export const DEFAULT_LANG: Lang = 'zh';

export function isLang(value: unknown): value is Lang {
  return LANGUAGES.some((language) => language.id === value);
}

/**
 * Whether a reading language uses Chinese numeric scales.
 *
 * Both Chinese scripts share 万/亿 as words, so the answer follows the locale's
 * language subtag rather than a list of ids: a later Chinese variant reads its own
 * unit style without being added here.
 */
export function isChineseLanguage(lang: Lang): boolean {
  return languageLocale(lang).startsWith('zh');
}

/** The BCP 47 tag for a reading language, for Intl and the document element. */
export function languageLocale(lang: Lang): string {
  return LANGUAGES.find((language) => language.id === lang)?.locale ?? 'en';
}
