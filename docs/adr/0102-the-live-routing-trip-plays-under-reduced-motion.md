# ADR 0102: The live routing trip plays under reduced motion

- Status: Accepted
- Date: 2026-10-17

## Context

`docs/design.md` §7 rule 9 animates a newly stored request across the dashboard's live routing map: a
dot leaves the model, crosses the gateway to the credential CPA chose, waits there for a beat, and
returns, while the lanes it uses flow and the nodes it reaches light. The rule also said that under
`prefers-reduced-motion: reduce` no dot, flow or glow is drawn and the readings update in place.

That made the map disappear for a group of readers it was built for. Chromium on Windows reports the
**Animation effects** switch as `prefers-reduced-motion: reduce`, and many operators turn that switch
off for reasons unrelated to motion sensitivity: an older workstation, a remote desktop session, a
laptop on battery. On exactly those machines the panel becomes a static diagram, and the one reading
it exists for - which model's request went to which credential, and whether the answer came back - is
no longer visible; the rows still count attempts, but the path is gone.

The map is also not ordinary chrome motion. Its trip is the encoding: the design already accepts that
the panel is the console's one lit surface (§2), and every other animation is either a hover
acknowledgement, a disclosure, or a number acknowledging that it moved. A static version of the trip
is not the same reading slowed down; it is a different, weaker reading.

## Decision

1. **The live routing map plays its full trip for every reader**, regardless of
   `prefers-reduced-motion`. That covers the travelling dot, the lane flow, the node glows, and rows
   entering and leaving; the panel no longer consults the query at all.
2. **The exception is scoped to the routing map.** Apart from the input-following scroll glide
   (ADR 0046), every other animation in the console keeps honouring the query: drawers, disclosures,
   the GitHub count, the loading bar, chart marks, placeholders and the KPI readouts are unchanged. No
   global "ignore reduced motion" switch is introduced.
3. **The exception is recorded where the budget is enforced.** `scripts/check-motion.mjs` gains a
   `reduced` exception kind, keyed by file, selector and property, with the reason and a stale-entry
   failure. The routing lane's flow is the only selector in the table. `scripts/acceptance/probes/routingMap.mjs`
   asserts that a request arriving under `reducedMotion: 'reduce'` still produces a packet and a flowing
   lane, so the behaviour is demonstrated rather than inferred from the absence of a guard.
4. **The motion itself stays bounded.** The map still animates only opacity and transform, except the
   lane-flow dash offset; at most eight requests replay from one read, staggered 70ms apart; at most
   sixteen are on the map at once; a burst past that is skipped rather than queued; and hiding the page
   ends every trip. The exception does not relax the concurrency or lifecycle limits.
5. **The lines carry identity, not verdicts.** A sibling change in the same delivery gives each model
   lane a cool `--route-*` slot and makes credential lanes neutral, so the trip's colour cannot be read
   as success, warning or failure. The answer's tone stays on the node's wash and port ring and in the
   row's text. This removes the other source of ambiguity on this surface: a green, amber or red line
   beside a model's name meant two things at once.

## Consequences

- A reader on Windows who turned animation effects off for performance sees the live routing panel work
  as designed. A reader who needs reduced motion for vestibular reasons gets this one trip in full; the
  reach is bounded by the map's small dot, short hops and the caps above, but the trade-off is real and
  is stated rather than hidden.
- The routing map is now the second motion that ignores the preference, after the input-following
  scroll glide (ADR 0046). Unlike the glide, there is no preference to hand the decision back to the
  system; adding one would ask an operator to find a setting before the panel tells them anything, and
  the reading exists only while they are looking at it.
- The check-motion exception table now has a third kind. Its self-test exercises the waiver in both
  directions: a listed selector passes without a reduced-motion block, an unlisted one still fails, and
  an unused entry fails.
- The design document's rule 9 and the live-routing section both name the exception, so a future
  "honour reduced motion everywhere" cleanup has to confront the decision instead of silently undoing
  it. `DESIGN.md` carries the same note at summary depth.

## Alternatives considered

- **Keep the static reading under reduced motion.** This is what the panel did, and it is what the
  Windows population saw. It satisfies the preference literally but deletes the panel's answer for the
  readers most likely to have the switch off.
- **Draw a calm variant: no travel, just a sequential highlight of the model, its lane, the credential
  and back.** This respects the preference more closely while still animating, but it is a second
  rendering of the trip to design, test and keep in step with the first, and it still moves light
  across the map on a timer. The map's reading is the travel; a stepped version is not obviously
  calmer, only less legible.
- **Add a preference with `On` / `Follow system` / `Off`, defaulting to `On`, as scroll smoothing
  does.** It gives a motion-sensitive reader a way out, but it adds a setting that has to be discovered
  before the panel is usable, and the panel's reading is transient rather than a persistent view. The
  scoped exception is smaller and easier to reason about.
