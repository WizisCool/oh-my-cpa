import React from 'react';
import { LANGUAGES, languageLocale, type Lang } from './language';
import { DICT } from './messages';

export { LANGUAGES, languageLocale, isChineseLanguage } from './language';
export type { Lang } from './language';

export type TFunc = (key: string, vars?: Record<string, string | number>) => string;

type Catalog = Readonly<Record<string, string>>;

/**
 * The catalogs loaded on demand.
 *
 * The base dictionary already carries two complete languages, but the additional
 * catalogs are large enough that bundling them into the entry chunk would make every
 * reader pay for languages they did not choose. Keeping the loaders here also means
 * the registry remains the only place a language must be declared: when a switcher
 * asks for one of these ids, this map supplies the catalog that makes it readable.
 */
const CATALOG_LOADERS: Partial<Record<Lang, () => Promise<Catalog>>> = {
  'zh-Hant': () => import('./locales/zh-Hant').then((module) => module.ZH_HANT),
  ms: () => import('./locales/ms').then((module) => module.MS),
};

const loadedCatalogs = new Map<Lang, Catalog>();
const catalogPromises = new Map<Lang, Promise<Catalog>>();

function isDeferredLanguage(lang: Lang): boolean {
  return Boolean(CATALOG_LOADERS[lang]);
}

function loadCatalog(lang: Lang): Promise<Catalog> {
  const loaded = loadedCatalogs.get(lang);
  if (loaded) return Promise.resolve(loaded);
  const existing = catalogPromises.get(lang);
  if (existing) return existing;
  const loader = CATALOG_LOADERS[lang];
  if (!loader) return Promise.resolve({});
  const pending = loader().then(
    (catalog) => {
      loadedCatalogs.set(lang, catalog);
      catalogPromises.delete(lang);
      return catalog;
    },
    (error: unknown) => {
      // A failed load is not cached, so the failure a later attempt meets is the fetch's rather than
      // this map's: the browser refuses to re-fetch a module whose import already failed in a
      // document, which is why the recovery below is a reload and not a second click. Holding the
      // rejection here anyway would leave the loader permanently disagreeing with itself.
      catalogPromises.delete(lang);
      throw error;
    },
  );
  catalogPromises.set(lang, pending);
  return pending;
}

/**
 * Whether the base dictionary names a key. For copy chosen from a server value - an audit
 * action, a result - so an identifier the console has no sentence for falls back to a
 * deliberate rendering instead of printing the lookup key.
 */
export function hasMessage(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(DICT, key);
}

/** A key with no entry renders as itself, so a miss is visible in development. */
export function makeT(lang: Lang): TFunc {
  return (key, vars) => {
    const entry = DICT[key];
    let text = key;
    if (lang === 'zh') text = entry?.[0] ?? key;
    else if (lang === 'en') text = entry?.[1] ?? key;
    else {
      // A deferred catalog can be incomplete while a deployment is rolling
      // out. Fall back to the base dictionary rather than showing a raw key.
      const fallbackIndex = lang === 'zh-Hant' ? 0 : 1;
      text = loadedCatalogs.get(lang)?.[key] ?? entry?.[fallbackIndex] ?? key;
    }
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        text = text.split(`{${name}}`).join(String(value));
      }
    }
    return text;
  };
}

const LANG_KEY = 'omc-lang';

/**
 * The reading language the console falls back to when the stored one cannot be fetched.
 *
 * It is the same language `readInitialLang` picks for an unrecognized stored id, so a console that
 * cannot read its stored preference still lands somewhere deliberate instead of nowhere.
 */
const FALLBACK_LANG: Lang = 'zh';
function readInitialLang(): Lang {
  if (typeof window === 'undefined') return 'zh';
  try {
    const stored = window.localStorage.getItem(LANG_KEY);
    return LANGUAGES.some((language) => language.id === stored) ? (stored as Lang) : 'zh';
  } catch {
    // Storage can be blocked by the browser or a sandboxed frame. The console
    // still has to render its default reading language.
    return 'zh';
  }
}

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: TFunc;
}

const I18nContext = React.createContext<I18nContextValue>({
  lang: 'zh',
  setLang: () => undefined,
  t: makeT('zh'),
});

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [initialLang] = React.useState<Lang>(readInitialLang);
  // Two languages, because a reader's choice and what the console can print are not the same thing
  // while a catalog is on its way. `requestedLang` is what they picked and what gets stored; `lang` is
  // what is rendered, and it is `null` only until the chosen catalog arrives - so the first paint is
  // never a reading language the reader did not ask for.
  const [requestedLang, setRequestedLang] = React.useState<Lang>(initialLang);
  const [lang, setLangState] = React.useState<Lang | null>(() => (isDeferredLanguage(initialLang) ? null : initialLang));
  const languageRequest = React.useRef(0);

  React.useEffect(() => {
    if (!isDeferredLanguage(initialLang)) return;
    let cancelled = false;
    loadCatalog(initialLang).then(
      () => {
        if (!cancelled && languageRequest.current === 0) setLangState(initialLang);
      },
      () => {
        // A stored catalog whose chunk cannot be fetched - a tab older than the deployment serving it
        // is the usual reason - leaves the console in the default reading language rather than blank.
        // That is the whole point: a blank page is a console with nothing on it to act from, and the
        // settings page is where a reader picks a language that is still there. The stored preference
        // is left alone, so the next load returns them to the language they chose.
        if (!cancelled && languageRequest.current === 0) setLangState(FALLBACK_LANG);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [initialLang]);

  const setLang = React.useCallback((next: Lang) => {
    // Every switch invalidates an in-flight one, deferred or not, so a catalog that lands late cannot
    // take the console back to a language the reader has already left.
    const request = languageRequest.current + 1;
    languageRequest.current = request;
    setRequestedLang(next);
    if (!isDeferredLanguage(next)) {
      setLangState(next);
      return;
    }
    // A switch to a language whose catalog has not arrived keeps the current reading until it does. A
    // fetch that fails leaves the console where it was and stores nothing: the browser will not
    // re-fetch the module in this document (see `loadCatalog`), so the language arrives on the next
    // load - which is the reload a tab this stale needs anyway - and never as an unhandled rejection.
    loadCatalog(next).then(
      () => {
        if (languageRequest.current === request) setLangState(next);
      },
      () => undefined,
    );
  }, []);

  const activeLang = lang ?? FALLBACK_LANG;

  React.useEffect(() => {
    if (lang === null) return;
    // The document's own language is what is *rendered* - a fallback is still what a screen reader
    // has to read - while only the reader's own choice is stored. Writing the fallback would replace
    // the preference the next successful load is meant to restore.
    document.documentElement.lang = languageLocale(lang);
    if (lang === requestedLang) {
      try {
        window.localStorage.setItem(LANG_KEY, lang);
      } catch {
        // A blocked storage backend must not break a language switch.
      }
    }
  }, [lang, requestedLang]);

  const value = React.useMemo<I18nContextValue>(
    () => ({
      lang: activeLang,
      setLang,
      t: makeT(activeLang),
    }),
    [activeLang, setLang],
  );

  return lang === null ? null : <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nContextValue {
  return React.useContext(I18nContext);
}

export function useT(): TFunc {
  return React.useContext(I18nContext).t;
}
