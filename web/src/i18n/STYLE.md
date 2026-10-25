# Localization style guide

OMC is a console for people who run an AI gateway: developers and operators who know what an API
key is, reading in a hurry. Every language is a first-class reading of the same product. Write the
sentence a careful local engineer would write for that screen; never translate the Simplified
Chinese or English word by word.

Terms come from the [glossary](GLOSSARY.md). This page covers everything else.

## All languages

- **Say what happened and what to do next.** An error names the failed action and, when there is
  one, the next step: "Could not save the key alias. Your edit is kept so you can retry." Do not
  apologize, blame the reader, or print an exclamation mark.
- **Keep labels short and sentences complete.** Buttons, menu items, column headers and tabs are
  a verb or a noun phrase with no final punctuation. Descriptions, hints and toasts are full
  sentences. When a target language needs more words, shorten the label by choosing a more
  precise word, not by abbreviating or dropping meaning; the layout is built to wrap.
- **Same detail in every language.** A translation may reorder or restructure a sentence, but
  it must not drop a condition, a unit, a version number or a warning the source carries.
- **Placeholders are code.** `{name}` is replaced at runtime: keep every placeholder the source
  has, spelled exactly the same, and add none. Their order may change. `pnpm check-i18n` fails
  on any mismatch.
- **Counts use the plural form.** A sentence that contains a count of things whose noun changes
  with number uses ICU plural syntax: `{n, plural, one {# request} other {# requests}}`. `#` is the
  number, grouped for the reading language. Languages without grammatical plural (Chinese, Malay)
  write the plain sentence: `{n} 个请求`, `{n} permintaan`.
- **Numbers, dates and units** are formatted by code, never written into copy. Digits group with a
  comma in every reading language. Units keep their symbols (`ms`, `KiB`, `%`, `×`) with a space
  after the number except `%` and `×`.
- **Identifiers stay verbatim**: configuration keys, YAML values, headers, paths, environment
  variables, model IDs and product names (see the glossary's last section). Put a configuration
  key in parentheses after its translated label only when the reader needs it to find the key in
  YAML: `默认规则 (default)`.
- **No HTML, no Markdown**, except where a key's source already uses it.

## Simplified Chinese (`zh`)

- Address the reader as 你, never 您; the console's voice is direct and collegial.
- Full-width punctuation for Chinese text (，。：；？！（）), “” for quotation, half-width
  punctuation inside code and between Latin words.
- One space between Chinese characters and Latin letters or digits: `5 小时额度`, `API 密钥`,
  `CPA v8`. No space before or after full-width punctuation.
- Measure words are required with counts: `{n} 个凭据`, `{n} 条规则`, `{n} 次请求`.
- No English glosses after a Chinese label (`优先级`, not `优先级 (Priority)`); a configuration
  key in parentheses is the exception above.
- Errors: 无法…／…失败：{msg}. Confirmations ask a direct question: 删除此凭据？

## Traditional Chinese (`zh-Hant`, Hong Kong)

- Hong Kong vocabulary throughout: 軟件, 網絡, 用戶, 帳戶, 密鑰, 項目, 插件, 網關, 審計, 地址, 優化,
  按 (by). Do not mix in Taiwan forms such as 軟體, 網路, 使用者, 帳號, 金鑰, 專案, 外掛, 閘道, 稽核,
  位址, 最佳化 or 依. The glossary records where a Hong Kong choice rests on mixed evidence rather
  than a published standard - 密鑰 is one - and those entries carry the `review` mark: keep the
  catalog consistent with the choice, and read the entry before rewording it.
- Not a character conversion of `zh`: check every phrase that differs between regions (刷新 →
  重新整理, 默认 → 預設, 信息 → 資訊, 文件 → 檔案, 设置 → 設定, 保存 → 儲存).
- Punctuation and spacing follow the Simplified Chinese rules, with 「」 for quotation.
- Register: 你; plain written Chinese, never Cantonese colloquial forms (嘅, 唔, 咗).

## English (`en`)

- Sentence case everywhere: "Request records", "Add provider", "Check for updates". Capitalize
  only the first word, proper nouns, product names and acronyms.
- Plain US spelling (behavior, color, canceled), serial comma optional but consistent within a
  string, no contractions in errors ("Could not", "is not").
- Errors start "Could not …" or state the condition ("The name may be at most 80 characters").
  No "Please", "Successfully", "Failed to".
- Buttons are imperative verbs ("Save fields", "Clear cooldown"); toasts are past tense
  ("Icon saved", "Added 3 models").

## Malay (`ms`)

- Malaysian Malay (Bahasa Melayu), formal register, address the reader as "anda" (never "awak"
  or "kamu").
- Sentence case, as in English.
- Numbers precede the noun and the noun does not repeat for plural: `{n} kelayakan dilumpuhkan`,
  not `Melumpuhkan kelayakan {n}`.
- Prefer established Malaysian computing terms (muat naik, muat turun, muat semula, tetapan,
  pemalam, log masuk) over English loanwords; keep the English term only when no Malay term is in
  common developer use (cache, token, bootstrap) or when it is an identifier.
- Errors: "Gagal …" or "Tidak dapat …"; confirmations: "Padam kelayakan ini?"

## UI fit

Copy is written for the reader, and layout adapts to copy — not the other way round:

- Do not shorten a translation to fit a width measured in another language. If a label does not
  fit at 375 px, report the layout problem; components wrap, grow, or move the label to a tooltip
  only where that is the design for every language.
- Never use an ellipsis that hides what an action does. A truncated value (an ID, a path) must
  still have its full text in a tooltip or accessible name.
- An accessible name (`aria-label`) is a sentence fragment in the reading language, like any
  visible label.
