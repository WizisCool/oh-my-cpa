# Interface design

OMC is a dense operator console: quiet structure, readable data and clear actions.
This guide explains design intent. Theme values and component APIs live in code.

## Sources of truth

| Need | Read |
| --- | --- |
| Palette definition, derivation and open Theme SDK | [`palette.ts`](../web/src/theme/palette.ts), [`themeContract.ts`](../web/src/theme/themeContract.ts) |
| Motion tokens and CSS variable projection | [`themeConfig.ts`](../web/src/theme/themeConfig.ts) |
| Global CSS, Tailwind token bridge and initial render | [`index.css`](../web/src/index.css) |
| Corner scale for UI primitives, canvas painters and exports | [`radius.ts`](../web/src/theme/radius.ts) |
| Typeface selection and assets | [`web/src/theme`](../web/src/theme) |
| Headless Base UI / shadcn primitives | [`web/src/components/ui`](../web/src/components/ui) |
| Shared console primitives | [`web/src/components/common`](../web/src/components/common) |
| Event and state feedback | [`web/src/components/feedback`](../web/src/components/feedback) |
| Copy and translation | [i18n README](../web/src/i18n/README.md), [style](../web/src/i18n/STYLE.md), [glossary](../web/src/i18n/GLOSSARY.md) |

Change a token in its implementation, not in a second table of color values. Use
resolved tokens/CSS variables in components; derive relationships once in the theme.
The pre-hydration appearance must agree with the chosen theme after mounting.

Read only tokens the console declares. An undeclared `var(--name)` resolves to nothing without
an error - a focus ring that never draws, a hover with no fill - and a fallback such as
`var(--warning, #b26b00)` hides the misspelling in one palette while painting the wrong colour in
the others. A logic test rejects any custom property that is read but never declared.
A filled shape that carries text, such as a count badge or an active step number, uses the
solved pair `--primary` with `--primary-on`: `--accent` is tuned as link ink on the page and
is not guaranteed to hold a label.

## Visual language

