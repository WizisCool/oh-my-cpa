# ADR 0096: Phone surfaces are dense and quiet

- Status: Accepted
- Date: 2026-10-13
- Amends: ADR 0055's phone page head (an 18px title under the top bar) and ADR 0012's phone
  row (controls on a line of their own).

## Context

Measured at 390×844 against the demonstration dataset, the phone console showed little of what
its pages hold:

- The request page's head and filters took 430px, and one stacked record about 700px: twelve
  labelled fields, one per line. A screen held less than one record. The first drag up folded
  the head away, which moved the list 430px under the finger.
- The dashboard drew one tile per row, so the first screen held three numbers.
- Every page drew its title twice: in the top bar, and 18px tall directly under it.
- A list row put its controls on a ruled line of their own, and an OAuth credential spent six
  blocks on six lines: about 320px for one credential.
- A sheet slid in at 70% opacity (antd's panel motion). On a phone a sheet is the width of the
  screen, so the page under it stayed readable through it for the whole slide. The request
  detail sheet emptied itself before it slid out.

A table spends its width on columns, and each column gives a mark's tint a place of its own.
Folded into a few lines, the same marks (a success fill, an effort hue, a substitution, a
credential kind, a cache tint) land in one glance and none reads as a signal.

## Decision

1. **The top bar names the page; the page does not repeat it.** At 640px and below the bar is
   48px (`--app-header-height`), and `PageHeader`'s `h1` stays in the document for the outline
   and assistive technology but is not drawn. A live subtitle and the page's actions take its
   row; a head that held only the title takes no room.
2. **A stacked request record is three lines of two facts each**: the model with its
   reasoning effort badge and the cost, in the primary weight; the provider with its account,
   and the total tokens; the time and verdict, and the latency, in the quiet tone. A record in a list is there to be
   recognised, and the detail drawer is where it is read: first-token time, the token
   breakdown, the cache rate, speed, the credential kind, the caller's key and the client label
   are in the drawer only. Repeating every table column in four lines of small type was tried
   and read as noise. It is the table row's own DOM: cells that hold two facts dissolve with
   `display: contents`, each line has one zero-basis cell that gives way, so no line wraps at
   320px, and the checkbox sits in the left padding so the three lines share one edge.
3. **A stacked record is drawn in the text colours.** Hue is kept for what a list is scanned
   for: the verdict's pip, a failure in full, and the reasoning effort badge, which keeps the
   table's own drawing and is never cut short. The table
   above the container threshold is unchanged.
4. **The request filters are two rows.** Search and the way into the full filter panel hold the
   first; the window, the verdict, the two facets, the grouping and the model view are one strip
   that swipes inside itself. Every control is kept. The list runs to the screen's edges.
5. **Counts and tiles keep their row.** `StatTiles` stays one strip of narrower tiles, and the
   dashboard grid keeps two columns with its wide tiles spanning both.
6. **A list row's controls share its headline's line** when both fit, and fall to a line of
   their own at the trailing edge when they do not. The OAuth credential record is four lines.
7. **A sheet slides opaque**, and a panel on its way out keeps drawing what it held.

## Consequences

- At 390×844 the request page shows about seven records with its head folded and five with it
  open; the head is 117px, so the fold moves the list by that much.
- A stacked record no longer prints the caller's key, the client label or the request id's
  text; the id's copy control stays, and all three are in the detail drawer.
- The filter strip hides its later controls until it is swiped. It bleeds to the page edge so a
  cut-off control signals the direction, which is the console's existing rule for a strip that
  cannot wrap.
- Phone screenshots in `docs/images/readme/` picture the earlier layout until regenerated.

## Alternatives considered

- **A persistent compact head instead of the fold.** The fold and its 48px pull are ADR 0048's
  contract and are pinned by `request-list-touch`; a 117px head makes the fold cheap rather than
  unnecessary.
- **A second, phone-only row component.** Two renderings of one record drift; the table row's
  DOM, rearranged, cannot.
- **Keeping every table field in the stacked record.** Packing every table column into four
  lines of small type was tried and read as noise. The adopted three-line layout keeps the
  provider and its account together on the second line, beside the total tokens; secondary
  fields are read in the detail drawer.
