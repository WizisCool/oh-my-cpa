# ADR 0008: Chart marks sweep between revisions, reversing §7 rule 5

- Status: Accepted; implementation and first-paint policy amended by ADR 0106
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

1. **Marks morph between readings on the shared `roll` token.** The six KPI sparklines, model trend,
   usage ring and Insights charts use `MOTION_ROLL` through
   `web/src/charts/echarts/echartsTheme.ts`. ADR 0106 extends the first-paint policy to a line reveal
   while the ring appears complete, keeping subsequent readings as morphs.
2. **Reduced motion is app-owned and mandatory.** `usePrefersReducedMotion` observes changes during
   the session; `echartsMotion` explicitly returns `animation: false` when requested. CSS cannot
   disable library-controlled geometry animation.
3. **The instance survives revisions.** `EChart.tsx` merges options into the same live instance;
   remounting on a poll would turn an update into a new draw-in. `dashboard-chart-motion` verifies
   both instance identity and painted intermediates, then drives another revision with reduced
   motion and requires a direct swap.
4. **The cost is explicit.** SVG geometry animation is not a compositor-only transform. It is a
   bounded exception to §7 rule 1, using the same token as the readout it describes.
5. **A poll may move the reading and its marks, nothing else.** It must not remount the view, reset
   pagination, change layout or relabel the data.
6. **Geometry is asserted in the browser.** Probes inspect actual SVG paths through revisions and
   inspect palette ink and layout under reduced motion. A configuration flag alone cannot prove
   that a rendered mark moved or stayed still.

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

- **A geometry update is not compositor-only.** §7 rule 1 binds for everything else in the console and now
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
- **The runtime changed in ADR 0106.** The motion policy remains, while both pages share the lazy
  `vendor-echarts` chunk and SVG lifecycle. ADR 0004 is superseded in full.

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
