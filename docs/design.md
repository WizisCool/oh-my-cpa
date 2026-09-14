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

### Dark (default)

| Token | Value | antd mapping | Usage |
| --- | --- | --- | --- |
| `--bg` | `#201d1d` | `colorBgBase`, `colorBgLayout`, `colorBgContainer` | App background, inputs, tables |
| `--surface` | `#302c2c` | `colorBgElevated`, `colorFillTertiary` | Cards, panels, dropdowns, hover states |
| `--fg` | `#fdfcfc` | `colorText`, `colorTextBase` | Primary text |
| `--fg-2` | `#c8c6c4` | `colorTextSecondary` | Secondary text |
| `--muted` | `#9a9898` | `colorTextTertiary` | Hints, legends, labels |
| `--meta` | `#6e6e73` | `colorTextQuaternary` | Group labels, footnotes |
| `--border` | `#464343` | `colorBorder` | Primary 1px borders |
| `--border-soft` | `#302c2c` | `colorBorderSecondary`, `colorSplit` | Row dividers, inner borders |
| `--accent` | `#00a2fb` | `colorInfo`, `colorLink` | Links, info, active bars, selection |
| `--accent-hover` | `#0077b8` | `colorPrimary` | Filled primary buttons |
| `--accent-active` | `#005d8f` | `colorPrimaryHover/Active` | Pressed state |
| `--success` | `#30d158` | `colorSuccess` | Enabled / healthy / ok pip |
| `--warn` | `#ff9f0a` | `colorWarning` | Degraded / quota warning |
| `--danger` | `#ff3b30` | `colorError` | Failed / disabled / delete |

### Light

| Token | Value |
| --- | --- |
| `--bg` | `#fdfcfc` |
| `--surface` | `#f1eeee` |
| `--fg` | `#201d1d` |
| `--fg-2` | `#424245` |
| `--muted` | `#6e6e73` |
| `--meta` | `#9a9898` |
| `--border` | `rgba(15, 0, 0, 0.12)` |
| `--border-soft` | `rgba(15, 0, 0, 0.07)` |

### Accent ladder

The accent is **not** mode-invariant. It is one hue (201) at three lightness steps, and each theme
uses a different assignment because the same blue cannot be both legible as text on a light page and
legible as text on a dark one:

| Step | Dark | Light | Measured use |
| --- | --- | --- | --- |
| `--accent` | `#00a2fb` | `#005d8f` | link text: **6.03:1** on the dark background, **6.92:1** on the light one |
| `--accent-hover` | `#0077b8` | `#004770` | white label on a filled control: **4.85:1** and **9.83:1** |
| `--accent-active` | `#005d8f` | `#00344f` | pressed state |

The dark theme's link step is the light theme's *filled-control* step, which is the same value doing
two jobs in two themes. That is deliberate: it is the only step of this hue that clears 4.5:1 as text
on a light page, and white-on-it also clears it. The bright `#00a2fb` reads **2.71:1** on a light
page and **2.78:1** under white text, so it can only ever be the dark theme's text colour.

Brand artwork follows the same tokens: the wordmark's accent marks and its letterforms are drawn from
`palette[mode]`, so a change here moves the logo with it — see `web/src/assets/brand/markup.ts`.

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
| `--cache-rate-yellow` | `#ffd60a` | `#6e5b00` | 0% stop |
| `--cache-rate-green` | `#30d158` | `#00662a` | 100% stop |
| `--cache-rate-tint` | `12%` | `22%` | badge fill = hue over `--bg` |
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
│ brand ›_ │ breadcrumb (Group / Page)  actions  ZH|EN│ 56px, border-bottom
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
   - The right side houses live session status, theme toggling, and language switching. Never display fabricated avatars, dummy balances, or mock workspace selectors before real capabilities exist.
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

- `colorPrimary: accentHover (#0056b3)` — filled controls use the deeper step;
  `colorInfo/colorLink: accent (#007aff)`. This is why buttons don't glow
  antd-blue while links stay recognizable.
- Menu: `itemSelectedBg = transparent`, `itemSelectedColor = fg`,
  `activeBarBorderWidth: 0` — kills the default blue selected block and avoids
  heavy filled blocks; active position uses the left 2px `--fg` inset rule.
- Switch: `colorPrimary = success (#30d158)` — active toggle switch uses
  semantic success green (enabled/healthy), never decorative blue.
- Modal & Drawer: `1px solid var(--border)`, zero shadow, 4px/6px radii. Simple
  single-task dialogs use a clean uninterrupted body ("Title → Field/Content →
  Right-aligned Actions") without decorative header/footer hairline dividers;
  only complex Drawers retain section dividers.
- Table: uppercase 12px `--muted` headers on `--bg`, `rowHoverBg = surface`.
- All shadow tokens set to `'none'`; every motion token pinned to ≤ 0.1s (§7).
- Components pinned: Button 32/28px, Input active ring `accent22`,
  Select optionSelectedBg = surface, Tag defaultBg = bg.
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
  initial login shell compact. Theme tokens (`palette[mode]`) are bridged into the chart
  config (`sparkColor(mode, tone)`), default library animations are explicitly disabled
  (`animate: false`, per §7 rule 5), and the hover readout uses an app-owned HTML
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
  every per-tile assertion.

## 7. Motion

```text
hover / state colour   none — it paints the frame the pointer arrives
fast    50ms    antd motionDurationFast
base    100ms   antd motionDurationMid and Slow: drawers, modals, route and data transitions
float   60ms    popovers and dropdowns — the click already said "open"
ease    cubic-bezier(0.2, 0, 0, 1)
```

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
   Background auto-refresh should be invisible.
5. **Charts do not animate.** Sparkline geometry swaps on the data revision
   with no transition or entrance animation; a line snapping to new data reads
   as honest, not janky.
6. **Feedback must be immediate.** Optimistic affordances (button `loading`,
   the progress bar) appear on the interaction itself, not after a transition.
7. **Hover is not an animation.** A hover is the interface acknowledging the
   pointer, so it paints on the frame the pointer arrives — never a transition
   on a hover colour. The trap: antd hangs menu-item hover, submenu expand and
   the sider collapse off `motionDurationSlow`, whose default is 0.3s, and
   setting only Fast/Mid leaves the nav feeling drags. All three tokens are
   pinned ≤ 0.1s in `themeConfig.ts`.

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
| Auto-refresh poll | Nothing moves. The poll is not a view change, so it must not reset pagination, remount the list, expand a collapsed header, or relabel the data as "previous results". |

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
