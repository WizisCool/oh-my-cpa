# ADR 0072: Canvases run in a sandboxed frame

- Status: Accepted
- Date: 2026-10-08
- Extends [ADR 0042](0042-display-tools-draw-referenced-frozen-data.md) and
  [ADR 0071](0071-panels-are-a-block-vocabulary-with-open-icons.md): `render_canvas`
  is the fourth display tool, for what the other three cannot express.

## Context

A closed vocabulary cannot draw everything worth drawing: a routing diagram, a
timeline with its own geometry, an interactive explanation. For those the model has
to write markup. Markup written by a model is untrusted in the strongest sense - the
model reads capability results, and provider notes, key aliases and model names are
strings other parties control - so it cannot become part of the console's document,
where it would hold the operator's session.

## Decision

`render_canvas` takes a title, a body of HTML with inline style and script (at most
48 KiB), and optionally `source {call_id, path}` with `fields`, resolved and frozen
exactly as a chart's rows are. A turn draws at most two.

The console never interprets the markup. It builds a separate document around it and
shows that document in a frame, with three independent boundaries:

1. **No origin.** The frame is `sandbox="allow-scripts"` and nothing else. Its
   document has an opaque origin: no cookies, no storage, no access to the console's
   DOM, no forms, popups, downloads or top-level navigation.
2. **No network.** The document's first element is a content security policy of
   `default-src 'none'` with only inline script and style and `data:` images and
   fonts allowed. It is stated before any of the model's markup is parsed, and a
   later policy can only narrow it.
3. **No way out by navigation.** A sandboxed frame may still navigate itself, and
   neither of the above stops that: a canvas could carry its data away in a URL. The
   console's own document therefore declares `frame-src 'self' blob:`, which the
   browser applies to every navigation of a nested frame. This was measured rather
   than assumed: without it a sandboxed `srcdoc` frame reached another host by
   assigning `location.href`; with it the navigation is refused.

The canvas is given two things. The theme, as the console's CSS variables with their
resolved values, so markup coloured with `var(--accent)` looks like the console and
is rebuilt when the theme changes. And its rows, as `window.OMC_DATA`, serialised so
that no row can end the script element they sit in.

The frame reports its content height with `postMessage`. The console accepts a report
only from the frame's own window, only when it is a finite number, and clamps it.

The frame is a `srcdoc` document, not a route. A dedicated endpoint with a `sandbox`
response header (the custom icon precedent) was considered: it would need a stored
conversation to serve from, so it could not draw a canvas that is still streaming,
and it would add a route to the facade, the demonstration and the saved HTML page,
all of which the `srcdoc` form serves with one builder
(`web/src/agent/canvasDocument.ts`).

## Consequences

- The markup is stored as written and not sanitised. Safety does not depend on
  recognising what is dangerous in it, which nothing could do reliably.
- `frame-src 'self' blob:` now applies to the whole console. Plugin pages are framed
  from this origin and are unaffected; a future feature that frames another origin
  has to revisit this policy, deliberately.
- The console's own font is not available inside a canvas (it cannot load one), so a
  canvas is set in the system monospace face.
- A saved HTML page embeds each canvas in the same sandbox, and its own policy has no
  `frame-src` allowance at all. A PNG, and print, show a note in its place: a script
  cannot run in a picture.
- The model pays for a canvas in tokens on every later round of the turn, since the
  markup is part of the stored tool call. The size and count limits bound that, and
  the request budget elides it like any other old tool exchange.
