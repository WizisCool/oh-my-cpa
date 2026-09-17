# Oh My CPA · Brand & Theme Tokens

Single source of truth for the visual system. OpenCode-inspired, product-owned:
interaction patterns and information density draw inspiration from OpenCode's
minimalist developer console, while brand identity (`›_`), warm terminal palette,
CPA information architecture, and security boundaries strictly belong to Oh My CPA.
Values are mirrored in code at:

- `web/src/theme/themeConfig.ts` — `palette` object + antd `ThemeConfig`
- `web/src/index.css` — CSS custom properties on `:root`

**Rule: never hardcode a color in components.** Import from `palette`, or use
the CSS variable. When a value changes, change it here and in those two files
only.

## 1. Design language

Terminal-flat console. Depth comes from **1px borders + background shifts**,
never shadows or gradients. Sarasa Mono SC first (Berkeley Mono, then IBM Plex
Mono as fallbacks), 4px radii, dense but breathable spacing.

| Principle | Meaning |
| --- | --- |
| Flat | `box-shadow: none` globally; borders carry all structure |
| Monospace | All text uses the mono stack; tabular numerals for data |
| Quiet chrome, loud data | UI scaffolding stays muted; status color is reserved for real state |
| Semantic color only | Green/red/amber mean enabled/error/warning — never decoration |

## 2. Color palette

### OMC Dark (default)

| Token | Value | antd mapping | Usage |
| --- | --- | --- | --- |
| `--bg` | `#121214` | `colorBgBase`, `colorBgLayout`, `colorBgContainer` | App background, inputs, tables |
| `--surface` | `#1c1c1f` | `colorBgElevated`, `colorFillTertiary` | Cards, panels, dropdowns, hover states |
| `--fg` | `#f4f4f6` | `colorText`, `colorTextBase` | Primary text |
| `--fg-2` | `#a1a1aa` | `colorTextSecondary` | Secondary text |
| `--muted` | `#71717a` | `colorTextTertiary` | Hints, legends, labels, chart crosshair rules |
| `--meta` | `#52525b` | `colorTextQuaternary` | Group labels, footnotes |
| `--border` | `#2c2c30` | `colorBorder` | Primary 1px borders |
| `--border-soft` | `#222226` | `colorBorderSecondary`, `colorSplit` | Row dividers, inner borders, chart grid rules |
| `--accent` | `#00a2fb` | `colorInfo`, `colorLink` | Links, info, active bars, selection |
| `--accent-hover` | `#0077b8` | `colorPrimary` | Filled primary buttons |
| `--accent-active` | `#005d8f` | `colorPrimaryHover/Active` | Pressed state |
| `--accent-on` | `#ffffff` | `Button.primaryColor` | Label drawn on a filled accent control |
| `--success` | `#10b981` | `colorSuccess` | Enabled / healthy / ok pip |
| `--warn` | `#f59e0b` | `colorWarning` | Degraded / quota warning |
| `--danger` | `#ef4444` | `colorError` | Failed / disabled / delete |

### OMC Light

| Token | Value |
| --- | --- |
| `--bg` | `#ffffff` |
| `--surface` | `#f6f6f8` |
| `--fg` | `#1c1c1e` |
| `--fg-2` | `#505055` |
| `--muted` | `#787880` |
| `--meta` | `#98989f` |
| `--border` | `#e5e5ea` |
| `--border-soft` | `#ededf2` |

### Preset registry

The two original palettes remain the exact OMC Dark and OMC Light presets. Four
additional presets are registered in `web/src/theme/themeConfig.ts`:

| Preset | Mode | Surface direction | Accent family |
| --- | --- | --- | --- |
| Midnight | dark | blue-black surfaces | cool blue |
| Porcelain | light | white/blue-grey surfaces | blue-teal |
| Forest | dark | deep green surfaces | vivid green |
| Sandstone | light | warm sand surfaces | teal |

Every preset declares `id`, `mode`, and one complete palette. The active preset
is the only source for Ant Design's `ConfigProvider`, the CSS custom properties
written to the document root, the categorical chart/ring series, and the token
heatmap ramp. `web/src/index.css` keeps the original OMC palette as the
pre-hydration fallback; `themePaletteCssVariables` supplies every preset's
runtime values. `omc-theme` stores the preset id and also accepts the legacy
`dark` and `light` values.

A palette also declares `accentOn`: the label colour for a filled accent control. It reaches Ant
Design as `Button.primaryColor` and the stylesheet as `--accent-on`, because Ant Design's own
`Button.primaryColor` default is `colorTextLightSolid` - white in every palette - and a preset whose
accent fill is light cannot carry a white label. Both original palettes use white; Forest's fill is
light enough that its label is a near-black step. Every preset's `accentOn` clears **4.5:1** against
its own filled-control step, and the registry check fails a preset that does not.

The OMC Settings page presents the registry as named cards with a four-swatch
preview, and the console header's theme menu presents the same registry as list
rows carrying the same swatch. The appearance controls must not introduce a
second palette source: both read `THEME_PRESETS`, so new presets extend
`themeConfig.ts`, and the registry and contrast checks in
`scripts/test-theme-presets.ts` fail if a preset is incomplete or unreadable.

### Accent ladder

The accent is **not** mode-invariant. It is one hue (201) at three lightness steps, and each theme
uses a different assignment because the same blue cannot be both legible as text on a light page and
legible as text on a dark one:

| Step | Dark | Light | Measured use |
| --- | --- | --- | --- |
| `--accent` | `#00a2fb` | `#005d8f` | link text: **6.03:1** on the dark background, **6.92:1** on the light one |
| `--accent-hover` | `#0077b8` | `#004770` | white label on a filled control: **4.85:1** and **9.83:1** |
| `--accent-active` | `#005d8f` | `#00344f` | pressed state |
| `--accent-on` | `#ffffff` | `#ffffff` | the label on a filled control — the colour both filled-control steps above are measured against |

The dark theme's link step is the light theme's *filled-control* step, which is the same value doing
two jobs in two themes. That is deliberate: it is the only step of this hue that clears 4.5:1 as text
on a light page, and white-on-it also clears it. The bright `#00a2fb` reads **2.71:1** on a light
page and **2.78:1** under white text, so it can only ever be the dark theme's text colour.

Brand artwork follows the same tokens: the wordmark's accent marks and its letterforms are drawn from
the active preset's palette, so a change here moves the logo with it — see `web/src/assets/brand/markup.ts`.

Success/warn/danger are identical in both modes.

### Status pip semantics

`ok/loaded → success` · `degraded/quota → warn` · `invalid/error/401 → danger`
· `inactive/offline/disabled → meta (gray)`. Pips are 7×7px, radius 2px.

**One pip per verdict.** A pip labels the state of the number it sits on, so a
row that shows a rate and its two components gets one pip — on the rate. The
components carry state by their own colour instead: a failure count is `danger`
when it is above zero and `meta` when it is not, because "0 failures" is not a
success worth painting green.

**Only a verdict gets a pip.** The request console's result filter segments
(Success / Failed) reuse the Result column's square bullet in its success/danger
token, but the All segment carries none: it is the absence of a verdict, and
both bullets side by side would read as a third, combined outcome. Same rule as
the success-rate bands — the state of "everything" is not a state.

**Success rate is a verdict, not a distance from 100%.** A gateway that fans out
to several upstreams always carries some noise — provider 429s, a timeout the
next retry absorbs, a request the caller cancelled — and a pip that turns amber
for that noise teaches its reader to ignore it. So the bands are wide, and they
are stated in *failures* rather than successes (`98% success` is a number nobody
reasons about; `2% of requests failed` is a decision):

| Window | Pip |
| --- | --- |
| no requests | `neutral` — nothing to judge |
| no failures | `success` — a clean window |
| too little evidence: under 20 requests *and* under 3 failures | `neutral` — a coin flip on four requests is not a trend |
| ≤ 5% failed | `neutral` — routine upstream noise |
| > 5% and ≤ 20% failed | `warn` — worth a look |
| > 20% failed | `danger` — broken, whatever the sample |

The bands live in `successRateVerdict` (`web/src/types/usageEventView.ts`). The
dashboard tile reads them; the request list does not show a verdict of its own,
for the reason below.

