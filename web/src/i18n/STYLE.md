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

## Subtitles, hints, and secondary copy (Captions)

Secondary copy (form field hints, card subtitles, section descriptions, table footers) exists to help
the operator act with clarity and confidence. It is a visual whisper that supports the interface,
not a legal disclaimer, an architecture manual, or an agent safety cushion.

### Invariants for secondary copy

1. **User necessity over agent defense.** State what the field does, what format it accepts, or what
   its immediate effect is. Never write defensive disclaimers ("并非解除所有限制", "请谨慎操作以免造成不可挽回的损失"),
   passive-aggressive warnings, or historical gateway version lectures ("此优先级要求 CPA v8.0.33 或更高版本；依赖凭据覆盖前请先升级旧网关").
   If an old gateway version is incompatible, enforce that via API/feature detection or graceful validation,
   not by lecturing the user in the caption.
2. **Concise precision on real gotchas.** When a real hazard or subtle rule exists (e.g. data deletion,
   precedence overriding an upstream wildcard, restart required), state it in a single, calm sentence.
   Do not explain the theoretical philosophy behind why the system was designed this way.
3. **Typographic budget & visual rhythm.**
   - A hint should typically be 1 concise sentence (maximum 2 short sentences).
   - Chinese copy should generally not exceed 40–50 characters.
   - Secondary copy must never dominate the vertical height or draw more visual attention than the control itself.
4. **No negative preemption.** Do not write what something is *not* unless users regularly mistake it
   for something destructive (e.g. "清空列表将恢复继承当前提供商规则" is complete and clean; adding "并非解除所有限制"
   is redundant defensive clutter).

### Bad vs Good Examples

- **Bad (Defensive & bloated):**
  > 以逗号或换行分隔模型 ID。非空列表会替代提供商禁用规则（包括 *）。清空列表将恢复继承当前提供商规则，并非解除所有限制。此优先级要求 CPA v8.0.33 或更高版本；依赖凭据覆盖前请先升级旧网关。
- **Good (Direct & actionable):**
  > 以逗号或换行分隔模型 ID；非空列表会替代提供商禁用规则（包括 *），清空列表将恢复继承当前提供商规则。

- **Bad (Anxious disclaimers):**
  > 注意：此操作具有较高风险，可能导致已有的鉴权配置失效并影响线上业务，请确保已做好配置备份后再行修改。
- **Good (Calm statement of consequence):**
  > 修改后立即生效，现有连接将使用新配置重新鉴权。

