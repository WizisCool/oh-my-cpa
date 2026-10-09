# ADR 0073: Charts and tables are canvases, and a command can hold an answer to one

- Status: Accepted
- Date: 2026-10-08
- Supersedes the `render_chart` and `render_table` tools of
  [ADR 0042](0042-display-tools-draw-referenced-frozen-data.md), and the `chart` and
  `table` blocks' counterparts in the tool list of
  [ADR 0079](0079-panels-are-a-block-vocabulary-with-open-icons.md). Their rule that
  a display draws referenced, frozen rows stands.
- Extends [ADR 0072](0072-canvases-run-in-a-sandboxed-frame.md): the canvas gains a
  drawing kit, a viewport-filling view and an image export.

## Context

The Agent had four display tools. Two of them, `render_chart` and `render_table`,
drew one fixed figure each from referenced rows; a page the model wrote itself could
draw the same figures and anything else, but only by hand - a model that wanted a bar
chart there had to write its own SVG arithmetic and its own number formatting, and
usually wrote both slightly wrong.

Four tools that overlap cost more than their schemas. The model has to choose
between them on every answer, the prompt has to explain the choice on every round,
and each figure kind needs a console renderer, an export renderer and tests. The
fixed tools were also the ceiling: a chart beside its table, two charts sharing a
legend, a table with a highlighted row were all one tool too many or a canvas written
from nothing.

Separately, the composer's `/` list offered canned questions. A canned question is
text the operator could have typed; it is not something the workspace does. What an
operator cannot type is a guarantee - "answer this one as a canvas" is a request the
model may or may not honour when it is only a sentence.

## Decision

**One display tool draws.** `render_ui` takes a title, the markup of the page, and
optionally the rows it referenced; the console draws it as a sandboxed frame wherever
the model called it (ADRs 0072, 0082, 0085). `render_chart`, `render_table`,
`render_view` (ADR 0079) and `render_canvas` are withdrawn: they are no longer
declared, offered or accepted, and a stored trace that names one is still read as a
display call that changed nothing.

**The canvas document carries a kit.** Before the model's markup, the console
injects a script it owns, exposed as `OMC` inside the frame:

- `OMC.rows` - the frozen rows the call referenced (`OMC_DATA` remains an alias);
- `OMC.fmt(value, unit)` - numbers written the way the console writes them, for
  `tokens`, `usd`, `ms`, `percent`, `bytes`, `time` and `number`, following the
  operator's token unit style, language and the deployment's time zone;
- `OMC.chart(target, options)` - line, area, column, bar and pie, optionally split
  by a series field or stacked, with formatted axes and a legend;
- `OMC.table(target, options)` - a table with labelled, unit-formatted, sortable
  columns.

The kit is source text inside the sandboxed document, so it holds no more authority
than the markup beside it: it reads `OMC.rows` and writes the frame's own DOM. It
draws with the theme variables the document already carries, so a kit figure follows
the palette and its light and dark schemes without the model naming a colour.

**A canvas can fill the viewport and be saved as an image.** The figure's own bar
offers both. The full-screen view is the same frame, drawn over the console and left
with Escape or the platform's Back gesture. The image is produced by the kit: the
console posts a capture request into the frame, the kit answers with an SVG of its
own document, and the console validates the reply's shape and size and rasterises it.
The frame stays as sandboxed as before - the console never reads the frame's DOM, and
the reply is treated as untrusted data.

**Stored conversations keep their traces.** A conversation saved before this change
may hold `render_chart` or `render_table` calls with their views. Those names stay
recognised as display calls - so the turn's replaceability and the trace's order are
judged as they were - but they cannot be a row source for a new call and the console
draws nothing for their views. The call remains listed in the answer's steps.

**A composer command can hold one answer to a presentation.** `/ui` and `/text` set
how the next message's answer is presented. The choice travels as
`forwardedProps.present`, is stored on the turn, and is kept by narrowing what the
turn is offered rather than by asking: a `ui` turn is offered `render_ui` and the
follow-up note, a text turn the follow-up note only, and a `ui` turn that ends without
a drawn UI is left as it is. The command offers no guarantee that one is drawn; what
it removes is the choice to answer in prose alone. `canvas`, the command's earlier
spelling, is still accepted on the wire and read as `ui`. A retry sends the turn's
presentation again.

**`/` lists commands, not prompts.** Every row either sets the next message's
presentation or runs a page action - stop, retry, edit, new conversation, export,
open the capability directory or the connection guide - and a row that cannot run
now is not listed.

## Consequences

- One renderer per figure instead of three. The console's chart and table views,
  their CSV export, and the conversation export's SVG charts and data tables are
  removed; a canvas is exported as the sandboxed frame it already was.
- A chart is now model-written markup calling a kit, which is slightly more for the
  model to write than a chart specification, and a wrong call draws nothing rather
  than failing validation. The prompt and the tool description name the kit's calls;
  the kit ignores what it does not understand and shows an empty state for no rows.
- The conversation image export still shows a canvas as a titled placeholder; the
  canvas's own "save as image" is the way to a picture of one figure.
- Charts and tables in conversations stored before this change are no longer drawn.
  The single stored conversation is short-lived working state, and re-running the
  question draws them as canvases; migrating frozen views into generated canvas
  markup would have kept a second renderer alive for it.
- The kit is part of every canvas document, including exported ones, at a few
  kilobytes each.
- `present` is the first forwarded property that changes what a turn is offered. It
  is validated against a closed set, accepted only with a new message, and a `ui`
  request is refused when the console did not declare `render_ui`.
