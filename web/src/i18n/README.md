# Translating Oh My CPA

Every word of the console's interface lives in this directory, one file per product area per
language. Fixing a translation means editing one line of one file; you do not need to know React
or Go to do it.

Read [STYLE.md](STYLE.md) (how each language is written) and [GLOSSARY.md](GLOSSARY.md) (which
word each concept uses) before you change wording. They are short, and following them is what
keeps the console reading as one product.

## Where things are

```text
web/src/i18n/
├── locales/
│   ├── zh/          Simplified Chinese — the source: it defines every message id
│   │   ├── index.ts     joins the area files into one catalog
│   │   ├── shell.ts     navigation, header, sign-in, shared buttons
│   │   ├── agent.ts     Agent and Playground
│   │   ├── config.ts    CPA configuration
│   │   └── …            one file per product area
│   ├── zh-Hant/     Traditional Chinese (Hong Kong) — the same files, the same ids
│   ├── en/          English
│   └── ms/          Malay
├── language.ts      the registry: which languages the switcher offers
├── resources.ts     where each language's catalog and Ant Design locale come from
├── catalog.ts       the types that keep every language complete
├── format.ts        placeholder and plural formatting
└── index.tsx        the runtime: language state, switching, `t()`
```

Each area file is a list of message ids and their sentences:

```ts
// locales/ms/models.ts
export default {
  …
  'models.clear_filters': 'Kosongkan penapis',
  …
  'models.search': 'Cari model atau pengeluar',
} satisfies Translation<typeof source>;
```

Files of the same name hold the same ids in the same order in every language, so a message sits
on the same line of `locales/en/models.ts` and `locales/ms/models.ts`. To find a
sentence you see on screen, search for it in the language you are reading:

```bash
git grep -n "Kosongkan penapis" web/src/i18n/locales
```

## Change an existing translation

1. Find the line (above) and edit the text between the quotes. Keep the id and every
   `{placeholder}` exactly as they are; a `'` inside the text is written `\'`.
2. Run the check: `pnpm check-i18n`.
3. Preview it (below) if the change is longer or shorter than before.

## Add copy for a new piece of UI

New copy always arrives in all four languages in the same change.

1. Pick the area file whose prefix matches the screen (`models.*` lives in `models.ts`) and add
   the id to `locales/zh/<area>.ts` with its Simplified Chinese sentence. Ids are
   `area.what_it_is`, lower case: `models.copy_named`, not the sentence itself.
2. Add the same id at the same position to `locales/en/`, `locales/zh-Hant/` and `locales/ms/`.
   TypeScript reports any language you missed: `pnpm --dir web type-check`.
3. Use it in code with `t('models.copy_named', { model })`. `t` only accepts ids that exist, so
   a typo is a compile error.

Counts that change a noun use the plural form in languages that have one:

```ts
// zh
'models.source_count': '{count} 个来源',
// en
'models.source_count': '{count, plural, one {# connection} other {# connections}}',
```

An id built from a server value (`audit.action.${action}`) cannot be checked by the compiler; look
it up with `translateOr(t, key, fallback)` so a value the console has no sentence for reads as
itself rather than as an id.

## Add a language or a regional variant

The example adds Indonesian (`id`); a variant such as Hong Kong versus Taiwan Traditional Chinese
is added the same way, as its own language with its own id.

1. **Copy a catalog.** Copy the language you will translate from:
   `cp -r web/src/i18n/locales/en web/src/i18n/locales/id`. Translate every file. Leave nothing in
   the source language: a reader must never meet a sentence in a language they did not choose.
2. **Register it.** Add a row to `LANGUAGES` in `language.ts`:
   `{ id: 'id', name: 'Bahasa Indonesia', code: 'ID', country: 'ID', locale: 'id-ID' }`.
   `name` is the language's own name in its own script; `code` is the two glyphs shown on the
   header button; `locale` is the BCP 47 tag used for dates and numbers.
3. **Load it.** In `resources.ts`, add the catalog to `CATALOGS` as a lazy import
   (`id: () => import('./locales/id').then((module) => module.default)`) and Ant Design's locale to
   `ANTD_LOCALES` (`import idID from 'antd/locale/id_ID'`). The list of Ant Design locales is in
   `web/node_modules/antd/es/locale/`.
4. **Draw its flag.** Import the country's flag in
   `web/src/components/common/LanguageFlag.tsx` and add it to `FLAG_MARKUP`.
5. Run `pnpm --dir web type-check` and `pnpm check-i18n`. The compiler names every place step 2
   requires, and the check fails until the registry, the directory and the flag agree.

The language then appears in the header's language menu and on the OMC settings page.

## Preview in the browser

The console's demonstration mode serves sample data without a CLIProxyAPI, which is enough to look
at every page. It needs Go and Node.js with pnpm (see [CONTRIBUTING.md](../../../CONTRIBUTING.md)):

```bash
pnpm install
pnpm build
OMCPA_DEMO_MODE=true OMCPA_BASE_PATH=/omc pnpm dev
```

Open `http://127.0.0.1:5173/omc/`, choose the language from the header's language menu, and
edits to the catalogs appear as you save. Check the screens you changed at a desktop width and
at phone width (375 px, the browser's device toolbar), in both the light and the dark theme.

## Check and submit

```bash
pnpm check-i18n            # every language complete, placeholders and plurals intact
pnpm --dir web type-check  # ids used in code exist
pnpm check-i18n --report   # optional: entries identical to the language they were copied from
```

`pnpm check-i18n` checks structure only: missing or stale ids, placeholders, plural and brace
well-formedness, the language registry, unused ids and Chinese text hardcoded outside the catalogs.
It does not look for English text hardcoded in a component, and it cannot tell whether a sentence
reads naturally - both are for people, which is what review is for.

One build detail is worth knowing when you edit English: production builds carry the English
sentences as values aligned with the source catalog's ids rather than as a second copy of every id
(`scripts/compact-locales.mjs`, and `scripts/test-compact-locales.ts` when you change it). You edit
the ordinary typed files either way; nothing about the authoring format changes.

Open a pull request against `main` describing which language and screens you changed. If you are
a native speaker reviewing a term the glossary marks **review**, say so in the pull request; that
confirmation is what moves it to **settled**.
