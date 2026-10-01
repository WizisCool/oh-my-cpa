# ADR 0047: A virtual list's glide adds no latency to the list's own jump

- Status: Accepted
- Date: 2026-10-01
- Supersedes: how decision 3 of [ADR 0046](0046-wheel-and-keyboard-scrolls-glide-on-every-platform.md) hands a glide to a virtualized list

## Context

ADR 0046 drives a virtualized list (the request list, a Select's option popup) by handing it one
wheel step per animation frame. The glide landed in the right place, but on the request list it
stuttered and lagged behind the wheel. Frame-by-frame measurements on the request list showed three
separate causes:

- **The list loses a frame at every notch.** `@rc-component/virtual-list` defers each wheel delta to
  its next animation frame, and any wheel it sees cancels that frame before it checks whether the
  event was claimed. The reader's own notch is such a wheel. The glide's previous step therefore
  stayed unapplied until the glide's next step was handed over.
- **The glide's first frame did not move.** Its clock started at input. An input lands partway
  through a frame, so the next frame evaluated the curve at or near zero.
- **A glide that had finished could lose the next notch.** The list shows a step two frames after it
  is handed over. A glide was discarded as soon as its curve ended, so a notch arriving in those two
  frames started a new glide from the list's lagging offset with a fresh span. When the list then
  applied the steps it still held, its offset left that span, and the glide read this as a
  correction and stopped.

Together these caused two frozen frames at every notch followed by a double-sized jump, a first
movement three frames (about 50ms) after the notch, and sometimes a notch dropped entirely. That is
a frame later than the list's own unsmoothed jump.

Writing the holder's `scrollTop` would avoid the list's frame, and with it its two-frame pipeline,
but ADR 0046 decision 3 still holds: the list re-applies its offset from React state. A direct write
also shows the rows of the previous range, leaving a blank strip above the first row when scrolling
up. The rows and the offset have to come from the same React render.

## Decision

1. **A virtual glide starts inside the input event.** Its first step is handed to the list
   immediately rather than on the glide's first frame. The list applies the step on the frame its
   own jump would have used, so the glide adds no latency to it.
2. **A notch that retargets a running glide re-arms the list's frame.** It hands over a zero step,
   which restarts the frame the reader's notch cancelled; the list keeps the deltas it has
   collected. It does not hand over a first step of its own, because the list still holds the
   previous one, and the two together would show as one double step.
3. **The list's frame runs before the glide's.** After handing a step over from an input event, the
   glide requests its own frame again. Animation frames run in the order they were requested, so the
   list applies what it holds before the glide hands it the next step, which would otherwise cancel
   it.
4. **Every glide's first frame already moves.** The curve's clock starts on that frame, one frame
   back: one frame at 60Hz, rather than a measured interval, since the frames around an input are
   the least regular ones.
5. **A finished virtual glide is kept while the list catches up.** It is kept until the list reports
   its destination to within a rounding, or for at most 20 frames. The list's lag is counted in
   frames, so the wait is counted in frames too. A notch in that time continues the chain from where
   the glide asked the list to be. The span the list may report narrows to the part of the way the
   list has left, so a correction that moves it elsewhere (a scrollbar drag, the return to the top)
   still ends the chain.

## Consequences

- On the request list, a wheel notch now moves the list on the next frame instead of the third, and
  a wheel that keeps turning moves the list on every frame until it lands. The glide hands over
  exactly the notches turned. The list may still shift by a few pixels as it re-anchors its offset
  while it measures rows, as it does for its own jumps.
- The layer depends on two more details of `@rc-component/virtual-list`: any wheel cancels its
  pending frame, and a zero-delta wheel schedules that frame again. The `scroll-smoothing` probe
  asserts both effects on the real list: the list must start moving within two frames of a notch,
  and a wheel turned two frames per notch must keep it moving from notch to notch. It also adds up
  the steps the glide hands over, which must equal the notches turned. The previous implementation
  fails the first two checks.
- The remaining cost of a glide on the request list is rendering the list once per frame. Rows
  rendered for the first time make that render heavier on the dev server, so the probe measures
  stalls over rows the list has already rendered once.
