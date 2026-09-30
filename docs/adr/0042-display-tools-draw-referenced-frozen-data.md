# ADR 0042: Display tools draw referenced data, frozen on the call

- Status: Accepted
- Date: 2026-09-29

## Context

An answer about usage is usually a trend or a comparison, and the Agent could only write it as
prose or as a Markdown table typed out by the model. Both have the same two faults. The numbers
are the model's retelling of a capability result, so a transcription error is indistinguishable
from the data; and every row costs tokens twice - once when the capability returns it and again
when the model repeats it.

Letting the model emit a chart specification with its own data would draw the figures but keep
both faults. Letting the browser read a capability result directly would draw real data but tie
the picture to whatever that result means when the page is next opened, and would put
capability-shaped parsing in the browser for every capability.

## Decision

The Agent has two display tools, `render_chart` and `render_table`, offered only when the client
declares it can draw them (the console does; the MCP bridge does not).

- **Data is referenced, not transcribed.** The model names `source {call_id, path}`: a successful
  capability call of this conversation and a dot path to its rows - objects, or positional arrays
  beside a `columns` list, which is how a `database_query` result is referenced. The
  server resolves the reference, projects the named fields and checks them - a chart's `y` fields
  must be numeric, a field must exist in some row, nested values are refused. `inline` rows (at most
  200) exist only for figures the model derived itself and no capability returned.
- **The view is frozen on the trace.** The resolved dataset - kind, title, chart specification,
  columns, rows and its source - is stored on the call's trace, so a reload shows the same figures
  whatever the deployment's data has done since, and an export carries exactly what was drawn.
- **The model receives a receipt, not the rows**: `{rendered, rows, fields}`. A refusal is an
  ordinary `invalid_tool_arguments` result with a detail naming the field of the request to change,
  and it never quotes stored data.
- **They are not capabilities.** They change nothing, so they never pass through the executor,
  never prepare an operation, never interrupt a run and are not audited as operations.
- Bounds: 1000 rows, 12 table columns, 8 chart series, 96 KiB per view; a larger array is refused
  with the instruction to aggregate first.

The console draws a view only from a turn that succeeded: the figures form a result section after the answer, outside the collapsed call chain - a table with sorting and CSV copy and download, a chart on the console's chart stack (series palette, shared tooltip, motion rules), loaded lazily, with a switch to the rows behind it and a PNG download. While the turn runs, a stopped answer or a refused reference keeps the display call in the trace as ordinary work; a chart or table the model drew while investigating is not published as an answer's result.

## Consequences

- A chart's figures are a capability's figures. What the model can get wrong is which result it
  points at and how it describes it, both of which the operator can check in the call details.
- Displays are final-answer artifacts: investigation stays in the trace, so a long task cannot
  turn the transcript into a gallery of intermediate figures.
- A chart or table costs its data once in tokens.
- A stored conversation grows by the frozen rows; the per-view byte bound and the session's existing
  trimming by whole turns keep that bounded.
- A new capability needs nothing to be drawable: any result holding its rows as objects, or as
  positional arrays beside their column names, can be referenced.