### Latency is not a verdict

The request list prints latency in plain `--fg` at every value. A long duration
is not a fault when the workload includes agents: a request that thinks for
minutes is doing its job, and the old `>= 4000 ms → amber` rule painted normal
traffic as degraded. Latency is read against its own baseline (the TTFT/stream
waterfall in the detail drawer), never against an absolute threshold, and the
semantic hues stay reserved for state.

### The request list carries no summary strip

The page used to open with a row of aggregates — page count, success rate with a
pip, mean latency, tokens, estimated cost. It was removed, and the rule it
violated is worth keeping:

- **Four of the five numbers restated the rows directly beneath them.** The page
  count is in the footer, and the totals are sums of the visible page, not of the
  window — so they changed meaning whenever the reader paged or filtered, without
  saying so, and they measured only the loaded page rather than what the reader
  believes they measure.
- **The one reading that was not a restatement was the success-rate pip, and it
  answered a question the list already answers per row.** A gateway's failure
  rate is a dashboard concern: it is a property of a *window*, and the dashboard
  owns windows. The list owns individual requests. Putting a window-level verdict
  on a page-sized sample (100 rows) made a 1-in-100 failure read as a 1%
  failure — the exact misreading that produced the 98%-shows-amber complaint.
- **A list is not a KPI view.** The strip consumed a full row of vertical space
  above the data it summarised, so on a 900px viewport 10% of the height went to
  information already available further down.

Totals belong where the whole window is in scope: the dashboard tiles, and the
detail drawer for one request. If a per-page figure is ever needed again, it
belongs in the footer next to the page count, stated as a page figure.

### Cache-rate scale

The request list's cache-rate badge is the one continuous reading in the app:
the value itself is a quality, so the badge paints it instead of bucketing it.
`0%` yellow → `100%` green, with no thresholds and no steps. **Red is not on the
scale**: a low hit rate is not a failure, and the danger hue is reserved for
failed requests, so a weakly-cached request never reads as an error.

| Token | Dark | Light | Role |
| --- | --- | --- | --- |
| `--cache-rate-yellow` | `#f59e0b` | `#b45309` | 0% stop |
| `--cache-rate-green` | `#10b981` | `#047857` | 100% stop |
| `--cache-rate-tint` | `14%` | `20%` | badge fill = hue over `--bg` |
| `--cache-rate-edge` | `32%` | `34%` | badge border = hue over `--bg` |

Rules:

1. **Interpolate in OKLCH**, via `color-mix(in oklch, …)`. Letting the browser
   mix keeps the stops as design tokens instead of hex values baked into a
   component, and OKLCH keeps the hue sweep even. The component never names a
   colour: `cacheScale.ts` returns the two stops as `var()` references plus the
   low stop's weight, and the CSS mixes them.
2. **The stops are palette steps, not new colours.** The dark stops are the
   semantic hues lightened until the 11px badge text clears **4.5:1** against the
   badge's own tint; the light stops are the darker reading of the same hues
   (the low end is ochre — a saturated yellow cannot also be legible on a light
   page). Measured worst case across the ramp in the browser harness: **6.70:1**
   dark, **4.69:1** light (asserted at ≥ 4.5:1 for every sampled rate, including
   the row's hover state). The light fill is stronger than the dark one because
   a light page needs more tint before the badge reads as a badge, which is why
   the two values differ.
3. **The top of the scale is presentation policy.** `100%` is not shown: the
   badge stops at **99.9%** (`MAX_CACHE_RATE`; the Go dashboard aggregate caps
   identically) so the app never claims a perfect hit rate. Readings carry **one
   decimal**; a rate that rounds to zero reads as `0%`, never `0.0%`.
4. **No data is not 0%.** A record with no token data gets the same badge shape
   at the neutral step (`--muted`) with an em dash, never a zero: "nothing
   cached" and "nothing measured" are different facts. The dashboard tile shows
   the same em dash when the window carried no prompt tokens.
5. The hue is redundant encoding — the percentage is printed in the badge — so
   the ramp needs no legend and no colour-only reading.

**Deferred: cache-write accounting.** A provider that accounts cache buckets
separately (Anthropic-style) reports prompt tokens as `input + cache_read +
cache_creation`, so its hit ratio currently reads high because the written
tokens sit outside the denominator. Counting them needs evidence the app does
not keep: CPA classifies each payload by provider/executor and emits a canonical
breakdown, but the decoder persists only the raw counts, and the hourly/daily
rollups carry no provider column, so a window cannot be split by convention.
Fixing it means persisting the breakdown (or per-convention token columns in the
rollup) before any arithmetic change. Until then the ratio is a bounded estimate
for cache-writing providers, and the request list is exact only for providers
whose input already includes the cached prefix.

### Token activity heatmap

The dashboard's token grid is the app's only sequential *quantity* encoding, and it is deliberately
not built from the semantic status hues.

**Shape.** A contribution-graph field: one row per weekday (Monday first), one column per week,
fifty-three whole weeks ending on the week containing today. Seven weekday rows are the whole point —
they make a weekly rhythm a *row* and a trend a *direction*, which a single-row strip cannot show.
The span and the shape are one decision: at seven rows a quarter's worth of days would be thirteen
columns, which reads as a small block rather than a field.

**The ramp is continuous, not stepped.** One hue at continuously varying lightness, from the cell's
own empty fill up to the accent. It replaced four fixed shades, which painted every day between two
of them identically — the day-to-day difference the panel exists to show was quantised away. The
mapping is the **square root** of the day's volume against the window's own busiest day
(`web/src/theme/heatmapRamp.ts`): token volume spans several orders of magnitude in one window, so a
linear ramp collapses the whole middle of the range into one invisible shade, while a logarithm
over-amplifies the bottom until a day with almost no traffic looks mid-scale. The square root keeps
day-to-day differences visible at the quiet end without flattening the busy end.

**The window rolls.** A trailing year, not a calendar one. A calendar grid spends every January
almost entirely empty and says nothing about last December, which is exactly the comparison a reader
wants at that moment; a rolling window always holds a year of history and always ends on today. It
is also GitHub's shape. The consequence is that there are no days still to come in the window,
except the tail of the current week — and those carry no traffic, so they are drawn exactly like
any other day with no stored record. They are still clickable: their tooltip states that nothing
is stored, which is the same answer a pruned day gives, and only the drill-down link is absent
because there would be nothing to open. The panel distinguishes "there is stored
data" from "there is not"; it does not ask the reader to hold "hasn't happened yet" apart from
"records were pruned", because those are the same fact to anyone comparing days.

**It fills its panel.** The tracks are `repeat(columns, minmax(--heatmap-min-cell, 1fr))`, so a year
of weeks divides whatever width the card has and reaches both edges. That is why the sizing is CSS
rather than JavaScript: an integer cell size cannot divide an arbitrary width evenly, and the
remainder is a visible gutter at the field's edge — which is what made the fixed-size version look
like an unfinished widget. There is no horizontal scrollbar at any desktop width; below the cell
floor the field swipes instead (see rule 9).

**The current week is a complete column.** Its later days have not happened, so nothing is stored for
them — the same fact as a day whose records were pruned, and they are drawn and treated identically
rather than given a state of their own. Leaving them blank was the alternative and it reads as a
rendering hole: the shape promises a full week.

| Token | Dark | Light | Role |
| --- | --- | --- | --- |
| `--heatmap-quiet` | `#3a3636` | `#e2dede` | the ramp's floor: a cell with no traffic |
| `--heatmap-busy` | `#00a2fb` | `#005d8f` | the ramp's ceiling: the window's busiest day |
| `--heatmap-zero-recorded` | `#3a3636` | `#e2dede` | recorded, no traffic |
| `--heatmap-zero-unrecorded` | `#343030` | `#eae6e6` | nothing stored for that day |

A measured cell mixes these two stops in **OKLCH** at a weight its own `--heatmap-quiet-share`
carries, so the whole ramp is one declaration and the endpoint it reaches is the accent token above.
`--heatmap-quiet` and `--heatmap-zero-recorded` are the same value on purpose: a measured day at the
bottom of the scale and a recorded day with no traffic have to be adjacent or the ramp does not start
where the field's floor is.

The two zero states are a **solid fill, never an outline**, and they form an ordered scale
against the card rather than against the page. Both are required properties, not styling
preferences:

- **Solid, because a grid is mostly zeros.** A quiet deployment has far more empty cells than
  measured ones, and drawn as 1px outlines they turned the field into a wire mesh. A stroke also
  draws attention to the *absence* of data, which is the loudest thing in a panel whose subject is
  the handful of coloured cells. GitHub's empty state is a wall of quiet blocks, and that is what
  this is.
- **Ordered against the card.** The panel sits at `--surface`, and both steps are a shade lighter
  than it on dark (darker on light), so the 4px gaps read as the card showing through. The order
  carries the meaning: unrecorded (no information) is closest to the card at ~1.06:1, empty (a
  measurement of zero) at ~1.16:1, and a measured day is the only thing clearly louder at ~1.23:1.
  Anchoring these to `--bg` was the defect: `--bg` is a step *up* from the card on dark, so
  "empty" rendered brighter than the panel and the ramp's floor rendered quieter than empty.

Rules:

1. **The accent hue, because the reading a status colour would imply is wrong.** The ramp continues
   the interface's own accent rather than introducing a second colour family, and it is deliberately
   *not* a semantic one: "a lot of tokens" and "this credential is healthy" must not be the same
   colour, or the grid implies a verdict it has no basis for. The probe asserts no measured cell's
   fill equals `--success`, `--warn` or `--danger`.
2. **Continuous, not stepped.** Four fixed shades painted every day between two of them identically,
   which quantised away the day-to-day difference the panel exists to show. The ramp is mixed in
   OKLCH rather than by interpolating in sRGB, where the midpoint of a light and a dark blue dips
   through a desaturated grey.
3. **Brightness is the square root of the day's share of the window's busiest day**, not the share
   itself. See the ramp note above for why a linear mapping collapses the middle of the range and a
   logarithmic one over-amplifies the bottom.
4. **The ramp is relative to the window, not absolute.** A self-hosted deployment's daily volume
   spans several orders of magnitude, so a fixed ladder would paint every cell of a busy install at
   the ceiling and every quiet one at the floor. The cost is that the same shade means different
   absolute volumes on two installs, which is why every cell states its counts in text.
5. **Colour is redundant, and there is no legend.** Every cell carries its date and both counts in
   its accessible name and in its tooltip, so the shade is never the only encoding — and a key exists
   to explain what a *stepped* scale's bands mean, which a continuous ramp does not have. The shade is
   relative to the window, so a swatch ladder would describe the field's own range rather than any
   fixed quantity. The numbers are one click away, which is where a reader who wants them goes. The
   tooltip's token volume prints in the console's **Token Unit Style** — the same layer the KPI tiles
   above it read — with the exact count on the value, while the request count keeps grouped digits
   because it is not a token volume.
6. **The tooltip opens on click, not hover.** On a field this dense a hover tooltip fires
   continuously as the pointer crosses it and competes with the hover ring for the same gesture.
   A click is deliberate, and it leaves the tooltip open to be read and followed. The drill-down is
   **a link inside the tooltip**, not the cell itself: the day's request list is a place, so it can
   be opened in a new tab and copied, and a stray click on a square cannot throw the operator out
   of the dashboard.
7. **Every cell is interactive.** Clicking one opens its tooltip, and a day with nothing recorded
   says so — "no requests on this date" is the answer to the question a reader is asking, not a
   reason to refuse it. The tooltip omits the two counts in that case rather than printing zeros:
   nothing stored is not the same claim as a measured zero, and `Requests 0 / Tokens 0` would assert
   a measurement the panel cannot make. A day with no traffic also has no drill-down link, because
   there would be nothing to open.
8. **Hover lifts the cell.** A `transform: scale()` — compositor-only, per §7 rule 1 — with the
   ring, and `z-index` so the enlarged square is not clipped by its neighbours. Deliberately no
   colour transition: §7 rule 7 forbids one, and a fade behind a fast sweep reads as lag. The
   `prefers-reduced-motion` override drops the movement and keeps the ring and the cursor.
9. **Every line of the tooltip clears WCAG AA on the popper's own surface** (measured, and
   asserted from painted pixels in both themes). Two things this pins down, because both shipped
   broken: the tooltip's fill is the palette surface in *both* themes - antd's `colorBgSpotlight`
   was set to `--fg` for light, which put near-black text on a near-black box at a contrast ratio
   of 1.0 - and the link uses its own step (`--heatmap-tip-link`) rather than either accent,
   because the bright accent reads 3.4:1 on the dark surface and the deeper hover step reads
   1.96:1 there while being the only legible one on the light surface.