The navigation sits on a canvas; the working page is one inset rounded panel.
Surfaces are edged by soft layered shadows rather than drawn borders (see
[Edges and elevation](#edges-and-elevation)). Group related content through enclosure rather
than a stack of headings and dividers.

Use the UI font role for interface prose, the mono role for code and aligned values,
and tabular numerals for changing measurements. The default typeface is
Sarasa Mono SC: its Latin side is bundled and hinted, the CJK glyphs it leaves out come from Google
Fonts' Noto Sans SC, the same Source Han Sans design (`web/src/theme/cjkFont.ts`).
Operator-selected fonts must preserve readability.
Publisher-owned plugin logos are optional assets, as described below.

Text inks have roles with their own contrast floors (`CONTRAST_FLOORS` in `palette.ts`): body
text, the hint step (`--muted`) and the footnote step (`--meta`). The footnote step is for quiet
prose only - timestamps, counts, captions. Anything the reader presses or must notice, such as a
link, an icon button, a field's clear or reveal glyph, or a row's open arrow, starts at the hint
step and brightens under the pointer.

Keep chrome muted. Semantic status colors convey actual health/state; categorical
chart colors identify series and must remain distinguishable in both modes. Do not
encode success, failure or selection in color alone. An unavailable reading is not
zero, and an unpriced request is not free.

Request duration reads on one continuous green-to-orange scale, from an instant to a
minute. It uses its own `--timing-*` stops, mixed by the same helper the cache-rate badge
reads; the two ramps share the mixing rule, not their colours. Duration is a measurement,
never a verdict: red stays with failure, and a slow request is not a failed one. TTFT is
request detail and keeps the secondary ink. The duration ramp's stops are solved against
the blends they produce, on row, hover and selection fills, so every reading between them
keeps its contrast; the cache-rate ramp holds only its two stops and promises nothing
about the blends between them.

## Corners

Every corner in the console takes one of five steps, chosen by the shape's role rather than its
size: `xs` for a mark (meters, chart bars, swatches, carets), `sm` for a shape nested in a
control (tags, badges, inline code, check boxes, a switch's knob or a segmented thumb), `md` for a
control (buttons, icon buttons, fields, selects, rows, tabs, menu entries, brand tiles), `lg` for a
block (menus, popovers and dropdowns, notices, callouts, code, a card inside a card) and `xl` for a
surface (the page panel, cards, tables, dialogs, drawers, toasts, the composer). The control step is
the anchor: everything else is read against the buttons. The values live in `index.css` and
`theme/radius.ts`; a logic test holds the two together and rejects any radius that is not a step.

Nested shapes are concentric: the inner radius is the outer radius less the gap between them. The
steps are spaced so the console's usual gaps land on them - a control 4px inside a block, a thumb
2px inside its track, a control or row 6px inside a surface - so a container that holds a control
near its edge sets its padding to fit the pair instead of inventing a radius. Once the gap is as
wide as the outer radius the two curves no longer read together, and each shape keeps its own
step. A ring drawn around a shape, such as a drop target, adds its offset to the shape's step with
`calc()`.

Only dots are round: status pips, radios, spinners, avatars and step numbers are circles. Nothing
else is a pill - not a switch, a badge, a progress bar or a scroll thumb.

## Edges and elevation

Edges are drawn by soft layered shadows rather than stroked borders, and every edge says how a
thing sits relative to the page. A raised thing (the panel, cards, tables, settings groups, code,
the composer) is a one-pixel ring of the foreground ink with blurred drops below it. A control
standing on its ground (a button, a segmented thumb) is the same material at a control's scale.
A field or a track (an input, a select, a segmented track, a field-shaped trigger) is set into its
ground: an ink wash with the ring drawn inside and its shade at the top edge. The composites in
`index.css` name the depth: `--shadow-edge` for what rests on the page, `--shadow-raised` for a
resting surface under the pointer or in the hand, `--shadow-float` for menus, popovers and toasts,
`--shadow-overlay` for dialogs and sheets, `--shadow-control` for a standing control and
`--shadow-well` for a field or a track. Dark drops carry an inset top highlight, because a dark
shadow on a dark ground cannot carry the edge alone.

An edge has to read at a glance in every palette, so its strength is solved rather than chosen:
`derivePalette` finds, per palette, the share of the foreground that moves the page by a fixed
OKLCH lightness step (`EDGE_STEPS`: edge, lift and the fine ring of controls and fields), and the
drops are cast in the palette's own `--shade`, its hue near black. A fixed share drew light and
low-contrast palettes at half the step of the dark ones; a solved share gives OMC Light, Fog,
Sandstone, Pewter and an operator's own palette the same visible edge. The steps stay
restrained: an edge must read as more than a single line, yet a resting card must not look
lifted off the page. Retune the steps or the drop parts, never one surface's own shadow.

A state colours the ring and keeps the drop: `0 0 0 1px <state colour>, var(--edge-drop)` for a
selected, focused, invalid or warning surface; a focused field trades its well for its accent
stroke. A shape whose rows stack into one card wraps them in a single element that carries the
shadow, since a drop drawn per row bleeds across the seams. Where a container clips its content
(the request list slides inside a clipping slot), the ring is drawn inside the clip instead.

Strokes remain where a line is the thing being drawn: dividers between rows and columns, the
dashed outline of an empty slot or drop target, a state-coloured button, the edge of a circular
glyph, a colour swatch or flag, and the grid lines of a markdown table. The logic test that guards
the corner scale also rejects a neutral enclosing border outside that list, and another holds the
stylesheet's first-frame edge values to the default palettes' solved ones.

## Brand marks

Connection branding, credential-provider identity and model manufacturer identity answer
separate questions. A connection renamed or assigned custom artwork must not relabel the
protocol it uses or the maker of a model it serves. Use the semantic provider/credential
entry points in [`LobeIcon.tsx`](../web/src/components/LobeIcon.tsx) and `ModelMark`, not
page-local combinations of preferences, plugin logos and catalog guesses.

[`brandMark.ts`](../web/src/types/brandMark.ts) owns the shared identity and ordered artwork
resolution; [`useProviderBranding`](../web/src/hooks/useProviderBranding.ts) resolves
collection-level sources through shared queries and revalidates the sanitized provider
catalog on mount. The DOM renderer and request-image painter consume the same artwork
candidates. Plugin ownership remains authoritative even when its logo is
missing or a registry read fails. Render plugin SVGs only as isolated images, never as
host markup. Plugin-published HTTP(S) logos load in the browser and fall back to catalog
artwork or a neutral mark if unavailable; they do not require server-side network access.
A fetched mark holds its box with the console's first-load placeholder until its bytes
arrive, so a row never flashes an empty chip; artwork already in the browser's cache or
settled earlier in the session appears without one, while still falling back if a later
load fails.
Operations/status glyphs remain in the static icon module, separate from brand identity.

A protocol family is not a provider identity. Only an OAuth channel's family names the
provider a connection belongs to, so only that family may resolve a plugin's artwork or
prove plugin ownership; an API-key family such as `codex` is a dialect several unrelated
connections speak, and lending it one plugin's mark would overwrite the operator's own
choice. A name resolved from the provider catalog is likewise provisional until that read
succeeds: a surface may show the withheld rows, but anything durable — an export above
all — has to say the name is unconfirmed instead of saving it.

## Composition and shared controls

Use the shared page, panel, toolbar, field, empty-state, drawer, dialog and
confirmation primitives before creating another page-local version. A dialog
(`AppModal`) holds one task that ends where the reader started; on a phone it is a
bottom sheet. A drawer shows or edits one record beside the page; on a desktop its
leading edge drags to resize it and a click restores the opening width. The width is a
server preference per `widthKey`, so panels that show the same kind of thing share one.
Keep semantic HTML, labels,
focus management and accessible names when adapting a library component. Number fields
use [`NumberInput`](../web/src/components/common/NumberInput.tsx): once it holds the
caret, the wheel steps the field by its own step and bounds. A value never changes for a
pointer that merely crosses the control, so a wheel scrolls the page it was meant for.

In form grids (such as `.settings-form-grid`), controls must maintain consistent horizontal
alignment across columns. Field labels sit at the top of each cell, input controls sit directly
below their labels with a uniform height (such as 32px for switches, selects, number inputs,
and text fields), and optional secondary copy (descriptions/hints) sits underneath the control,
never between the label and the control. This prevents uneven subtitle lengths from pushing
adjacent controls out of alignment. Combos (such as host/port) align at the start
(`align-items: start`) so both labels and control baselines align horizontally. Secondary
copy is strictly optional: self-explanatory settings (ports, URLs with formatted placeholders,
standard toggles) omit subtitles entirely rather than cluttering cards with redundant or
defensive text.

Put the primary action where the task finishes. Destructive actions need an explicit
confirmation that names the affected resource. Preserve edits during background
refreshes; distinguish Apply/Save from Cancel and from viewing current server state.
A disabled or pending action should not move surrounding controls.

The shell header's Refresh all re-reads every open view. A page adds its own
[`RefreshButton`](../web/src/components/common/RefreshButton.tsx) only for work that re-read
cannot do: pulling records from CPA, fetching quota, a model catalogue or exchange rates
upstream, or reloading a log tail. A page that only refetches its own queries does not get one.

A table is one dataset with one set of column semantics. On phones, use the shared
labelled-row representation, not a separately maintained mobile dataset. Preserve
ordering, values, action reachability and empty/loading states in either presentation.

A list the operator arranges by hand uses
[`RowReorder`](../web/src/components/common/RowReorder.tsx); the dashboard grid and the
routing board use the same drag library for their own layouts. Only a handle starts a
drag. On a wide screen it stays hidden along the row's leading edge until the pointer
reaches that edge, so it takes no column. On a phone it sits inline with the row's
controls. Rows sort live, without dimming, and travel only along the list. The drop
keeps the order on screen until the stored preference arrives. A focused handle moves
its row with the arrow keys. A display order is presentation only: routing priority and
weight belong to the routing board. A new list takes
[`useSortableList`](../web/src/hooks/useSortableList.ts) rather than its own preference
wiring: a grouped order document when its keys are stable, such as credential file names, or a
rank document of its own when they carry a provider's positional id, which the server re-keys
with the other provider overlays when a delete or move shifts later entries.

## Information expression

Facts about one thing are structured by layout, not by punctuation. The middle dot (`·`) is not a
separator in this console: a run of values strung on dots has no hierarchy, wraps mid-fact and
reads as one undifferentiated line. Pick the structure the content already has:

| Content | Use |
| --- | --- |
| Short facts side by side (size and line count, provider and priority, requests and failures) | [`MetaLine`](../web/src/components/common/MetaLine.tsx): space between facts, each wraps whole; a figure that matters takes `<b>`, a failure its tone |
| A label with its value | [`FactList`](../web/src/components/common/FactList.tsx) in a panel, label/value rows in a tooltip |
| A name and the thing it qualifies (an instant and its countdown, a channel, an id behind a name) | Parentheses through a catalog sentence: `09/30 01:05 (4h left)`, `Channel price (relay)` |
| Clauses of one description | A sentence: `joinPhrases` in [`utils/format.ts`](../web/src/utils/format.ts) uses the locale's comma |
| A machine error | `formatErrorCode`: `invalid_grant (HTTP 400): max_tokens` |
| An action on a target, as an accessible name | `common.action_on`: `Move earlier: Playground` |
| A title and its secondary line | Two elements with two inks, never one joined string |
| Several active filters | Separate chips (`FilterDisclosure` takes a list) |

A field's description goes under the control through `Field`'s `extra`, not after the label.
Catalog sentences follow the same rule: write the relation in words or parentheses instead of
`A · B`. Data that arrives joined from upstream (Antigravity's stored group label) is parsed in
one named helper and shown as its parts. `pnpm check:feedback` refuses a middle dot in web source,
styles and catalogs.

## Tooltips

A tooltip answers a reader who stopped on something and wants what the page cannot show in place.
It is the last resort, after a visible label, a description under the control, or a column.

A tooltip earns its place when it:

- names an icon-only control (the `aria-label` alone does not reach a sighted pointer user);
- says why a control is disabled;
- completes text the layout truncates (`data-tip-overflow`, shown only while it is cut off);
- gives the exact figure behind a rounded one, or the instant behind a relative time;
- reads a data mark that has no text of its own: a heatmap cell, a sparkline block, a chart point.

It does not repeat visible text, restate what the control's label already says ("click to
filter", "click to select"), carry content the reader needs to complete a task, or hold an action.
The delegated layers and `Tooltip` refuse to open a plain hint whose text equals the trigger's own
visible text, so an exact count beside a count already printed in full stays quiet on its own.

One phrase goes in `title` (or `data-tip`). More than one fact is a card: a heading, label/value
rows and quiet notes, drawn by `TooltipReadout` in
[`components/ui/tooltip.tsx`](../web/src/components/ui/tooltip.tsx). Every route takes the same
card shape (`TipCard` in [`tipCard.ts`](../web/src/components/common/tipCard.ts)):

- `Tooltip card={...}` for a React trigger;
- `{...tipCard(...)}` on any element for the document-level `data-tip` layer;
- `{...requestTipCard(...)}` inside the virtualised request list;
- `ChartTooltipContent` / `TooltipReadout` directly for charts and heatmaps.

In a card the labels sit in the secondary ink and the values right-aligned and tabular; a value may
take a tone (`up`/`down` for a change, `warn`/`danger` for a degraded or failing reading) and how a
figure was derived goes in `notes`, under a hairline. Never build a tooltip by joining strings with
separators or by stacking ad-hoc `<div>` lines.

## Feedback and loading

- Toasts describe events: a completed save, a failed operation, a copied value.
- Inline notices describe persistent state: unavailable data or required configuration.
- Field validation belongs beside the field. Do not repeat the same failure in a toast,
  banner and dialog.
- Initial absence can use a skeleton. Refreshing existing data should retain the data
  and its geometry, with a local activity indicator.
- A route names the body its loading frame draws (`loadingAs` in `App.tsx`; the bodies
  are in `PageLoading.tsx`). A page's first read keeps its real head and draws that same
  body, so the download frame, the first-read frame and the content land in one place.
- A progress estimate is not elapsed-time truth. Do not invent a time remaining or an
  exact accessibility percentage for work whose total cannot be measured.

Prefer concise, actionable copy. Secondary text explains what the user can do or what
a value means, not internal version history or defensive disclaimers. A record the server
names by a code - an audit action, a category - reads as a sentence in every locale; a raw
identifier among translated rows is a missing catalog entry, and a logic test compares the
server's audit actions with the catalog. Instants are shown in the console's time zone and
format, never as a raw ISO string.

## Motion and lifecycle

Motion explains a state transition; it must not delay the action it describes. Keep
transitions short and interruptible, preserving semantic values and focus while visual
readouts settle. Do not animate every item on a large mount or duplicate scroll ownership.
The console's motion is brisk: it answers the hand at once and is finished before anyone
waits for it, critically damped rather than bouncy.

Elements React renders animate with Motion through [`web/src/motion`](../web/src/motion/index.tsx)
only: its named springs, its reduced-motion policy and its `MotionScope`, which keeps the
library in the consuming route's lazy chunk. Give `animate` a target whose identity is
stable across renders; a fresh object reads as a new target and fights a running exit.
A height fold animates a wrapper with no padding or border and the visible box sits inside it:
Motion measures `auto` in the state it is heading for, so padding folding alongside would stall
the motion short of its end and snap the rest.

Charts are the exception. A chart's marks are hundreds of SVG nodes, so a new dataset is rendered
once inside an element-scoped view transition ([`useChartMorph`](../web/src/charts/useChartMorph.ts))
that cross-fades the chart on the compositor, and the chart library's own tween stays off. Where
scoped transitions are missing or motion is reduced, the new data simply lands.

A list that a search or a status filter narrows animates through the same layer
([`motion/filter.tsx`](../web/src/motion/filter.tsx)): what remains glides to the place the shorter
list gives it, and what starts to match fades in where it now belongs, as one move. A row the filter
drops leaves at once - holding it for a fade before the rest close up reads as a pause, and the
operator is already typing again by the end of it. Only a change that keeps something is drawn as a
move; another page or another provider's rows replace the list and arrive as they are.

The list itself owns how much is on screen, because a filter that mounts hundreds of rows is slow
however it is drawn: pages that can grow paginate, and the plugin store keeps a shelf of each
registry with the rest one deliberate, interruptible click away. A list long enough that moving it
would cost more than a frame is drawn in its new shape at once, so a large catalogue answers with
the row it was searched for rather than with motion.
Library overlays (drawers, dialogs, menus) keep the CSS motion tokens in `index.css`.

Honor reduced motion and visibility changes. Reduced motion is one console setting (OMC
Settings, defaulting to the system's), published as `data-reduced-motion` on the root; a
stylesheet keys on that attribute and never asks `prefers-reduced-motion` directly, which would
keep animating after the operator switched motion off in the console. A logic test enforces it. Timers, observers, animation frames,
subscriptions and native listeners belong to a disposable lifetime. Background or
unmounted views must not continue doing presentation work. Test behavior in the lowest
credible layer; browser timing is useful only where the browser engine is the subject.

## Small screens, keyboard and touch

Design for content first, including a 390px-wide phone, dynamic viewport height and
safe-area insets. Avoid page-level horizontal overflow.

The console has two breakpoints and they mean different things (`useIsNarrowViewport`,
`useIsPhoneViewport`). At 900px the shell changes shape: the sidebar becomes a sheet and the
header names the page. At 640px the device is a phone, and a list stops being a table. Between
them a page has no sidebar but still draws its desktop content, so a rule that follows the
shell's shape - a toolbar that must stack, a bar placed beside the sidebar - uses 900px, and only
a rule about the content itself uses 640px. Check that band at 768px. A wide table there scrolls
inside its own card; a frame that clips its content must not sit on the element that scrolls.

A strip that scrolls sideways with its scrollbar hidden - filter segments, maker chips, section
tabs - takes the shared `scroll-fade-x` class, which fades the edge that has more behind it. A
clipped label with no such cue reads as broken, not as more to see. Dialogs and drawers must keep
the current action and focused field reachable when the keyboard appears. Opening a
list must not raise the keyboard over it: a select the reader can type into uses
[`SearchSelect`](../web/src/components/common/SearchSelect.tsx), which becomes a
bottom sheet on narrow screens.

Use visible labels, keyboard navigation, clear focus indicators and appropriate hit
areas. Do not make hover the only route to information or an action. A control inside a
field that holds state the reader cannot otherwise change, such as revealing a secret, is in the
tab order; one that repeats what the keyboard already does in the field, such as clearing it,
may stay out of it. Never nest one interactive role in another: a tile that toggles a checkbox
is that checkbox's `<label>`, not a `role="button"` around it. When a submission fails because
of what was typed, the field carries `aria-invalid` as well as the notice above the form. On coarse pointers,
keep editable text large enough to avoid browser focus zoom. A phone layout must retain
the same information and capabilities as the desktop layout.

A field a hand types into with an input method composes before it commits: pinyin, kana or an
accented letter is drawn as a draft that may become different text. The field draws that draft and
commits only the finished text to the page, so a half-typed romanisation never filters a list or
redraws the field under the hand.

## Finishing a UI change

Inspect light and dark modes, a narrow viewport, keyboard flow, loading/error/empty
states and reduced motion where affected. Use [Testing](testing.md) to choose checks.
If a pictured user-facing page changed, refresh the relevant README screenshots with
`pnpm build && pnpm readme:screenshots`; screenshots are presentation assets, not a test
of exact pixels. Do not duplicate this guide in component comments or feature documents.
