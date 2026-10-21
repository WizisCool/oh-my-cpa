# ADR 0103: A quiet panel on a canvas, and only summoned layers lift

- Status: Accepted
- Date: 2026-10-21
- Amends: ADR 0009's bound (the `fast` token is now 120ms), ADR 0011's derived set (eighteen tokens,
  adding `canvas`), and ADR 0086's radius values.

## Context

The console was drawn as a terminal: every boundary a 1px line, zero shadows anywhere, 4px corners on
everything from a pip to a dialog, and a motion budget of 50ms and 100ms. Each rule was defensible alone. Together they cost the interface its hierarchy:

- **Everything was the same kind of object.** A card, a menu, a dialog and the page itself were all a
  fill and a hairline, so the only thing telling a summoned menu from the card under it was a border
  that matched the card's own. The rail, the header and the page were three regions divided by two
  rules, which read as a grid of boxes rather than as navigation beside a document.
- **Grouping was drawn with lines.** A settings group was a framed box with a ruled header strip and
  ruled rows, so a page of settings was a stack of tables; the eye found the lines before the labels.
- **Every fact wore a frame.** Status, counts, flags and rates were each a bordered chip, so a row
  of a list was a strip of small boxes and the one exception in it - a failure - had no more weight
  than the eleven expected facts around it.
- **The motion budget was below the point where an entrance reads as one.** At 60ms a menu and at
  100ms a dialog are a cut with a smear; antd's own entrances, which the budget shortened rather than
  replaced, scale a panel from 80% (a dialog from 20%, out of the pointer), which at any duration reads
  as flying in.

The data surfaces - dense tables, tabular figures, the dashboard's readouts - did not have these
problems, and nothing here changes how they read.

## Decision

1. **The shell is a rail on a canvas and the page on one inset panel.** The navigation stands on a
   new derived token, `canvas`, one step behind the page; the header and the route content are drawn
   on a single panel at `bg`, inset 8px from the window and rounded by the card step. Neither the rail
   nor the header carries a border of its own: the panel's edge is the separation. On a phone the
   panel is the screen.
2. **Rail entries are soft filled rows.** Hover and selection are foreground washes over whatever the
   entry stands on (5% and 8%), so the same rule reads on the canvas and on the phone sheet; the
   selected entry takes the text colour at weight 500. The 2px inset bar is retired. Group names are
   quiet captions in reading case.
3. **The corner scale nests: 2 · 6 · 8 · 12.** Marks 2px (a check box 4px, status pips round); controls, tags and inputs 6px; menus,
   popovers, inner boxes and tiles 8px; cards, lists, dialogs, drawers and the content panel 12px. A
   shape inside another takes the step below its frame. `pnpm check:style-tokens` enforces the
   literals and refuses 5px as a step nobody chose. The conversation's corners move onto the
   same scale (`THREAD_RADII`: document 8, control 6, surface 10, thread 12).
4. **Static surfaces stay flat; summoned layers lift.** Cards, tables and the layout remain a fill and
   a hairline. A layer the reader summoned - a menu, a popover, a select or date panel, a toast, a
   dialog, a side sheet - carries a soft shadow (`--shadow-float`, `--shadow-overlay`) in addition to
   its hairline, with a deeper pair in dark mode where a light shadow would not read. A desktop side
   sheet floats like the page panel, inset 8px and rounded. The modal mask dims rather than hides
   (12% in light, 50% in dark). The composer, the one object a reader writes into, sits on a raised
   shadow that deepens to the floating one while focused.
5. **Grouping is enclosure, not division.** A card is drawn on the panel's own ground and enclosed by
   its hairline, never a second fill. Rows inside a settings group are divided by a dashed rule inset
   from the edge. On the OMC settings page the group's name is a caption above its enclosure, and the
   page takes a 920px reading column.
6. **Quiet controls are fills.** A secondary button is a foreground wash (6%, 10% hovered, 13%
   pressed) with a transparent edge and its label in the text colour in every state; a dashed button
   keeps its dashed outline because it draws the slot it will fill. Every field - an input, a select,
   the time window - is a filled well whose edge appears only under focus (antd's global `filled`
   variant), so a toolbar of fields is one row of equal wells.
   A row action is its glyph alone until the pointer brings a fill under it. The switch is a pill
   with a raised knob; position and fill carry the state.
7. **Facts are text; only exceptions are marked.** A verdict is a dot and a word, coloured in full
   only when it is a failure; counts are a line of text divided by quiet dots; a tag is a soft fill
   with no edge; a continuous reading (the cache rate) is its value in its hue. Status pips are round.
   Column headers and captions are sentence case; log levels and unit marks, which label data, keep
   their case. The bundled Sarasa face stays the default for both typeface roles, and the mono role
   is reserved for strings read character by character - identifiers, keys, paths and code - so
   names, models and figures follow the interface role an operator chooses.
8. **Motion is gentle and still restrained: 120 · 160 · 180 · 240ms.** `fast` 120ms (hover, press,
   colour), `float` 160ms (a summoned panel), `base` 180ms (route fade, disclosure), `slow` 240ms (a
   dialog, a sheet). Entrances use a decelerating curve (`--ease-out`). A panel fades in while settling
   the last 4% toward its origin; a menu also drops its last 4px toward its control; a dialog rises 8px
   into place; a leaving panel fades over `fast`. Opacity and transform only, every keyframe with a
   reduced-motion counterpart: a panel is pinned to its settled state, and a dialog, whose library
   moves focus and unmounts on `animationend`, keeps an opacity-only fade. Nothing bounces or overshoots.
   A button gives a little (97%) under a press. A palette change cross-fades the whole page over `slow`
   through the View Transitions API, and holds every element's own transition off for the two frames
   the repaint takes, so a switch is one composited movement instead of hundreds of colour eases. ADR 0009's
   bound survives as a bound - a hover lands within `fast` - at the new value.

## Consequences

### Positive

- Hierarchy is legible at a glance: chrome on the canvas, the work on the panel, and anything above
  the work visibly above it.
- Settings pages read as forms rather than tables, and the rail as navigation rather than a column of
  boxes.
- The palette contract is unchanged in kind. `canvas` is derived like every other relationship, so an
  operator's palette gets a canvas without authoring one, and no authored token moved.

### Trade-offs

- **Shadows exist again.** Dark mode needs much deeper shadows to read, and a shadow is a paint cost a
  border was not; both are confined to summoned layers, of which a page shows one or two at a time.
- **The motion budget is roughly doubled.** A hover now takes up to 120ms where it took 50ms. That is
  still well inside the point where a hover drags, but it is a relaxation of a documented constraint,
  and the dashboard's `roll` token (240ms) is no longer the only motion that long.
- **Dashboard cards moved from `surface` to `bg`.** The heatmap's two zero states were calibrated
  against the old card fill; they keep their order and stay quiet against the new ground, but their
  measured ratios changed (`docs/design.md` §2 carries the current numbers).
