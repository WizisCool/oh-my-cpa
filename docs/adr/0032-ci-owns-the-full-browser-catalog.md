# ADR 0032: CI owns the full browser catalog; local verification is scoped to the change

- Status: Accepted
- Date: 2026-09-28

## Context

Before a push, every change had to pass `pnpm verify:full` locally: a production build,
the whole cross-stack acceptance run, the whole dev-server probe catalog (about five
minutes, run serially) and the demo acceptance. That took six to seven minutes on a
4-CPU machine and was repeated after every fix. Pull-request CI, meanwhile, ran only the
smoke and P0 acceptance subsets and no probes at all, so the full catalog was enforced
only by local discipline and by master CI after merge.

The UI fast lane did not relieve this. Its planner selected every scenario for any
change to the shared translation catalog, and new copy is required to go there, so in a
replay of 410 recent commits 88% of those touching the UI selected the whole catalog.

## Decision

- **CI is the authority for the full browser catalog.** Every pull request and every
  master push runs the whole probe catalog as three disjoint, weight-balanced shards on
  separate runners (`scripts/acceptance/probe-shards.mjs`). One aggregate check,
  `probes`, passes only when every shard passed and is the name branch protection
  requires. Pull requests also run the P0 cross-stack acceptance, which now asserts the
  smoke path's checks too, so the separate smoke step is gone. Master runs the whole
  cross-stack acceptance.
- **Local verification before a push is `pnpm verify` plus `pnpm check:ui`.** The
  static gates and the worktree secret scan still run in full; the browser runs only
  the scenarios the change can reach. `pnpm verify:full` remains available and
  unchanged for changes to the build, the harness or the workflow, and for reproducing
  CI.
- **The UI planner narrows by evidence, not by guess.** It follows the runtime import
  graph from TypeScript's transpile output, treats a catalog edit that only adds entries
  as selecting nothing, and attributes probe-code changes to the scenarios that use
  them. Every rule that narrows has a self-test with a case where it must not, and the
  planner widens to the whole catalog whenever it cannot place a change.

## Consequences

- No gate was removed. The probe catalog now runs before merge instead of after it,
  which is stronger than before; the local run is narrower but is followed by the full
  run in CI before anything merges.
- CI uses more runner minutes: three probe shards per event. The pull request's wall
  clock is roughly unchanged, since the shards run beside the browser job.
- Branch protection on `master` requires the `probes` aggregate alongside `static` and `browser`. Without that requirement the shards would run but not block a merge; the ADR's decision depends on it, so it is part of the change rather than a follow-up.
- A planner bug could under-select locally. CI's full catalog catches it before merge,
  and the planner's negative-case tests are what keep that rare.
- Adding a console page requires one planner rule (enforced by
  `scripts/ui-impact.test.mjs`); adding a probe requires only its registry entry.
