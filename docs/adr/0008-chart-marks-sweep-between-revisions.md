# ADR 0008: Chart marks sweep between revisions, reversing §7 rule 5

- Status: Accepted
- Date: 2026-09-17

## Context

`docs/design.md` §7 rule 5 read **"Charts do not animate. Sparkline geometry swaps on the data revision
with no transition or entrance animation; a line snapping to new data reads as honest, not janky."**
Three components enforced it by passing `animate: false` to the library, and the surrounding prose
explained the intent as a preference for honesty over flourish - the same instinct as `DESIGN.md`'s
"raw and terminal-like" character and its rejection of artificial entrance animations.

Two things then changed, and only one of them was a taste change.

**The tiles above the marks now roll.** ADR 0007 granted the six dashboard KPI numbers a 240ms sweep,
which satisfies §7's own test for motion - a state change that has to feel continuous - but it left the
dashboard inconsistent with itself: the number said "this reading moved" while the plot drawn from that
same number hard-cut, so one revision read as two different events, one of them a
replacement.

**Measured, the library's behaviour is not what "animate" implies.** `@ant-design/plots`' React wrapper
does not destroy and rebuild a chart when its props change: `useChart` builds the options object, then
calls `Plot.update()` followed by `Plot.render()` on the *same* G2 runtime - it never calls `changeData`
and never remounts. So an enabled `update` animation interpolates the mark the reader is already looking
at. It is a morph, not a redraw, and a drawing-in entrance is not what turning it on would cost. That
distinction is the whole decision, because "a repaint dressed as new data" was the thing rule 5 was
protecting against.

The measurement, on the requests sparkline with one bucket moved and both settings otherwise identical:

| `animate` | Frames painted across a revision | Shape |
| --- | --- | --- |
| `false` (rule 5 as written) | 2 | the old reading, then the new one |
| `update: { type: 'morphing' }` on the roll token | 11-12, including intermediates | a sweep between them |

Two facts about this data had to be established before the change was worth making, because both were
surprises that a plausible-looking demo would have hidden:

- **A uniform level change is invisible with or without animation.** The sparkline has no axis and its
  y domain is normalized to the window's own maximum (`scale.y.nice: false`, `domainMin: 0`), so scaling
  every bucket by the same factor repaints the canvas *pixel for pixel* - measured, not inferred. These
  are shape charts: the animation is visible on a change of composition, and a quiet window that simply
  gets busier moves nothing.
- **Neither `@antv/g2` nor `@ant-design/plots` reads `prefers-reduced-motion` anywhere**, and the
  library's default update animation is a 900ms spring. A chart that enabled animation without its own
  reduced-motion switch would move hardest for the reader who asked for none.

## Decision

1. **Rule 5 is rewritten rather than deleted.** A mark morphs to its new geometry over `roll`, and fades
   rather than grows when a series enters or leaves (content appears; it does not fly, and a mark growing
   in from an axis claims a direction the data does not have). The entering/exiting case is a fade for
   exactly the reason `DESIGN.md` rejects entrance flourishes.

2. **All three marks take the same spec:** the six KPI sparklines, the model token trend and the model
   usage ring. One shared definition (`web/src/charts/chartMotion.ts`) and one token
   (`MOTION_ROLL`), so a tile's digits and the mark under them move at one tempo and cannot drift apart
   in review.

3. **The reduced-motion switch is app-owned and mandatory.** `web/src/hooks/usePrefersReducedMotion.ts`
   reads the media query and re-reads it on change, because a preference that only took effect on reload
   would break the promise mid-session. `resolveChartAnimation` returns `false` - not an empty object and
   not `undefined` - since the library reads a missing spec as "use your own defaults", which is the
   900ms spring.

4. **The morph is bounded by the instance reuse that makes it a morph.** If a chart is ever remounted on
   a revision (a `key` change, an imperative ref owning the lifecycle, a `changeData` rewrite), the
   animation silently becomes a draw-in and this decision no longer holds. `dashboard-chart-motion`
   asserts intermediates exist; a draw-in on remount would still pass it, so the constraint is recorded
   here and in the component's own comment.

5. **The cost is accepted explicitly.** A canvas mark is redrawn frame by frame; it is not a
   compositor-only `transform`, so §7 rule 1 is not satisfied by these eight marks. The exception is
   bounded to 240ms on eight small canvases, and rule 1 continues to bind everywhere else - including
   the digits, which are real transforms.

