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
  effort-1: "#94bfce"         # reasoning-effort scale, minimal → max; light mode uses the darker steps
  effort-2: "#4eccd3"
  effort-3: "#91b7fe"
  effort-4: "#bda7fe"
  effort-5: "#f08dee"
  effort-6: "#ff8cc1"
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
- **Immediate Feedback**: Motion budget capped at ≤ 100ms with zero spring physics, plus one 240ms `roll` exception shared by the dashboard's KPI readouts and the chart marks drawn from them, and a JavaScript-only 160ms `scroll` token for wheel notches and scrolling keys gliding to where they would have jumped; hover states land within the 50ms fast token, because a longer hover is a drag rather than an acknowledgement.

## Colors

The palette is anchored on warm charcoal darks with pure semantic status pigments and an OKLCH-interpolated continuous cache scale. A palette is **nine authored tokens and seventeen derived ones**: `web/src/theme/palette.ts` declares the authored set and computes the rest, so the six registered palettes - OMC Dark, Midnight and Forest for dark mode; OMC Light, Porcelain and Sandstone for light mode - and an operator's own are the same kind of object. The resolved palette feeds Ant Design, CSS variables, charts, the heatmap, the Monaco editor, the settings preview and the brand artwork from that one place. A theme mode (light, dark, or follow-the-system) holds one palette of its own, and an operator-authored palette is labelled «Custom» in the reading language. `omc-theme` stores the whole preference document and still reads an older build's bare palette id or bare `dark`/`light`. See `docs/adr/0011-theme-modes-and-derived-palettes.md`.

### Primary
- **Deep Accent Blue** (`#0579bd` dark / `#004a73` light): Used for filled primary action buttons and confirm controls. It provides a decisive focus point without overwhelming the dark mode.
- **Accent Ladder** (hue 201, per mode): `#00a2fb` / `#005d8f` are the link steps for dark and light, `#0579bd` / `#004a73` the filled-control steps. The accent is deliberately *not* mode-invariant: the bright step reads 6.74:1 on the dark background but only 2.71:1 on the light one, so each mode's palette uses the step that is legible there. Used for interactive links, breadcrumb highlights, active progress bars, `:focus-visible` focus rings, the brand wordmark, the trailing corner of the square brand mark (collapsed rail, Agent authorization page, favicon), and the token heatmap's ramp. The ladder is *derived*: a proportional OKLCH lightness step from the authored accent, then deepened until one of white and near-black clears 4.5:1 as the filled control's label. Measured ratios are in `docs/design.md` §2.
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


### Reasoning effort (ordinal)

The request list colours a request's reasoning effort on one cool sweep, quiet at the bottom and
saturated at the top; see `docs/design.md` §2.

- **Steps** (`--effort-1` … `--effort-6`, `minimal` → `max`): slate `#94bfce` / `#39626e`, teal
  `#4eccd3` / `#00686c`, blue `#91b7fe` / `#3057a3`, violet `#bda7fe` / `#6343a4`, magenta `#f08dee`
  / `#8a2b8a`, pink `#ff8cc1` / `#9b2065` (dark / light). `none` and any level the vendors do not
  publish stay at the neutral step, `--fg-2`: plain, and as legible as the scale.