10. **The field swipes only when it must.** Below the cell floor (a phone) the container scrolls with
   the scrollbar hidden — a bar inside a dashboard card is noise and touch shows none — and it opens
   on today's column. Clipping instead would hide two thirds of the year silently, which is worse
   than either alternative. The probe asserts no scrollbar is rendered at desktop widths.
11. **The grid is DOM, not a chart mark** — see `docs/adr/0005-token-heatmap-as-a-dom-grid.md`.

### Categorical series palette

The dashboard's model panels colour a **category**, not a state. A model is whatever upstream name the
deployment happens to serve, so there is no good/bad axis for a hue to mean - which makes this the one
place in the app where colour is decoration, and the reason §1's semantic-only rule carries an explicit
exception rather than being quietly stretched. See `docs/adr/0006-categorical-series-palette.md`.

The exception is scoped by **role**, not by hue: these six tokens belong to categorical marks. The
status pips, the cache-rate scale, the token heatmap's ramp, the caller mask and every interactive
colour are untouched and still mean exactly one thing.

| Slot | Dark | Light | Family |
| --- | --- | --- | --- |
| `--series-1` | `#3b82f6` | `#2563eb` | blue |
| `--series-2` | `#10b981` | `#059669` | emerald |
| `--series-3` | `#8b5cf6` | `#7c3aed` | purple |
| `--series-4` | `#f43f5e` | `#e11d48` | coral |
| `--series-5` | `#f59e0b` | `#b45309` | amber |
| `--series-6` | `#06b6d4` | `#0891b2` | cyan |
| `--series-track` | `#2a2a30` | `#e5e5ea` | the trend's plot floor and the ring's unfilled track |

The table shows the original OMC Dark/OMC Light pair. Every registered preset
supplies its own six-slot series palette and track in `themeConfig.ts`;
`scripts/test-chart-marks.ts` checks every preset for exactly six slots,
graphical contrast on that preset's card surface, and adjacent-slot distance.

**The slot is the identity; the family survives a theme switch.** `seriesColor(mode, 0)` is the blue
family in both themes and only the step changes, because the bright steps are illegible on a light
card - the accent's own bright step reads 2.78:1 there, the same measurement that produced the accent
ladder. A model therefore keeps its colour when the operator changes theme.

**Categorical colour and status colour are separate roles, not separate hues.** The constraint is not
that a series hue avoids `success`/`warn`/`danger`; an amber line is not a warning when the legend
beside it names a model. The constraint is that the two roles never rely on the same signal: the status
tokens keep those hues exclusively, and both panels state their categories in text - the trend's legend
names each group, and the ranked list prints each group's name, volume and share. Colour is never the
only encoding.

Rules, all measured and asserted by `scripts/test-chart-marks.ts`:

