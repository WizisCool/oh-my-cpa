# ADR 0006: A categorical series palette is a scoped exception to semantic-only colour

- Status: Accepted
- Date: 2026-09-15
- File pointer (2026-09-18): the six slots and the track now live in `MODE_SEMANTICS` in
  `web/src/theme/palette.ts`, which ADR 0011 moved the palettes into. The decision below is unchanged;
  only the file this ADR names for it is.

## Context

`docs/design.md` §1 states the app's colour rule as **"Semantic color only — green/red/amber mean
enabled/error/warning, never decoration"**, and every colour token in `themeConfig.ts` and
`index.css` follows it: `success`, `warn`, `danger` and `accent` all carry a verdict or an
interactive affordance. `scripts/test-chart-marks.ts` pins the consequence, asserting that each
`ChartTone` resolves to a distinct palette token and that `neutral` never resolves to the accent.

The dashboard's next increment adds two panels above the token activity grid: a **per-model token
trend** (one line per model over the selected window) and a **model-usage ring** (each model's share
of the window's tokens, with a ranked list). Read together they answer "which models is this
deployment actually spending on, and when" — a question the six KPI tiles aggregate away, because
they sum every model into one number.

This breaks the existing colour rule rather than extending it, and the pressure arrives from two
directions at once:

1. **Model identity is not a verdict.** A model list is whatever the deployment happens to serve —
   upstream names, dated revisions, per-provider aliases. It is open-ended, and it has no good/bad
   axis. There is nothing for a semantic hue to *mean*.
2. **The existing tokens cannot be reused for it.** Cycling
   `accent/success/warn/danger` across series would put a green line labelled "model B" beside the
   green pip that means "credential healthy" and the green cache-rate badge that means "high hit
   rate". One hue would then carry both a category and a state, and both readings would degrade —
   which is worse than the rule being violated, because it also destroys the semantic colours the
   rest of the console depends on.

So the choice was between dropping the multi-series requirement, cycling the status hues, or
admitting a second, clearly separated colour family that carries identity and never a verdict.

## Decision

**Introduce a categorical series palette as a scoped, documented exception — not a relaxation of
the rule.**

1. **Six series tokens, `series 1`–`series 6`, in both themes**, defined in
   `web/src/theme/themeConfig.ts` (`palette[mode].series`) and mirrored as
   `--series-1`…`--series-6` in `web/src/index.css`. They are consumed only through
   `seriesColor(mode, index)` in `web/src/charts/chartTheme.ts`.

2. **The slot is the identity, and the *family* survives a theme switch.** `seriesColor(mode, 0)` is
   the blue family in both themes, `1` the emerald family, and so on; only the lightness step differs,
   because the bright steps are illegible on a light card (the accent's own bright step reads 2.78:1
   there, the same measurement that produced the accent ladder). A model therefore keeps its colour
   when the operator changes theme, which is what makes the two panels' colours comparable across a
   preference change.

3. **Role separation between categorical data and operational status.** Categorical series colours
   encode qualitative categories, not boolean health, so the constraint is *not* that a series hue
   avoids the status hues - an amber line is not a warning when the legend beside it names a model.
   The constraint is that the two roles never rely on the same signal. `success`/`warn`/`danger` stay
   exclusively operational, and every panel carrying a category states it in text: the trend's legend
   names each group and the usage list prints each group's name, volume and share. The sequence
   alternates warm and cool families - blue, emerald, purple, coral, amber, cyan - so a warm hue
   reaches an ordinary two- or three-model window instead of appearing only in a long tail.

   The bounds that *are* asserted mechanically by `scripts/test-chart-marks.ts`: every series colour
   resolves to its own value and clears the WCAG 3:1 graphical-object contrast threshold against the
   card it is drawn on, adjacent legend entries are at least 25 ΔE apart in CIE Lab so no two
   neighbours read as one swatch, and the stylesheet's six custom properties match `themeConfig.ts`
   character for character so the two copies cannot drift.

   These are **limits, not accessibility guarantees.** Lab distance and WCAG contrast are ordinary
   perceptual and luminance measures: they rule out two colours being effectively identical and a
   colour being too dark to read, and they say nothing about how the palette reads to a person with a
   colour-vision deficiency. Validating that needs a validated simulation and, better, human review,
   neither of which this repository has, so no such claim is made here.

4. **Colour is assigned from one shared ranking, not per panel.** The domain is a *key* per group —
   `model:<name>` or the folded discriminator — rather than the display label, so a real model whose
   name equals the remainder's translated label cannot take the remainder's colour. The range is then
   generated in rank order, which means a group's colour follows its rank: it is stable for as long as
   the ranking is, and it can change when the ranking does. What the shared ranking buys is that the
   trend's line and the ring's slice for one group are never two different hues — they are two views
   of one response — and the legend beside each panel always states which colour belongs to which model.

5. **The exception is scoped to categorical charts.** The token heatmap's continuous ramp, the
   cache-rate scale, the status pips and every interactive colour are unchanged and remain semantic.
   `docs/design.md` §2 records both the palette and this boundary.

## Consequences

### Positive

- The model panels can distinguish six groups without borrowing a meaning, and the semantic tokens
  keep meaning exactly one thing everywhere else in the console.
- The two panels share one ranking and therefore one colour assignment, so a model's line and its
  ring slice cannot disagree — including across a theme switch, which is the case a per-component
  colour choice would have broken silently.
- The bounds that can be measured are measured and asserted (legibility against the card, separation
  between neighbours, and agreement between the two copies of the tokens), so the sequence can be
  revised without re-arguing the rule.
- Both marks are native `@ant-design/charts` components (`Line`, `Pie`) inside the existing lazily
  loaded `vendor-charts` chunk, so the exception costs no new runtime and the bundle budget is
  unchanged.

### Trade-offs

- **`docs/design.md` §1 now has an exception, and an exception is a thing future changes can widen.**
  The mitigation is that it is written down in one place with its reason, and that the boundary is
  scoped by role: these tokens belong to categorical marks, and the status, interactive and
  quantity-ramp roles are unaffected.
- **Colour is never the only encoding, and both panels are built that way.** A reader who cannot
  separate two hues reads the legend's names and the usage list's numbers, which is why neither panel
  is allowed to rely on a swatch alone.
- **Six slots, and a seventh series would fold back to the first colour.** Nothing currently asks for more
  — the ranking keeps five named models plus one remainder — and the fold is deliberate, but two
  models sharing a hue is possible if that limit is ever raised.
- **The palette is a second set of colour literals to maintain in two themes.** It is two arrays of
  six values in `themeConfig.ts` plus six custom properties in `index.css`. `test-chart-marks.ts`
  asserts the properties of `themeConfig.ts` and compares the stylesheet's copies against it, so a
  token edited in one place and not the other fails the suite.
- **A categorical hue is relative to nothing.** Unlike the heatmap's ramp, which is scaled to the
  window, these colours are arbitrary labels — a reader learns the mapping from the legend in the
  same panel rather than from any property of the colour. That is inherent to a categorical
  encoding, not a defect of this choice, but it is why the legend is always rendered.

## Alternatives considered

- **Cycle `accent/success/warn/danger` across the series.** No new tokens and no document change, and
  rejected because it makes one hue mean both a category and a state. The green pip on the
  success-rate tile and a green line for "model B" would sit on the same page.
- **Render every series in the accent at different opacities.** Keeps one hue and the document
  untouched, but opacity is a *quantity* encoding: two models at similar volumes become
  indistinguishable, which is exactly the comparison the panels exist to support. It also collides
  with the heatmap's ramp, which already uses accent lightness for a continuous quantity.
- **A single-hue sequential ramp keyed to the ranking.** Only distinguishes adjacent ranks, and it
  makes a model's colour change as its rank changes — the same instability as positional binding.
- **Let the library use its own default palette.** It is a different visual system (G2's tableau
  default is cooler and more saturated than this console's neutral graphite), it is not theme-aware, and it
  would put colour literals outside the two files that are allowed to name one.
- **Fold every model into one line and one slice.** The smallest change and no palette at all, but it
  discards the per-model reading that motivated both panels, leaving the KPI tiles' total drawn twice.
