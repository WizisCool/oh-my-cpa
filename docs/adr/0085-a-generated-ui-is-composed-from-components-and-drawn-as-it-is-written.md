# ADR 0085: A generated UI is composed from components and drawn as it is written

- Status: Accepted
- Date: 2026-10-09
- Amends: [ADR 0072](0072-canvases-run-in-a-sandboxed-frame.md), whose frame gains a preview and a
  taller cap; [ADR 0073](0073-charts-and-tables-are-canvases-and-a-command-can-hold-an-answer-to-one.md),
  whose kit gains components and a diagram; and
  [ADR 0080](0080-work-in-flight-is-shown-where-it-will-land.md), whose draft figure was a loader
  until the call settled.

## Context

`render_ui` gave the model a sandboxed page, theme variables, and helpers for a chart and a table.
Everything else was the model's own CSS, written without knowing the frame it would be drawn in.
The results were uneven in exactly the ways an operator notices: layouts designed for a 1050px
page squeezed into a 750px frame, cards nested in cards, an "architecture diagram" that was a grid
of boxes with no connections, content taller than the frame's 720px cap scrolling inside it, and a
canvas whose measured height missed overflowing content and grew a scrollbar over its last column.
A canvas also showed nothing but a loader for the whole time its markup was being written.

Interfaces of this kind that read as one product do two things: they are assembled from a library
of components, and they appear while they are generated.

## Decision

1. **The frame carries components, and the model composes from them.** The kit's stylesheet adds
   `omc-stack`, `omc-row`, `omc-grid`, `omc-card`, `omc-stat`, `omc-badge`, `omc-callout`,
   `omc-kv`, `omc-field` and `omc-tabs`, drawn with the console's tokens, radii and spacing, and
   every one fluid. Tabs are wired from markup (`data-omc-tabs`, `data-tab`, `data-panel`).
2. **A diagram is a call.** `OMC.diagram` takes nodes and edges, layers the nodes by their distance
   from a source, and draws the arrows between their boxes: side by side in a wide frame, an
   indented tree in a narrow one. A node can be picked to read its detail and see what it touches.
3. **The tool states the frame as a layout contract.** The `html` parameter's description gives
   the frame's width on a desktop and a phone, says the height follows the content and that
   padding, surface and title are supplied, and asks for fluid widths, no nested cards and the
   components before custom CSS. It lives on the parameter rather than in the system prompt, whose
   budget is 6 KiB and which every turn pays for whether or not it draws.
4. **Nothing a canvas draws leaves the frame.** Media is capped to the frame's width, preformatted
   text scrolls inside its own block, the reported height includes content overflowing the
   document's box, and the cap rises from 720px to 1600px so a canvas is read by scrolling the
   conversation rather than a box inside it.
5. **A canvas is drawn as it is written.** While the call's arguments arrive, the draft figure
   holds a preview frame with the canvas's sandbox, policy, tokens and components and none of its
   scripts. The console decodes the `html` string as far as it has been written - cut back to its
   last whole character - and posts it every 120ms; the preview assigns it as markup, which never
   runs a script and drops an unfinished tag. The finished canvas replaces the preview at the
   height the preview had reached.

## Consequences

- A canvas written with the components looks like the console whichever model wrote it, and a
  model that ignores them still gets a frame its content cannot overflow sideways.
- What a canvas computes - a chart, a diagram, a control's state - is absent from the preview and
  appears when the canvas settles. The static structure around it is what streams.
- The preview and the canvas are two frames, so the swap redraws the figure once. Holding the
  height keeps the conversation from moving when it does.
- The tool declaration is longer. It is sent only on turns that offer `render_ui`.
- The components are a contract with stored conversations: a class a stored canvas uses has to keep
  meaning what it meant, so they are added to rather than renamed.