1. **Every slot clears 3:1 against the card it is drawn on** (WCAG's bar for a graphical object, not
the 4.5:1 body-text bar - these are 1.6px lines and 8px swatches). Measured across both themes the
range is 4.01:1 to 7.92:1 on the dark card and 3.41:1 to 5.28:1 on the light one.
2. **Adjacent legend entries are at least ΔE 25 apart in CIE Lab**, so no two neighbours read as one
swatch. The sequence exists for that bound: it alternates warm and cool families, which also puts a
warm hue into an ordinary two- or three-model window instead of reserving it for a long tail.
3. **The runtime projection is what every preset is checked against.** `themeConfig.ts` is the only
source of the six slots. `index.css` carries them for the two original palettes as the pre-hydration
fallback, and the suite compares that fallback with `palette.dark` / `palette.light` character for
character; every other preset's slots are projected at runtime by `themePaletteCssVariables` and
asserted against its own registry entry. A token edited in one place and not the other fails rather
than shipping a chart in a colour the legend does not show.
4. **Colour is assigned from one shared ranking, not per panel.** The domain is a *key* per group -
`model:<name>` or the folded discriminator - rather than the display label, so a real model whose name
equals the remainder's translated label cannot take the remainder's colour. The range is then generated
in rank order, which means a group's colour follows its rank: it is stable for as long as the ranking is,
and it can change when the ranking does. What the shared ranking buys is that the trend's line and the
ring's slice for one group are never two different hues - they are two views of one response - and the
legend beside each panel always states which colour belongs to which model.
5. **Six slots, and a seventh series would fold back to the first colour.** Nothing asks for more: the
ranking keeps five named models plus one remainder. Colour is never the only encoding regardless - both
panels print every group's name and the list prints every group's numbers.

   The Lab and contrast bounds above are **limits rather than accessibility guarantees**: they rule out
   identical or unreadable colours, and do not establish how the palette reads to a person with a
   colour-vision deficiency. See ADR 0006 for why that claim is not made.

### Dashboard model panels

Two peer cards between the KPI tiles and the token activity grid, both driven by the window picker:

```text
┌─ Token trend ──────────────────┐ ┌─ Model usage ─────────────────────────┐
│ ● gpt-5-codex ● claude-... ● … │ │   ╭───╮   ● gpt-5-codex  61.7K   73%    │
│        ╱╲                      │ │  ╱ 84.8K╲  ● deepseek-…    14.3K   17%   │
│   ╱╲__╱  ╲__╱╲___              │ │  ╲tokens╱  ● qwen3-…        6.7K   7.9%  │
│ ──┴────┴────┴────┴──           │ │   ╰───╯   ● …                          │
└────────────────────────────────┘ └────────────────────────────────────────┘
```

**The trend is a multi-series line, not an area.** The KPI tiles above use an area because their series
is a fixed zero-filled grid where a quiet stretch is a *measured* zero and an area carries it down to
the baseline. Here up to six groups share one plot, and six overlapping translucent fills compound into
a mud that hides whichever model is underneath - which is the reading the panel exists to provide. Lines
separate; fills compound.

**The line is smoothed, and the curve is monotone.** `shapeField="smooth"` resolves to G2's `smooth`
shape, which draws with `curveMonotoneX` - a monotone cubic, not a plain Catmull-Rom spline - and the
KPI sparklines use the same shape. That distinction is the whole reason smoothing is safe here: these
series are zero-filled, so most buckets sit exactly on the floor, and a non-monotone spline through them
would overshoot *below* the axis between points, drawing a line where the data says zero. A monotone
curve cannot leave the range spanned by its own neighbours, so the floor stays the floor. The probe
asserts this from painted pixels: no series-coloured ink appears below the axis rule.

**No y-axis.** The reading is the shape of each line against its own baseline - which models rose, and
when - and the numbers are in the tooltip and in the usage list beside it. An axis would take the width
the lines need to add a scale nothing on the card refers to. The plot floor and the x labels stay: the
floor is what makes a quiet stretch read as zero rather than as absent data.

**The plot's chrome is the palette's ink, at the palette's own opacity.** The grid rules, the axis rule
and the tooltip's crosshair are the one part of this mark the console does not draw itself: the runtime
paints them from its own theme, which is one of the library's *light* themes unless the mark names the
console's mode, and it multiplies the inks it *is* handed by that theme's opacity tokens (`alpha45` on
the labels, the axis rule and the ticks, `alpha10` on the grid). A palette colour handed through either
one is not the colour that reaches the card - a near-black grid on a dark card is one 8-bit step from the
surface it is drawn on. So every rule is named from the palette *and* pinned to full opacity, and the
theme's mode follows the console's: `--border-soft` for the grid, `--border` for the axis rule and its
ticks, `--fg-2` for the labels, `--muted` for the crosshair. The browser probe reads both themes' painted
pixels and matches the ink to the token, because the light card is exactly the surface on which a wrong
ink still looks correct.

**Four x ticks, chosen by position.** The bucket grid runs to ~48 points; a tick per bucket printed the
same instant forty-eight times across a half-width card. The first and last bucket are always among the
four, because those are the two a reader places the window with. The label format follows the span -
`HH:mm` within a day, `MM-DD` beyond it - which is the only place the window's extent is stated, and
keeps the outermost label narrow enough to sit inside the card's gutter.

**The legend is app-owned DOM.** G2's legend is built from its own type scale, so it would be the one
place in the console not set in the mono stack. It also has to be the same colour assignment the usage
list uses, which is only guaranteed if one ranked list produces both.

**The ring's centre is DOM**, and it is the window's own total rather than the KPI tile's. The two read
on different cadences, so borrowing the tile's number would let the centre disagree with the slices
drawn around it. Its percentages are derived from the same total, so the list, the ring and the centre
cannot drift.

**The ranked list is the ring's legend and its values in one.** A separate library legend would print
the same ranking a second time with no numbers, and a reader comparing two models needs the numbers: a
slice's angle is a poor way to compare 5.9% against 4.6%. A share that rounds to zero is reported as
under the smallest step rather than as `0%`, which would claim a model carried nothing.

**Both marks are native `@ant-design/charts` components** (`Line` and `Pie`) inside the existing lazily
loaded `vendor-charts` chunk, and both morph between two revisions on §7's `roll` token (§7 rule 5).
The ring is not a chart-runtime
heatmap, so ADR 0005's DOM grid is untouched.

**The usage list's columns are one grid, not one per row.** The tracks are declared on the list and the
rows inherit them as a subgrid. Per-row tracks resolve against each row's own content, so one amount a
character wider than its neighbours shifts that row's volume and share cells to the right and the
numeric columns stop lining up down the card - and a column that does not line up cannot be compared
downward, which is the whole reason the list is ranked. A subgrid rather than `display: contents`:
dissolving the row to inherit the tracks also dissolves the row's own gap and separator, leaving the
swatch against the name and the rule drawn in fragments between the columns.

**The ring yields width to the list, down to a floor, and the panels stack by the card's width.** The
list's numeric columns cannot be abbreviated, so the name column loses that race whenever the ring
insists on its full size - and a model name truncated to a handful of characters identifies nothing.
The ring therefore shrinks before the name does, and once neither fits, the two stack. That decision is
taken on the *card's* inline size via a container query, not on the viewport: the card is half the grid
at some viewports and the full width at others, so a viewport breakpoint would stack the panels at a
width where the row still fits and keep them side by side at one where it does not. The ring's frame is
kept square by CSS through the whole range, because a frame clamped in one axis while the canvas keeps
the other draws an ellipse.

**The ring hover states the group, its volume and its share**, matching the trend's tooltip rather than
the share being left to the list alone. A slice is read as a fraction of the ring, so the percentage is
part of what is being pointed at; it is derived from the same window total the centre reports, so the
readout and the centre cannot disagree. The group's name comes from the datum through the mark's own
tooltip items - the library's inferred item is built from the y channel, so every slice would otherwise
be labelled after the field it plots.

### Caller-key display mask

The request list's Key column and the caller-key facet show a mask, never the
key. The shape is a short head, a fixed bullet run, and a short tail:
`sk-1234••••••••7890`. A key too short for edges to identify it is masked
completely (`••••••••`) — exposing four of an eight-character key would give
away half the secret while still failing to name it, so short keys are
intentionally indistinguishable from one another. The filler is a constant
length, so the mask never reveals the secret's length.

- **Identity is the fingerprint.** Grouping, filtering and deduplication use the
  keyed HMAC (`api_group_key`), which is also what the detail drawer shows. The
  mask exists only for a human reading the list.
- **Legacy masks are converted on read.** Rows ingested before the filler
  changed still carry `xxxxxxx`; the list, detail and facet projections
  normalize the filler and keep the visible edges. Nothing reconstructs a
  secret, and a missing mask stays missing.
