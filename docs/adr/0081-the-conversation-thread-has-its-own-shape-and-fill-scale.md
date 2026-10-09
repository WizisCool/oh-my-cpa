# ADR 0081: The conversation thread has its own shape and fill scale

- Status: Accepted
- Date: 2026-10-08
- Amends: design.md §4's single 4px radius, for the conversation workspaces and the approval card
  only. Colour, type, the zero-shadow rule and §7's motion budget are unchanged.

## Context

The Agent and the Playground were drawn with the console's table-and-form geometry: 4px corners,
a 1px frame around each object, a rail beside every disclosure and a 2px edge bar on every notice.
That geometry suits dense records. In a transcript it made an answer read as a stack of boxes: the
operator's message, a call row, the reasoning, an approval and a failure each carried their own
frame, so the lines outnumbered the content and nothing told a pressed object from printed output.

assistant-ui, the library the thread is built on, publishes a design language and a catalogue of
thread elements (tool rows, approval cards, suggestions, error and thinking states) that answer
this: shape is chosen by what an element is, groups are fills instead of frames, and lines are
budgeted. Its components are written with Tailwind utilities and its own neutral palette.

## Decision

1. **The thread takes that language's registers, not its code.** Shape by kind (printed matter
   6px, pressed controls 8px, field panels and floating lists 10px, the composer, the operator's
   bubble, cards and suggestions 16px); grouping by a faint fill of the foreground; one hairline
   edge at most on an object; rows separated by spacing and a hover fill.
2. **Every value is a token derived from the palette**, declared once in `web/src/index.css`
   (`--radius-document`, `--radius-control`, `--radius-surface`, `--radius-thread`,
   `--thread-field`, `--thread-field-hover`, `--thread-hairline`). The accent stays the palette's
   accent; state colours stay `--success`, `--warn` and `--danger`.
3. **The elements are first-party CSS Modules over the assistant-ui primitives.** No Tailwind, no
   component registry and no second icon set enter the build.
4. **The scale stops at the workspace's edge.** The console keeps its 4px radius and framed
   panels; the exported conversation follows the thread, because it is the thread on paper.
5. **Motion keeps §7's budget.** The source language's 150-300ms transitions are not adopted; a
   press scales its object slightly over `--motion-fast`.

## Consequences

- An answer carries far fewer lines: no rail beside reasoning or the capability chain, no edge bar
  on a failure or an approval, no rule above the follow-up questions.
- Two geometries now exist in one console. The boundary is a whole surface (the conversation),
  not individual widgets, which is what keeps the difference from reading as inconsistency.
- A destructive approval is no longer marked by a thick edge; its permission tag, its notice and
  the danger-coloured Allow carry that, with the hairline tinted `--danger`.
- New thread elements are drawn from this scale; a 4px frame inside the thread is a defect.

## Alternatives considered

- **Install the Tailwind-based elements and map their theme variables to ours.** Rejected: it adds
  a second styling system and its reset to an offline, size-budgeted bundle, its utilities carry
  fixed hues (blue for live, emerald for done) that bypass the palette presets, and its durations
  break the motion gate.
- **Keep the 4px geometry and only remove lines.** Rejected: at 4px a borderless filled bubble or
  composer reads as a table cell; the larger radius is what lets a fill replace a frame.