- The sweep never enters green, amber or red, which are verdicts; the level's name is always printed
  beside the colour. Each step clears 4.5:1 as badge text on its own tint in every registered
  palette, asserted by `scripts/test-effort-scale.ts`.

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
- **Healthy Green (`--success`)** (`#10b981`): Active provider switches, healthy proxy instances, success-rate pips at 80% or better, and 200 OK badges.
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
│ wordmark │ nav / breadcrumb       GitHub + actions   │ 56px, border-bottom 1px
│──────────┼──────────────────────────────────────────┤
│ nav      │                                          │
│ (236px)  │ page content        ← scrolls alone      │
│          │ (max-width: 1440px)                      │
│ foot:    │                                          │
│ CPA conn │                                          │
└──────────┴──────────────────────────────────────────┘
```

- **Top Header**: Fixed 56px height, full-width with 1px bottom border (`#2c2c30`). Contains the navigation toggle, breadcrumb hierarchy, and five right-aligned actions: the project GitHub link, refresh, the theme mode control, the language menu, and sign out. The mode control is a **cycling button** — light → dark → follow-the-system, one icon per state (sun, moon, desktop) — because the palettes belong to the modes and are chosen on the OMC Settings page, where each candidate repaints the console as it is picked; the language stays a **menu** over `LANGUAGES`, because four languages, one of which the reader may not read, is exactly the case a list answers. The project GitHub link uses the existing local Octicons mark and opens `https://github.com/WizisCool/oh-my-cpa` in a new tab with `noopener noreferrer`; its tooltip and accessible name follow the reading language, and it remains available in the demonstration. Each action keeps one width in every reading language — labels change length with the language, so sign out is an icon button named by its tooltip. On phones the action cluster keeps its full control widths with a 4px gap and 12px safe-area-aware edge padding; the navigation toggle does not shrink, and the current breadcrumb truncates with an ellipsis rather than overlapping actions. CPA connection status and version are reported in the side rail's foot only.
- **Navigation Sidebar**: Fixed 236px width (58px collapsed), 1px right border. Houses grouped navigation categories: `Operate`, `Gateway`, `Observe`, `Control`.
- **Navigation Sheet (phone)**: Below 900px the rail becomes a left sheet of `min(320px, 86vw)`, carrying the same three parts — brand, grouped nav, then the CPA connection and version. There is no bottom bar and no phone-specific menu: a phone has less room, not less to navigate, and a second navigation is a second place for the grouping to drift. The `vw` bound matters at a 320px viewport, where a fixed 320px sheet would leave no page visible behind the mask.
- **Content Area**: Single-scroll container with responsive padding (32px desktop / 24px tablet / 16px mobile), inside a 1440px content column. The widths that follow: content column 1376px (1440 − 2×32), and a list frame 1376px (every list is its own hairline frame, or the body of a card that is). Every page measures these; a page that needs a different column states why where the rule is written (the configuration workbench's 920px reading column is the one case).
- **Settings Workbench Layout**: A three-track grid — 216px sticky section nav + 920px reading column + 216px balancing gutter — accompanied by a full-width sticky action bar, so the form never drifts to one side on wide screens.

### Small Viewports & Touch

The console is operated from a phone as well as a desktop, and the phone is treated as its own device rather than a narrow desktop.

**Two viewport breakpoints, one container threshold.** `900px` — the shell changes shape (the rail becomes a sheet, page head and grid columns stack). `640px` — the device is a phone (list surfaces render labelled rows instead of a table, controls take their touch sizes). `920px` **container** (`reqstream`) — the request list's own width no longer fits its columns, so each record becomes a stacked row. The third is a container query on purpose: that list lives inside the content column, so the same viewport holds a different list width depending on whether the rail is open, and "do the columns fit" is a question only the box can answer. Above it the list folds columns instead of scrolling sideways: user agent, caller key, speed, cache rate and mode leave in that order as the measured width runs out, while time, result, provider, model, latency, tokens and cost stay until the stack.

- **A finger has no hover.** Every `:hover` reveal carries a `@media (hover: none)` counterpart that draws it permanently (`.provider-jump-arrow`, `.req-id-quick-copy`). A tooltip may name a control, never be the only way to reach one.
- **The tap floor is a hit area, not a drawn size.** `space scale 4 · 8 · 12 · 16 · 20 · 24 · 32 · 48px` is what the density *is*, so a 28×28 control keeps its size and gains `::before { inset: -4px }` under `(pointer: coarse)`. Tabs and segmented items grow vertically only, since edge-to-edge neighbours would lose taps to a horizontal inset. antd's small switch grows to 44×22 because the floor needs real dimensions; number steppers (measured 1×19px) and the request list's column resizer are hidden on touch, where a drag near a header edge means "scroll".
- **16px is the focus floor.** iOS Safari zooms the page when a focused field is under 16px, and the base size is 14px, so under `(pointer: coarse)` every focusable text control takes 16px. The declaration carries `!important` because antd injects its component styles at runtime, after the stylesheet: an equal-specificity rule loses on source order. The *displayed* text of a Select keeps its token size, because the browser reads the size of the element it focuses.
- **Pinch-zoom is never disabled.** `maximum-scale=1` and `user-scalable=no` are absent on purpose.
- **A page never moves sideways.** The content pane scrolls vertically only on a phone; a code block, a wide table, the heatmap, and a strip of choices that cannot wrap (price-book filters, configuration section nav) swipe inside their own frames with `overscroll-behavior-x: contain`. The conversation transcript clips horizontally as a backstop, and its capability steps are bounded by the column.
- **The composer starts at one line.** It grows to ten lines on desktop, with the action in its foot. Below 640px it grows to five lines with the action beside the input, and keeps a foot row only for a control that needs one. User message text has no paragraph margins inside its padded bubble.
- **The source editor is a phone surface too.** Monaco owns text/widget geometry through its API. At 640px and below use 16px text / 24px lines, a two-character number gutter, no folding/decorations/minimap/overview ruler, and `wrappingIndent: 'none'`. Wrapping defaults on for phones and off for desktop; a visible manual choice lasts for the source session. Find/wrap/focus are direct; format/copy/statistics use tools. The same Monaco instance enters a focused region bounded by `visualViewport`, with dirty-only measured actions and Back/focus restoration. See the content-first phone contract below.
- **The viewport is not a fixed rectangle.** `viewport-fit=cover` is declared so `env(safe-area-inset-*)` resolves, and the insets go on chrome that touches a screen edge — never on a scroll container. Heights that decide how much data fits use `dvh`, not `vh`, because the mobile URL bar changes `100vh` continuously. `touch-action: manipulation` goes on controls, not on the page.

### Named Rules
**The Finger Is Not a Cursor Rule.** A control that a finger must reach is drawn where a finger can reach it: never revealed only by a hover, never smaller than 16px of text if it can take focus, and at least ~40px after its hit area if it is small in *both* dimensions. A control that is wide — a labelled button, or any of the console's 32px-tall buttons — is aimable even when it is short, so it keeps its box: requiring 40px of height from every button would assert a change the design system deliberately does not make. Nothing is enlarged unless it cannot be rescued by a hit area — the drawn size is the density and is not the knob. The rule's selector list is a maintenance surface: it must name the console's own dense controls as well as antd's icon-only variant, and a browser probe asserts the slop rather than trusting the list.

**The Glide Rule.** A wheel notch or a scrolling key glides over the `scroll` token (160ms, easeOutCubic) on every platform, the virtualized request list included; trackpads and Apple-platform pixel wheels already glide and are never intercepted, and touch is never glided (a finger on the request list is the Finger Moves the List Rule). A glide never adds lag to the reader's hand: it moves on its first frame, the request list starts on the frame its own jump would have, and a turning wheel moves the list on every frame until it lands. The glide is input following the reader's hand, so it stays on under `prefers-reduced-motion` by default; the **Smooth scrolling** setting (`On` / `Follow system` / `Off`) hands it to the system or turns it off. See `docs/design.md` §7 and ADRs 0046 and 0047.

**Request-list mount sizing.** The initial virtual-row estimate is 68px via Listy's component token (22px font height plus twice 23px block padding). The wrapper retains zero CSS padding; the request-row CSS owns visible geometry. The virtualizer still measures actual item and group-header heights, including phone rows. Each row declares `contain: layout style` so that measurement stays inside the row; a row is the containing block for anything positioned in it, so row-level popups belong to the list or a portal.

**The Finger Moves the List Rule.** On a phone the request page fits the screen and its virtualized list is the only scroller, so no drag can scroll or bounce the page around it. The list moves exactly with the finger, coasts after a flick at iOS's rate, and stops on a tap on the list without opening a row; while the list is shown, the first drag up folds the filter header away and a 48px pull past the top brings it back, and on a loading or empty page a 48px pull anywhere does. See `docs/design.md` §8 and ADR 0048.

**The Independent Column Rule.** The sider and the main content area scroll independently with `overscroll-behavior: contain`. Wheel events only affect the container currently beneath the cursor; the page never scrolls globally.

**The Gesture vs. Correction Rule.** A scroll the reader asked for (back to top, applying a new-records backlog) is animated unless `prefers-reduced-motion` is set; a scroll that exists to keep the view correct (pinning row one after the header collapses, resetting on page change) is instant, because a virtualized list re-measures after committing rows and a correction still in flight has not landed. Gesture animations are driven frame by frame through the list's own scroll entry point, never by CSS `scroll-behavior` on the holder — the virtualizer owns that element and would overwrite it.

**The Unified Credential Workspace Density Rule.** OAuth sign-in, credential management and quota reading share one credential collection. The list presents a scan-first overview: identity, management state and metadata, quota condition, plan, observation age and the credential's own model family as its five-hour and weekly windows - each a labelled bar carrying its share, with its reset on the line below. A group's window is named from the period it covers when the provider sends no kind, so the row reads in the console's language whatever the provider labelled. The row carries one visible action beside its enable switch; models, editing, a quota refresh, a cooldown release, download and delete sit in the row menu, because a row is a reading and not a stack of buttons. A menu entry names its action and never the file name, which would stretch the menu to whatever the longest credential is called; the file name belongs to the confirmation, where it identifies the target. A refresh reports itself once, as a toast: a run without a failure is an acknowledgement that leaves on its own, and a run with a failing target is a report toast that lists each target's reason and stays until it is closed. Redeeming a banked reset credit is not a row action at all: it is irreversible and spends an entitlement, so only the Drawer's Quota tab offers it, beside the credit expiries it consumes. One Details action opens the complete reading - every family, credit, cooldown and diagnostic - in the credential Drawer. The overview floor is six complete credential records at 1440x900: the row is allowed its height, because reading a credential matters more than fitting as many of them as possible. The Drawer separates Quota, Configuration and Models into tabs; only the selected task is visible. Configuration drafts survive tab changes and remain guarded when closing from any tab. Safe fields and models are fetched only when their respective tabs are selected. Search stays visible, additional filters are disclosed on demand, and pagination owns page size. Provider tabs show populated families plus the selected family; empty providers remain available in Connect. Record boundaries are visible, status colors remain semantic, and model/group labels and ordering survive full quota rendering.  Full quota completeness is verified in the Quota tab, including six model/group windows, with no horizontal overflow in the list or Drawer at 320px. Compact window footers wrap long capacity estimates, including previous-cycle token-only values in full-digit style, within their own window rather than clipping digits or widening the page.

**The Open List Rule.** Prefer border-separated open rows (`border-bottom: 1px solid var(--border-soft)`) over nested card wrappers for resource, provider, and model lists. Cards are reserved for summaries, metrics, and comparisons. A management list is one container: its head row, the rule under it, and the list are a single surface.

**The One Dataset, Rendered Responsively Rule.** A list is a table above `640px` and labelled rows at `640px` and below — chosen by width, never by a control the operator has to find. The threshold was fixed by measurement: at 390px a key table measured 316 → 980px inside its card and put the reveal, copy and edit controls 664px off the screen, with no affordance saying it scrolled. Both renderings come from one column array (`web/src/components/common/phoneRowFields.ts`), so a column added to the table reaches the row and a value cannot be formatted two ways. See ADR 0012 for the threshold, its measurement and the alternatives it was chosen over.

**The One Content Column Rule.** `.terminal-page` owns the console's 1440px content column, and no page-level class may declare a `max-width` of its own: a rule of equal specificity wins by source order (CSS module styles load after the stylesheet), so `max-width: 100%` on a page root silently drops the cap and that surface renders wider than every other one. Width comes from the column; a list spans it inside its own hairline frame, or runs flush to the edges of the card that frames it. Where a surface deliberately reads narrower, the reason sits next to the rule that makes it so.

**The One Page Chrome Rule.** Every route opens with `PageHeader`: one title, a line under it only when that line carries live data (no echo subtitles, footnotes or field hints that restate what is on screen), and right-aligned actions at the default 32px height with the primary action last. Refresh is always `RefreshButton` (the header's rotate glyph, spinning while a read is in flight rather than locking); a state is `StatusLabel` (pip + word, never a filled tag); row actions are quiet 28px squares that take the accent - or the danger colour, for a destructive one - only on hover; a list is `ResponsiveList`, which scrolls a wide table sideways only so the wheel over a list still scrolls the page, and every wide list shares the OAuth list's surface - a hairline frame, a mono uppercase header strip on `--surface`, rows on `--bg` split by `--border-soft` rules (`.data-table`). A list summarised before it is listed opens with `StatTiles` - counted tiles that double as its filter, a count painted in its tone only when non-zero - with the `.logs-toolbar` strip under them (the audit trail, the AI provider list); an open-ended counted set (the audit categories) stays a `Select` whose options carry the count; a record opens in a Drawer from its row rather than expanding in place; a list grouped by a heading is one frame per group with the column names drawn once. Stacked blocks share the `.terminal-page-stack` rhythm (16px, 24px under the head). See `docs/design.md` §5 "Page chrome".

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
- **Thread Scale** (conversation workspaces and the approval card only, ADR 0081 refined by ADR 0086): `--radius-document` 4px for printed matter, `--radius-control` 4px for what is pressed, `--radius-surface` 6px for field panels and floating lists, `--radius-thread` 8px for the composer, the operator's bubble, cards and suggestions; grouping by `--thread-field` (`--fg` at 5%, 8% on hover) and one `--thread-hairline` edge (`--fg` at 12%), radii owned by `THREAD_RADII` (also used by HTML conversation exports), fills derived from the palette by `THREAD_FILL_SHARES` and `themePaletteCssVariables`, with pre-hydration defaults in `web/src/index.css`.
- **Status Indicator Pip**: `7×7px` square with a `2px` micro-radius.
- **Borders**: Uniformly `1px solid` with no beveling or pseudo-3D outlines.

### Named Rules
**The Uniform 4px Geometry Rule.** Every interactive widget, form field, and card container in the system adheres to the 4px terminal corner radius (the conversation thread follows its own scale, above), preserving a coherent geometric silhouette throughout the entire UI.

## Components

### Buttons
- **Shape**: 4px radius (`--radius-sm`).
- **Sizes**: Standard 32px height (padding 0 15px); Small 28px height (antd `controlHeightSM`); Square 28×28px for row-level action icon buttons.
- **Row Actions**: A row's secret-facing actions (reveal, copy, edit) stay in the open as square buttons. Actions that do not read the value — a drill-down into the row's traffic, and removal — group behind one overflow trigger of the same size. An action that cannot apply is disabled with its reason rather than hidden.
- **Installed Plugin Actions**: Configuration and overflow are matching 28px row-action buttons. The enable switch is separated from the action pair by a quiet rule. Repository/homepage links and uninstall sit in the overflow menu; uninstall confirms against the same row with a danger confirmation button. Cancel and Escape return keyboard focus to the row action. Existing palette and motion tokens are reused. The credential-handling capability badge says "Auth provider", without claiming an OAuth login method. The OAuth connection picker uses plugin names without an OAuth suffix and a "Plugin-managed" method tag. Registered plugin pages take precedence through "Open plugin page"; pageless providers resolve device/redirect controls only after a successful explicit login request.
- **Primary**: Deep accent fill (`#0077b8` dark, `#004770` light) with the palette's `accentOn` label step (white in both original palettes; Forest uses a near-black step because its fill is light), no shadow. Hover shifts one step deeper (`#005d8f` dark, `#00344f` light) with zero transition lag.
- **Secondary / Default**: Surface fill (`#1c1c1f`), 1px border (`#2c2c30`), chalk white text.
- **Ghost**: Transparent background, borderless, text color `#f4f4f6`, hover reveals `#1c1c1f`.

### Cards & Setting Group Panels
- **Corner Style**: 4px radius, 1px solid border (`#2c2c30`).
- **Background**: `#1c1c1f` (`--surface`).
- **Internal Padding**: 20px (`space scale: 20px`).
- **Usage**: Restricted to KPI stats, entity summary headers, and peer comparison panels.
- **Managed Elsewhere**: A group whose field is edited on its own page states how much is configured and leads there with one action, and it still renders in search results. One editor per field; a second editor could disagree with the first.

- **Payload Rules**: All categories start collapsed. Disclosure does not edit the YAML; external document updates preserve the chosen state. A failed save opens the first invalid category.

### Caller-Key Masks
- **One Pattern, One Chip**: The request list's pattern filter is a field select joined to a mono pattern input, committed and removed as a single chip; its hint states RE2, match-anywhere and `(?i)`. See `docs/design.md` §2.
- **Marked Options**: A model, provider or credential filter option is led by the 16px mark its rows carry - the maker's mark by Model Square's rule, the provider's through the request row's own resolver - so the option and the rows it leaves show one picture. Vocabularies of plain words get no mark. See `docs/design.md` §2.
- **Select and Export**: Request rows lead with a palette-drawn checkbox (`--bg` with a `--muted` edge; `--accent-hover` fill and `--accent-on` tick when set); the header's checkbox speaks for the loaded page and the header carries no scrollbar gutter, since the virtual list gives up no width to one. A selection bar appears with the first tick and holds the one primary action, Export: a PNG sheet drawn on a canvas from the palette (wordmark, caption, the list's columns at 1480px minimum, newest 100 rows) or JSON of stored values for every selected row. OAuth account names and keys are redacted by default, request ids and whole columns on request; a redacted value is a neutral bar in the image and an omitted field in JSON, absent from the export's data rather than covered. A non-streaming response uses the crossed-out broadcast glyph, never Model Square's boxes. See `docs/design.md` §2.
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
- **Status Pip**: 7×7px square, 2px radius, paired with explicit status text (e.g. `[●] Running`). Green = healthy, Amber = degraded/warning, Red = error, Gray = offline. A success rate is a verdict on one published band, read by every surface that shows one: 80% or better is green, 50% up to but not including 80% is amber, below 50% is red, and a window with no traffic is gray because its rate is unknowable rather than bad. The dashboard's provider rows colour the rate's own number and the meter beside it with that same band token, and the number is what keeps the band readable at a measured 0%, where the meter's fill has no width to paint. Only a verdict gets a pip: the request console's Success / Failed filter segments carry one each, while All carries none.
- **Latency**: never tinted by an absolute threshold. Agent requests legitimately run for minutes, so a time-based amber rule would flag healthy traffic; the detail drawer compares TTFT against total duration instead.
- **Cache-Rate Badge**: Pill-shaped badge featuring continuous OKLCH gradient tint fill with ≥ 4.5:1 text contrast. Displays values up to `99.9%` with one decimal place. The scale is never red: a cache miss is the shape of a novel prompt, not a failed execution.
- **Credential Quota**: The dashboard panel that fills the token grid's right-hand column - the two stacking into one column under 900px - lists every enabled credential by urgency (sign-in required, cooling down, exhausted, unavailable, running low, healthy, no reading) as one row each: a row draws its plan's two shortest quota windows as remaining-share bars with the countdown to the tightest of them refilling, except in the four states with no reading to draw (sign-in required, cooling down, unavailable, no reading), which state the reason in the bars' place; an exhausted credential keeps its windows, all of them at zero, with the countdown to when it serves again. Disabled credentials are only counted, in the header beside the serving and blocked counts, and the list scrolls inside the panel, so a large fleet cannot outgrow the row it shares. A bar's hue is the remaining share (`--success` from 70%, `--warn` from 25%, `--danger` below) and never the heatmap ramp: "plenty left" and "a lot of tokens" must not be the same colour. Rows are not interactive - a touch meant to move the list must not leave the page - so the panel's one control is a header refresh glyph that asks the providers for fresh readings through the same refresh run the credential workspace uses, reporting under the same toast, and its footer links to `/oauth-management`. Its states are about freshness: a re-read that fails keeps the rows with a warning, only a credential list that was never read is unknown with a retry, and a deployment holding no credential gets an empty state that links to connecting one.
- **Token Activity Heatmap**: The dashboard's token grid is the one sequential *quantity* encoding, so it uses a **continuous** ramp of the theme accent rather than four fixed steps or any status hue — "lots of tokens" and "credential healthy" must not be the same colour, and a stepped scale paints every day between two steps identically. Brightness is the square root of the day's volume against the window's busiest day, which keeps day-to-day differences visible across the several orders of magnitude a window spans. The shape is a contribution-graph field (one row per weekday, one column per week, a year of weeks) that shows as many of the newest weeks as fit at an 18px cell and stretches them to its panel's edge, so it never leaves a gutter; the older weeks scroll inside the panel behind a pinned weekday gutter, and a five-swatch key names the ramp's direction. The current week is a complete column: the days after today are drawn as normal unrecorded cells, because a day that has not happened is a day nothing is stored for. Every cell is interactive and lifts on hover with a compositor-only `transform` scale; clicking one opens its tooltip, so a day with nothing recorded says so rather than refusing the question. The tooltip prints the day's token volume in the console's token unit style, keeping the exact count on the value. The day's drill-down is a link inside the tooltip rather than the cell itself. The two zero states (recorded-but-empty, and nothing-stored) are solid fills ordered against the card at 1.04–1.06:1 and 1.16–1.22:1 (light to dark mode), never outlines — an outline over a year-long grid whose cells mostly predate the retention horizon renders as a wire mesh. The ramp is relative to the window rather than absolute, so the same shade means different volumes on two installs - which is why every cell carries its date and counts in text, and the shade is never the only encoding. DOM, not a chart mark.

### Feedback Surfaces (Toasts, Load Failures, Notices)
- **Chosen by what the message describes**: the outcome of the operator's action is a toast (`useToast`); a region that could not be read is a `LoadFailure` in that region's place with a Retry; a condition that holds while the region is on screen is an inline `Notice`; a refusal of the input in front of the operator (a login, a composer message) stays beside that input. One outcome is reported on one surface, and a result never opens an information-only dialog.
- **Toast**: a floating panel like a menu — `--elevated` fill, 1px `--border` edge, 4px radius, one 420px width, 18px icon, top centre, never stacked into a pile. A brief success holds 2s, info or a success with detail 3s, warning 4s, error 5s, an offered shortcut 6s; hover pauses the remaining timer without restarting it. Shortcut destinations remain available from the page; exclusive or time-critical actions require a persistent surface. An upstream JSON envelope is read down to its status and sentence.
- **Report toast**: a batch outcome with per-target reasons lists them under group headings (failures first), each target's full name on its own line with its reason beneath, and stays until closed. Ordinary notifications never evict a report; the next refresh replaces it under the same key. A long context group is summarised one line per reason; nothing in a toast changes height after it opens.
- **Notice / LoadFailure**: one layout — body-size icon, headline, detail beneath in `--fg-2`, the action (Retry) at the right.
- **Enforced**: `pnpm check:feedback` refuses raw antd `Alert`, `message`, `notification` and information-only `modal.*` dialogs outside `web/src/components/feedback/`. All checks resolve Ant Design bindings, including namespace imports, local aliases and `App.useApp()` results; comments, strings, type-only imports and unrelated or shadowed bindings are ignored.

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
- **Do** give a `:hover` reveal a `@media (hover: none)` counterpart, and express a phone arrangement as a `640px` viewport rule (or a `920px` container query on the box the layout is about) rather than a new magic number.
- **Do** size focusable text controls at 16px under `(pointer: coarse)`, and give touch-only hit areas to controls whose drawn box stays at its token size.
- **Do** wire a Drawer or Modal to `useOverlayHistory({ isOpen, onClose })` so the platform's Back dismisses it, and leave Popovers, dropdowns, selects and tooltips out of the history — Back traverses pages, not the toolbar.
- **Do** let the loading bar hint at counted work (queries and module downloads) and separately mark pending activity and wait 200ms before painting, so a fast response never flickers; draw a first load as placeholders at the content's own geometry (`Placeholder.tsx`), never as a centred spinner.

### Don't:
- **Don't** add drop shadows (`box-shadow: 0 4px...`) or blurred lighting effects anywhere in the application.
- **Don't** use decorative gradients, animated skeleton sweeps (antd `Skeleton active`), or spring/bounce easing curves. A placeholder's staggered opacity breath is the one sanctioned first-load motion (ADR 0052).
- **Don't** use danger red on the cache-rate scale; cache misses are not system execution failures.
- **Don't** hard-swap an active screen to a blank white canvas during navigation or background polling.
- **Don't** display duplicated translations side-by-side in the interface.
- **Don't** pack single settings or isolated input fields into individual card boxes.

## Conversation workspaces

The Playground and the Agent share one frame from `web/src/components/workspace`: a head carrying
the title, the key-and-model target as one joined control and the page actions; a main column whose
transcript, notices and composer share a centred 760px reading column; and a resizable side panel
(a keyboard-operable splitter, never wider than half the viewport) that becomes a Back-aware Drawer
below 900px, where the target moves onto its own head row. The frame spans the content area, like
the configuration workbench.

- **Transcript**: assistant-ui's thread viewport, following the newest message while the reader is
  there and offering "back to latest" once they scroll away. The operator's message is a bordered
  `--surface` block; an answer is borderless with a model-and-status head, a reasoning disclosure
  without a frame, Markdown in the console's own styles, and a foot of measurements plus muted
  icon actions. The Agent's disclosure reads "Thinking…" while the reasoning is written and
  "Thought process" once it settles; the Playground shows its live phase in the disclosure title.
- **Model output**: tables in a hairline frame; fenced code with a language head and copy action,
  highlighted only for allowlisted languages after the fence closes, in a palette-ink syntax theme
  that never borrows the semantic hues. Raw HTML is escaped and images are links.
- **Conversation exports**: the HTML page and the PNG are the workspace in the resolved palette and
  the embedded mono face, not a report about it: the same reading column, bubble, pip, disclosures
  and code frames under a wordmark head and a one-line masthead. A canvas is exported as the sandboxed frame it is in the
  workspace, and as a titled placeholder in the PNG. The PNG is an
  840px card at 2x without controls or reasoning, its capability chain shown open.
- **Composer**: assistant-ui's composer with Ant Design controls; Enter and the send button as one
  gate decided on the runtime's live state, a blocked send drawn with `aria-disabled` (`--border`
  fill, `--meta` glyph). Send and stop share one action slot and one shape - a 32px circle filled
  with `--accent-hover`, an up arrow or a rounded square in `--accent-on`, the console's one round button: running with an empty draft
  shows stop; an Agent draft replaces it with Queue, and queueing restores stop. Queued messages
  wait in a tray resting on the frame under a line that counts them, each removable, and the model and effort stay choosable during a run; one line beneath names the cost or privacy boundary.
  In the Agent `/` (commands: `/ui` and `/text` for the next answer, and the page's own actions,
  each listed only while it can run) and `@` (models, key aliases, capabilities) open
  a shadowless `--elevated` list above the frame, a 16px `--muted` icon and mono name beside a
  `--muted` description; Enter belongs to the highlighted row, a mention lands as the bare name, and
  Up on an empty box recalls sent messages. The frame holds only what a message is sent with: the
  Agent's foot is a round `+` that attaches, the effort chip, the model chip and the send slot. What the next message
  carries beyond its text - an edit, a presentation - is a 24px hairline chip above the input,
  `--accent` for a presentation, each with its own remove. The composer's edges meet the
  transcript column's: it is offset by half the transcript's scrollbar gutter. A 14px ring on a `--border` track with a small mono percentage under the frame, at the end of the note's line, states
  the context window in use (`--meta`, `--warn` at 75%, `--danger` at 90%), absent when either
  figure is unknown.
