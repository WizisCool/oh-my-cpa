# ADR 0082: A display is drawn where the model calls it, framed or not

- Status: Accepted
- Date: 2026-10-08
- Amends: the placement in [ADR 0042](0042-display-tools-draw-referenced-frozen-data.md)'s line of
  display decisions, which gathered every figure in a result section after the answer. What a
  display is, how it is frozen and how a canvas is sandboxed are unchanged.

## Context

Every figure was drawn in one section at the end of the answer, in one bordered card with a title
bar, while its call sat as a row in the capability chain. The model could decide what to draw but
not where the reader met it: an answer that explains, shows, then concludes came out as all of its
prose followed by all of its figures. A small inline visual - a status strip, a single comparison -
was also given the weight of a titled card.

## Decision

1. **A display call is drawn at its own position in the answer's parts.** It leaves the chain of
   reasoning and capability calls and renders, where the model made it, as a draft while its
   arguments arrive and as the figure once it has settled. Text the model writes before and after
   the call surrounds it, and a turn may hold several.
2. **`render_ui` takes an optional `frame`.** `card`, the default, is the titled and bordered
   figure and is stored as absence, so stored views and new ones read alike. `none` sets the UI
   on the conversation's ground with no border and no title bar; its title remains the frame's
   accessible name, and its controls (source, save, full screen) stay available at reduced weight.
   Any other value is refused with a readable detail.
3. **A failed display stays a call row**, where its code and detail are read; it never leaves a
   silent gap.
4. **Reasoning is an unframed rolling disclosure.** It opens while reasoning arrives, follows
   the newest line until the reader scrolls up, and resumes following when they return to the
   bottom. It folds when reasoning finishes; reopening a settled block is the reader's choice.
5. **The system prompt says where a UI lands and what `frame: none` is for**, in one sentence
   inside the presentation section's existing budget.

## Consequences

- The placement needs no new stored field: the order of a turn's parts already records it, so
  conversations stored earlier redraw with their figures where they were called.
- The answer's copy action and quoting skip figures as before.
- The exported HTML and PNG still gather views after the answer's text; bringing them to the same
  order is follow-up work in `web/src/agent/conversationHtml.ts`.
- A frameless canvas depends on the model colouring with theme variables to sit on the page; the
  sandbox and content security policy are the same in both frames.