- **Shape checking is not a security boundary.** A credential can contain the
  filler, so `IsMask` only stops an obviously unmasked value from being written
  to a display column; provenance comes from masking at ingestion.

## 3. Typography

```text
Font stack   "Sarasa Mono SC", "Sarasa UI SC", "Sarasa Term SC", "更纱黑体 SC",
             "Berkeley Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular,
             Menlo, Monaco, Consolas, "Liberation Mono", monospace
Subset font  Build-time subsetted woff2 (~105KB per weight, Regular & Bold)
             embedded in assets; local Sarasa Mono SC takes zero-latency priority.
Base size    14px (antd token fontSize)
Line height  1.5
Tabular      font-variant-numeric: tabular-nums on all numeric data
```

| Level | Size / weight | Usage |
| --- | --- | --- |
| Page title (`--text-xl`) | 22px / 700 | One per page, the verdict or page name |
| Section h2 | 16px / 600 | Dashboard sections |
| Hero number | 42px / 700, letter-spacing −0.04em | The one big KPI |
| KPI value | 28px / 700 | Stat cards |
| Body | 14px / 400 | Default |
| Data / mono | 12–13px | Tables, logs, code |
| Eyebrow | 10px / 500, letter-spacing 0.16em, uppercase, `--muted` | Tiny group labels above KPI numbers only |

**Hierarchy rules:**

1. One page title per page — the dashboard title is the *verdict* (e.g. `Healthy.`),
   other pages use the nav label. No duplicated subtitles restating it.
2. No decorative subtitles. A subtitle exists only when it carries live data
   (e.g. `Default CPA · Connected`, `3 auth files`), never static marketing copy.
   The same rule covers warning text: a state label (`CPA file logging disabled`) plus
   an action (`Retry`) is the whole message. Sentences explaining *why* the switch
   exists, or promising what another screen will do, are documentation pasted
   into the UI — an operator who needs them is looking at the wrong product.
3. No stacked language pairs: a Chinese UI never shows English captions for the
   same thing (both languages localize fully; proper nouns like "Provider" may
   remain English in zh copy where that is the industry term).
4. Body max width `1440px`; page padding 32px desktop / 24px tablet / 16px phone.

## 4. Shape, spacing, elevation

```text
radius-sm     4px    inputs, buttons, tags, cards, pips (the app's radius)
radius-lg     6px    modals/drawers outer shell only
space scale   4 · 8 · 12 · 16 · 20 · 24 · 32 · 48px
section gap   32px (dashboard sections)
card padding  20px (antd Card paddingLG)
page head     title block left, actions right, 24px bottom margin
header        56px tall, 1px bottom border
sider         236px (58px collapsed), 1px right border
```

Elevation: **zero shadows** on layout, card, drawer, modal, popover, dropdown.
`--focus-ring: 0 0 0 2px var(--accent)` is the only ring.

## 5. Layout skeleton

```text
┌──────────┬──────────────────────────────────────────┐
│ brand ›_ │ breadcrumb (Group / Page)   actions ⟳ ◧ ▣ ⇥│ 56px, border-bottom
│──────────┼──────────────────────────────────────────┤
│ nav      │                                          │
│ (groups) │ page content        ← scrolls alone      │
│          │                                          │
│ foot:    │                                          │
│ CPA conn │                                          │
└──────────┴──────────────────────────────────────────┘
   236px        1fr    — both columns scroll independently
```

- `body { overflow: hidden }` — the shell is `100dvh`; sidebar and content
  scroll independently (`overscroll-behavior: contain`).
- Nav groups: Operate / Gateway / Observe / Control. Group labels 10px
  uppercase `--meta`. Items: icon + label only, no subtitles. Selected item =
  2px `--fg` inset rule (`box-shadow: inset 2px 0 0 var(--fg)`) + `--fg` bold text,
  never a filled background block. Hover uses `--surface` for immediate feedback.
- Sider foot shows live CPA connection + version in `--meta`.

### OpenCode-inspired patterns

Oh My CPA draws from OpenCode's minimalist, high-density, engineer-first console philosophy while preserving Oh My CPA's warm charcoal palette, security boundaries, and technical architecture:

1. **Open List Pattern**
   - Lists of models, credentials, configuration items, etc., favor open rows over nested outer Card wrappers.
   - Rows are separated by subtle 1px hairline dividers (`border-bottom: 1px solid var(--border-soft)`).
   - Clear structure: entity name and identifier on the left, technical metadata / provider in the middle, and direct interactive controls on the right (e.g. switch toggles, action buttons).
2. **Task-Dependent Density**
   - Monitoring and high-frequency telemetry (Dashboard, Live Logs, Request Records): High density, compact, tabular monospace alignment.
   - Configuration and system operations (Config, Pricing, System Settings): More generous whitespace, 32–48px section spacing, and full-width 1px dividers.
3. **Honest Card Boundaries**
   - Cards are reserved for: core KPIs, key entity summaries, and peer comparisons.
   - Never wrap a single isolated input or switch into an individual card box to avoid visual clutter.
4. **Peer Comparison Panel**
   - Multi-column horizontal comparison card pattern: clean outer grid + 1px hairline borders + inner dividers (primary comparison metrics on top, secondary sources and provider logos below).
5. **Contextual Next Actions**
   - Allow a single concise line describing the current target or guiding the next step (e.g. underlined links like `Learn more.` or `Documentation`).
   - Avoid marketing boilerplate or lengthy guides inside UI cards.
6. **Top Context Slot**
   - The left side hosts the signature `›_` prompt logo, expandable to an instance context selector when multi-instance support lands;
   - The right side houses four fixed-width actions: refresh, the theme menu, the language menu, and sign out. Both preferences are **menus over their whole registry** rather than toggles between two states - the console already carries six presets, and a language pair that cycled would have to be rewritten as soon as a third language lands. The theme menu previews each preset with the same four-swatch mark the settings cards use; the language menu pairs each language's **endonym** - its own name in its own script, never a translation - with its flag, so a reader who cannot read the console's current language can still recognize and choose their own. The settings page's language picker lists the same endonyms.
   - **Every header action keeps one width in every reading language.** Labels are the one thing whose length changes with the language, so sign out is an icon button named by its tooltip, and the language trigger holds its code in a fixed slot. A control that resizes moves the actions beside it, which is a real defect rather than a cosmetic one: the pointer is already on one of them.
   - Connection status and version are the side rail foot's, not the header's: this slot carries actions. Never display fabricated avatars, dummy balances, or mock workspace selectors before real capabilities exist.
