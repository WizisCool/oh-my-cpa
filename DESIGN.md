---
name: Oh My CPA
description: Terminal-flat developer console for AI resource identity & organization
colors:
  primary: "#0056b3"
  primary-accent: "#00a2fb"   # dark theme; light theme uses #005d8f
  primary-active: "#004085"
  neutral-bg: "#201d1d"
  neutral-surface: "#302c2c"
  neutral-border: "#464343"
  neutral-border-soft: "#302c2c"
  neutral-fg: "#fdfcfc"
  neutral-fg-subtle: "#c8c6c4"
  neutral-muted: "#9a9898"
  neutral-meta: "#6e6e73"
  status-success: "#30d158"
  status-warn: "#ff9f0a"
  status-danger: "#ff3b30"
  cache-yellow: "#ffd60a"
  cache-green: "#30d158"
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

Oh My CPA is a dedicated developer control plane for AI resources and proxy telemetry. Built upon an OpenCode-inspired minimalist console philosophy, the system delivers dense, honest, and high-frequency operational visibility without aesthetic clutter. It repudiates decorative gradients, glassmorphism, heavy shadows, and artificial entrance animations in favor of strict terminal discipline.

Depth is achieved purely through 1px hairline borders and subtle tonal shifts between dark background tiers (`#201d1d` base and `#302c2c` elevated surface). Typography is universally monospaced across Latin, Cyrillic, and CJK characters, anchoring every token count, timestamp, and latency reading on stable tabular columns. The interface follows the doctrine of "Quiet chrome, loud data"—the surrounding scaffolding remains dark and muted, reserving saturated chromatic accents exclusively for genuine operational states.

**Key Characteristics:**
- **Terminal-Flat Structure**: Zero drop shadows (`box-shadow: none`), no rounded bubble aesthetics, crisp 1px borders.
- **Monospace Everywhere**: Sarasa Mono SC, Berkeley Mono, and IBM Plex Mono stacks across labels, titles, inputs, and tabular numbers.
- **Quiet Chrome, Loud Data**: Dark charcoal scaffolding ensures that green, amber, red, and blue badges instantly telegraph system health.
- **Immediate Feedback**: Motion budget capped at ≤ 100ms with zero spring physics; hover states paint on pointer arrival.

## Colors

The palette is anchored on warm charcoal darks with pure semantic status pigments and an OKLCH-interpolated continuous cache scale.

### Primary
- **Deep Accent Blue** (`#0056b3`): Used for filled primary action buttons and confirm controls. It provides a decisive focus point without overwhelming the dark theme.
- **Accent Ladder** (hue 201, per theme): `#00a2fb` / `#005d8f` are the link steps for the dark and light themes, `#0077b8` / `#004770` the filled-control steps. The accent is deliberately *not* mode-invariant: the bright step reads 6.03:1 on the dark background but only 2.71:1 on the light one, so each theme uses the step that is legible there. Used for interactive links, breadcrumb highlights, active progress bars, `:focus-visible` focus rings, the brand wordmark, and the token heatmap's ramp. Measured ratios are in `docs/design.md` §2.
- **Pressed Blue** (`#004085`): Used for button active/down states.

### Neutral
- **Console Background (`--bg`)** (`#201d1d`): Base canvas, table row backgrounds, input wells, and overall page substrate.
- **Graphite Surface (`--surface`)** (`#302c2c`): Elevated containers, cards, dropdown menus, modals, and row hover states.
- **Hairline Border (`--border`)** (`#464343`): Primary 1px structural separator for cards, tables, sider borders, and toolbars.
- **Soft Divider (`--border-soft`)** (`#302c2c`): Inner item dividers, table row borders, and subtle panel boundaries.
- **Chalk White Text (`--fg`)** (`#fdfcfc`): Primary readable text, titles, numbers, and selected navigation items.
- **Silver Secondary Text (`--fg-2`)** (`#c8c6c4`): Secondary descriptions, field hints, and subtitle text.
- **Ash Muted (`--muted`)** (`#9a9898`): Table column headers, units, disabled text, and legend entries.
- **Slate Metadata (`--meta`)** (`#6e6e73`): Navigation group headers, timestamps, masked keys, and footer build metadata.

### Status & Functional
- **Healthy Green (`--success`)** (`#30d158`): Active provider switches, healthy proxy instances, 100% success rate pips, and 200 OK badges.
- **Degraded Amber (`--warn`)** (`#ff9f0a`): Quota thresholds, rate warnings, dirty configuration state flags, and degraded health pips.
- **Danger Red (`--danger`)** (`#ff3b30`): Request failures, 4xx/5xx responses, delete confirmations, and disabled accounts.
- **Cache-Rate Scale**: Sequential gradient interpolated in OKLCH from Ochre Yellow (`#ffd60a`) at 0% to Terminal Green (`#30d158`) at 100%.