- **Views**: new display calls default to inline components at their call position.
  `frame: none` keeps an accessible title and quiet controls without the frame or title bar;
  explicit `frame: card` adds the hairline frame. Stored displays retain their original framing
  (ADR 0082, 0087). A stored panel (ADR 0079) stacks token-drawn blocks - figure tiles on one `--border-soft` grid, label/value
  rows, a toned-rule callout, steps on a rail, 4px meters, hairline page links - with 1.5px Lucide
  outline icons and a neutral circle for an unresolved name; a canvas (ADR 0072, 0073) is a borderless
  sandboxed frame on `--surface` with icon actions for view source (the same button returns to the rendered UI), save as image,
  download HTML and full screen. Its charts and tables are drawn inside the frame by the console's
  kit from the theme variables: series palette marks, `--border` grid rules, `--muted` tick text,
  hairline table rows with tabular right-aligned figures. Markup appears progressively without
  executing model scripts until completion. Component surfaces use the 6px surface radius,
  controls the 4px control radius, including in previews and exports. Natural height grows
  and shrinks with content between 48px and 16384px so normal content scrolls with the
  transcript, not inside a nested root viewport. Local filters, forms and calculators operate
  on frozen content; new-data or write follow-ups are reviewed in the composer. Full screen is the same figure fixed over
  the viewport on `--surface`, left with Escape or Back; a dashed hairline box holds its place.
