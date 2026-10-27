# ADR 0109: A finger scrolls the request list natively

- Status: Accepted
- Date: 2026-10-27
- Supersedes: ADR 0048's decisions 2-4 (the console moving the list under a finger, its coast,
  and the header's touch fold and pull). Decision 1, one scroller that fits the screen, stands.

## Context

ADR 0048 kept the request list virtualized on touch and moved it under a finger from script: every
touch move was taken from the library, the list scrolled by the finger's travel and drawn
synchronously, and a release coasted on a curve that imitated iOS. It also had the first drag up
fold the filter header and move nothing else, and a 48px pull at the top unfold it.

On phones that still felt wrong. Each finger move ran a synchronous React render of the visible rows
on the main thread, so any busy frame - a poll landing, a row measuring itself - held the list back
from the finger, and a curve in script is never quite the platform's. The fold made it worse: the
first drag up moved nothing, and the fold resized the list while the finger was still on it. Readers
described the result as the list sticking to the finger and dropping frames.

ADR 0048 rejected a native scroller because 100 to 500 tall phone rows "have to stay virtualized".
That assumed every row costs layout and paint wherever it is. With `content-visibility: auto` a row
away from the view keeps its height in the scroll extent and is neither laid out nor painted, so the
cost of an unvirtualized page is its first render, paid once per page of records.

## Decision

1. **Wherever a finger can scroll (`any-pointer: coarse`), the request list is not virtualized.** It
   is an ordinary overflowing element, and the browser scrolls it on the compositor with its own
   tracking, momentum, tap-to-stop and edge behaviour. Rows away from the view are skipped with
   `content-visibility: auto`, and `overscroll-behavior: contain` keeps a drag at either end from
   reaching the page.
2. **There the header never folds on its own.** Scrolling, by finger or by wheel, leaves it open;
   the full-screen toggle in the header folds and unfolds it. With a mouse alone the list stays
   virtualized and the wheel's fold and top bounce are unchanged.
3. `requestListTouch.ts`, its coast physics and their logic tests are deleted.

## Consequences

- A drag moves the list on the frame the finger moves, independent of the main thread, and the
  first drag scrolls rather than folding the header.
- A phone shows fewer records at once while the filters stay open; the toggle buys the room back.
- A page of 500 records renders all of its rows once when it arrives. Above `any-pointer: coarse`
  nothing changes, including on a desktop narrowed to a phone's width.
- The `request-list-touch` probe asserts end states rather than frames, so it no longer runs alone
  (ADR 0095).
