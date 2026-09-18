---
name: Oh My CPA
description: Terminal-flat developer console for AI resource identity & organization
colors:
  primary: "#0579bd"          # dark mode's filled-control step; light mode uses #004a73
  primary-accent: "#00a2fb"   # dark mode's link step; light mode uses #005d8f
  primary-active: "#025e94"   # dark mode's pressed step; light mode uses #023b5d
  primary-on: "#ffffff"       # label on a filled accent control; computed per palette, near-black where white cannot clear 4.5:1
  neutral-bg: "#121214"
  neutral-surface: "#1c1c1f"
  neutral-border: "#2c2c30"
  neutral-border-soft: "#212124"
  neutral-fg: "#f4f4f6"
  neutral-fg-subtle: "#a1a1aa"
  neutral-muted: "#71717a"
  neutral-meta: "#52525b"
  status-success: "#10b981"
  status-warn: "#f59e0b"
  status-danger: "#ef4444"
  cache-yellow: "#f59e0b"
  cache-green: "#10b981"
  series-1: "#3b82f6"
  series-2: "#10b981"
  series-3: "#8b5cf6"
  series-4: "#f43f5e"
  series-5: "#f59e0b"
  series-6: "#06b6d4"
  brand-openai: "#10A37F"
  brand-codex: "#60A5FA"
  brand-claude: "#D97757"
  brand-gemini: "#A78BFA"
  border-light: "rgba(15, 0, 0, 0.12)"
typography:
  display:
    fontFamily: '"Sarasa Mono SC", "Sarasa UI SC", "Berkeley Mono", "IBM Plex Mono", monospace'
    fontSize: "42px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.04em"
  tile:
    fontFamily: '"Sarasa Mono SC", "Sarasa UI SC", "Berkeley Mono", "IBM Plex Mono", monospace'
    fontSize: "34px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.03em"
  kpi:
    fontFamily: '"Sarasa Mono SC", "Sarasa UI SC", "Berkeley Mono", "IBM Plex Mono", monospace'
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "normal"
  tile-sm:
    fontFamily: '"Sarasa Mono SC", "Sarasa UI SC", "Berkeley Mono", "IBM Plex Mono", monospace'
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  headline:
    fontFamily: '"Sarasa Mono SC", "Sarasa UI SC", "Berkeley Mono", "IBM Plex Mono", monospace'
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "normal"
  title:
    fontFamily: '"Sarasa Mono SC", "Sarasa UI SC", "Berkeley Mono", "IBM Plex Mono", monospace'
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: '"Sarasa Mono SC", "Sarasa UI SC", "Berkeley Mono", "IBM Plex Mono", monospace'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  sub:
    fontFamily: '"Sarasa Mono SC", "Sarasa UI SC", "Berkeley Mono", "IBM Plex Mono", monospace'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  data:
    fontFamily: '"Sarasa Mono SC", "Sarasa UI SC", "Berkeley Mono", "IBM Plex Mono", monospace'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  caption:
    fontFamily: '"Sarasa Mono SC", "Sarasa UI SC", "Berkeley Mono", "IBM Plex Mono", monospace'
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "normal"
  label:
    fontFamily: '"Sarasa Mono SC", "Sarasa UI SC", "Berkeley Mono", "IBM Plex Mono", monospace'
    fontSize: "10px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.16em"
rounded:
  none: "0"
  xs: "2px"
  sm: "4px"
  lg: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral-fg}"
    rounded: "{rounded.sm}"
    padding: "0 15px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.primary-accent}"
    textColor: "{colors.neutral-fg}"
    rounded: "{rounded.sm}"
    padding: "0 15px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.neutral-fg}"
    rounded: "{rounded.sm}"
    padding: "0 15px"
    height: "32px"
  input-base:
    backgroundColor: "{colors.neutral-bg}"
    textColor: "{colors.neutral-fg}"
    rounded: "{rounded.sm}"
    padding: "4px 11px"
    height: "32px"
  card-base:
    backgroundColor: "{colors.neutral-surface}"
    rounded: "{rounded.sm}"
    padding: "20px"
---

# Design System: Oh My CPA

## Overview

**Creative North Star: "The Terminal-Flat Console"**

Oh My CPA is a dedicated developer control plane for AI resources and proxy telemetry. Built upon an OpenCode-inspired minimalist console philosophy, the system delivers dense, honest, and high-frequency operational visibility without aesthetic clutter. It repudiates decorative gradients, glassmorphism, heavy shadows, and flying entrances in favor of strict terminal discipline.

