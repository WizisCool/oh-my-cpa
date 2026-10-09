# ADR 0084: Calls are a timeline of disclosures in the answer

- Status: Accepted
- Date: 2026-10-09
- Amends: [ADR 0076](0076-the-agent-has-its-own-shell-and-names-its-model-in-the-composer.md), whose
  drawer no longer shows call details, and
  [ADR 0081](0081-the-conversation-thread-has-its-own-shape-and-fill-scale.md), which drew the
  capability chain without a rail.

## Context

A capability call was one row in the answer, and its arguments and receipt opened in a drawer at
the side of the page. Reading what a call returned meant covering part of the answer it belonged
to, and comparing two calls meant opening and closing the drawer twice. The stretch of reasoning
and calls above an answer was an indented list under "Used N capabilities", open for the whole of
a running turn, so a long answer was pushed down by its own working until the turn ended.

## Decision

1. **A call is a disclosure.** Its row - status mark, title, arguments in brief, duration, caret -
   opens a panel under itself with the capability's identifier, status and start time, the full
   arguments and the receipt the model was given. The drawer keeps the capability directory and
   the connection guide, which are about the page rather than about one call.
2. **A stretch of reasoning and calls is a timeline.** A summary line states how many capabilities
   were used and how many failed; under it the steps hang from one rail in the order they
   happened, reasoning included, each step's mark on the rail.
3. **The timeline is open where the work is.** It is open while it is the end of a running answer,
   or while a call in it waits on the operator, and folds to its summary once the answer has moved
   past it. Folded mid-run, the summary reads "Working…" with the work-in-flight highlight of
   [ADR 0080](0080-work-in-flight-is-shown-where-it-will-land.md). The reader's toggle wins.
4. **A phase is named where it is drawn.** Reasoning being written reads "Thinking…" on its own
   disclosure and a running call carries the highlight on its title; the activity line under the
   answer keeps the loader and the elapsed time, and names a phase only when nothing in the answer
   does.
5. **Both disclosures open by a grid row growing from nothing** within `base`, the one way to
   animate to a height that is not known in advance without measuring it in script. It is a
   `layout` exception in `pnpm check:motion`, as the settings accordion is, and reduced motion
   removes it. A folded panel is hidden from focus and assistive technology.

## Consequences

- A call's details are read beside the answer and several can be open at once. A large receipt
  scrolls inside its own 280px block rather than lengthening the answer without bound.
- The capability's identifier is one click further from view than it was on the row. The row's
  title is the localized name; a capability the console has no copy for still reads as its
  identifier.
- The steps of a settled timeline are drawn the first time it is opened and kept afterwards, so a
  long stored conversation does not pay for timelines nobody opens.
- A database query opens to its SQL arguments and timing and has no receipt block; its rows stay
  on the server ([ADR 0078](0078-agent-results-carry-data-references-and-completed-turns-keep-conclusions.md)).
- The elements follow assistant-ui's tool-call and tool-timeline elements, written against the
  theme tokens and the console's own trace model rather than taken as components.