- **Target**: each model is led by its maker's mark, or a neutral box when the maker is unknown.
- **Retry, edit, files**: the newest answer's foot offers retry and edit while its turn changed
  nothing; an edit shows an "editing" chip above the input. A message sent with a presentation carries an
  `--accent` hairline chip naming it above its bubble. Attached text files (ADR 0074) are hairline name chips in the composer and above
  the sent bubble.
- **Follow-ups**: up to three questions the model offered, as plain lines under the newest answer
  that fill the composer without sending.
- **Playground**: images pasted, dropped or picked into the composer; the last answer regenerates
  and the last message edits in place, replacing its turn. The Agent quote toolbar styles itself
  from theme tokens even though its portal sits outside Ant Design's variable scope.
- **Playground panel**: Parameters (unset values read "Default"; sliders rest muted) and Turn
  diagnostics (metrics grid, request and response code blocks, labelled cURL copy).
- **Agent**: a capability directory as an open list grouped read / write / destructive with pips,
  each row a localized title with its mono identifier beside it;
  a turn drawn in the order it happened - reasoning, text and capability calls as segments, runs of
  reasoning and calls joined as a timeline on a hairline rail under a "Used N capabilities" summary that is open while it is the end of a running answer or waits on the operator and folds once the answer moves past it, each call a disclosure (status mark - a check once it succeeded - title,
  arguments as a mono chip, status in words unless it simply succeeded, duration, caret) that unfolds its identifier, arguments and the model's receipt under its own row (ADR 0084), with a `--warn` attention glyph when it
  waits on the operator or its outcome is unconfirmed; database queries keep their status, SQL arguments and
  timing there, while raw query rows are never shown; panels and canvases from successful display calls drawn where the model made the call, in a hairline frame or frameless at the model's choice (ADR 0082); reasoning set on the page without a frame, following its newest line until the reader scrolls away, resuming at the bottom and folding on completion; page actions together at the conversation's top trailing corner - New conversation labelled first, then icon actions for export, the capability directory and the connection guide; an empty state of wordmark, one paragraph, four starting questions and a `--meta` line of `kbd` hints for `/`, `@` and Up; an approval card
  under the call that raised it (`--surface`, one hairline edge at the 8px thread radius, tinted `--danger` when
  destructive, its changes on a field panel) with one Deny / Allow decision (Allow in the danger hue for a destructive capability),
  and a `--warn` notice in the composer while it is open; "Ask about this" on selected answer text,
  quoted in the composer; agent questions in an accent-framed panel that takes
  the composer's place, shaped like the coding agents' question prompts: a tab per question and a
  Review tab, numbered option rows (a digit picks, the chosen one accent-edged with a filled key
  cap), "Something else…" as the last row with its field inside it; the data notice as the
  line beneath the composer (no consent checkbox); model and reasoning chips sharing shadowless `--surface` popovers and named
  option rows (ADR 0077): 304px for models, 180px for reasoning, both viewport-bounded.
  The model list has maker marks, search beyond eight names, and a secondary client-key
  footer that opens a key list in the same surface. Reasoning offers model default first,
  then parameter names and secondary localized descriptions; its text chip shows the current
  parameter name (`Low`, `High`, `Max`, `xHigh`) in `--fg` at regular 400 weight across
  languages. Request values retain their original casing. Current rows use `--selected-inset`,
  `--fg` and 600 weight; model rows also use an ink-colored check. Reasoning pairs the
  primary parameter name on the left with its localized description in `--muted` at
  the trailing edge; identical descriptions are omitted. Rows are 36px, 44px for phones/touch. Arrows/Home/End browse;
  Enter/Space/click confirms; confirmation or Escape closes and restores chip focus.
  Existing theme tokens are reused; reasoning shown live and kept with the turn; the sent message shown at once.

