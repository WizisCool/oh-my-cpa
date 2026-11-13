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

Contrast is read differently in the two modes. A dark page dilates the eye, and a bright stroke
blooms into the dark around it, so dark text has a ceiling as well as a floor: the default dark
foreground stops near 14:1, inside the -90 limit the perceptual contrast model sets for dark text.
A light page keeps conventional reading contrast (near 15.5:1), but on an off-white ground rather
than white, so shadows have something to fall on and the near-white raised layer - a menu, a
segment's thumb, a selected row - stands out from the page. The default palettes are neutral; a
tinted look belongs to the alternative palettes.

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

Only dots are round: status pips, radios, spinners, avatars and step numbers are circles, and a
switch is a dot travelling in its slot, so its knob is a circle and its track a pill (`9999px` is
the stylesheet's spelling of full, `rounded-full` Tailwind's). Nothing else is a pill - not a
badge, a tag, a progress bar or a scroll thumb.

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

Elevation is a ladder, and every surface stands on one rung of it. The page panel and the cards
on it rest at `--shadow-edge`; a card the reader can press rises to `--shadow-raised` under the
pointer (with the `--hover-inset` fill) and never moves; a group inside a card is a flat wash
(`--surface` or an ink wash) holding white raised items, never a second edge stacked on the first;
menus, popovers, tooltips and toasts float at `--shadow-float`; dialogs and sheets at
`--shadow-overlay`. A card inside a card that also casts a drop reads as a pile, not a hierarchy.

A chosen thing is picked up and lit, never outlined. An outline flattens a shadowed surface into
a drawing of one, and a bright ring reads the same in ink as in the accent. A selected filter
tile, theme card, icon tile or answer option takes `--shadow-selected` (the lift ring at half
again its share, over `--select-drop`) and the `--select-surface` fill: on a dark palette the face
steps one tone toward the light, on a light one the drop gains a firmer contact line. It stays one
rung above its neighbours, so a strip of cards keeps lying on the page; a float-height selection
made the whole strip look airborne. The navigation marks the current page the same way, as a
small tile of the panel's material lifted off the canvas. An open or focused field keeps its well
and takes `--shadow-field-focus`, the select ring inside with a soft neutral halo. The accent ring (`--shadow-focus`) is kept for keyboard focus alone, where it has to
be found at a glance. A semantic state colours the ring in its own tone and keeps the drop:
`0 0 0 1px var(--danger), var(--edge-drop)` for an invalid surface, the warning tone for a
warning. A shape whose rows stack into one card wraps them in a single element that carries the
shadow, since a drop drawn per row bleeds across the seams. Where a container clips its content
(the request list slides inside a clipping slot), the ring is drawn inside the clip instead.

A long stream of records (the request list) separates its rows by rhythm instead of rules, and
marks hover, the open record and a ticked row with a rounded ink wash inset from the card's edge,
the same shape as a highlighted menu or navigation item. Hundreds of ruled rows read as a ledger
of hairlines. A short table of entities keeps its soft row rules.

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

## Buttons

A button's variant says how much the action weighs, never which page drew it. There are six
weights; a page does not restyle one into another with a class.

| Variant | Use it for | Never for |
| --- | --- | --- |
| `primary` | The one action that finishes the page's, dialog's or drawer's task: Save, Create, Sign in, Add provider. At most one per region. | A toggled state, a current page, a second action beside the first |
| `secondary` (default) | Every other labelled action, and the standing tools of a page header or toolbar (`ToolButton`) | Actions repeated on every row |
| `ghost` | Actions that live inside content: a row's actions (`.row-actions` with `row-action-btn` for a glyph), a card head's action, the shell header (`HeaderAction`), menu rows | The page's main action |
| `active` | The on state of a tool that toggles (`aria-pressed`) or a disclosure that is open: a filter panel, line wrap, an expanded restore | Anything that is not a toggle |
| `link` | Navigation or a text-like action inside prose: "Request events ›", "Show all", "Clear filters". A trailing chevron points where it goes. | An action that changes data |
| `dashed` | An empty slot that adds an entry to a list | Any other action |

`filled` is a field-shaped trigger (the time-range button) that sits among selects and must look
like one. `danger` turns any weight into its destructive form; a destructive row action stays in
the hint ink until the pointer reaches it. Sizes follow the place, not the importance: `default`
(32px) for page and dialog actions, `sm` (28px) inside rows, card heads and dense toolbars, `lg`
only on the sign-in form. An icon-only action is a `ToolButton`, which carries the name the glyph
cannot.

## Composition and shared controls

Use the shared page, panel, toolbar, field, empty-state, drawer, dialog and
confirmation primitives before creating another page-local version.

An on/off setting is a [`Switch`](../web/src/components/common/Switch.tsx): on fills the track with
the healthy green, and the side the knob sits on states the value without the colour. A lone
switch stays beside its setting's name at every width; a phone does not drop it under the
description.

The language picker is a globe and the language's own name (its endonym), never a flag: a flag
names a country, and the console's languages are not countries. Flags are kept for currencies,
where the issuer is the fact.

