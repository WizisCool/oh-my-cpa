# ADR 0007: The KPI readouts roll, a scoped exception to the motion budget

- Status: Accepted
- Date: 2026-09-17

## Context

**The dashboard's six KPI numbers are the console's most-read readings, and they change under a poll
the reader did not ask for.** `/management/dashboard` answers a sliding window and is refetched on a
tail poll paced to the served resolution — floored at five seconds, capped at two minutes. The
six tiles are also the only place in the console where a *value* is the whole content of the element
that carries it: a request total that goes from 1,600 to 1,614 repaints a number of identical width in
an identical box, and nothing distinguishes "this reading moved" from "this is what it always said".

`docs/design.md` §7 forbids exactly that kind of motion. Its motion table caps every token at `base`
(100ms/0.1s) except `fast` and `float`, its rule 5 states that charts do not animate because "a line
snapping to new data reads as honest", and its "Never hard-swap a view" table states that an
auto-refresh poll moves nothing. The philosophy behind all three is stated in the same section: "The
interface is deliberately raw and terminal-like. Motion exists only to make state changes feel
continuous and **hand-following** — never to impress." `DESIGN.md` states the same budget as a brand
characteristic: ≤ 100ms, zero spring physics.

A rolling number is not hand-following: the reader is not the one changing the value, the clock is.
Taking it therefore needs an explicit, bounded exception rather than a quiet widening of the rule, and
the exception has to answer four questions the rule exists to protect: does it animate compositor-only
properties, does it keep the animated area tiny, does it survive `prefers-reduced-motion`, and does it
leave rule 5 (chart ink does not animate) intact?

Two smaller questions also had to be settled before the motion could be allowed at all.

**Who owns the number's text?** `web/src/types/tokenDisplay.ts` is documented as the one layer every
user-facing token number goes through, and it supports three unit styles — international compact
(`300M`, `1.2B`), the Chinese scale (`30万`, `1.2亿`) and a language-neutral grouped form. The Chinese
scale is not expressible as `Intl.NumberFormat` options, so a number-animation library that formats
from its own `format` prop (supported options include `notation: 'compact'`) could only reproduce two
of the three styles. Reformatting the tiles through the library would have been a second formatting
authority beside the shared one — precisely the defect the layer exists to prevent.

**What happens when the unit changes?** `en-compact` and `zh` both print a different unit word at a
different magnitude. A readout that swept between them would roll `1.2` into `900` while the unit word
swapped from `B` to `M` underneath the digits, so the moving digits never described the window at any
instant except the last.

## Decision

1. **The exception is granted to the six KPI readouts and nothing else.** No other surface takes
   `roll`, and §7 rule 8 names the scope. Chart ink, list rows, ledger totals and the model panels are
   unchanged: rule 5 still holds and the sparkline drawn under a rolling tile still snaps.

2. **The sweep is `roll`: 240ms on the console's existing `cubic-bezier(0.2, 0, 0, 1)`.** It is
   longer than `base` because a 100ms digit move is indistinguishable from a redraw — the reader has
   to see *which* digit changed for the motion to explain anything — and it stays far below the point
   where waiting for a footer number becomes work. Glyph presence (a digit entering or leaving the
   number) stays on the `base` token, so an arriving `,000` does not trail the sweep that explains it.
   `opacity` and `transform` only, inside a 34px-tall box: rules 1 and 2 are untouched.

3. **The animated text is derived from the formatter that already prints it.** Each readout is split
   out of the owning formatter's own parts (`Intl.NumberFormat.formatToParts` for the compact, plain
   and grouped forms; the shared `万`/`亿` step table for the Chinese scale), so the number the library
   animates and the number the tile prints cannot disagree. A logic suite asserts the equivalence over
   every style and a spread of magnitudes, including the boundaries where a second rounding rule would
   diverge.

4. **A change of unit word prints in place.** The readout carries its unit word separately from its
   number, and the frame where that word changes is not animated. The next same-unit change sweeps
   normally. This is what keeps a legend-scale change from being drawn as a magnitude change.