Depth is achieved purely through 1px hairline borders and subtle tonal shifts between dark background tiers (`#121214` base and `#1c1c1f` elevated surface). Typography is universally monospaced across Latin, Cyrillic, and CJK characters, anchoring every token count, timestamp, and latency reading on stable tabular columns. The interface follows the doctrine of "Quiet chrome, loud data"—the surrounding scaffolding remains dark and muted, reserving saturated chromatic accents exclusively for genuine operational states.

**Key Characteristics:**
- **Terminal-Flat Structure**: Zero drop shadows (`box-shadow: none`), no rounded bubble aesthetics, crisp 1px borders.
- **Monospace Everywhere**: Sarasa Mono SC, Berkeley Mono, and IBM Plex Mono stacks across labels, titles, inputs, and tabular numbers.
- **Quiet Chrome, Loud Data**: Dark charcoal scaffolding ensures that green, amber, red, and blue badges instantly telegraph system health.
- **Immediate Feedback**: Motion budget capped at ≤ 100ms with zero spring physics, plus one 240ms `roll` exception shared by the dashboard's KPI readouts and the chart marks drawn from them; hover states land within the 50ms fast token, because a longer hover is a drag rather than an acknowledgement.

## Colors

The palette is anchored on warm charcoal darks with pure semantic status pigments and an OKLCH-interpolated continuous cache scale. A palette is **nine authored tokens and seventeen derived ones**: `web/src/theme/palette.ts` declares the authored set and computes the rest, so the six registered palettes - OMC Dark, Midnight and Forest for dark mode; OMC Light, Porcelain and Sandstone for light mode - and an operator's own are the same kind of object. The resolved palette feeds Ant Design, CSS variables, charts, the heatmap, the Monaco editor, the settings preview and the brand artwork from that one place. A theme mode (light, dark, or follow-the-system) holds one palette of its own, and an operator-authored palette is labelled «Custom» in the reading language. `omc-theme` stores the whole preference document and still reads an older build's bare palette id or bare `dark`/`light`. See `docs/adr/0011-theme-modes-and-derived-palettes.md`.

### Primary
- **Deep Accent Blue** (`#0579bd` dark / `#004a73` light): Used for filled primary action buttons and confirm controls. It provides a decisive focus point without overwhelming the dark mode.
- **Accent Ladder** (hue 201, per mode): `#00a2fb` / `#005d8f` are the link steps for dark and light, `#0579bd` / `#004a73` the filled-control steps. The accent is deliberately *not* mode-invariant: the bright step reads 6.74:1 on the dark background but only 2.71:1 on the light one, so each mode's palette uses the step that is legible there. Used for interactive links, breadcrumb highlights, active progress bars, `:focus-visible` focus rings, the brand wordmark, and the token heatmap's ramp. The ladder is *derived*: a proportional OKLCH lightness step from the authored accent, then deepened until one of white and near-black clears 4.5:1 as the filled control's label. Measured ratios are in `docs/design.md` §2.
- **Pressed Blue** (`#025e94` dark / `#023b5d` light): Used for button active/down states.

### Series (categorical)

The dashboard's model panels colour a **category**, not a state: a model is whatever upstream name the
deployment serves, so its hue carries identity and no verdict. These are the one decorative colour
family in the app, and the only exception to the semantic-only rule above; see
`docs/adr/0006-categorical-series-palette.md` and `docs/design.md` §2.

- **Slots** (`--series-1` … `--series-6`): blue `#3b82f6` / `#2563eb`, emerald `#10b981` / `#059669`,
  purple `#8b5cf6` / `#7c3aed`, coral `#f43f5e` / `#e11d48`, amber `#f59e0b` / `#b45309`, cyan
  `#06b6d4` / `#0891b2` (dark / light). Matches AntV, Tremor, and ZCode/CodeX data visualization standards.
- **Track** (`--series-track`, `#2c2c30` dark / `#e5e5ea` light): the trend's plot floor and the usage
  ring's unfilled track, which is each mode's border step.
- Every slot clears 3:1 against the card, adjacent legend entries are at least ΔE 25 apart in CIE Lab,
  and the stylesheet tokens match the derived palette character for character. All bounds are asserted by
  `scripts/test-chart-marks.ts` from the palette itself. The slots above are the OMC Dark/OMC Light pair;
  the six slots are **per-mode constants rather than derived tokens**, so every palette inherits its
  mode's set.