### Named Rules
**The Semantic Color Rule.** Color is never applied as casual visual decoration. Green, amber, and red strictly communicate boolean health, degradation, or active errors. Scaffolding, icons, and containers remain neutral.

**The Honest Cache Scale Rule.** Cache-rate indicators never display danger red. A cache miss or low hit rate is an inherent trait of novel prompts, not an infrastructure defect. Red is reserved exclusively for failed executions.

## Typography

**Display Font:** "Sarasa Mono SC", "Sarasa UI SC", "Berkeley Mono", "IBM Plex Mono", ui-monospace, monospace
**Body Font:** "Sarasa Mono SC", "Sarasa UI SC", "Berkeley Mono", "IBM Plex Mono", ui-monospace, monospace
**Label/Mono Font:** "Sarasa Mono SC", "Sarasa UI SC", "Berkeley Mono", "IBM Plex Mono", ui-monospace, monospace

**Character:** Unified, technical, and precise. The monospaced character set across Chinese, English, and code symbols gives Oh My CPA the rhythm of an interactive terminal monitor while retaining high CJK legibility.

### Hierarchy
- **Display** (700, 42px, line-height 1.1, letter-spacing -0.04em): The single prominent dashboard KPI (e.g. Total Requests, Estimated Cost).
- **Headline** (700, 22px, line-height 1.2): Main page verdict title (e.g. `Healthy.` or section navigation name).
- **Title** (600, 16px, line-height 1.3): Card section headers, drawer titles, and table group banners.
- **Body** (400, 14px, line-height 1.5): Standard body copy, form labels, input values, and status explanations.
- **Data / Mono** (400, 12–13px, line-height 1.4): Table cells, log lines, route paths, JSON/YAML values, and latency metrics.
- **Label / Eyebrow** (500, 10px, line-height 1.2, letter-spacing 0.16em, uppercase): Small metadata headers above KPI cards and navigation category headers.

### Named Rules
**The One Verdict Rule.** Exactly one top-level title is permitted per page. Subtitles exist strictly to carry live dynamic data (e.g. `Default CPA · Connected`), never static marketing boilerplate or repetitive translations.

**The Tabular Numerals Rule.** All numbers, financial values, latency figures, and timestamps must inherit `font-variant-numeric: tabular-nums` to ensure perfectly steady columns during real-time streaming updates.

## Layout

The application viewport uses a fixed shell architecture (`100dvh`, `body { overflow: hidden }`), preventing window-level scroll jank:

```text
┌──────────┬──────────────────────────────────────────┐
│ brand ›_ │ breadcrumb (Group / Page)  actions  ZH|EN│ 56px, border-bottom 1px
│──────────┼──────────────────────────────────────────┤
│ nav      │                                          │
│ (236px)  │ page content        ← scrolls alone      │
│          │ (max-width: 1440px)                      │
│ foot:    │                                          │
│ CPA conn │                                          │
└──────────┴──────────────────────────────────────────┘
```

- **Top Header**: Fixed 56px height, full-width with 1px bottom border (`#464343`). Contains the `›_` terminal prompt logo, breadcrumb hierarchy, connection status pill, discovery refresh, theme toggle, language switch, and logout triggers.
- **Navigation Sidebar**: Fixed 236px width (58px collapsed), 1px right border. Houses grouped navigation categories: `Operate`, `Gateway`, `Observe`, `Control`.
- **Content Area**: Single-scroll container with responsive padding (32px desktop / 24px tablet / 16px mobile).
- **Settings Workbench Layout**: A three-track grid — 216px sticky section nav + 920px reading column + 216px balancing gutter — accompanied by a full-width sticky action bar, so the form never drifts to one side on wide screens.

### Named Rules
**The Independent Column Rule.** The sider and the main content area scroll independently with `overscroll-behavior: contain`. Wheel events only affect the container currently beneath the cursor; the page never scrolls globally.

**The Gesture vs. Correction Rule.** A scroll the reader asked for (back to top, applying a new-records backlog) is animated unless `prefers-reduced-motion` is set; a scroll that exists to keep the view correct (pinning row one after the header collapses, resetting on page change) is instant, because a virtualized list re-measures after committing rows and a correction still in flight has not landed. Gesture animations are driven frame by frame through the list's own scroll entry point, never by CSS `scroll-behavior` on the holder — the virtualizer owns that element and would overwrite it.