7. **Form Workbench & Setting Group Panels**
   - **Full-width Toolbar & Viewport Anchoring**: The top action toolbar and its 1px bottom border span 100% of the viewport, with right-side actions (search / refresh / save) pinned to the far right (vertically aligned with the global header actions) to eliminate awkward empty gaps. The form workbench below maintains a three-track grid: 216px sticky section navigation + 920px reading width + 216px balancing gutter (used solely to center content on wide viewports), establishing an anchored layout that keeps forms focused and legible.
   - **Setting Group Panels**: Related settings converge into **Setting Group Panels** (uniform 1px hairline border, `--surface` background, and 4px terminal radius) rather than an endless flat list of inputs or fragmented cards. Three specialized structures are used:
     1. **Form Grid**: Labels and descriptions on top, controls below; related short fields (such as Host and Port, retry counts and delays) sit side by side; short number inputs are bounded to 120px and selects to 260px;
     2. **Settings List**: Toggles and flags use in-card row lists with "title and description on left + Switch on right", bounded by the panel container;
     3. **Entity List**: Proxy client API keys use dedicated 32×32px square buttons with tooltips for deliberate, safe interaction;
     4. **Progressive Disclosure Panel**: TLS sections host an enable switch in the group header; when disabled, only explanatory text is shown; when enabled, certificate and private key path fields expand smoothly, while preserving YAML data and disabling hidden controls when collapsed.
   - **Sticky Action Toolbar**: Title, sync pill, mode switch (`Visual / Source`), and actions (search, refresh, save) converge into a single sticky bar. The Save button stays anchored to the far right.
   - **Target Ergonomics**: High-frequency inline actions use discrete 32×32px square buttons (1px border and subtle background), providing ample click targets and tooltip feedback rather than bare icons.
   - **Form Control Sizing**: Controls are sized to 38–40px height with 14px font size for comfortable editing; numeric inputs are left-aligned with 34px right padding to prevent steppers from obscuring values.
   - **Monaco YAML Source Editor**:
     - **Offline & Zero-CDN Constraint**: Injects locally bundled `monaco-editor` core with `editor.worker` and `yaml.worker`; never loads assets via CDN; disables remote schema requests (`enableSchemaRequest: false`);
     - **On-demand Lazy Loading**: Dynamic import via `React.lazy` prevents bloat on initial page loads; Vite aliases prune unused language workers, bundling only `editor.worker` (274 KB) and `yaml.worker` (1017 KB);
     - **Terminal-Flat Theme Integration**: Dedicated `omc-dark` and `omc-light` themes match the Sarasa Mono SC font stack and 1px hairline borders, eliminating the jarring contrast of VS Code default themes;
     - **Full IDE Capabilities**: YAML syntax highlighting, bracket matching, indentation guides, folding, `Ctrl+F` search/replace, native `Ctrl+S` interception, and explicit format/validation hints.
   - **Floating Dirty Action Bar & Confirmation Semantics**:
     - **Trigger**: Appears only when unsaved edits exist (`isDirty === true`), fully hidden otherwise; the top toolbar concurrently shows a Discard button;
     - **Viewport Centered & Non-intrusive**: Centered dynamically within the content column based on `--app-sider-width`; outer container uses `pointer-events: none` to avoid blocking lower page interactions;
     - **Terminal-Flat Tone**: 1px border, solid `--surface` background, and amber dirty indicator pip;
     - **Confirmation Rules**: Save actions trigger a Popconfirm (and `Ctrl+S`/`Cmd+S` triggers a confirmation modal); Discard actions revert immediately without confirmation, cleanly dismissing the dirty bar; Save is disabled with tooltip explanations when YAML has syntax errors or required fields are incomplete.
   - **Modular Payload Rules Builder**:
     - **Structured Collapsible Panels**: Replaces generic raw textareas with structured panels (Default rules, Default Raw rules, Override rules, Override Raw rules, Filter rules);
     - **Bi-directional Lossless AST Mapping**: Directly manipulates the YAML Document AST; models, protocols, typed parameters, raw fragments, and filter paths use dedicated controls; preserves non-payload configurations, ordering, and comments, round-tripping unknown fields (`_extra`);
     - **Validation Timing (Pristine → Touched → Submitted)**: Avoids premature errors on initial open or rule addition; required fields remain neutral until blur (`onBlur`) or submit; errors clear immediately upon valid input;
     - **Advanced Match Modal**: Supports protocol filtering (`from-protocol`), header matching (`headers`), path equality matching (`match`), path inequality matching (`not-match`), and path existence checks.
   - **Architectural Rationale: Why Avoid @ant-design/pro-components**:
     - ProComponents (`FooterToolbar`, `ProFormList`) bundle massive dependencies (`rc-field-form`) and heavy enterprise patterns;
     - Adding them would introduce megabytes of bundle weight, conflicting with the single-binary zero-CDN offline mandate and introducing incompatible drop shadows;
     - Dedicated native components integrate seamlessly with the YAML AST state stream, resulting in minimal bundle size, instant responsiveness, and high customization.

### Time range control

One button names the window (`Last 1 hour`, or `08-11 – open-ended`); the rest lives
in its popover. **Presets** lists the quick windows and nothing else — no secondary
column repeating the span each one resolves to. **Custom** is antd's own range
picker: its panel, its two-month calendar, nothing wrapped around it. Wrapping a
date picker in a draft state and a second Apply control means two opinions about
when a date is "chosen", and users feel the disagreement.

The picker stays day-granular on purpose. `showTime` collapses antd's range panel
to one calendar plus time columns — the least legible thing in the component —
and it keeps OK disabled until the end field has a value, which makes an empty
end impossible. Without it, `allowEmpty` works the way the antd docs advertise:
**leave the end empty and the range runs open-ended**. A picked end means *through*
that day, so `08-09 → 08-21` really includes the 21st.

Three kinds of window, and only the first two move:

| Chosen | Behaviour |
| --- | --- |
| Preset (Last N) | Sliding: re-resolved against `now` on every poll, so the newest bucket keeps appearing. |
| Custom, end left empty | Growing (open-ended): fixed start, end tracks `now`. Polled like a preset. |
| Custom, closed range | Frozen: shown exactly as picked, never polled. |

The choice is stored on the server, not in the browser: a reload, a service
restart and a container rebuild must all bring back the window the operator was
looking at. A date picker that is not in use never sits in the toolbar.

The selected row is marked the way a TUI marks it — a 2px accent inset rule and
the text weight, not a filled block. Polling is paced to the resolution being
served — `bucket / 12`, clamped to 5s–120s — because refreshing faster than the
grid can change costs queries and buys nothing. There is no "live" switch: the
shortest preset **is** live. It is fifteen minutes at one bucket per minute, so
the pacing rule lands on its five-second floor by itself; five minutes was too
narrow to read as a trend and an hour too coarse to feel like it was moving.

## 6. antd theme wiring (themeConfig.ts)

Non-obvious decisions, keep these when editing:

- `colorPrimary: accentHover` (`#0077b8` in OMC Dark, `#004770` in OMC Light) — filled controls
  use the deeper step; `colorInfo/colorLink: accent` (`#00a2fb` / `#005d8f`). This is why buttons
  don't glow antd-blue while links stay recognizable.
- Menu: `itemSelectedBg = transparent`, `itemSelectedColor = fg`,
  `activeBarBorderWidth: 0` — kills the default blue selected block and avoids
  heavy filled blocks; active position uses the left 2px `--fg` inset rule.
- Switch: `colorPrimary = success (#10b981)` — active toggle switch uses
  semantic success green (enabled/healthy), never decorative blue.