### Neutral
- **Console Background (`--bg`)** (`#121214`): Base canvas, table row backgrounds, input wells, and overall page substrate.
- **Graphite Surface (`--surface`)** (`#1c1c1f`): Elevated containers, cards, dropdown menus, modals, and row hover states.
- **Hairline Border (`--border`)** (`#2c2c30`): Primary 1px structural separator for cards, tables, sider borders, toolbars, and the model trend's axis rule and ticks.
- **Soft Divider (`--border-soft`)** (`#222226`): Inner item dividers, table row borders, subtle panel boundaries, and the model trend's grid rules.
- **Chalk White Text (`--fg`)** (`#f4f4f6`): Primary readable text, titles, numbers, and selected navigation items.
- **Silver Secondary Text (`--fg-2`)** (`#a1a1aa`): Secondary descriptions, field hints, subtitle text, and the model trend's axis labels.
- **Ash Muted (`--muted`)** (`#71717a`): Table column headers, units, disabled text, legend entries, and the model trend's tooltip crosshair.
- **Slate Metadata (`--meta`)** (`#52525b`): Navigation group headers, timestamps, masked keys, and footer build metadata.

### Status & Functional
- **Healthy Green (`--success`)** (`#10b981`): Active provider switches, healthy proxy instances, 100% success rate pips, and 200 OK badges.
- **Degraded Amber (`--warn`)** (`#f59e0b`): Quota thresholds, rate warnings, dirty configuration state flags, and degraded health pips.
- **Danger Red (`--danger`)** (`#ef4444`): Request failures, 4xx/5xx responses, delete confirmations, and disabled accounts.
- **Cache-Rate Scale**: Sequential gradient interpolated in OKLCH from Amber Gold (`#f59e0b`) at 0% to Emerald Green (`#10b981`) at 100%.

### Named Rules
**The Semantic Color Rule.** Color is never applied as casual visual decoration. Green, amber, and red strictly communicate boolean health, degradation, or active errors. Scaffolding, icons, and containers remain neutral.

**The Honest Cache Scale Rule.** Cache-rate indicators never display danger red. A cache miss or low hit rate is an inherent trait of novel prompts, not an infrastructure defect. Red is reserved exclusively for failed executions.

**The Palette Ink Rule.** Chart chrome the runtime would otherwise paint from its own theme — grid rules, the axis rule and its ticks, axis labels, and the tooltip's crosshair — is named from the palette and drawn at the palette's own opacity, and a mark's chart theme follows the console's mode rather than the runtime's light default. The light card is exactly the surface on which a wrong ink still looks correct, so both themes are asserted from painted pixels.

## Typography

**Display Font:** "Sarasa Mono SC", "Sarasa UI SC", "Berkeley Mono", "IBM Plex Mono", ui-monospace, monospace
**Body Font:** "Sarasa Mono SC", "Sarasa UI SC", "Berkeley Mono", "IBM Plex Mono", ui-monospace, monospace
**Label/Mono Font:** "Sarasa Mono SC", "Sarasa UI SC", "Berkeley Mono", "IBM Plex Mono", ui-monospace, monospace

**Character:** Unified, technical, and precise. The monospaced character set across Chinese, English, Malay, and code symbols gives Oh My CPA the rhythm of an interactive terminal monitor while retaining high CJK legibility.

### Hierarchy
- **Display** (700, 42px, line-height 1.1, letter-spacing -0.04em): The single prominent dashboard KPI (e.g. Total Requests, Estimated Cost).
- **Headline** (700, 22px, line-height 1.2): Main page verdict title (e.g. `Healthy.` or section navigation name).
- **Title** (600, 16px, line-height 1.3): Card section headers, drawer titles, and table group banners.
- **Body** (400, 14px, line-height 1.5): Standard body copy, form labels, input values, and status explanations.
- **Data / Mono** (400, 12–13px, line-height 1.4): Table cells, log lines, route paths, JSON/YAML values, and latency metrics.
- **Label / Eyebrow** (500, 10px, line-height 1.2, letter-spacing 0.16em, uppercase): Small metadata headers above KPI cards and navigation category headers.