5. **`prefers-reduced-motion` reaches the readout.** The library's own respect for the user preference
   is left enabled, so a reader who asked for reduced motion gets the new value with no travel. §7's
   override applies to the exception exactly as it applies to everything else.

6. **A missing reading is still a dash.** A null rate or count prints the console's shared em dash and
   does not animate from or to a number, because "nothing measured" is not a very small number.

7. **The readout's exact value stays reachable.** The tile keeps `title` with the exact grouped count,
   and the readout publishes the formatted value as its accessible name, so an abbreviated digits run
   is never the only way to read the number.

## Consequences

### Positive

- A poll that changes a KPI now says so. The dashboard is read at a glance and the tiles are the
  glance; before this, a refetch that moved the request total by fourteen was invisible.
- The exception is one 240ms transform of glyphs in six small boxes, so it costs no layout, no
  repaint of the page and no frames outside the tile it belongs to.
- Formatting stays in one place. The tiles gained an animation without gaining a second rounding rule,
  and the equivalence is pinned by a test rather than by review.
- The reduced-motion contract is enforced on the new surface too, and the browser scenario asserts
  both halves: the sweep with motion allowed, its absence with motion refused.

### Trade-offs

- **§7's motion budget is no longer absolute.** A reader of the token table now has to notice the
  `roll` line and its scope, and "≤ 100ms" is a rule with one named hole rather than a rule. That is
  the price of changing a documented constraint instead of violating it quietly.
- **The dashboard may move on every poll.** With a five-second tail poll on a sliding window, a busy
  deployment can roll a tile every five seconds. The mitigation is scoped rather than absolute: 240ms
  of glyph movement, and nothing else on the page moves.
- **The tiles' DOM is now a custom element with a shadow root.** `innerText` on a tile value is empty,
  so anything reading the number back must go through the accessibility tree; the probes and the
  acceptance scenario do, and the older `innerText` assertions were replaced rather than kept.
- **A new frontend dependency and a new shadow root in the dashboard route.** It rides in the
  dashboard's lazily loaded chunk rather than the entry, and the bundle budget still passes.
- **Divergence between the readout's unit word and a library-chosen one is impossible by construction,
  but only for the forms the readout can express.** Scientific and engineering notation are outside
  the readout's type for the same reason the animation runtime cannot draw them.

## Alternatives considered

- **Widen the `base` token to cover the sweep.** Rejected on reading: at 100ms the digits are a blur
  that looks like a repaint, which is the state the motion is meant to distinguish itself from. The
  budget is a token list, not a single number, so the exception can be named rather than absorbed.
- **Let the library format the numbers (`format={{ notation: 'compact' }}`) and drop the shared
  layer's unit words.** Rejected: it would delete the `zh` scale and the `full` style from the
  console's loudest readout, and would put a second formatting authority next to the one the project
  documents as authoritative. The readout is derived from the formatter instead.
- **Animate the whole tile (fade the card, slide the value in).** Rejected by §7 rules 1 and 2:
  fading a grid cell composites more than the number, and a value that flies in re-enters the
  entrance-animation aesthetic `DESIGN.md` repudiates.
- **Count up from zero on first paint.** Rejected: it invents readings that were never measured, and
  on a window that is already loaded it would animate a number the API never returned.
- **Roll the model-panel and heatmap readouts too.** Rejected: the panels' numbers sit beside marks
  that §7 rule 5 holds still, so motion there would separate a value from the chart that explains it.
- **Roll on user-driven changes only (window preset, manual refresh), never on a poll.** The more
  conservative reading of §7, and it was the first proposal. Rejected because the poll is exactly when
  a reader needs the signal: a manual refresh is a reader who is already looking at the number, while a
  poll is one who is looking away. The bounded scope (six glyph runs, `transform`-only, unit changes
  frozen, reduced motion honoured) is what makes the wider trigger defensible.
- **A `@react-spring`-style spring or an odometer we write ourselves.** Rejected: a spring is the
  bounce `DESIGN.md` forbids, and a hand-written odometer is a digit-layout implementation to maintain
  for one surface — including the mask, the measurement and the reduced-motion handling the library
  already ships.
