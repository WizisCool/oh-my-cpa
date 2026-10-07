# ADR 0068: Fail-closed browser evidence and parallel release verification

- Status: Accepted
- Date: 2026-10-07
- Baseline: dc2002c0bec2968a99c0361526734fd0742d09df
- Refines: ADR 0032's CI coverage and ADR 0066's publication workflow

## Context

The existing three probe shards provide full development-mode coverage, but release
verification serialized the catalog inside a single local full-verification job.
A probe could pass despite a captured page exception or an undeclared API receiving
an empty successful mock. Publication consumers could check out a mutable tag after
verification and label different source with the verified revision. Local logic
iteration also paid for every suite and withheld short-check verdicts until peers
finished.

## Decision

1. Keep required `static`, `browser` and aggregate `probes` merge checks. Run full
   built acceptance on both PR and master, alongside the full three-shard development
   catalog and production demo coverage. P0/smoke commands remain optional local tools.
2. Resolve release identity once, fan out read-only static/browser/probe verification,
   and aggregate every verdict before packaging/publication. Downstream checkouts use
   that exact revision; re-resolve tag agreement at publication boundaries. Preserve
   native cache isolation, fresh dependency installation, checksums, runtime smoke
   and digest-only latest promotion.
3. Make unexpected runtime/console/transport problems and unknown API contracts
   scenario failures. Deliberate failures declare exact resource/marker and bounded
   counts locally. Deny undeclared HTTP and WebSocket origins, block service workers,
   and prove the harness verdict using real-browser negative scenarios.
4. Own Vite readiness with a run-specific token and own Chromium through BrowserServer.
   Bound scenario and shutdown lifetime; escalate only owned children/process groups.
   Keep the existing batch watchdog rather than increasing assertion waits.
5. Separate long OAuth/system flows into isolated contexts with unchanged claims and
   explicit preconditions. Retain structured timings and review deterministic weights;
   timings never decide whether a scenario runs.
6. Narrow logic suites only in the local fast lane through a conservative import graph.
   Unknowns widen and opaque suites always run; final static/CI discovery remains full.
   Print completed verdicts immediately and spool detailed output.
7. Add weekly/manual read-only race, fuzz, advisory and macOS/Windows runtime lanes.
   Network-dependent advisory availability is not a normal hermetic PR prerequisite.
   Ownership/review deadlines do not suppress advisory failures.

## Consequences and validation

Full built PR acceptance deliberately increases that lane's work in exchange for
coverage of domains the former P0 subset omitted. Release verification can overlap
independent lanes, but actual hosted throughput and runner cost must be measured
across compatible runs before claiming a percentage gain. New split weights remain
provisional until sufficient samples exist.

Native target parallelism, trusted SPA artifact sharing and package/verification
speculation are experiments, not automatic cache or publication-boundary changes.
No native shared cache is restored. Foreign runtime tests do not certify code signing
or all architectures. Tag checks narrow the mutable-ref window but cannot make
cross-service publication transactional.

Semantic validators reject bypassed gates, mutable checkouts, incomplete shards and
lost evidence. Script self-tests, actual browser fault injection, full catalog and
built/demo gates are required for delivery. Review findings and reproducible local
results live in `docs/plans/ci-testing-optimization.md`; hosted benchmarking remains
an explicit follow-up measurement rather than a claimed local result.
