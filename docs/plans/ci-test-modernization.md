# Typed, isolated CI and test execution

## Scope

Modernize verification execution without changing application behavior, API/schema
contracts, publication gates or the required check names `static`, `browser` and `probes`.
Routine development keeps affected static/UI selection; hosted CI retains the complete
static, built-browser, probe and demonstration coverage. This change neither publishes
nor changes repository branch protection.

## Failure evidence

The audit inspected the latest 60 CI workflow records on October 20, 2026 at
03:36 MYT (UTC+08:00), corresponding to October 19, 2026 at 19:36 UTC. The records
cover October 17, 2026 at 08:56:45 UTC through October 19 at 19:23:40 UTC.
Their final conclusions were 48 successful, nine failed and three cancelled. Two of the
successful records had a second attempt, so those final conclusions do not measure
first-attempt reliability. Attempt-one job records and failure logs were inspected for
the failed/rerun subset.

| Evidence | Interpretation |
| --- | --- |
| Master run `39310607590`, PR runs `39286380321` and `39164421549`: request-list `By client` stops at `req_interaction_0090`, then the back-to-top locator times out | A real readiness defect in the test: both groupings have the same first request. That predicate can observe the outgoing holder before React replaces it. Wait for the target group's rendered title before scrolling. |
| PR static runs `39283973329` and `39286168669`: unused React import | A genuine TypeScript failure. A runner migration must not turn this into an ignored failure. |
| PR run `39041111704`: missing fixture type member | A genuine fixture/type contract failure. |
| Demo freshness negative controls edit live responses, provenance, source, recording and checker files while freshness/type checks run concurrently | A structural shared-worktree race. Temporary per-test input trees remove it; it does not establish that every historical stale-demo failure was flaky. |
| Run `39131339847`: auto-refresh switch assertions; run `39031891843`: sidebar control click | Additional browser state/interaction evidence to retain and diagnose, not proof that rerunning fixes the underlying behavior. |

A successful local run and a rerun after a changed commit are not proof of hosted
stability. In particular, cancelled runs and deterministic type failures must not be
counted as flake fixes.

## Execution architecture

- **Hosted static isolation:** independent Go, frontend and repository matrix lanes,
  `fail-fast: false`, followed by an always-running, fail-closed `static` aggregate.
  Full-history/worktree secret scans, pinned tools/actions and clean-tree checks remain.
- **Browser probes:** pinned Playwright Test matching the existing Chromium/core version;
  the full registry and reviewed weighted shards remain. Native workers, contexts,
  deadlines, steps, assertions and reporting replace the handwritten
  queue, batches and watchdog. Shared and exclusive frame scenarios have separate native
  invocations; a failed shared test does not omit exclusive claims. Complete local
  catalogs retain the same three sequential CI partitions and per-partition deadline,
  rather than applying one partition's deadline to the entire catalog. Shared and
  exclusive phases consume one partition budget; restarting the native runner does
  not reset that deadline.
- **Domain fixtures:** API allowlists, synthetic local state, bounded fault expectations
  and a post-context-close ledger remain project-owned. A Vite readiness nonce emitted through the owned child pipe after a strict
  port bind prevents tests silently attaching to another worktree. Vite prepares the
  common entry and selected conversation modules before emitting readiness, so cold
  source transformation is owned by server startup rather than a page locator budget.
- **Logic:** Node's test runner owns isolated files and bounded execution. `tsx` replaces
  the custom ESM extension/JSON loader. The affected import-graph planner remains.
- **Components/contracts:** keep the existing Vitest, jsdom and Testing Library stack.
  There is no benefit in replacing an already appropriate tool for uniform branding.
- **Typed tooling:** migrated orchestration, configuration, fixtures, reporters and new
  self-tests run through `tsx` and a strict tooling TypeScript project. Existing `.mjs`
  domain fixtures, distribution gates and cross-stack acceptance are not mechanically
  renamed; remaining migration is incremental, with the same behavioral claim owners.