6. **The poll may move a reading and the mark behind it, and nothing else.** §7's auto-refresh row is
   updated in the same change: the view still must not remount, reset pagination or relabel data.

7. **Assertions moved to where the claim is observable.** A logic test pins the spec and its
   reduced-motion branch; the browser scenario `dashboard-chart-motion` drives a revision with motion
   allowed and again after switching the preference in place, and asserts painted intermediates in the
   first case and none in the second. Both probe lanes that already existed keep running with reduced
   motion, so their pixel assertions stay deterministic - which is a second reason the gate is
   app-owned rather than optional.

## Consequences

### Positive

- A revision the reader did not ask for now reads as movement in the whole card, not as a replacement of
  half of it: the number rolls and the plot it describes sweeps beside it.
- The animation is a morph because the library reuses the instance, and that mechanism is now documented
  where a future change could break it.
- The reduced-motion gap is closed by us and covered by a probe, rather than assumed to be the library's
  job. That assumption would have been wrong, and invisibly so.
- Chart geometry and paint assertions elsewhere in the suite are unaffected: they run under reduced
  motion, where the marks are still painted in one frame.

### Trade-offs

- **A canvas redraw is not compositor-only.** §7 rule 1 binds for everything else in the console and now
  has eight named exceptions that a reader of the token table must notice.
- **§7 rule 5 is no longer absolute.** It went from a flat prohibition to a scoped claim with two
  conditions attached; that is a heavier rule to hold in review than "charts do not animate".
- **The reduced-motion switch is ours to maintain.** A regression in it would be invisible in the
  default configuration, which is why the probe measures both states on one page.
- **The marks can look static when the level changes.** Not a defect of this decision, but its most
  likely misreading: the sparklines are normalized shape charts, so a revision that scales everything
  uniformly paints the same picture. Reading it as "the animation is broken" would be easy.
- **ADR 0007's scope note is superseded on one point.** It recorded that "rule 5 is untouched"; this ADR
  is the newer decision, and 0007 is not rewritten - it remains an accurate record of what was decided
  then.
- **ADR 0004's fourth mitigation is superseded.** That ADR, adopting the charting runtime, required
  "disable chart library animations explicitly (`animate: false`)" as a visual invariant. Rule 5 above
  replaces that instruction; the other three mitigations in the same list - the dedicated
  `vendor-charts` chunk, the lazy import, and the enforced bundle budget - stand unchanged, and the
  budget was re-verified under this change.

## Alternatives considered

- **Keep rule 5 and remove ADR 0007's tile sweep, so the dashboard is uniformly still.** The most
  internally consistent option, and it was rejected on the reading it produces: a poll that moves a
  number is precisely where motion earns its place, and reverting the tiles to snap would trade a real
  signal for consistency with a rule the measurement had already shown to be over-broad.
- **Animate only the ring.** The arcs are the most legible morph, and it was rejected because the six
  sparklines are the loudest marks on the page; leaving them hard-cutting beside a morphing ring is a
  worse inconsistency than the one being fixed.
- **Use `Plot.changeData` or an imperative chart ref.** Rejected: the wrapper already reuses the runtime,
  so nothing is gained, and owning the chart lifecycle in React would mean re-implementing the update
  path (and its `isEqual` gate) to get exactly the behaviour already present.
- **Let the library decide the timing.** Its default update animation is a 900ms spring - three to four
  times §7's budget and the one curve `DESIGN.md` forbids by name.
- **Gate motion with CSS (`@media (prefers-reduced-motion: reduce)`).** Impossible: the animation is
  canvas frames, not CSS transitions, and the library reads no media feature at all.
- **A per-chart reduced-motion check.** Rejected: three components would each own the preference, and a
  fourth chart added later would silently animate for everyone. One hook, one resolver, one assertion.
- **Enable `enter` with a grow or a path-in.** Rejected: it is the entrance flourish `DESIGN.md`
  repudiates, and it implies a direction the data does not have.
- **Leave the reduced-motion question to the probe harness.** The harness could have forced
  `animate: false` in tests and left the product ungated, which would have made the suite deterministic
  while shipping the defect the suite exists to catch.
