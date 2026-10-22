# ADR 0105: Verification follows blast radius, and work lands through an integration branch

- Status: Accepted
- Date: 2026-10-23
- Supersedes: ADR 0032; ADR 0068 decisions 1, 5 and 6, and the harness self-proof in
  decision 3; ADR 0091's custom batch scheduling

## Context

Every pull request ran the same nine jobs whatever it changed: a one-line edit to
`plugins/registry.json` paid for a production build, the whole built-artifact
acceptance, the demo acceptance and three probe shards. Branch protection required the
branch to be up to date with `master`, so each merge invalidated every other open pull
request's run, and the cost of a day's work grew with the square of its pull requests.
Typical waits were thirty to sixty minutes per merge.

The test suite had grown the same way. Most changes added assertions in two or three
layers for one claim, and nearly every repository script carried its own self-test,
including the planners, the shard balancer, the timing reporter, the workflow shape and
each documentation gate. The tooling that selected and balanced tests had become larger
than several product modules. One shared file, `deploy/cloudflare/data/provenance.json`,
recorded a digest of the Go sources and changed on almost every Go edit, so parallel
branches conflicted on it.

## Decision

- **Lanes follow the changed paths.** `scripts/ci-scope.mjs` decides which lanes a run
  needs. The repository lane (documentation, i18n, design gates, workflow lint, secrets)
  runs on every event. The Go and frontend lanes run when their paths change. A pull
  request gets built-artifact smoke and the probe scenarios its frontend change selects.
  The full built-artifact acceptance, the demo acceptance and the whole probe catalog in
  three shards run on pushes to `master`, nightly, on the `next → master` pull request
  and under the `full-ci` label. An unrecognised path runs every lane. The required
  checks keep their names (`static`, `browser`, `probes`); each is an aggregate that
  passes only when every lane it waits on succeeded or was skipped by scope, and that
  also waits on the scope decision.
- **Own work lands on `next`.** Maintainer and agent changes merge into `next` after
  `pnpm test:fast`; one `next → master` pull request per feature or release runs the
  full catalog. External contributions open pull requests against `master` and run the
  scoped lanes.
- **One owner per claim, and outputs asserted whole.** A parser or projection is tested
  by golden files under `internal/<pkg>/testdata/golden/`, run by `internal/testkit`
  and regenerated with `UPDATE_GOLDEN=1`; a fix adds a case rather than a test file.
  Tooling that does not ship is not tested by its own suite: a gate is proven by running
  it against the repository, and a broken planner fails loudly in CI's full run.
- **Freshness is a test, not a digest.** `TestExportDemoDataset` regenerates the
  demonstration dataset in memory and fails when the committed copy differs. The
  provenance digest is gone.
- **Native runner features replace custom ones.** Probes shard with Playwright's
  `--shard`; the weight file, timing evidence, custom batch scheduler and harness
  self-proof are removed.

## Consequences

- A documentation or registry pull request runs the repository lane only, and a Go-only
  pull request runs no browser. The full catalog no longer gates every external pull
  request before merge; a regression it alone catches is found on `next → master`, on
  the push to `master`, or nightly, and is fixed forward. Release tags are cut only from
  a green `master`.
- The repository is user-owned, so a merge queue is unavailable. Turning off "require
  branches to be up to date" in branch protection removes the rebase cascade; the full
  run on `master` is what catches a semantic conflict between two scoped pull requests.
- About 60 script self-tests and their tooling were deleted. Two claims they held that
  are product guarantees moved rather than disappeared: capability copy completeness is
  part of `pnpm check-i18n`, and demonstration freshness is `TestExportDemoDataset`.
  The import-graph guard that kept shared conversation modules from importing page state
  went with the import-graph planner it was built on; that boundary is now a review rule
  in `docs/architecture.md`.
- Component tests answer requests from one in-memory OMC (`web/tests/support/omcApi.ts`)
  instead of a fetch stub per file, and fail on a request nothing answers. Their files run
  in parallel; ADR 0089 began with one worker, and three parallel runs of the whole suite
  showed no shared state between files.
- The UI planner maps routed pages to scenarios and runs every scenario for anything
  else. It selects more than the old import-graph planner did; the cost is minutes
  locally, and CI runs the full catalog where it matters.
