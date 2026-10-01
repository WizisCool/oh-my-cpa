# ADR 0048: The request list moves under a finger itself

- Status: Accepted
- Date: 2026-10-01

## Context

On a phone the request list scrolled badly in three separate ways, all measured on the real list at
390×664 with touch input dispatched through the DevTools protocol:

- **The page around the list scrolled and bounced.** On phones the page was held to at least 760px,
  taller than most phone screens, so the content pane scrolled as well. A drag that started on the
  filters scrolled the pane, and a drag that reached either end of the list was handed on to the
  pane. The pane then bounced at its own end, or reloaded the page when pulled down at the top. The
  unfolded filter header took 399px of a 608px pane, and the footer sat below the screen.
- **The list ran ahead of the finger.** The list is virtualized, so its holder clips its overflow and
  the browser cannot scroll it for a finger. `@rc-component/virtual-list` emulates touch scrolling
  instead: every touch move scrolls the list by the finger's travel and restarts a coast on a 16ms
  interval. That coast keeps firing between moves while the finger is still down, so a 200px drag
  moved the list up to 370px.
- **A finger could fold the header but not unfold it.** The first scroll folded the header after the
  list had already moved under the finger. The only ways back were a wheel turned up at the top and
  the back-to-top pill, which is not shown at the top.

## Decision

1. **On touch the page fits the screen and the list is its only scroller.** Below 640px, and wherever
   a finger is the main pointer, the page and the list drop their minimum heights. Over the list the
   browser keeps only sideways panning and zoom (`touch-action: pan-x pinch-zoom`), so a drag at
   either end has nowhere to go.
2. **The console moves the list under a finger** (`web/src/components/usage/requestListTouch.ts`).
   Every touch move over the list is taken from the library with its `_virtualHandled` flag, which
   the library already checks for touch moves, from a capture-phase listener on the page. The list
   is moved by exactly the finger's travel and drawn synchronously, so it is on screen on the frame
   the finger moved.
3. **A release coasts at the speed the finger left with**, measured over the last 100ms and decaying
   at iOS's normal rate (98% of the speed kept per 10ms). A finger that rested before lifting does not
   coast. A tap on a coasting list stops it and is not delivered as a click, as on a native scroller.
   A wheel, a key, a page change and the return to the top all stop a coast.
4. **The header folds and unfolds with the wheel's gestures.** A drag up on an unfolded header folds
   it and moves nothing else, wherever it starts, as the first wheel notch does. A pull down of 48px
   past the top of the list unfolds it, as the wheel's top bounce does. One gesture changes the header
   at most once.

The coast is the one place the console imitates platform physics. A native scroller would avoid that,
but it would need the list to be an ordinary overflowing element. At 100 to 500 rows a page, each a
tall labelled row on a phone, the list has to stay virtualized.

## Consequences

- On a 390×664 phone the folded list fills the screen with its footer visible. A drag moves the list
  exactly as far as the finger, and nothing around the list moves at either end.
- The layer depends on one more detail of `@rc-component/virtual-list`: a touch move flagged
  `_virtualHandled` is not scrolled by the library. The `request-list-touch` probe drives real
  touch input and fails if the list stops following the finger, coasting, stopping on a tap or
  folding and unfolding its header. The previous implementation fails all of those checks.
- The coast's speed and rate are pure functions with logic tests (`scripts/test-request-list-touch.ts`).
- Only the request list is moved this way. A virtualized Select popup still uses the library's
  emulation; it is short and opened briefly, and it is not where the console is read.
