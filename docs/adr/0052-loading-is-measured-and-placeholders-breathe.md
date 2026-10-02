# ADR 0052: Loading is measured, and first-load placeholders breathe

- Status: Accepted
- Date: 2026-10-02
- Amends: design.md §7 rules 2 and 3 as they apply to loading feedback. The motion budget, the
  200ms show delay and the rule that a refresh never replaces painted data are unchanged.

## Context

The console showed work in flight in three unrelated ways. The app-wide bar under the header was
an indeterminate slide on a 900ms loop: it said "something is happening" and nothing about how
much, so a page waiting on its last slow read looked exactly like a page that had just started.
First loads were a mix of antd `Spin` spinners centred in empty space (the shell, every lazy
route, the OAuth credential list, the icon library), antd `Skeleton active` - the sweeping
gradient §7 rule 3 forbids - on six surfaces, and static `Skeleton` paragraphs elsewhere. None of
the placeholders matched the geometry of what replaced them, so content landed with a jump.
Two waits drew nothing at all: the whole authenticated tree while the stored preferences are
read (the time zone guard), and a page's own lazy editor or drawer body.

Static placeholders were the rule because §7 rule 3 bans shimmer, but a frozen grey frame reads as
a page that has stalled, which is the impression the rule was meant to avoid.

## Decision

1. **The bar measures counted work.** Every non-silent query and every module download behind a
   Suspense boundary (the shell, a route, an editor, a drawer body) is a task. A batch opens with
   the first task and closes with the last; a settled task counts in full, and a pending one
   earns credit on an exponential curve capped at 85% of its share, so only a task actually
   settling can finish the bar. The bar never moves backwards: a task joining the batch lowers the
   model's value, and the drawn bar holds until the model passes it again. Done, it holds full for
   one `base` beat and fades over another. The policy is the pure `web/src/utils/loadProgress.ts`;
   `ProgressBar` draws it.
2. **The same bar is used wherever work is counted.** Under the console header (`DataProgress`),
   under the shell placeholder's header, and along the sign-in page's top edge for the session check
   and the sign-in request. A silent poll is still not counted.
3. **First-load placeholders are first-party and drawn at the content's geometry.** One kit
   (`web/src/components/common/Placeholder.tsx`) replaces antd `Skeleton` and page-level `Spin`:
   the shell's rail and header, the page head, list rows, table rows, dashboard tiles, paragraph
   bodies and the icon library's tiles. A region carries the localized `common.loading` status
   name, because the blocks themselves are decoration.
4. **Placeholders breathe.** Each block cycles opacity between 1 and 0.45 over 1400ms, delayed one
   `--motion-base` per row so the wave runs down the frame. This is not rule 3's shimmer: no
   gradient moves, and opacity stays on the compositor. It is a recorded `duration` exception in
   `scripts/check-motion.mjs` and is frozen at a static 0.7 under reduced motion.

## Consequences

- Rule 2 ("keep the animated area tiny") now has a stated exception: a placeholder frame can
  cover a page. It is acceptable because it exists only while nothing has ever loaded. A refresh
  keeps its data on screen (`keepPreviousData`) and never shows a placeholder, so the frame never
  animates over content.
- The bar runs a frame loop while painted. It writes one transform and, in tenths, the
  `aria-valuenow` of a `progressbar`, directly to the DOM rather than through React state. Under
  reduced motion the pending credit is dropped and the bar steps only when a task settles.
- The pending credit is an estimate. The bar's length is "the share of counted work done, with
  pending work given partial credit", not a byte count. Work the console cannot see (a request
  made outside React Query and outside a Suspense boundary) does not move it.
- A placeholder that must match a surface's geometry has to change when that surface does. The
  shell placeholder reads the rail's group sizes from a constant beside it, not from the rail's
  own definition.
