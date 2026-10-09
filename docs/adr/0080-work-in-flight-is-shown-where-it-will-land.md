# ADR 0080: Work in flight is shown where it will land

- Status: Accepted
- Date: 2026-10-08
- Amends: design.md §7 rule 3 for one surface, a short text label naming work that is still
  running. Placeholders keep breathing as [ADR 0052](0052-loading-is-measured-and-first-load-placeholders-breathe.md)
  decided, and the motion budget is unchanged.

## Context

A display call is written by the model as arguments, and a canvas can take the better part of a
minute to arrive. Until the call settled, the answer showed one call row and an activity line, and
the figure then appeared all at once. A stored conversation's first load drew an empty frame. The
only sign of work in a running turn was a 6px pip, so a long reasoning pass or a slow capability
read as a stalled page.

§7 rule 3 forbids gradient shimmer for two stated reasons: a swept background repaints its whole
box every frame, and it clashes with the flat aesthetic on large placeholder blocks.

## Decision

1. **A display call being written is a draft figure.** It takes the figure's own frame at the end
   of the answer, with a dashed edge, the title as soon as its string has closed in the partial
   arguments, and a stage holding the generation loader over its label. The settled figure replaces
   it in place.
2. **A stored conversation's first load is a thread-shaped placeholder** at the thread's column
   width, in a named status region.
3. **A label for running work carries a highlight across its glyphs**: the reasoning disclosure's
   "Thinking", a running call's title, the activity line and the draft figure's label. The
   highlight is a glint 3.2em wide whatever the label's length, and it and the label's own ink
   are two layers of one background clipped to the glyphs, so nothing outside the glyphs is
   painted and each glyph is drawn once. Masking the element to its text and moving a
   pseudo-element over it kept the sweep on the compositor but drew every glyph through its own
   outline, which thinned the strokes until dark text on a light ground was hard to read;
   repainting one short line is the cheaper cost. Both of rule 3's reasons are about
   blocks; neither holds for one line of text. Where a text mask is unavailable, and under reduced
   motion, the label is plain text. The loop is a `duration` exception in `pnpm check:motion`.
4. **A figure, its draft, a call row and a follow-up question arrive with opacity and a 4px rise**
   inside `base`, follow-ups one `fast` step apart. Nothing scales, and no fill mode is left on a
   settled figure.
5. **Generation has one loader**: a three-by-three field of dots with a run of lit cells
   travelling through it, drawn in `--fg`. It stands in the draft figure's stage and, at mark
   size, leads the activity line in place of a pulsing pip. The nine cells share one opacity
   keyframe and enter it at different steps, so no timer runs.
6. **Arriving answer text fades in, and a caret marks its end.** While a text part streams, each
   new run of words starts from `--accent` at 20% opacity and reaches the ink within 220ms, and a 2px `--accent`
   caret pulses after the last word. Both stop with the stream; a stored answer is plain text.
   The fade is longer than `base` on purpose: the words are on screen at full size from the first
   frame, so it never delays reading, and at 100ms the arrival is not perceptible. It is no longer
   than that because every run still fading is tinted: at 600ms a fast stream kept a paragraph in
   the accent and read as an answer dragging its tail.

## Consequences

- The technique is the one `tw-shimmer` uses for text. The package itself is a Tailwind plugin and
  the console has no Tailwind, so it is written in the workspace stylesheet against the theme
  tokens.
- The draft is derived from the live run's traces, so it needs no server change and a reload
  mid-run shows it again.
- The loader and the arriving text follow assistant-ui's loading-state and streaming-text
  elements, written against the theme tokens; the text fade uses the markdown renderer's own
  streaming animation with the thread's keyframe in place of its default.
- A swept highlight on a placeholder block, a card or a button is still rule 3's shimmer.
