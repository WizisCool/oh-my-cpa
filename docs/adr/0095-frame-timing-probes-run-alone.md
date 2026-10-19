# ADR 0095: Frame-timing probes run alone

- Status: Accepted; execution ownership updated for Playwright Test on 2026-10-20
- Date: 2026-10-12
- Amends: ADR 0091's two-worker scheduling, for scenarios that assert motion frame by frame.

## Context

ADR 0091 runs two scenario contexts at once inside each probe batch and records the cost:
individual scenarios take longer. Most scenarios wait on conditions, so a slower page only
makes them wait longer. Two do not: `scroll-smoothing` samples the request list once per
animation frame and fails when a turning wheel leaves it still on three or more shown frames,
and `request-list-touch` taps a flicked list and requires it to be coasting at that moment.
The defects they guard against are a stall at every notch (about twelve frames over a turn of
six notches) and a list that never coasts. A sibling context rendering on the same runner CPU
drops a few frames the product does not drop, and the pull request runs on hosted runners and
locally failed exactly these checks while every condition-based scenario beside them passed.
A retry or a looser threshold would also admit part of the defect each check exists to catch.

## Decision

1. A scenario that asserts motion frame by frame is marked `shouldRunAlone` in
   `scripts/acceptance/scenarios.mjs`, with its reason beside the mark. Today that is
   `scroll-smoothing` and `request-list-touch`.
2. `scripts/testing/probes.ts` runs shared scenarios with the configured Playwright Test
   worker count first, then invokes the marked scenarios with one worker. A failure in
   the shared part still runs the exclusive part, and every verdict is retained.
3. Frame thresholds, per-scenario budgets and shard membership remain protected; the native runner owns deadlines and reports.
   Marking a scenario is not a way to make a flaky one pass: it is for a scenario whose claim
   is about frames, with the frame-level reason stated.

## Consequences

- A batch holding a marked scenario takes that scenario's serial time on top of the shared
  part, about a minute on the shard that holds both.
- `--workers 1` and `verify:full:serial` behave as before; the mark changes nothing when
  there is only one worker.