**The Open List Rule.** Prefer border-separated open rows (`border-bottom: 1px solid var(--border-soft)`) over nested card wrappers for resource, provider, and model lists. Cards are reserved for summaries, metrics, and comparisons.

## Elevation & Depth

Oh My CPA is an uncompromisingly flat design system. Drop shadows (`box-shadow`) are globally suppressed across all components, panels, modals, dropdowns, and cards (`box-shadow: none`).

Depth and hierarchy are conveyed exclusively through:
1. **1px Border Contrasts**: Separating surfaces via `#464343` (`--border`) and `#302c2c` (`--border-soft`).
2. **Background Luminance Shifts**: Stacking elements using `#201d1d` (substrate) and `#302c2c` (elevated panels).
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
- **Primary**: Deep accent fill (`#0056b3`), white text, no shadow. Hover shifts to `#004085` with zero transition lag.
- **Secondary / Default**: Surface fill (`#302c2c`), 1px border (`#464343`), chalk white text.
- **Ghost**: Transparent background, borderless, text color `#fdfcfc`, hover reveals `#302c2c`.

### Cards & Setting Group Panels
- **Corner Style**: 4px radius, 1px solid border (`#464343`).
- **Background**: `#302c2c` (`--surface`).
- **Internal Padding**: 20px (`space scale: 20px`).
- **Usage**: Restricted to KPI stats, entity summary headers, and peer comparison panels.

### Inputs & Selects
- **Style**: Dark background (`#201d1d`), 1px border (`#464343`), 4px radius, 32px height (enhanced to 38–40px on dense configuration workbenches).
- **Focus**: Distinct cyan outline (`0 0 0 2px #007aff`), zero glow blur.
- **Numeric Fields**: Left-aligned with 34px right padding to ensure stepper controls never overlap number values.

### Navigation Items
- **Dimensions**: Sider items 38px height, 12px horizontal padding.
- **Normal State**: Transparent background, text `#c8c6c4`, monochrome icon.
- **Hover State**: Immediate background paint to `#302c2c`.
- **Active State**: 2px chalk white inset tick (`box-shadow: inset 2px 0 0 #fdfcfc`), bold white text (`#fdfcfc`), transparent background.

### Status Pips & Badges
- **Status Pip**: 7×7px square, 2px radius, paired with explicit status text (e.g. `[●] Running`). Green = healthy, Amber = degraded/warning, Red = error, Gray = offline. A pip reports whether a window needs attention, never how far a number sits from its ideal: success rate stays gray for ≤ 5% failures, amber above that, red above 20%, and a window under 20 requests with under 3 failures carries no verdict at all. Only a verdict gets a pip: the request console's Success / Failed filter segments carry one each, while All carries none.
- **Latency**: never tinted by an absolute threshold. Agent requests legitimately run for minutes, so a time-based amber rule would flag healthy traffic; the detail drawer compares TTFT against total duration instead.
- **Cache-Rate Badge**: Pill-shaped badge featuring continuous OKLCH gradient tint fill with ≥ 4.5:1 text contrast. Displays values up to `99.9%` with one decimal place. The scale is never red: a cache miss is the shape of a novel prompt, not a failed execution.

### Floating Action Bar (Dirty Bar)
- **Position**: Floating fixed bar anchored 24px above the viewport bottom, centered dynamically within the content column.
- **Appearance**: 1px border (`#464343`), `#302c2c` solid background, amber dirty pip, Save and Discard action triggers.
- **Behavior**: Appears only when `isDirty === true`; Save triggers popconfirm while Discard reverts immediately without prompt.

## Do's and Don'ts

### Do:
- **Do** import colors exclusively from `palette` or CSS variables (`var(--bg)`, `var(--surface)`, `var(--border)`).
- **Do** pair every status indicator pip with explicit text labels so colorblind users can immediately identify states.
- **Do** inherit monospaced font families across all components and enable `tabular-nums` for numeric telemetry.
- **Do** pin motion durations to ≤ 100ms and animate only `opacity` and `transform`.
- **Do** preserve previous rendered content during query filter updates using `placeholderData: keepPreviousData`.
- **Do** delay loading spinners by 200ms (`DataProgress`) to eliminate flicker on fast responses.

### Don't:
- **Don't** add drop shadows (`box-shadow: 0 4px...`) or blurred lighting effects anywhere in the application.
- **Don't** use decorative gradients, animated skeleton sweeps, or spring/bounce easing curves.
- **Don't** use danger red on the cache-rate scale; cache misses are not system execution failures.
- **Don't** hard-swap an active screen to a blank white canvas during navigation or background polling.
- **Don't** display duplicated English and Chinese text strings side-by-side in the interface.
- **Don't** pack single settings or isolated input fields into individual card boxes.