### Cost & Usage provider grouping

The price book uses the existing console tokens and table/phone-row primitives. Provider headings carry the shared provider mark and display name, authentication kind and routing priority; model rows carry text identities and inline pricing actions. One global 20-row page bounds the rendered memberships across groups. A single sticky footer shows the visible entry range and page navigation; phones use a read-only compact page indicator with 40px previous/next targets. Search and provider/mode filters remain above the list, with the sync control in the page header. The upstream model picker uses bounded 12-row pages. No new palette, typography, spacing or motion tokens are introduced.

### Dashboard plot alignment and readouts

KPI card bodies stretch within each grid row; captions absorb spare space so plots remain
bottom-aligned when cost notes wrap. KPI sparklines and Token Trend share G2 tooltip
hit-testing, crosshairs and positioning, with escaped content from
`web/src/charts/chartTooltip.ts` and the palette-styled `.omc-tip` readout.
Token Trend preserves measured zero buckets as continuous baseline segments. KPI, model-trend and model-donut tooltip rows use content-sized columns, 8px decorative swatches and 6px gutters; timestamp headings do not stretch the data tracks. Names align on the left and numeric edges on the right, with full names and exact values in escaped titles. Existing palette, font and motion tokens remain unchanged.

## Time zone picker

Use the shared controlled `TimeZoneSelect`: actual IANA names, a left-aligned name column and a right-aligned tabular UTC-offset column. Pin the server zone first and place its localized source label below the name. Field and popup share a width; narrow screens use the full settings-row width. Keep the helper text to “Used for timestamps and calendar-day totals.” Fixed 64-pixel virtual rows reserve indicator space uniformly. Search supports city/zone names and UTC offsets. Reuse existing color, typography and motion tokens.

