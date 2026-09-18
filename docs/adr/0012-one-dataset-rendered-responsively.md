# ADR 0012: A list is one dataset rendered responsively, not an operator-facing view switch

- Status: Accepted
- Date: 2026-09-19

## Context

`docs/design.md` §7 and `DESIGN.md`'s Open List Rule both said: *"One table serves every viewport
width — it scrolls sideways on narrow screens instead of becoming a second layout."* That sentence was
written in `b9cf688`, in the change that removed the key-management page's **table/card view toggle**
and with it the narrow-screen card layout and its stylesheet. The reasoning recorded there was sound
and is still sound: two views of one dataset cost two descriptions of it, the operator has to find the
switch, and the removed toggle had already produced a status column and a rename modal that could
disagree with the table beside them.

What was never measured was the cost of the sentence in its place. On a phone it is this, from a
390×844 audit of the built console:

| Surface | Inner scroller at a 316px card | Consequence |
| --- | --- | --- |
| Key management | 316 → 980px | the reveal, copy and edit controls — which §2 requires to be "in the open" because a secret behind a menu sits one click further — were 664px further |
| AI providers | 316 → 1081px | the protocol tag was clipped mid-word ("Codex (Res"), which reads as broken text |
| Plugins | 316 → 537px | the name column crushed to one character per line |
| Pricing | columns crushed | the 价格 / 倍率 header rendered one character per line |

and, on the same measurement, none of those scrollers carried any affordance that it *was* a scroller:
`hasFadeOrHint: false`, and `scrollbar-width: thin` is invisible on a touch device. A rule that made
every list page scroll sideways had also removed the only thing that said so.

So the sentence was doing what it said — refusing a second layout — at a cost it had not priced.

## Decision

**The rule is revised from "one table, scrolled sideways" to "one dataset, rendered responsively".**

A list surface now renders as a table on a pointer-fine viewport and as labelled rows below **640px**.
The change is made by *width*, never by a control the operator has to find, and the two renderings are
derived from one description of the record:

- The columns stay the single description of what a record shows — their order, their titles and their
  own render functions. `phoneRowFields` turns them into the row's labels and values, so a column
  added to the table reaches the row, and a value cannot be formatted two ways.
- The dataset, the filters, the URL, the actions, the empty states and the counts are one
  implementation. Nothing about *what* is listed, or what selecting it means, differs by width.
- There is no toggle, no preference and no remembered mode. An operator cannot put the console into a
  phone arrangement on a desktop, or the reverse.

What `b9cf688` rejected does not come back: there is no status column, no rename modal, no
independently-styled card vocabulary, and no second place for a field list to live.

## Consequences

- **The narrow-screen table's touch affordances are freed up.** A row stops being a 4px-gap cluster of
  28px controls, which is the cluster the touch rules had to accept overlapping hit areas for; the
  actions get a line of their own.
- **The 640px breakpoint is now load-bearing for layout, not only for size.** It joins 900px (the
  shell changes shape) and the request list's `920px` container query (that list's own width no longer
  fits its columns), and the three are documented together in `docs/design.md` §8. A fourth number
  needs a reason stated beside it.
- **Every list surface now has two renderings to keep honest**, which is the real cost and the reason
  for the derivation rather than a second hand-written field list. `scripts/test-phone-rows.ts` pins
  the derivation's silent-omission property: a column that is addressable and not explicitly skipped
  becomes a field.
- **`docs/design.md` §7, `DESIGN.md` and the key list's own comment are amended in the same change**,
  because the old sentence is quoted in all three.
- The table remains for wide viewports, and the sideways scroll inside its card remains the console's
  convention *there* — where a pointer can drag it and a scrollbar is visible.

## Alternatives considered

**Keep one table and make the sideways scroll usable** — a sticky identity column, a sticky action
column, an edge fade and no resize handle on touch. This preserves the sentence exactly, and it was the
cheaper option. It was rejected because the measurements above are not about the scroll being hard to
perform but about the controls being *off the screen*: pinning two columns of a 980px table into 316px
leaves the middle unusable, and the key list would still need one scroll before a secret could be
revealed.

**A read-only summary on phones** — the cheapest and the least useful: an operator on a phone is
usually there precisely to act, which is why the console is reachable at all.

**Reinstate the table/card toggle** — rejected for the reasons `b9cf688` recorded, which this ADR
endorses rather than overturns: an operator-facing choice between two views is a second description of
the dataset, and the operator has to know it exists.
