# Translating the console

The console's copy lives in `web/src/i18n/locales/`, one file per product area per language.
Adding or changing a sentence is a text edit in four files — no TypeScript knowledge and no build
step beyond the checks below.

```
locales/
  zh/<area>.ts        the source: its ids are the message ids
  en/<area>.ts        typed against zh/<area>.ts
  zh-Hant/<area>.ts   typed against zh/<area>.ts
  ms/<area>.ts        typed against zh/<area>.ts
```

## Changing a sentence

1. Find the id. `grep -rn "the sentence" web/src/i18n/locales/zh` names the file and the id, and
   `grep -rn "id.you.found" web/src --include=*.tsx` shows where it is rendered.
2. Edit the value in all four language files of that area, keeping the id.
3. Run `pnpm check-i18n`.

What the gate decides without a reader: every language defines every id, no id is defined twice,
placeholders match the source, braces and ICU plural forms are well formed, a Chinese catalog
contains no character from the other script, every id is referenced by some source file, every
registered Agent capability has copy, and the spellings `GLOSSARY.md` has settled are the ones in
use. What it cannot decide is whether a sentence reads well — that is `STYLE.md` and a reviewer.

## Adding a sentence

1. Add the id and the Simplified Chinese sentence to the area file that holds its siblings — a
   prefix can span files (`af.*` lives in `authFiles.ts`, `pg.*` in `agent.ts`), so place an id
   beside the ones it belongs with rather than guessing from its prefix.
2. Add the same id to the same area file under `en/`, `zh-Hant/` and `ms/`.
3. Run `pnpm check-i18n` and `pnpm type-check`. The three translations are typed against the source
   file (`satisfies Translation<typeof source>`), so a missing id is a compile error at the file
   where it is missing.
4. Write it where it is rendered with `t('your.id')`. The key is a `MessageKey`, so a typo does not
   compile.

## Translating a language you are not a native reader of

Say so. A translation contributed without a native review is welcome and useful, but the pull
request must not claim the review happened: mark the sentences that need one in the description,
and if a term is uncertain add it to the "Under review" table in `GLOSSARY.md` rather than picking a
word silently. Copy that is machine-drafted and committed as reviewed is worse than copy that says
it is open: the next reader has no way to find it.

## Copy chosen at runtime

Not every id is a literal. A server reports a category, a permission class, a warmup reason, and
the console has a sentence for the ones it knows:

- `prefixedKey('audit.cat.', category)` and `messageKey(id)` answer a `MessageKey` or `undefined`;
- `translateOr(t, id, fallback)` renders the fallback when the console has no sentence.

A new value the server starts reporting therefore needs a new catalog entry under the same prefix,
and until then it reads as itself rather than as a lookup key. `AGENT_CAPABILITIES`-style
completeness — a reference list the server publishes — is checked by `pnpm check-i18n` for Agent
capabilities; other families are not, so adding the sentence is part of the server change.

## Adding a language

1. Add a row to `web/src/i18n/language.ts`. The registry is the only place a language is listed;
   the compiler then names what else must learn about it.
2. Add its catalog under `locales/<id>/`, one file per source area, each typed against `zh/`.
3. Add the antd locale and the deferral decision to `resources.ts` if the language's catalog should
   not be part of the first paint (see `CATALOGS`, and `web/vite.config.ts` for the chunk name the
   acceptance probe looks for).
4. Add the language's `Intl` locale to `LANGUAGES`; dates and numbers follow it.

## Files

| File | What it holds |
| --- | --- |
| `catalog.ts` | `MessageKey`, `Catalog`, `Translation`, `TFunc`, and the helpers that answer a key or `undefined` |
| `format.ts` | Placeholder filling and ICU plural selection, in the reading language's rules |
| `language.ts` | The registry: id, endonym, glyph, flag, `Intl` locale |
| `resources.ts` | Which catalog and antd locale each language loads, and whether it is deferred |
| `index.tsx` | The provider, the translator, and the `hasMessage`/`messageKey`/`translateOr` helpers |
| `GLOSSARY.md` | The word for each concept, and the variants the gate refuses |
| `STYLE.md` | How a sentence reads |