### Live reasoning and phase labels

Reasoning disclosures point right when collapsed and down when expanded.

Reasoning is `--fg-2` at 12.5px / 1.6, unframed and bounded to 168px while streaming, 320px
when settled and reopened. Following tracks the rendered Markdown's height and viewport reflow,
not just incoming tokens. The top fade appears only when following with history hidden above;
short reasoning and manual scrollback keep full ink. Returning to the bottom resumes following,
and reopening a live disclosure shows the newest line. Title, body and the Agent's activity row
remain in document flow, with the answer's 12px gap before activity. Live activity reports the
phase and elapsed time; round counts belong to settled-turn measurements.

Short live labels carry a 3.2em `--fg` glint across their own ink on the 900ms
linear `--motion-live-text` loop, painted by a background clipped to the glyphs. `MOTION_LIVE_TEXT` in `web/src/theme/themeConfig.ts` and the
pre-hydration root variable in `web/src/index.css` share that period across palettes. This is an
indeterminate loop, not a transition; reduced motion and unsupported masking leave plain text.
Placeholder blocks retain their opacity breath (ADR 0052).

### Live elapsed labels and Stop

Agent activity, running capability rows and Playground running turns use isolated `LiveElapsed`
labels. A shared visible-only animation-frame clock quantizes milliseconds to 10ms and seconds
to 0.1s; a formatted external-store snapshot limits second-scale label renders to 10Hz without
rerendering the page or transcript. Hidden documents and settled labels schedule no frames.
Stop is the composer's send slot with a square glyph; it uses the existing `--accent-hover` / `--accent-on` tokens
and no shadow. This changes component usage, not the palette or token mapping.

### Custom icon picker

The existing icon modal has Built-in and Custom segments. The built-in catalog keeps its category filters and lazy artwork loading. The library header pairs its title/count with Add icon; editor headers pair Back with the action title. The custom library has name search, full-width empty/search-empty states and artwork cards with separate selection, edit and delete targets. New/edit forms replace the grid within the same modal: a named file/Base64 source sits alongside a specimen preview at 64px and a provider-list preview at 24px, with a single save footer. File imports support a keyboard-accessible choose button and drag/drop; only server-validated artwork enables saving. The preview becomes a compact stacked panel on narrow screens, and the modal body scrolls within the viewport. Saving returns to the library without assigning the icon. Deletion opens a dedicated confirmation view with the artwork, reference count and default-reset impact; Cancel receives initial focus, and confirmed deletion removes the asset and restores every assignment to its default or placeholder. Returning from editing or deletion restores focus to Add icon. In-flight writes prevent dismissal and tab switching. The modal retains its explicit layer above the provider drawer. Existing palette, typography, spacing and motion tokens are unchanged.


### Route error recovery surface

`web/src/components/common/RouteErrorPage.tsx` uses the console's theme-aware
22px wordmark and `StatusLabel` danger pip above a flat Ant Design card. The
heading reuses `terminal-title`; reading text uses the console's 13px body scale,
with 12px monospaced diagnostic blocks. Card padding, border, small radius,
background, foreground ladder and action spacing reuse the current console
system. The right-aligned primary reload action comes last, after the dashboard
anchor. There are no error-page-specific palette or token mappings.

`PanelTitle`, `FactList` and `CopyButton` own the diagnostic header, metadata rows
and copy interaction. Error type, route, build, UTC occurrence time and optional
HTTP status stay visible alongside the redacted error message; a native details
control reveals the selectable stack. Code wraps and scrolls within its region.
On phones actions stack with 44px hit areas, and the copy/detail controls keep the
same touch floor. Heading focus and localized document title identify the failed
page for keyboard and screen-reader users. Recovery and diagnostic copy are
available in Simplified Chinese, Traditional Chinese, English and Malay.

### Loading feedback