A [`Tag`](../web/src/components/common/Tag.tsx) has one geometry everywhere: 22px high (18px
small), `--radius-sm`, weight 500, a tint of its tone with a rim of the same tone drawn inside.
Anything else shaped like a chip - a count, a prefix, a badge on a row - takes the small tag's
height, radius and rim rather than its own. A dialog
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

Nothing a state brings in moves what is already on screen. A reset or clear-filters control
arrives at the end of its row, and the search beside it has a small flex basis so it gives the
room back instead of wrapping the row. A selection docks as the floating
[`SelectionBar`](../web/src/components/common/SelectionBar.tsx) over the foot of the list it acts
on; on a phone it is one line, with the actions as glyphs. A list carries no checkboxes until a
choice starts, from the toolbar's select tool or a row menu's Select; while it lasts a plain click
picks, and clearing the selection ends it. The checkbox column opens from no width on
`--select-reveal` while the columns after it glide over, and its checkboxes stay mounted and grow
in with it (`.select-reveal`), so starting or ending a choice never jumps the rows. A long, wide
list tells its rows apart by bands on every other row, never by rules. Bands run edge to edge and
are tone alone, with no edge or shadow. The first row is always the opposite of the column names:
on a dark ground the bands are a breath of ink from the second row; on a light ground the rows
alternate between a soft white and a breath of ink from the first, and neither is the page's own
ground, so the list reads as one material. The bands never change under the pointer: a row says
it opens through its own way in (the chevron brightens and leans toward the drawer), and while
choosing, through its checkbox's edge. The open record is a full-width face tinted with the
accent.

A record's name renames in place ([`InlineName`](../web/src/components/common/InlineName.tsx)).
The rename glyph is the last thing on the name's line and shows while the row is hovered or the
glyph has focus; it keeps its width while hidden. The field takes the name's own place and type,
selects the whole name, saves on Enter or on leaving, and restores it on Escape. Where nothing can
hover, the row's menu carries the rename.

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
So does an arrival with no state to interrupt: a page frame, a list's first paint and the docked
selection bar settle in once on mount through one keyframe each, switched off under reduced motion.

A spring belongs to the hand: a dragged card landing, a check mark the reader just set, a
gallery leaning under the pointer. Its overshoot is a nudge felt rather than watched. Anything
that arrives on its own - a finished step, an outcome, a status - settles in on `--ease-out`
without an overshoot. A card under the pointer rises in shadow and never travels.
A route settles in rather than swapping: the page frame fades in over a 4px rise
(`route-enter`), a list or table arriving inside a page that is already standing only fades, and
a loading placeholder waits 120ms before it shows, so a fast answer never flashes a skeleton. A card the
reader chooses presses in by `--press-scale` (0.99) under the pointer and settles into its
selected state on `--select-transition` (`--motion-base`, `--ease-out`): felt, not watched, with
no spring.

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

A control keeps one height on every pointer: 32px, 28px at `sm`. A coarse pointer gets its larger
hit area from an inset `::before`, never from a taller control, so a select, a segmented control, a
field and a switch on one row stay aligned on a phone. Only items inside an open menu or sheet
grow for a finger.

The console has two breakpoints and they mean different things (`useIsNarrowViewport`,
`useIsPhoneViewport`). At 900px the shell changes shape: the sidebar becomes a sheet and the
header names the page. At 640px the device is a phone, and a list stops being a table. Between
them a page has no sidebar but still draws its desktop content, so a rule that follows the
shell's shape - a toolbar that must stack, a bar placed beside the sidebar - uses 900px, and only
a rule about the content itself uses 640px. Check that band at 768px. A wide table there scrolls
inside its own card; a frame that clips its content must not sit on the element that scrolls.

A segmented filter of four or more segments becomes two rows of two on a phone, so every segment
keeps its label on one line at one height instead of wrapping to a different number of lines.

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
of what was typed, the field carries `aria-invalid` as well as the notice above the form. A field keeps the
console's reading size on a phone; iOS's zoom into a focused small field is stopped by
`maximum-scale=1`, which the console adds on iOS alone, where pinch zoom survives it. A phone layout must retain
the same information and capabilities as the desktop layout.

A field a hand types into with an input method composes before it commits: pinyin, kana or an
accented letter is drawn as a draft that may become different text. The field draws that draft and
commits only the finished text to the page, so a half-typed romanisation never filters a list or
redraws the field under the hand.

## Finishing a UI change

Inspect light and dark modes, a narrow viewport, keyboard flow, loading/error/empty
states and reduced motion where affected. Use [Testing](testing.md) to choose checks.
If a pictured user-facing page changed, [`.github/workflows/readme-screenshots.yml`](../.github/workflows/readme-screenshots.yml)
refreshes README screenshots on a daily schedule or manual dispatch (or you can run
`pnpm build && pnpm readme:screenshots` locally when previewing changes before merge);
screenshots are presentation assets, not a test of exact pixels. Do not duplicate this
guide in component comments or feature documents.
