# Style

How a sentence in a catalog reads. These rules describe the copy that is already there, so a
reviewer can tell a mistake from a choice — and so a new sentence looks like the ones beside it.

## Voice

Second person, addressed to the operator who runs the deployment. The console says what a screen
does and what a control changes; it does not congratulate, apologise, or explain itself.

- `en`: sentence case, no trailing period in a label, tooltip or button; a full sentence that
  explains a consequence keeps its period.
- `zh`: full-width punctuation (`，。：；`), a space between a Chinese sentence and an inline Latin
  word or number is not inserted — the font handles the gap.
- `zh-Hant`: the same, written in Hong Kong Traditional Chinese (軟件, 網絡, 帳戶, 金鑰). See
  `GLOSSARY.md` for the terms.
- `ms`: sentence case, Latin punctuation, and the standard Malaysian spelling (the catalog writes
  `tetapan`, not `setelan`).

## What a sentence may contain

- **A placeholder, a unit, or a proper noun.** Nothing else that is not words: an id, a JSON field
  name, or a raw HTTP status in the middle of a sentence belongs in a code span beside it, not in
  the sentence.
- **The same placeholders as the source sentence, exactly once each.** `pnpm check-i18n` compares
  the sets; a translation that drops `{n}` silently loses the number.
- **An ICU plural only where the language inflects.** English and Malay take `one`/`other`; Chinese
  takes `other` alone, because it has no plural form. Every plural keeps `other`.
- **No leading or trailing whitespace**, and no double space. The layout owns spacing.

## Names of things

A surface is named once and keeps that name: the same word for the page title, the menu entry, the
breadcrumb and the empty state. `GLOSSARY.md` is where the name for a concept is decided; this file
is only about how a sentence around it is written.

## Errors

An error sentence says what happened and, where the operator can act, what to do. It never shows a
stack, an exception type, or an upstream's English body as the sentence — those are quoted
underneath, in a code frame. A refused action names the rule it broke:

> 该备份来自更早的版本，无法直接恢复。

rather than "操作失败".

## Length

A label has one line. When a sentence does not fit in a control, the answer is a shorter sentence,
not a wider control: the mobile console renders the same catalog. A tooltip may hold the longer
explanation, and that is where a caveat belongs.