The bar under the console header, under the shell placeholder's header and on the
sign-in page's top edge is one 2px `ProgressBar`. Its fill is a never-backwards rough
estimate from task counts: settled work counts in full and pending work earns
exponential credit toward 85% of its share. Its 18% accent-tinted track remains;
the fill uses 65% accent opacity. A solid accent segment, at most 16px and 25% of its
window, travels inside the fill's front edge in a clipped window at most 64px and
16% of the track width. Its 1200ms linear CSS cycle fades in and out at the wrap.
This indicates a pending client wait, not an upstream heartbeat or more completed
work, and continues when the fill holds. Only transform and opacity animate;
frames do not rerender React or measure layout.

The bar waits 200ms to suppress fast-request flashes. Source notifications do not
reset its drawing clock or activity cycle. Actual task settlement stops activity,
closes the fill within one resolved `--motion-base` beat, then holds full for one
`base` beat and fades over another; content appears immediately. Settlement includes
failure and cancellation, so completion is not a success verdict. Its localized
`progressbar` omits `aria-valuenow`; `aria-busy` describes pending work rather than
animation. Live reduced motion preserves the batch and never moves it backwards,
removes activity and pending estimates, and stops frames until a task event; it
immediately hides completed work, including a cancelled fade. Hidden documents
suspend drawing, show timers and activity; pending work resumes from its actual
state, while completed work is retired without replay. Palette derivation and
theme token mappings are unchanged.

First loads retain the first-party placeholder kit: `--border` blocks at the
content's geometry (shell rail and header, page head, lists, tables, dashboard
tiles and paragraphs), breathing in opacity one `base` apart per row and frozen
under reduced motion. See `docs/design.md` §7 and ADRs 0052 and 0054.
Paragraph/table compositions live in `ContentPlaceholder.tsx` behind route imports;
the shell/sign-in kit stays eager.

### Sign-in surface

A centred 360px column on the page's `--bg`, with no card, texture or header rule. It holds the
centred 28px wordmark, the centred 22px title, the labelled key field and a full-width primary
button at antd's large size. The theme and language menus sit alone at the top right. There is no
eyebrow, subtitle or footnote. The session check draws the column's outline as placeholders, and the
rough-progress bar and waiting activity run along the page's top edge. See `docs/design.md` §9.

### System version comparison

The Versions & Updates card keeps two product rows separated by a single rule. Each row
places product identity and its repository beside a concise semantic status. Below it,
the running and latest published versions form a compact comparison, bounded to 320px
with a quiet vertical divider. The release tag appears in the comparison, not again in
the status. Existing `--fg` and `--fg-2` tokens carry versions and labels; only a known
update target uses `--accent`. On narrow screens the comparison becomes two label/value
rows, with long build tags wrapping within their own column.

The change-log action occupies its own trailing space alongside the comparison. It is a
32px-high text button with a document icon, a localized label and a muted actual release
count; its accessible name identifies both product and count. On phones it follows the
comparison on a separate line, keeping both readings aligned and the action label intact.
The action appears only for actual entries; the repository link stays with the product
identity. Long comparison explanations belong below the readings rather than in the
status slot. A missing-notes hint belongs only to a known change-log range; an empty or
unchecked feed does not acquire a second warning about notes. A failed check retains the
readings and shows its reason and, when available, the last successful check time.
The log remains a Drawer and remote images remain links, never automatically fetched media.
These are page-level arrangements using the existing visual tokens, not new theme mappings.

### System information status cards

Maintenance, storage and component health present their selected readings immediately.
Card titles wrap on narrow screens, and these arrangements use the existing theme tokens
and system response without additional API requests.

Maintenance pairs three short action names with one-sentence explanations and the
console's standard outlined antd buttons. Button dimensions, typography, border,
background and interaction states inherit the shared configuration. Admission refusals
replace the ordinary explanation; running, failed and partial outcomes remain explicit.
VACUUM requires confirmation of the exclusive write gate and measured disk requirements.
Completed outcomes are independently dismissible; running work is not.

Storage prioritizes the total physical footprint above one shared label/value list.
The three measured file sizes, journal mode and schema generation share identical label
and right-aligned value columns at every viewport. Missing files read "not present"
rather than zero. Physical footprint is not
repeated as allocated pages or record counts; internal geometry, reusable pages and
connection settings belong in the sanitized diagnostics bundle.

Component health has four divided rows, each with a component name, semantic status and
one short inline operational summary. The gateway shows its credential count, Oh My CPA
its start age and memory, SQLite its request count, and the collector the latest usage
age. Each summary uses at most two paired facts, with labels beside values rather than
separate metric grids. Positive ingestion backlog and collection gaps appear as warning
readings; healthy zero values do not consume space. Missing observations remain explicit.
The version card retains the compact comparison and separate change-log action above.

## Content-first phone console (ADR 0055)

- Phone breakpoint: 640px; navigation sheet: 900px. One-row header: navigation, ellipsised page
  name, refresh, More. Click-open theme/language/repository/sign-out tools show selected preferences,
  use 44px rows and dismiss with Back/Escape. Demo mode retains its marker and restrictions.
- Page titles: 18px; horizontal content padding: 12px; compact gaps/padding: existing 8/12/16px
  scale. `PageHeader.mobileActions` chooses primary phone actions explicitly. Secondary tools use
  `ActionMenu`; additional provider/audit filters use `FilterDisclosure` with selected-state summary.
  Desktop actions, row-list rendering and request/conversation scrolling are unchanged. The phone conversation frame follows usable viewport height so input and Send stay above the keyboard.
- Configuration: non-sticky status/mode/tools row, search on its own row, locally scrolling categories,
  retained group headings/descriptions. Only dirty drafts show the measured-height bottom save/discard
  bar; content reserves its space. Save validation and a single confirmation remain shared.
- YAML: 16px text / 24px line height, two-character line-number gutter, no folding/decorations/minimap/
  overview ruler/indent guides, `wrappingIndent: none`. Phone default wrap is on, desktop off; manual
  choice lasts for the source session and survives rotation/focus. Find/wrap/focus are direct actions;
  format/copy/statistics use tools. Desktop shortcut hints stay desktop-only.
- Focused editing keeps the same Monaco DOM/model, undo stack, selection and scroll. Its fixed region
  follows the visible viewport (keyboard resize/caret pan); dirty actions fit inside it. Background
  siblings are inert while dialog portals remain active. Nested overlays close before focus on Back,
  and exit restores entry-button focus. Palette/font/token derivation stays unchanged.

### Model Square directory

Model Square answers one question: which model names can a client call right now. The head's
subtitle carries live data only: the model count, the maker count and the reference snapshot's
source and date. One toolbar holds the search field (names, makers and known model
identities). A strip of maker chips, each with its mark and a count, filters to one maker; its
counts follow the search, so a count is what selecting the chip will show. An active filter
states "shown of total" and offers one clear action. Search and maker live in the URL.

