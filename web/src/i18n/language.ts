/**
 * The console's reading-language registry.
 *
 * Kept in its own module because language identity is read by non-React code too:
 * the token display layer, the heatmap's date formatter, the HTML `lang`
 * attribute, and the i18n dictionary. A registry buried in the React dictionary
 * would force those modules to import a component file just to answer "is this
 * language Chinese?".
 *
 * `name` is the language's **endonym** - its own name in its own script - and is
 * deliberately not translated. A switcher that renamed 简体中文 to "Simplified
 * Chinese" would be unusable by exactly the reader who needs it: someone who
 * cannot read the console's current language cannot recognize their own behind a
 * translation of it, and would have no way back out. `id` and `code` are likewise
 * stable in every reading, which is what lets the header's trigger - a flag and a
 * two-glyph code - be the same width in every language.
 *
 * `locale` is the BCP 47 tag used for `Intl.DateTimeFormat` and
 * `document.documentElement.lang`. It is separate from `id` because a stored id
 * is a stable internal key, not a locale tag: `zh` means Simplified Chinese in
 * every existing browser profile.
 */
export type Lang = 'zh' | 'zh-Hant' | 'en' | 'ms';

export interface LanguageOption {
  readonly id: Lang;
  readonly name: string;
  readonly code: string;
  readonly country: string;
  readonly locale: string;
}

export const LANGUAGES: readonly LanguageOption[] = [
  { id: 'zh', name: '简体中文', code: '中', country: 'CN', locale: 'zh-CN' },
  { id: 'zh-Hant', name: '繁體中文', code: '繁', country: 'HK', locale: 'zh-Hant' },
  { id: 'en', name: 'English', code: 'EN', country: 'US', locale: 'en' },
  { id: 'ms', name: 'Bahasa Melayu', code: 'MS', country: 'MY', locale: 'ms-MY' },
];

/**
 * Whether a reading language uses Chinese numeric scales.
 *
 * Both Chinese scripts share 万/亿 as words, so accepting only `zh` would leave a
 * Traditional Chinese console unable to select the unit style its own copy reads.
 */
export function isChineseLanguage(lang: Lang): boolean {
  return lang === 'zh' || lang === 'zh-Hant';
}

/** The BCP 47 tag for a reading language, for Intl and the document element. */
export function languageLocale(lang: Lang): string {
  return LANGUAGES.find((language) => language.id === lang)?.locale ?? 'en';
}