- Modal & Drawer: `1px solid var(--border)`, zero shadow, 4px/6px radii. Simple
  single-task dialogs use a clean uninterrupted body ("Title → Field/Content →
  Right-aligned Actions") without decorative header/footer hairline dividers;
  only complex Drawers retain section dividers.
- Table: uppercase 12px `--muted` headers on `--bg`, `rowHoverBg = surface`.
- All shadow tokens set to `'none'`; every motion token pinned to ≤ 0.1s (§7).
- Components pinned: Button 32/28px with `primaryColor = accentOn` and `Input` active ring
  `accent22`, Select optionSelectedBg = surface, Tag defaultBg = bg. The button label is pinned
  because Ant Design defaults it to `colorTextLightSolid`, so a preset with a light accent fill
  would otherwise draw white on it.
- Dashboard KPI cards use `@ant-design/charts` (`Area`) to render one trend per tile.
  **The mark is an area, and that is a data-shape decision, not a style one.** The
  backend zero-fills a fixed bucket grid (`fillDashboardBuckets`), so a quiet window
  is mostly *zero* buckets — six hours resolves to 36 buckets of ten minutes, and a
  real window can carry traffic in under a fifth of them. A zero here is a measured
  value, not a missing one, and a bar mark draws each of those zeros as an invisible
  gap between floating marks, which reads as "no data" — the one thing it does not
  mean. An area carries the series down to its baseline, so an empty stretch renders
  as the axis and stays distinguishable from an unmeasured period.
  The mark is two paths on purpose: the fill is fill-only and the trend is a separate
  stroke, because a stroked area closes its path along the baseline and would paint a
  horizontal rule across the plot floor. `y.nice` is disabled and `domainMin` pinned to
  zero for the same reason — a lifted domain would float an empty window above its axis.
  The charting runtime is isolated in a separate `vendor-charts` chunk and loaded lazily
  (`React.lazy` dynamic `import()`) so only the dashboard route pays for it, keeping the
  initial login shell compact. The active preset's palette is bridged into the chart
  config (`sparkColor(preset.palette, tone)`), the marks morph between two revisions on
  §7's `roll` token with a reduced-motion escape (`chartMotion.ts`, §7 rule 5), and the hover
  readout uses an app-owned HTML
  `.chart-tooltip` styled from CSS custom properties. That readout is a direct child of
  `.chart-slot`, so the slot's child sizing rule must exclude it
  (`.chart-slot > div:not(.chart-tooltip)`); sizing every direct `div` stretches a
  two-line label across the whole tile.
  **Each tile plots its own metric**, and the six marks must stay visually distinct:
  Requests plots request counts, RPM those counts per minute, Tokens plots token
  volume, TPM that volume per minute, Cache rate plots the cache reads behind the
  rate, and Total cost plots priced spend per bucket. The cache-rate tile plots the
  *numerator* rather than the ratio on purpose: a rate needs both its terms and the
  series carries only cache reads, so plotting the ratio would invent a denominator
  from total tokens and overstate the rate whenever output tokens were large.
  Rates are per minute because the bucket width is not one minute at every range
  (`dashboardBucketWidth` snaps it to a friendly step), so dividing by the bucket's
  own minutes is what makes an RPM readout an RPM.
  The `dashboard-charts` probe asserts the six tiles paint six *distinct* pixel
  patterns; without that check a tile wired back to another tile's series passes
  every per-tile assertion. `dashboard-chart-motion` is its sibling for the motion:
  it drives a revision with motion allowed and again after switching the preference
  in place, and asserts the marks paint intermediate frames in the first case and
  none in the second.
- **The tile numbers are one readout layer, and they roll per §7 rule 8.** Each value is
  derived from the formatter that already owns that reading — `formatTokens` and its
  `zh`/`full` styles, `formatCacheRate`, the compact token rate, the plain count — and an
  `Intl`-backed one reads its number and unit word back out of that formatter's own parts
  rather than rounding a second time. The animated digits are therefore the printed digits:
  31,750 cannot arrive as `31.8K` and settle as `32K`. The unit word travels beside the
  number, and a tile whose unit word changes prints the new reading in place instead of
  rolling, because sliding 1.2 into 900 while `B` becomes `M` shows digits that never
  described the window. The exact count stays on the tile's `title`, which the readout's
  accessible reading matches.

## 7. Motion

```text
hover / state colour   ≤ fast — the acknowledgement must land on the pointer's frame (rule 7)
fast    50ms    antd motionDurationFast
base    100ms   antd motionDurationMid and Slow: drawers, modals, route and data transitions
roll    240ms   the dashboard's KPI readouts and the marks drawn from them (rules 8 and 5)
float   60ms    popovers and dropdowns — the click already said "open"
ease    cubic-bezier(0.2, 0, 0, 1)
```

**The table is the budget, and the stylesheet is held to it.** `web/src/index.css` mirrors `fast`,
`base` and `float` as `--motion-fast`, `--motion-base` and `--motion-float` for every CSS transition
and animation the console owns;
`scripts/test-theme-presets.ts` parses both and asserts they equal the Ant Design tokens above, so the
two spellings of one budget cannot drift apart again. `roll` is the only token with an exception
attached, and it is scoped to the dashboard by rules 5 and 8.

### The budget is enforced, not documented

`pnpm check:motion` reads every stylesheet and every inline `transition:` in a component, and fails
on four things: a duration that is not a `--motion-*` token (or a `var()` fallback, which is never
applied and is how a wrong value hid for months), a transition on a layout property or on `all`, a
keyframe animation with no `prefers-reduced-motion` counterpart, and a hover transitioning colour
outside `fast`. The layout animations that a disclosure genuinely needs are listed in the checker's
`EXCEPTIONS` table with the reason each is one, and an exception that stops matching a rule is itself
a failure — the list cannot rot into things that were once true. `scripts/check-motion.test.mjs`
exercises every rule in both directions on a fixture tree and asserts the repository itself is clean.
Enforcing the reduced-motion rule immediately paid for itself: antd animates its floating panels in
with a zoom under reduced motion as well, and the panel has to be pinned to its settled state rather
than merely un-animated, because rc-motion holds the enter state inline until the animation ends.
That surface is asserted in the browser now, not only in the declaration.

No bounces, no scale-ins. Content appears; it does not "fly".

### Motion is restraint, not decoration

The interface is deliberately raw and terminal-like. Motion exists only to make
state changes feel continuous and **hand-following** (responsive direct manipulation) — never to impress.
When fluidity and flourish compete, keep fluidity; when flourish and
performance compete, drop the flourish.

Hard rules:

1. **Animate compositor-only properties** — `opacity` and `transform`. Never
   `width`, `height`, `top`, `margin` or anything that triggers layout or
   repaint of a large subtree.
2. **Keep the animated area tiny.** A 2px progress bar is acceptable; dimming or
   fading a whole grid is not — it forces the browser to composite the entire
   page on every refresh.
3. **No gradient shimmer.** antd's `Skeleton active` and similar sweeping
   gradients cost frames and clash with the flat aesthetic. Use static skeleton
   blocks.
4. **Suppress spinner flash.** A request that resolves quickly must never paint a
   loading indicator at all (`DataProgress` waits 200ms before showing).
   Background auto-refresh must not paint a loading state at all; a reading that
   changed may still say so, which is rules 8 and 5 and nothing else.
5. **A mark sweeps between revisions instead of hard-cutting.** An AntV mark morphs to its
   new geometry over `roll`, and fades rather than grows when a series enters or leaves.
   A plot that hard-cuts every few seconds reads as a redraw rather than as new data - and
   beside a tile whose number now rolls (rule 8), a snapping line was the one element still
   saying "this replaced itself". The marks are the dashboard's own, so this covers both the
   six KPI sparklines and the model panels, which re-read on a query of their own.
   Two limits keep this a morph rather than a draw-in: it exists **only because the
   library reuses the chart instance** (the wrapper hands the new spec to the same runtime,
   so an update interpolates, while a remount is a draw-in and stays forbidden), and a
   canvas cannot be
   reached by CSS, so the reduced-motion switch is app-owned
   (`usePrefersReducedMotion` in `web/src/hooks/`) and must stay wired: the library has no
   handling of its own and its default update animation is a 900ms spring, which would
   animate hardest for the reader who asked for none. The cost is stated rather than hidden:
   a canvas mark is redrawn frame by frame instead of being composited, so rule 1 is *not*
   satisfied by these eight marks, and 240ms on surfaces this small is the whole of what the
   exception buys. See ADR 0008.
6. **Feedback must be immediate.** Optimistic affordances (button `loading`,
   the progress bar) appear on the interaction itself, not after a transition.
7. **A hover lands within the fast token.** A hover is the interface acknowledging the
   pointer, so it must land on the frame the pointer arrives — a transition longer than
   `fast` (50ms) is a drag, not an acknowledgement, and the rule was written after antd's
   `motionDurationSlow` default of 0.3s on menu-item hover, submenu expand and the sider
   collapse. All three tokens are pinned ≤ 0.1s in `themeConfig.ts` for the same reason.
   The bound is on the *duration*, not on the property (ADR 0009): three frames is the
   acknowledgement, and anything longer is the drag. Two narrower rules stand inside it: a
   hover may never animate a layout property, and the one element that scales under the
   pointer (the heatmap mark) may not fade its colour, because the fade would smear behind
   the scale it is meant to accompany.
8. **The dashboard's numbers may travel.** The six dashboard KPI numbers roll to
   their new value over `roll` (`MOTION_ROLL` in `themeConfig.ts`), for the reason that names
   the whole exception: those tiles change under a poll the reader did not ask for, a number
   that swaps in place is indistinguishable from a number that was already there, and the
   sweep is what says "this reading moved" without the page moving. Rule 5 gives the marks
   drawn from those numbers the same token; nothing else in the console moves on a poll. For
   the digits the exception is cheap and scoped -
   glyphs transforming inside a 34px-tall box, so rules 1 and 2 hold as written, and a change
   of *unit* prints in place, because rolling 1.2 into 900 under a swapping unit word would
   show digits that never described the window. `prefers-reduced-motion` removes it and the
   value still updates. See ADR 0007 for the token and ADR 0008 for what rule 5 costs.

### Never hard-swap a view

**A painted frame must never go blank between two states.** This applies to
every transition: route changes from the sidebar, dashboard window presets,
custom range changes, manual refresh and background refetch.

| Situation | Required behaviour |
| --- | --- |
| Route change | Content sits in a keyed `.route-transition` that fades in over 100ms with a 3px rise, and the scroll position resets with the new page. |
| Query key change (preset, range, filter) | `placeholderData: keepPreviousData` — the previous result stays on screen while the next one loads. |
| Any request in flight | The app-wide 2px `.data-progress` bar, shown after a 200ms delay. Regions are never dimmed or unmounted. |
| First load with no data yet | Render the real page frame with static `Skeleton` blocks, not a bare full-page spinner swap. |
| Error after data existed | Keep the stale data visible and surface a warning; only replace the page when nothing was ever loaded. |
| Auto-refresh poll | The view does not move, though a reading and a mark may. The poll is not a view change, so it must not reset pagination, remount the list, expand a collapsed header, or relabel the data as "previous results". Two things may move: a dashboard KPI number rolling to its new value, and any dashboard chart mark morphing to its own new revision - the six KPI sparklines, and the model trend and usage ring, which re-read on their own endpoint rather than on the tiles' (rules 8 and 5). |

`prefers-reduced-motion` removes the fade and freezes the progress bar, but the
no-blank rule still applies — fall back to a static loading state.

### Live tail: follow at the top, hold when reading

A polling list is a live tail, and a live tail has to answer one question: does
the reader want to be carried along, or are they reading?

- **At the top** (within a few pixels) the reader is following. New records appear
  immediately; the newest is always the first row.
- **Scrolled away** the reader is reading. The rows on screen are held exactly as
  they are, the poll keeps running in the background, and a pill above the footer
  reports `N new records` — clicking it applies the backlog and returns to the top.
  Scrolling back to the top by hand resumes the follow, so the pill is never the
  only way out.

The pill replaces the plain back-to-top button when there is a backlog, because
the two are the same gesture. Jumping the reader to the top on every poll — or
reordering the rows under the cursor — is the failure mode this exists to
prevent: it is what Grafana, Datadog, Sentry and Vercel logs all refuse to do.

Two supporting rules keep the follow honest:

1. **Pagination survives a poll.** The view scope is the filters plus the page
   the reader chose; the auto-refresh counter is deliberately outside it. It used
   to be inside, which silently reset every reader to page one.
2. **The list is ordered by request time, newest first**, so the column the
   reader sorts by eye is the column the list is sorted on. See
   `docs/architecture.md` for the keyset cursor and index this order needs.
   "Arrived" is a separate question and is answered separately: the pill counts
   records *recorded* since the reader stopped following, because a request that
   ran for an hour is new while sorting far below the first page.

### Scroll: a gesture moves, a correction lands

The list itself scrolls, so its scrolls carry two different intentions and they
must not share a behaviour:

| Intent | Scrolls | Behaviour |
| --- | --- | --- |
| Gesture | Back to top, applying the `N new records` backlog | Animated, unless `prefers-reduced-motion` |
| Correction | Pinning row one after the header collapses, resetting on page change | Instant |

A correction is not a weaker gesture, it is a different job. Collapsing the header
and paging both need row one on screen *before* the next statement runs, and the
list re-measures after committing new rows — so a correction that is still gliding
is a correction that has not landed, and the reader sees a position nobody asked
for in between. `web/src/utils/smoothScroll.ts` names the two intents and owns the
schedule.

**The animation is driven in JavaScript, not by CSS.** Setting `scroll-behavior:
smooth` on the list holder looks like the natural implementation and does not
work: the list is virtualized, so the virtualizer owns that element, keeps writing
`scrollTop` on its own schedule, and wins. Measured against the real list the
holder never moved at all. So `animateScrollToTop` interpolates frame by frame and
pushes every frame through Listy's own `scrollTo`, which leaves exactly one
authority over the offset and no fight to lose. The schedule is a pure function of
elapsed time rather than an accumulator, so a dropped or late frame cannot make the
gesture drift or overshoot, and the last frame writes `0` explicitly — a
return-to-top that arrives *approximately* at the top has not returned to the top.

An animated return to the top emits scroll events the whole way up, so the page
holds the collapse state until it arrives (bounded by a deadline, in case the
reader interrupts it and it never does). Without that, the early frames — which
still carry a large `scrollTop` — would re-collapse the header on the first frame
of the very gesture that was expanding it.

### Nothing expensive rides along with the scroll

Scrolling this list is the interaction the page is used through, and the cost of a
frame is paid on every frame. Two things are therefore not allowed on any element
that is on screen while the list scrolls:

| Not allowed | Why |
| --- | --- |
| `backdrop-filter` | The compositor must re-read the pixels behind the element as those pixels change underneath it — the worst possible case for a blur, because a scroll changes them every frame. Chrome on Windows commonly resolves this in software rather than on the GPU, which is why the same build scrolls smoothly on macOS and heavily on Windows. |
| `box-shadow` | Paint cost grows with the blur radius and the area covered, and it repaints when the element moves. The console has no shadow language anyway (§1). |

The floating back-to-top pill is the case that matters: it appears *precisely* when
the reader is scrolling. It is an opaque `--surface` with a 1px border, which reads
against a busy list without either effect.

The same rule governs the entry animation: a scroll-adjacent element animates only
`opacity` and `transform`, never a property that forces layout or a repaint.

### Naming is a first-class action, not a hidden setting

Gateway keys are identified by masks (`sk-5Yalm••••••••odar`). A mask is
unreadable and, because it keeps only a short head and tail, ambiguous: two keys
can share one. So a key's **name** is the primary identifier and the mask is the
identifier of last resort.

The key-management table therefore reads name → key → use → actions. The name comes
first because it is what the operator recognises and what every other surface will
show. Where a key is unnamed the cell says so rather than sitting blank, because a
blank cell reads as missing data instead of a name nobody has set yet.

Three rules keep the two identifiers from being confused:

| Rule | Why |
| --- | --- |
| A name is a **label**, never an identity | The stored fingerprint stays the filter value. A filter that means something different from what it displays is the ambiguity the name exists to remove. Renaming must not change what a saved filter or a drill-down link selects, and duplicate names are allowed because a label need not be unique. |
| Every surface that prints a caller prints the name | List, detail, facet options and applied chips resolve it from the same key, so the dropdown and the rows it filters cannot name a key differently. |
| Unnamed falls back to the mask, never to a fingerprint | The fingerprint is a hashed identity; printing it would name a filter in a form the operator never chose. |

**Counts must state their scope.** Per-key request counts and last-used times come
from Oh My CPA's own stored events in one window, not from CPA and not from the
key's whole life. The table says so next to them: a count that reads as a lifetime
total would be a fact the system does not have. A key with no matching records
shows "not linked" rather than a fabricated `0` or an invented creation date — CPA
publishes no creation date, so any such column would be a guess rendered as data.

## 8. Checklist for new UI
- [ ] Colors only via `palette` / CSS vars; semantic colors carry meaning
- [ ] A continuous scale (cache rate) reads from its own tokens, never a
      per-component hex, and stays ≥ 4.5:1 against its own badge fill
- [ ] No shadows, no gradients, 4px radius
- [ ] Mono font inherited (never set a new font-family)
- [ ] One page title; subtitles only with live data; no zh/en duplication
- [ ] Nav position marked by 2px `--fg` left tick rule, not a filled block or semantic color
- [ ] Settings and management favor open section lists over heavy card wrappers
- [ ] Cards reserved for KPIs, summaries, and peer comparisons
- [ ] Switches use `--success` when active (green = enabled)
- [ ] Status shown with pip + text, never color alone
- [ ] Numbers tabular; empty states say what's missing (no fake data or invented workspace/account placeholders)
- [ ] A name is a label, not an identity: renaming never changes what a filter selects, and an unnamed value falls back to something recognisable rather than a hash
- [ ] Any count states its window and source; a missing observation is never rendered as a fabricated zero or date
- [ ] "Nothing to show" distinguishes its reasons: blocked (cannot serve it),
      loading (no answer yet), empty (a live source with nothing in it). One
      shared message makes a working page look broken.
- [ ] Wheel scrolls only the hovered column; page never scrolls body-wide
