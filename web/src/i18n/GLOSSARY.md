# Glossary

One word per concept, per language. The console's copy is read by operators who compare two
windows side by side, so a concept that changes its name between two screens reads as two
different things: "供应商" here and "提供商" there is a support question, not a style preference.

This file is also executable. A row under **Enforced** names the variant the catalogs must not use,
and `pnpm check-i18n` fails on any occurrence of it — including one inside a longer sentence.
Rows under **Under review** record a split this project has no native reader to settle; the gate
does not enforce them, and a translator who settles one moves it up.

## Enforced

| Language | Concept | Use | Not | Why |
| --- | --- | --- | --- | --- |
| `zh` | provider | 提供商 | 供应商 | The catalog's own count before this table existed: 101 against 7. |
| `zh-Hant` | provider | 供應商 | 提供商 | Hong Kong usage, and the catalog's majority: 62 against 42. |
| `zh-Hant` | credential | 憑證 | 憑據 | The majority: 147 against 35. 憑據 is understood but reads as a document, not as an access credential. |
| `zh-Hant` | key | 金鑰 | 密鑰 | The catalog's majority: 136 against 1. Hong Kong sources split the two, so the catalog's own usage decides. |
| `ms` | provider | penyedia | pembekal | The majority: 73 against 30. `pembekal` is the ordinary word for a shop's supplier and reads oddly for an API upstream. |

The machine-readable half of the table is the `glossary-enforced` block at the end of this file. A
row here without a line there is a row the gate does not check.

## Under review

| Language | Concept | In use | Question |
| --- | --- | --- | --- |
| `zh` | credential | 凭据 (103), 凭证 (79) | Both are correct Mandarin. Settling it moves ~80 strings, so it needs a reader who can judge the surrounding sentences, not a count. |
| `zh` | channel | 渠道 (19), 通道 (2) | 渠道 is the majority; 通道 may be deliberate where the line is a transport rather than a reseller. |
| `zh-Hant` | channel | 渠道 (10), 通道 (10) | An even split. Hong Kong usage prefers 渠道 for a reseller and 通道 for a physical path, which is the distinction the copy is already making inconsistently. |
| `ms` | credential | kelayakan (99), kredensial (46) | `kelayakan` ("eligibility") reads better in prose; `kredensial` is the direct borrowing. A native reader decides. |
| `zh` / `zh-Hant` | token | 令牌 (9) / 權杖 (7) | Only a handful of strings; the rest of the console names the unit rather than the token. |

## Terms this console keeps in English

Product names (Devin, Claude Code, Codex, OpenRouter), protocol names (OAuth, SSE, MCP, Base URL),
units the operator reads as units (`ms`, `TPS`, `RPM`), and the `stdio` transport are written the
same way in every catalog. They are proper nouns, not untranslated copy, and `pnpm check-i18n`
does not report them.

## Numbers, dates and placeholders

Placeholders (`{n}`, `{count}`) keep their name and their count across languages; ICU plural
branches are per language, and a language without plural inflection keeps a single `other`. A
catalog sentence holds words, not digits: dates and times are formatted through `Intl` with the
reading language's locale.

Numbers are the deliberate exception. Grouping and compact suffixes (`1,234`, `12.3K`) come from
`Intl.NumberFormat('en')` in every language, including the ones that write Chinese numerals, because
a separator that changes between two catalogs makes two tables disagree about the same column, and
the reading an operator compares is built from digits. `web/src/types/tokenDisplay.ts` is where that
formatting lives; the Chinese `亿`/`万` steps it uses above ten thousand are part of the same
formatter, not of a catalog.

## Enforced spellings, for the gate

```glossary-enforced
zh	供应商	提供商
zh-Hant	提供商	供應商
zh-Hant	憑據	憑證
zh-Hant	密鑰	金鑰
ms	pembekal	penyedia
```