- **Demo:** per-test complete input copies make positive/negative controls independent.
  Source-text editing and restore retries are replaced with semantic coverage inputs and
  real subprocess exit-code checks. Only the declared provenance digest changes; the
  generated response corpus remains the same.

## Coverage ownership after deletion

| Removed implementation/test mechanism | Claim owner |
| --- | --- |
| Handwritten logic worker queue and custom ESM resolver | Node test runner + tsx; CLI/planner tests, unchanged logic files |
| Probe queue/batch implementation tests | Native Playwright collection checked against every registry ID; fault harness and exact timing-evidence validation |
| Handwritten probe scenario watchdog/cleanup/report orchestration | Playwright Test deadlines/lifecycle/reports; domain faults are checked after context closure |
| In-place demo source/dataset mutation and retry-based restoration | Isolated input trees, positive/negative controls, subprocess exit status and concurrent byte-preservation test |
| Request grouping's first-row-only readiness and fixed bottom-scroll delay | Target group title and actual final request rendered, using Playwright web-first assertions |

## Performance and rollout evidence

Measure matched commands on the same revision/toolchain and idle machine; distinguish
cold/warm setup and the full catalog from a single scenario. Hosted comparison must
include first-attempt pass rate, workflow p50/p95, slowest job and summed runner time.
The new static matrix spends additional setup/runner capacity to isolate resources;
its hosted critical-path benefit is unverified until pushed and observed.

Browser diagnostics use failure-only final DOM/PNG, native error reports, timing
records and the post-close fault ledger. Continuous tracing of the source-heavy dev
server is excluded from timing measurements. No scenario is skipped, retried, given
a larger wait or reduced in assertion strength to meet a speed target.

Hosted speedup, long-term flake-rate reduction and complete `.mjs` migration are
not established by local verification.

The built acceptance pass also exposed a pricing timing defect: the old three-second
check measured the driver around `goto`'s full load event and only observed a page
container, not the table. It now samples a visible row action in the renderer against
the browser's monotonic navigation clock, retaining the same three-second threshold.
The Payload rule journey waits for expanded disclosure geometry; real draft/editor/
dirty-bar integration is additionally covered in the component suite.

## Local measurements

Single-run observations on the same host and pinned toolchain, with warm caches:

| Matched operation | Previous entrypoint | Native entrypoint |
| --- | ---: | ---: |
| All 86 logic files, process wall time | 21.1 s | 23.3 s |

These are not idle-host benchmarks: later inspection found unrelated persistent CPU
load on the shared host. Neither the table nor the new static matrix establishes a
hosted speedup. The logic path has about two seconds of additional observed startup/
runner cost in this sample; it is recorded rather than described as an optimization.


## Local verification

The final lane-level evidence on the pinned toolchain is:

| Gate | Result |
| --- | --- |
| `pnpm verify` plus affected self-test rerun | Go tests/vet, strict frontend/tooling types, 86 logic files, 140 component/contract tests, 449 repository tests, static policy gates and worktree secret scan passed |
| `pnpm verify:probes` | All 72 unique scenarios passed, two shared workers and one exclusive frame worker, zero retries |
| `pnpm verify:browser:harness` | All nine negative and four positive controls produced the expected native verdicts with both one and two workers |
| `pnpm verify:browser` | All 381 deterministic built-SPA checks passed; pricing table readiness was measured in the renderer under the unchanged three-second budget |
| `pnpm verify:demo` | All 18 public-demo routes passed; the 129-response corpus remained fresh |
| Build, bundle and history scan | Production build, loading boundaries/anomaly ceilings and full-history secret scanning passed |
| `pnpm verify:workflow:lint` | Pinned actionlint accepted all three workflows |

The composed full-verification command was exercised during implementation. After
repairing failures, affected or failed lanes were rerun individually as required by
the repository's verification policy; the table is final lane-level evidence, not a
claim of a separate all-green final composed invocation. Exact-base bundle growth
comparison and clean-runner timing remain hosted-CI checks. First-attempt hosted
reliability and p50/p95 cost require observations after publication of the branch.