### Named Rules
**The One Verdict Rule.** Exactly one top-level title is permitted per page. A subtitle is one line naming the surface's subject (e.g. `Manage upstream AI provider endpoints…`) or it carries live dynamic data (e.g. `Default CPA · Connected`) — never a restatement of the title, an instruction, marketing boilerplate, or a repetitive translation.

**The Tabular Numerals Rule.** All numbers, financial values, latency figures, and timestamps must inherit `font-variant-numeric: tabular-nums` to ensure perfectly steady columns during real-time streaming updates.

## Layout

The application viewport uses a fixed shell architecture (`100dvh`, `body { overflow: hidden }`), preventing window-level scroll jank:

```text
┌──────────┬──────────────────────────────────────────┐
│ brand ›_ │ breadcrumb (Group / Page)   actions ⟳ ◧ ▣ ⇥│ 56px, border-bottom 1px
│──────────┼──────────────────────────────────────────┤
│ nav      │                                          │
│ (236px)  │ page content        ← scrolls alone      │
│          │ (max-width: 1440px)                      │
│ foot:    │                                          │
│ CPA conn │                                          │
└──────────┴──────────────────────────────────────────┘
```

- **Top Header**: Fixed 56px height, full-width with 1px bottom border (`#2c2c30`). Contains the `›_` terminal prompt logo, breadcrumb hierarchy, and four right-aligned actions: refresh, the theme mode control, the language menu, and sign out. The mode control is a **cycling button** — light → dark → follow-the-system, one icon per state (sun, moon, desktop) — because the palettes belong to the modes and are chosen on the OMC Settings page, where each candidate repaints the console as it is picked; the language stays a **menu** over `LANGUAGES`, because four languages, one of which the reader may not read, is exactly the case a list answers. Each action keeps one width in every reading language — labels change length with the language, so sign out is an icon button named by its tooltip. CPA connection status and version are reported in the side rail's foot only.
- **Navigation Sidebar**: Fixed 236px width (58px collapsed), 1px right border. Houses grouped navigation categories: `Operate`, `Gateway`, `Observe`, `Control`.
- **Content Area**: Single-scroll container with responsive padding (32px desktop / 24px tablet / 16px mobile), inside a 1440px content column. The widths that follow: content column 1376px (1440 − 2×32), and a list inside a Card 1334px (1376 − 2×1 border − 2×20 body padding). Every page measures these; a page that needs a different column states why where the rule is written (the configuration workbench's 920px reading column is the one case).
- **Settings Workbench Layout**: A three-track grid — 216px sticky section nav + 920px reading column + 216px balancing gutter — accompanied by a full-width sticky action bar, so the form never drifts to one side on wide screens.

### Named Rules
**The Independent Column Rule.** The sider and the main content area scroll independently with `overscroll-behavior: contain`. Wheel events only affect the container currently beneath the cursor; the page never scrolls globally.

**The Gesture vs. Correction Rule.** A scroll the reader asked for (back to top, applying a new-records backlog) is animated unless `prefers-reduced-motion` is set; a scroll that exists to keep the view correct (pinning row one after the header collapses, resetting on page change) is instant, because a virtualized list re-measures after committing rows and a correction still in flight has not landed. Gesture animations are driven frame by frame through the list's own scroll entry point, never by CSS `scroll-behavior` on the holder — the virtualizer owns that element and would overwrite it.

**The Open List Rule.** Prefer border-separated open rows (`border-bottom: 1px solid var(--border-soft)`) over nested card wrappers for resource, provider, and model lists. Cards are reserved for summaries, metrics, and comparisons. A management list is one container: its head row, the rule under it, and the table are a single surface, and it scrolls sideways on narrow viewports rather than becoming a second layout.

**The One Content Column Rule.** `.terminal-page` owns the console's 1440px content column, and no page-level class may declare a `max-width` of its own: a rule of equal specificity wins by source order (CSS module styles load after the stylesheet), so `max-width: 100%` on a page root silently drops the cap and that surface renders wider than every other one. Width comes from the column; a list's inset comes from its card's 20px body padding. Where a surface deliberately reads narrower, the reason sits next to the rule that makes it so.

## Elevation & Depth

Oh My CPA is an uncompromisingly flat design system. Drop shadows (`box-shadow`) are globally suppressed across all components, panels, modals, dropdowns, and cards (`box-shadow: none`).

Depth and hierarchy are conveyed exclusively through:
1. **1px Border Contrasts**: Separating surfaces via `#2c2c30` (`--border`) and `#222226` (`--border-soft`).
2. **Background Luminance Shifts**: Stacking elements using `#121214` (substrate) and `#1c1c1f` (elevated panels).
3. **Selection Insets**: Highlighting selected items with a crisp 2px left border or inset rule (`box-shadow: inset 2px 0 0 var(--fg)`).

### Named Rules
**The Zero-Shadow Rule.** Never use drop shadows, ambient blur, or frosted glass effects to establish spatial elevation. Layering is always rendered via hairline 1px borders and tonal background steps.

**The Inset Marker Rule.** Active navigation items and row selections are marked by a 2px `--fg` inset left rule (`box-shadow: inset 2px 0 0 var(--fg)`), never by a heavy solid background pill or vibrant primary color block.

## Shapes

The geometric form language is compact, rectangular, and tightly controlled:
- **Standard Radius (`--radius-sm`)**: `4px` across all interactive elements (buttons, inputs, selects, tags, and cards).
- **Outer Shell Radius (`--radius-lg`)**: `6px` reserved strictly for modal dialogs and slide-out drawers.
- **Status Indicator Pip**: `7×7px` square with a `2px` micro-radius.
- **Borders**: Uniformly `1px solid` with no beveling or pseudo-3D outlines.

### Named Rules
**The Uniform 4px Geometry Rule.** Every interactive widget, form field, and card container in the system adheres to the 4px terminal corner radius, preserving a coherent geometric silhouette throughout the entire UI.

## Components

### Buttons
- **Shape**: 4px radius (`--radius-sm`).
- **Sizes**: Standard 32px height (padding 0 15px); Small 28px height (antd `controlHeightSM`); Square 32×32px for row-level action icon buttons.
- **Row Actions**: A row's secret-facing actions (reveal, copy, edit) stay in the open as square buttons. Actions that do not read the value — a drill-down into the row's traffic, and removal — group behind one overflow trigger of the same size. An action that cannot apply is disabled with its reason rather than hidden.
- **Primary**: Deep accent fill (`#0077b8` dark, `#004770` light) with the palette's `accentOn` label step (white in both original palettes; Forest uses a near-black step because its fill is light), no shadow. Hover shifts one step deeper (`#005d8f` dark, `#00344f` light) with zero transition lag.
- **Secondary / Default**: Surface fill (`#1c1c1f`), 1px border (`#2c2c30`), chalk white text.
- **Ghost**: Transparent background, borderless, text color `#f4f4f6`, hover reveals `#1c1c1f`.

### Cards & Setting Group Panels
- **Corner Style**: 4px radius, 1px solid border (`#2c2c30`).
- **Background**: `#1c1c1f` (`--surface`).
- **Internal Padding**: 20px (`space scale: 20px`).
- **Usage**: Restricted to KPI stats, entity summary headers, and peer comparison panels.
- **Managed Elsewhere**: A group whose field is edited on its own page states how much is configured and leads there with one action, and it still renders in search results. One editor per field; a second editor could disagree with the first.

### Caller-Key Masks
- **One Shape**: The key list computes its mask from the value in hand and the request list reads the stored one. Both use the same thresholds — a short head, a fixed `••••••••` run, a short tail — so one key renders identically on both surfaces and the mask never carries the secret's exact length.
- **Fixed Box**: The key list prints the mask and the secret inside a box whose width does not depend on the value in it, so revealing a key moves nothing in the table.
- **Ink**: Masked keys are `--meta`; a revealed secret is `--fg`. The colour says which of the two is on screen.

### Inputs & Selects
- **Style**: Dark background (`#121214`), 1px border (`#2c2c30`), 4px radius, 32px height (enhanced to 38–40px on dense configuration workbenches).
- **Focus**: Distinct cyan outline (`0 0 0 2px` of the theme's `--accent`), zero glow blur.
- **Numeric Fields**: Left-aligned with 34px right padding to ensure stepper controls never overlap number values.

### Navigation Items
- **Dimensions**: Sider items 38px height, 12px horizontal padding.
- **Normal State**: Transparent background, text `#a1a1aa`, monochrome icon.
- **Hover State**: Immediate background paint to `#1c1c1f`.
- **Active State**: 2px chalk white inset tick (`box-shadow: inset 2px 0 0 #f4f4f6`), bold white text (`#f4f4f6`), transparent background.

### Status Pips & Badges
- **Status Pip**: 7×7px square, 2px radius, paired with explicit status text (e.g. `[●] Running`). Green = healthy, Amber = degraded/warning, Red = error, Gray = offline. A pip reports whether a window needs attention, never how far a number sits from its ideal: success rate stays gray for ≤ 5% failures, amber above that, red above 20%, and a window under 20 requests with under 3 failures carries no verdict at all. Only a verdict gets a pip: the request console's Success / Failed filter segments carry one each, while All carries none.
- **Latency**: never tinted by an absolute threshold. Agent requests legitimately run for minutes, so a time-based amber rule would flag healthy traffic; the detail drawer compares TTFT against total duration instead.
- **Cache-Rate Badge**: Pill-shaped badge featuring continuous OKLCH gradient tint fill with ≥ 4.5:1 text contrast. Displays values up to `99.9%` with one decimal place. The scale is never red: a cache miss is the shape of a novel prompt, not a failed execution.
- **Token Activity Heatmap**: The dashboard's token grid is the one sequential *quantity* encoding, so it uses a **continuous** ramp of the theme accent rather than four fixed steps or any status hue — "lots of tokens" and "credential healthy" must not be the same colour, and a stepped scale paints every day between two steps identically. Brightness is the square root of the day's volume against the window's busiest day, which keeps day-to-day differences visible across the several orders of magnitude a window spans. The shape is a contribution-graph field (one row per weekday, one column per week, a year of weeks) that fills its panel via fractional CSS tracks, so it never scrolls horizontally at desktop widths and never leaves a gutter. The current week is a complete column: the days after today are drawn as normal unrecorded cells, because a day that has not happened is a day nothing is stored for. Every cell is interactive and lifts on hover with a compositor-only `transform` scale; clicking one opens its tooltip, so a day with nothing recorded says so rather than refusing the question. The tooltip prints the day's token volume in the console's token unit style, keeping the exact count on the value. The day's drill-down is a link inside the tooltip rather than the cell itself. The two zero states (recorded-but-empty, and nothing-stored) are solid fills ordered against the card at 1.04–1.06:1 and 1.16–1.22:1 (light to dark mode), never outlines — an outline over a year-long grid whose cells mostly predate the retention horizon renders as a wire mesh. The ramp is relative to the window rather than absolute, so the same shade means different volumes on two installs - which is why every cell carries its date and counts in text, and the shade is never the only encoding. DOM, not a chart mark.

### Floating Action Bar (Dirty Bar)
- **Position**: Floating fixed bar anchored 24px above the viewport bottom, centered dynamically within the content column.
- **Appearance**: 1px border (`#2c2c30`), `#1c1c1f` solid background, amber dirty pip, Save and Discard action triggers.
- **Behavior**: Appears only when `isDirty === true`; Save triggers popconfirm while Discard reverts immediately without prompt.

## Do's and Don'ts

### Do:
- **Do** import colors exclusively from the resolved palette or CSS variables (`var(--bg)`, `var(--surface)`, `var(--border)`); add a palette to the registry in `web/src/theme/palette.ts` rather than introducing palette literals in a component. The seventeen derived tokens are computed from the nine authored ones, so a component should reach for a *relationship* (the surface a tooltip sits on, the border-soft step) rather than re-deriving one.
- **Do** pair every status indicator pip with explicit text labels so colorblind users can immediately identify states.
- **Do** inherit monospaced font families across all components and enable `tabular-nums` for numeric telemetry.
- **Do** pin motion durations to ≤ 100ms and animate only `opacity` and `transform`; the dashboard's KPI numbers and chart marks are the one `roll` (240ms) exception — the numbers transform glyphs, the marks are redrawn by the canvas library and stop entirely under `prefers-reduced-motion`. The exact count stays on the tile's `title`.
- **Do** preserve previous rendered content during query filter updates using `placeholderData: keepPreviousData`.
- **Do** delay loading spinners by 200ms (`DataProgress`) to eliminate flicker on fast responses.

### Don't:
- **Don't** add drop shadows (`box-shadow: 0 4px...`) or blurred lighting effects anywhere in the application.
- **Don't** use decorative gradients, animated skeleton sweeps, or spring/bounce easing curves.
- **Don't** use danger red on the cache-rate scale; cache misses are not system execution failures.
- **Don't** hard-swap an active screen to a blank white canvas during navigation or background polling.
- **Don't** display duplicated translations side-by-side in the interface.
- **Don't** pack single settings or isolated input fields into individual card boxes.