Makers are open sections under a heading rule. Named makers sort alphabetically; the
multiple-maker group (a shared alias spanning several makers) and the unidentified group follow
them. Inside a section each client model name is a compact card on `--surface` with a 1px
`--border` and the 4px radius - the dashboard tiles' surface at a directory's density - and the
cards fill the section's width in as many columns as fit (280px minimum, `auto-fill`, 12px
gaps): a model here is a
name, a price and a connection, which is too little to justify a full-width line. A card holds
only what the operator acts on: the call name with its reference display name as a caption
under it, then one line with the price (input / output; the per-1M-token unit is stated once,
in the details) on the left and the connection serving it on the right. One connection is named; several
collapse to up to three of their marks and a count ("3 connections"), so every card keeps
the same height, and the details list each of them. Reference
specifications - limits, capabilities, openness - and usage figures are not drawn in the list;
they belong to the details.

The call name is itself the copy control: clicking it copies exactly the string a client
sends, and the glyph beside it turns into a `--success` check for 1.5s. Everything else on the
card opens the details, so the card has two targets and no dead space; hover raises its
border to `--fg-2` over `--hover`. A model without a price shows a `warn` status reading
"Set price" in the price position, which opens the shared price editor in place. The directory
raises no page-level notice about unpriced models: summarising the price book is Cost & Usage's
job. A price that could not be read is left blank - never drawn as unpriced.

The column count follows the section's own width with no breakpoint: three or four columns on
a desktop, one on a phone. On phones the name and the details chevron are 44px touch targets,
long names wrap inside the card, and the maker strip scrolls within itself so the page never
moves sideways.

A maker with brand artwork shows it. The two groups that are not a maker draw the console's
own Lucide glyph (a cube for unidentified, layers for multiple) at 1.5px stroke in `--fg-2`,
framed by a 1px `--border`, `--surface` and the 4px radius once the mark is 20px or larger;
smaller marks are the bare glyph in `--muted`. They read as chrome beside the artwork, never
as another brand. The navigation entry uses the boxes glyph, distinct from the dashboard's grid.

The details are a Back-aware, viewport-bounded Drawer titled with the client name, with copy
beside the title. It opens with Cost & Usage: three tiles (input price, output price, requests
in 24 hours - the one window every usage figure on this page uses), then the price action - primary "Set price" for an unpriced
model, default "Edit price" otherwise - and a link to the request list narrowed to this call
name over the same 24 hours. The price editor stacks above the Drawer and one Back closes it
alone. Below, the Drawer names the connections serving the model (the upstream name where it
differs), then gives each distinct model its own models.dev profile (connections that reach the same
source record under different upstream names share one): three limit
tiles (context, output, input), a capability group (modalities, reasoning, tools, structured
output, attachments) and a release group (openness, license, release, knowledge cutoff,
metadata date). Openness is one of three terms: closed-source model, open-weight model (weights
are published), open-source model (weights are published under a recognised open-source
license). A supported capability carries a `--success` check; an unsupported one and every
omitted field are drawn in `--meta`, so what is known stands out and what is unknown stays
explicitly stated. Weight links, source links and the models.dev, OpenRouter and pi.dev
lookups are bordered link buttons that open a new tab with opener/referrer protection. The
footer steps to the previous or next model of the filtered list without closing the Drawer;
one Back still dismisses it. The source note and snapshot date close the Drawer. Local icons
and the existing palette, typography, spacing and motion tokens are reused without new global
design tokens.

### OAuth model rules

The OAuth workspace's Model rules action opens a viewport-bounded, Back-aware
Drawer. The close action sits at the trailing header edge, keeping it reachable
beside centered save acknowledgements; the credential detail Drawer uses the same
close placement. Its provider picker uses the same display names and local brand marks as
the provider tabs, including plugin-published artwork, while retaining CPA's key
as the selected value. Search accepts both the display name and the key. Options
carry the saved alias and exclusion counts; the closed picker shows only the
provider identity. Unknown providers keep a neutral mark and a readable name.

Two full-width section tabs show aliases and exclusions with their draft counts
and an unsaved indicator. Each section saves or reverts independently, and provider
selection remains disabled while either has edits. Closing or native Back asks
before discarding drafts. Aliases use the provider catalog as source suggestions,
keep manual entry and default new mappings to retaining the original model (`fork`).
Exclusions use open checkbox rows, searchable catalog bulk actions and a separate
list for typed IDs and wildcard rules. A wildcard-covered row identifies its rule
and cannot be unchecked unless its own exact rule exists; the catch-all rule warns
that every model will be excluded. The footer keeps Clear, Revert and Save reachable
on a phone. Existing palette, shape, typography and motion tokens are reused.

### Credential policies, Vertex import and gateway log tools

The credential Configuration tab edits credential-local model aliases as stacked
entries: source name, call alias and display name share one group, with retain-original
and force-mapping controls below. It uses the existing guarded configuration draft;
provider-wide OAuth mappings remain a separate editor. The Vertex import dialog
shows the selected service-account file's project and account address before import,
with the region field and replacement consequence visible. Key contents are never
rendered or retained in cached mutation variables; closing also invalidates an unfinished
file read so it cannot restore the cancelled selection.

The gateway log toolbar keeps search, level, the additional-filter count, row count
and actions on its first row. Status class, method, path and management-traffic
visibility belong to its disclosed filter panel. Method and path choices show facet
counts; wrapping is a persistent viewing preference. Fullscreen moves the same log
viewer above page chrome without replacing its tail or scroll state. Escape leaves fullscreen only when no selector or confirmation is open. On phones the
controls wrap within the viewport and the log list owns its scrolling.

Under reduced motion, a closing floating panel becomes hidden as soon as its
leave phase starts, even while the library retains its node for motion cleanup.

### Credential cooldown and model disclosure

An identified `credential_quota` cooldown is explained by the existing CPA cooldown status tooltip rather than a second red banner. Unrecognized reasons remain visible in the overview; the Quota tab retains full reasons and action-failure diagnostics. A newly added provider custom model starts collapsed, with its request model and alias editable; image and reasoning controls open only through explicit disclosure, preserving other rows' expansion.

### Native and virtual option scrolling

Native option popups with `overflow-y: auto`, including the Playground model picker, retain browser-owned wheel scrolling even when they share the list library's holder structure. Their scroll listener mirrors offsets through deferred React state, so a second offset writer can undo progress. Only hidden-overflow virtual holders receive synthetic wheel steps; structure alone does not identify virtual scrolling. Existing scroll and motion tokens are unchanged.

### Navigation scroll and portable answer fidelity

The sidebar's native vertical viewport has a 6px overlay indicator instead of consuming a
scrollbar column. Hover, scrolling, dragging or keyboard focus reveals it; touch retains
native content scrolling. The thumb tracks the viewport/content ratio and can be dragged;
pressing the bare track pages toward it. The motion uses the existing fast/base tokens.
The mobile heatmap starts at the newest edge with a signed-32-bit-safe scroll offset and
stays pinned through resize only until the reader chooses an older date.

The demonstration announces its nature using the global arrival toast, with contextual
Agent/Playground replay copy on those pages; it reserves no banner row. Portable Agent HTML
keeps the same text, standalone reasoning, working timelines and inline generated figures
in reading order. Call rows retain argument summaries, outcome and duration disclosures.
PNG captures generated interfaces at their laid-out width, including kit charts and controls;
unavailable figures keep a visible fallback note rather than silently disappearing.
