# CI, testing and release optimization review

- Review date: October 7, 2026.
- Source baseline: `dc2002c0bec2968a99c0361526734fd0742d09df` (`master`, version 0.1.3).
- Status: adopted implementation and full local verification completed. Sections 1–3 and 7 record the source-baseline audit; section 9 records delivery evidence, remaining advisory findings and hosted rollout measurements.
- Goal: improve feedback latency, failure detection, diagnosability and maintainability without reducing the existing required coverage or weakening publication integrity.

## 1. Evidence and limits

The review inspected the current workflows, package commands, affected-check and UI planners, verification orchestration, browser harnesses and scenarios, fixtures, native packaging and release-policy tests. The architectural baseline is `CONTEXT.md`, `docs/architecture.md`, `docs/design.md`, `docs/testing.md`, ADR 0032 and ADR 0066. This is a system/harness review, not a claim to have manually audited every backend business assertion. The source inventory contains 170 Go test files, 65 TS logic-suite files plus one JS logic suite, 34 repository/Worker self-test files and 54 registered browser scenarios across 27 probe modules (including shared fixture/helper modules). File counts are not coverage percentages.

GitHub evidence includes the 15 most recently listed PRs (#135 through #150, with gaps), 53 CI runs in the 60-run listing and five release runs. Job records were retrieved for those 53 CI runs and the two release runs in that listing. Detailed logs were retrieved for 28 selected CI runs, including 24 successful runs, and all five releases. The cancelled/infrastructure-affected run 37368319732 had job metadata but no available consolidated log. Statistics below use 45 successful CI runs: 24 PR and 21 master-push runs. They exclude failed and cancelled runs rather than treating them as fast successful feedback. Historical samples include changes in catalog size; they are a baseline, not a controlled A/B experiment.

Durations use Actions timestamps: workflow wall time is `updatedAt - createdAt`, and job/step duration is `completed_at - started_at`. Workflow wall time includes startup and scheduling. Job start offsets do not establish why a runner was delayed. Summed job seconds are a utilization proxy, not a GitHub billing calculation. p95 uses nearest rank; it is not a stable service-level estimate with this small sample.

Scenario estimates use medians from 24 successful CI logs, not local timings or release runs. Rebalancing estimates sum those medians; they exclude startup, shared Vite warming and covariance between scenarios. No speedup has been demonstrated by a changed implementation.

### Observed baseline

| Measurement | PR CI | Master CI |
| --- | ---: | ---: |
| Successful sample size | 24 | 21 |
| Workflow p50 | 234 s | 243 s |
| Workflow p95 | 252 s | 263 s |
| Static job p50 | 108.5 s | 111 s |
| Built-browser job p50 | 195.5 s | 229 s |
| Probe jobs p50, shards 1 / 2 / 3 | 171.5 / 218 / 218 s | 169 / 213 / 216 s |
| Sum of job durations p50 | 896.5 s | 927 s |

PR build preparation has a median of 78 s; P0 browser execution is 53.5 s; demo execution is 11 s. Static gates themselves take 51 s, with the remainder of the static job spent on setup, scans and post-actions. The required checks are `static`, `browser` and the aggregate `probes`, with strict up-to-date checking. The branch-protection API reports administrator enforcement disabled; the repository ruleset listing was empty at review time. This is a configuration observation, not evidence that anyone bypassed checks.

Release run 37559724448, version 0.1.3, took 960 s:

| Release job/step | Observed duration |
| --- | ---: |
| verify job | 596 s |
| full verification step | 533 s |
| probe process inside verification | 456.52 s |
| full production-browser process inside verification | 120.90 s |
| native job, after verify | 304 s |
| native build/package step | 264 s |
| publish job, beside native but after verify | 238 s |
| acceptance image build / smoke / multi-platform push | 150 / 17 / 40 s |
| release / promote jobs | 19 / 28 s |

The preceding successful releases also spent approximately 493–499 s in the probe process. Version 0.1.2 predates native distribution, so its packaging timings are not directly comparable. PR #145 is especially important: disabling shared native-builder caches was an explicit review remediation, not an accidental missed optimization.

### Failure evidence

- PR #146 runs 37488130095 and 37490258518 failed different probe assertions: reopened native-popup scrolling and a phone-boundary header measurement. The final PR describes observing popup closure/options/layout and the responsive transition before measuring. Do not count these historical assertions as unresolved product defects.
- Run 37340902046 failed a dashboard-model-panel locator with a 30 s timeout. This establishes a failure mode, not the current presence of that regression.
- Run 37368319732 lasted about 69 minutes; job metadata includes delayed starts and cancelled jobs with no executed steps. It must not be used as evidence that a test took 69 minutes or that adding test shards fixes runner availability.
- The initial release run 37206359027 failed because Chromium had not been provisioned. Current release verification installs and launch-probes Chromium first, and the release-policy self-tests pin that ordering. This defect is already fixed.

## 2. What should be preserved

1. CI already separates static, built-artifact acceptance and dev-server probes. Three independent probe runners avoid competing browsers on one small machine.
2. Every PR runs the entire probe catalog. Unknown local impact widens conservatively, and narrowing rules have negative tests. Do not replace this with affected-only PR coverage.
3. P0 includes the smoke path in one browser process. Reintroducing a separate smoke run would duplicate setup and seed work.
4. Production build output precedes the Go application build because the binary embeds the SPA. Preserve the sequence and the test that pins it.
5. The Chromium installer proves a launch instead of unconditionally paying for OS dependency installation. Recent cache restores are about 4 s and warm installs about 2 s; setup is not the main PR bottleneck.
6. Go, frontend-logic and repository-script tests are automatically discovered, with bounded inner concurrency. Keep process isolation and avoid new registration lists.
7. Bundle failures do not erase independent browser evidence and still fail the final browser verdict. Preserve this unusual but useful orchestration.
8. Release actions are SHA-pinned, repository-write permission is confined to publication, new GitHub releases remain drafts until attachments finish, checksums are revalidated after artifact transfer, and latest promotion uses the verified image digest.
9. Native package builders deliberately do not restore shared pnpm or Go caches. Any artifact-sharing proposal must preserve or explicitly replace that trust boundary through a new ADR.
10. Generated SPA files are ignored; the committed placeholder and clean-worktree checks are not a requirement to commit production bundles.

## 3. Baseline findings, ranked by risk and leverage

### F1 — High: Docker publication can resolve a different source than verification

**Evidence:** `.github/workflows/release.yml` exports `verify.outputs.revision`. The native job checks out that revision, but `publish`, `release` and `promote` check out the tag again. Docker embeds the verified revision in its label even though its build context comes from the later tag checkout. The release-policy test in `scripts/release-plan.test.mjs` asserts exact revision checkout only for native.

**Failure condition:** if a publishing tag moves after verification, the native package can come from commit A while Docker compiles commit B and claims A in its OCI label. Workflow concurrency serializes releases; it does not make a Git reference immutable. No such movement was observed in the sampled releases.

**Plan:** use the verified commit SHA for every downstream source checkout and verify the tag still resolves to that commit before externally visible publication. Add a mutation case for each downstream job and a tag-movement refusal. Confirm release-tag creation/movement restrictions. Apply administrator enforcement only with an explicit repository-governance decision.

### F2 — High: a probe can silently accept an undeclared API contract

**Evidence:** `installRoutes` in `scripts/acceptance/probe.mjs` returns HTTP 200 with an empty object for unmatched requests under its API pattern. A read-only mock-context reproduction returned exactly that result for an unknown endpoint. Most default route matchers also do not discriminate request methods.

**Risk:** a mistyped or newly added read may receive successful synthetic data and a tolerant page may pass. A wrong-method write can match a read fixture. The mock layer can therefore hide the contract defect it should expose.

**Plan:** record and fail unexpected method/path pairs by default; declare intentional optional reads and fault responses explicitly. Narrow broad matchers incrementally, without adding a global ignore list. Add harness fault-injection tests proving unknown reads, wrong-method writes and missing fixtures fail. Retain explicit fixture composition per context.

### F3 — High: probe runtime errors are collected but not generally enforced

**Evidence:** `createProbePage` records `pageerror` and console warnings/errors. `runProbes` increments a scenario's passing count solely when there are no failed explicit checks and no thrown exception. Only some probe modules assert the recorded errors. A scratch scenario injected a synthetic page exception, waited for its capture, and then checked an unrelated visible button. The harness returned one passed scenario, zero failures, while the collected error array contained that exception. A late runtime exception outside the assertions can therefore leave a green scenario; F3 is reproduced, not just inferred.

**Plan:** make unexplained page exceptions, console errors and relevant request failures a harness-level verdict. Route-error and intentional failed-read scenarios must declare expected failures locally and consume them precisely; matching an expected marker must not authorize unrelated exceptions. Mutation tests should inject an otherwise unobserved exception and verify the scenario fails with its diagnostics.

### F4 — Medium: isolated application configuration is not network isolation

**Evidence:** `isolatedAppEnvironment` removes operator application and proxy variables, which is useful. The ordinary cross-stack browser context has no outbound-deny route; probes only intercept their local API pattern. Neither arrangement constitutes a browser network allowlist.

**Plan:** allow only the fixture's exact origins plus explicitly required local resource schemes in deterministic suites. Block and report attempted external requests; cover service workers, WebSocket usage where relevant, and child-process integrations separately. Explicit live smoke remains a different command. Add a controlled local foreign-origin test rather than calling a real provider. Do not confuse this guard with a complete OS-level network sandbox.

### F5 — Medium: timeout and teardown behavior is uneven, and release failures lose evidence

**Evidence:** probes have a 480 s batch watchdog, but no per-scenario budget and no explicit default locator/navigation timeout. Cross-stack browser cleanup awaits browser close and fake-server close without comparable bounds. Its application termination waits at most 3 s but does not escalate to a forced stop. `startVite` checks port occupancy and child liveness, which resolves the earlier peer-server hazard, but an owned-server identity would additionally close the remaining precheck/readiness race. `release.yml` does not upload verification failure diagnostics, while CI does.

**Plan:** introduce tested, idempotent resource ownership with signal handling, bounded termination and escalation, cancellable startup reads and owned-server readiness. Give scenarios diagnostic deadlines and report the active step. Always retain same-run failure evidence on release verification failure. Keep watchdogs distinct from performance targets; do not increase limits or retry scenarios to mask defects.

### F6 — Medium, highest speed leverage: release verification is a serial probe critical path

**Evidence:** release calls local `verify:full`. That runner executes browser and probes concurrently on one machine, and the full probe catalog is three sequential batches, each starting Vite/Chromium. PR CI uses three separate machines. The release's probe process took 456.52 s and dominated the 533 s verification step; packaging starts only after the verification job finishes.

**Plan:** retain tag-specific full verification, but give release static checks, full built-browser/demo and all three probe shards separate read-only jobs with one aggregate verification verdict. Publication must depend on every verdict. Share semantic gate definitions/validation with CI rather than calling the local resource scheduler from Actions. Preserve independent bundle verdicts and complete failure artifacts.

**Expected effect:** first target approximately 10–12 minutes end-to-end, instead of 16 minutes for 0.1.3. This is an engineering target, not a measured result; native packaging becomes the next critical path. Do not claim that changing shard weights alone halves release time.

### F7 — Medium: shard weights no longer represent current costs

**Evidence:** 54 scenarios currently split into three groups of 18 with configured totals 151/150/150 s. Seven scenarios have no measured weight: route-render-error, route-lazy-error, route-preloading, custom-icon-library, config-source-editor, config-backups and model-square. CI medians place current partition sums at approximately 145.6/169.8/171.0 s. Longest-first placement using observed medians models approximately 161.8/162.7/161.8 s.

**Plan:** emit machine-readable per-scenario timings with revision, event, runner architecture and warm/cold setup context. Refresh a reviewed weight snapshot from a bounded window of successful compatible runs; do not change shard placement live during a run or depend on a network lookup. Preserve exact-one-shard coverage and unknown-weight fallback tests.

**Expected effect:** weight refresh alone models only about 8 s off the slowest scenario sum, around 5%. Treat it as a low-risk improvement, not the main optimization.

### F8 — Medium: long scenarios combine distinct claims and real-time waits

**Evidence:** successful CI medians include OAuth management 67.41 s, system information 38.12 s, scroll smoothing 34.85 s and lazy route recovery 27.97 s. OAuth and system-information modules exceed 1,000 lines. OAuth still contains fixed waits, including a 3.4 s polling window and an Escape/Drawer wait whose timeout is swallowed. The fixed-wait ratchet permits inherited waits; it prevents growth rather than proving all existing waits are necessary.

**Plan:** instrument steps before splitting. Separate independent OAuth authorization/policy/import/geometry cases and independent system release/maintenance/status cases into coherent scenarios, without duplicating setup or claims. Use held-response rendezvous and injected clocks for scheduling policy; preserve real browser time for paint, focus, scroll, motion and causal negative timing claims. Remove swallowed waits only after replacing them with the correct observable condition. Validate mutations before and after extraction.

### F9 — Medium: some built cross-stack claims are checked only after merge

**Evidence:** PRs execute 166 P0 checks; master and releases execute 353 full checks. `browser-acceptance.mjs` deliberately omits provider, key, configuration/plugin, theme and OAuth-flow portions in P0. Dev probes cover many of these UIs with mocks, but cannot observe the real Go DTO, embedded assets and fake-CPA write/readback together.

**Interpretation:** this is the accepted coverage trade-off, not a breach of ADR 0032. Nevertheless, a regression outside P0 can reach master before its production integration assertion runs.

**Plan:** keep P0 mandatory and add relevant existing built-domain modules to PRs using conservative impact rules. Unknown impact and build/harness changes run full built acceptance. As a lower-maintenance fallback, compare always-full PR acceptance: the observed full-vs-P0 step difference is about 33.5 s, and probes often still dominate total PR wall time. Select between these approaches by measured wall time and planner complexity, not by assumption. Preserve fixture reset and ordering semantics; changing stateful acceptance order is not a cosmetic split. A policy change requires a new ADR and synchronized testing/agent documentation.

### F10 — Medium: verification policy is duplicated and overly tied to syntax

**Evidence:** `package.json`, `scripts/verify-full.mjs`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, workflow validators and `scripts/release-plan.test.mjs` all encode overlapping phase relationships. CI validation requires exact mutable action tag strings and CI checkouts retain default credentials; release validation requires immutable action revisions, disabled checkout credential persistence and exact command strings, and performs its policy validation inside a test file. Current release annotations also warn about Docker actions targeting the deprecated Node 20 runtime. The document checker has a fixed document list, so new plan documents are not automatically included.

**Plan:** extract small semantic validators for required verdicts, prerequisites, coverage, permissions, immutability and artifact provenance. Parameterize event/mode, keep negative mutation tests and leave YAML auditable. Avoid a general workflow-generation framework. Pin CI action revisions and disable checkout credential persistence; keep updates deliberate and compatibility-tested. Inspect current official Docker action releases before choosing runtime upgrades. Add YAML/shell/expression validation as an independent check, not as a replacement for project invariants. Decide separately how maintained documents are discovered; this review explicitly validates the new plan without changing the current document gate.

### F11 — Medium: fast verification remains broad and diagnostics are buffered

**Evidence:** any frontend TS change selects the whole frontend logic suite, currently 65 TS suites plus the JS base-path suite. A warm local static run measured frontend at 43.90 s and logic at 12.61 s. `runChecks` awaits every process before printing any result, and captures complete stdout/stderr in memory. Release logs consequently publish scenario timings in a block only after the probe process exits. A failed short check can remain invisible while a long sibling is running.

**Plan:** first report each completed check immediately, retain a final combined verdict and spool detailed output to same-run artifacts. Then evaluate conservative affected-logic selection only for the local iteration command, using both changed test ownership and application import reachability, with unknowns widening. CI and final static verification remain full. Keep per-suite process isolation. Measure nested process concurrency on the actual runner before changing it.

### F12 — Medium: concurrency and dependency risks have no dedicated automated lane

**Evidence:** static Go commands run ordinary `go test` and `go vet`; neither workflow contains race-detector or fuzz execution. This does not prove a race exists. Several packages nevertheless implement writes, cancellation and concurrent task lifetime. A live `pnpm audit --json` on the baseline returned one high and two moderate advisories, matching PR #149's disclosed remaining scope: braces and two react-router advisories. The standard verification commands do not perform this advisory audit.

**Plan:** introduce bounded race runs for concurrent backend packages, initially scheduled and required for relevant changes only after cost is measured. Keep CGO-free production builds; the race instrumented job has its own appropriate toolchain. Add targeted deterministic/fuzz smoke for request parsing, redaction and cancellation invariants with a fixed budget. Run dependency advisories in an explicit maintenance lane with an exception owner, justification and expiry; do not make ordinary hermetic tests depend on registry availability. Triage actual reachability before assigning product vulnerability severity. Foreign native targets are cross-compiled and metadata-checked, not executed; consider Windows/macOS smoke separately rather than a full multi-browser matrix.

## 4. Delivery sequence and acceptance criteria

Each stage is a separate reviewable PR. Effort ranges are planning estimates, not commitments. Existing accepted ADRs stay unchanged; record a new decision when gate coverage, release artifact trust or publication prerequisites change.

| Stage | Scope / findings | Estimated effort | Acceptance evidence |
| --- | --- | --- | --- |
| A | Exact release SHA and tag agreement; diagnostics on failed release verification (F1, part of F5) | 1–2 days | Mutations for tag/commit disagreement and downstream checkouts; no external publication on failure; all current release tests and full verification pass |
| B | Strict mock contracts, global error verdict, network boundary and resource ownership (F2–F5) | 2–4 days | Unknown read/wrong method/unexpected exception/foreign request/startup collision/termination faults each fail for the intended reason; intentional errors remain narrow; full catalog passes without retries |
| C | Structured timings, immediate check verdicts and reviewed weights (F7, part of F11) | 1–2 days | All 54 baseline scenarios appear exactly once across shards; timings survive failed runs; comparable-run imbalance falls without coverage loss |
| D | Sharded tag verification and semantic workflow validation (F6, part of F10) | 2–4 days | Every release prerequisite enforced under failed/cancelled/skipped jobs; separate-runner browser evidence; exact tag revision; release rehearsal without production publication |
| E | Slow-scenario decomposition and built PR coverage decision (F8, F9) | 3–5 days | Assertion/claim ownership retained, state reset proven, planner mutations refuse under-selection; compare scoped versus full built acceptance on recent PR shapes |
| F | Native/Docker build optimization experiment | 2–4 days | Same eight targets, checksums, extracted runtime smoke and provenance; fresh publication inputs; measured end-to-end benefit before adopting |
| G | Local logic selection, race/advisory lanes and native runtime smoke (F10–F12) | 2–4 days | Full final gates unchanged; affected selector has positive/negative/fallback cases; diagnostic lane has cost and failure ownership |

### Release target shape after stage D

```text
validate stable identity -> exact immutable revision
                 |
                 +--> static + history/worktree secrets
                 +--> built SPA -> embedded Go -> full acceptance + demo + bundle verdict
                 +--> probe shard 1
                 +--> probe shard 2
                 +--> probe shard 3
                               |
                     aggregate verify verdict
                               |
                 +-------------+-------------+
                 |                           |
             native build             Docker build + smoke + push
                 |                           |
                 +----------+----------------+
                            |
                 checksum-verified GitHub publication
                            |
                 latest policy recheck + digest promotion
```

This first release refactor preserves the current rule that packaging waits for verification. A later experiment may overlap **read-only** package/image construction with verification after identity validation, but any push, release visibility or pointer update must remain blocked by complete verification. Moving that prerequisite or reusing fresh same-run SPA artifacts needs a new ADR and provenance tests. Do not restore native publication caches merely to meet a time target.

A shared SPA artifact experiment must use a fresh trusted producer in this same tag run, not PR build artifacts or a mutable branch lookup. Its manifest must bind source revision, lockfile and toolchain identities, file hashes and producer run/artifact identity. Consumers verify the manifest before embedding. Preserve the existing fresh native dependency/build trust policy; downloading an artifact alone does not make its provenance sufficient.

Stage F should first benchmark serial native cross-compilation and the shared Go cache lock. The existing `-p 2` and serial target loop limit contention; eight simultaneous builds are not an evidence-based recommendation. Compare a bounded two-worker build and a minimal target grouping, including runner startup, module downloads, artifact transfer and aggregate-verdict overhead. Keep Docker's base paths, non-root permissions, certificates, timezone data, SBOM/provenance and both architectures. Reusing the verified container digest avoids a second publication build only if the packaged image that passed smoke is demonstrably the one promoted.

## 5. Targets and decision rules

- First retain all required claims and exact publication identity. Faster green output is not success if a deliberate fault can now pass.
- Stage C: scenario-sum imbalance at most 10%, measured from compatible successful runs; report startup separately. Do not treat elapsed performance variance as a test retry condition.
- Stages C/E: provisional PR p50 at most 210 s and p95 at most 230 s, with summed job duration no worse than the baseline by more than 10%. Weight refresh alone is not enough to promise these targets.
- Stage D: provisional stable-release wall time at most 12 minutes. Stage F: explore 8–10 minutes only if publication trust and runtime evidence stay intact.
- Stage G: a representative one-helper local edit should avoid unrelated logic suites, with a proposed warm feedback target of 15 s. Shared infrastructure, dependencies and unknown imports still widen; clean type checking remains in final verification.
- Evaluate at least ten comparable successful runs after a stage; tag experiments need multiple rehearsals. Record cold/warm state, runner platform, changed-file profile, catalog version, workflow attempt and setup cost. Report failures/cancellations separately and inspect time-to-first-failure as well as time-to-green.
- Roll back an optimization when it loses mutation detection, leaks fixture state, widens artifact trust unexpectedly, or increases p95/runner cost beyond the accepted envelope. A final required aggregate must fail on failed, cancelled or skipped prerequisites.

## 6. Verification and documentation obligations

During implementation use `pnpm test:fast` and relevant `pnpm check:ui`; at logical completion run `pnpm verify` and `pnpm check:ui`. Build, harness and workflow changes additionally require `pnpm verify:full`, with failed checks rerun first rather than restarting every suite. Preserve no-fixed-wait, no-retry and no-skip-switch rules.

- Gate/runner/planner changes: update `docs/testing.md` and `AGENTS.md`; module/data-flow/orchestration statements also update `docs/architecture.md` where applicable.
- Release policy/build changes: update `docs/releasing.md`, `docs/architecture.md`, and, when commands/toolchains/package installation change, both installation guides together.
- New trade-offs: add an ADR; do not amend accepted ADR 0032 or ADR 0066.
- Apply the normal domain, design, demo-data and screenshot synchronization rules to implementation changes.
- Automatic document discovery now includes maintained root Markdown and recursive `docs/` documents; validate this plan through the ordinary document gate.

## 7. Source-baseline audit execution record

- Initial worktree: clean.
- Local `pnpm test:fast --plan`: no changed files at review start.
- Local baseline `pnpm verify`: passed in 50.97 s; Go 1.84 s, frontend 43.90 s, repository 27.20 s. This warm ARM64/4-CPU run overlapped early browser work and is not a controlled performance benchmark or representative hosted-runner measurement.
- Unknown API fixture reproduction: HTTP 200 and empty object, confirming F2 without changing repository tests.
- Dependency audit: exit 1 with three disclosed advisories; this is independent of the passing static gates.
- CodeRabbit reviewed the release-workflow delta since `c8ef234`: zero emitted findings, with outcome `completed_with_warnings` and unverified-findings warning. It does not establish that the whole CI/testing system is defect-free.
- Local `pnpm check:ui --all`: all 54 scenarios passed, 654.6 s reported by the runner (659.62 s command wall time). This ARM64 workstation run had sequential batches and overlapped static verification during part of execution; it is functional evidence, not a hosted-runner performance comparison.
- Final `pnpm verify`: passed in 43.47 s. Documentation-only `pnpm test:fast` passed, and `pnpm check-docs` plus explicit `checkDocument` validation of this proposed plan passed.
- Runtime-error fault reproduction: an injected page exception was captured but the harness reported a passed scenario and no failed checks, confirming F3.
- Release-policy mutation reproduction: changing downstream publish/release/promote checkout refs to an unverified ref was accepted by the current validator; all six existing release-policy tests still passed, confirming the F1 guard gap. The actual workflow files were not changed.
- Supplementary OCR release-code review was stopped after 13 minutes without usable findings; it exited as cancelled with all five selected items incomplete. Neither this cancellation nor its zero-comment count is evidence of correctness. No retry or code change was made from that output.
- No fresh local production build/cross-stack acceptance, native cross-compilation or Docker publication was performed in this review. Built-artifact evidence comes from the successful CI/release records at the exact source baseline. No production deployment, tag mutation, branch-protection change or commit is part of this review.

## 8. Reproducible evidence index

Retrieve an indexed run with `gh run view RUN_ID --log` or its job metadata with `gh api repos/WizisCool/oh-my-cpa/actions/runs/RUN_ID/jobs`. Use the exact recorded IDs rather than a moving recent-run query. Logs require the appropriate GitHub access and can expire.

- Successful PR CI: 37559381074, 37557589110, 37555642799, 37555218133, 37554284749, 37501151296, 37497317956, 37494044935, 37488084828, 37482086782, 37470752799, 37463702778, 37462794386, 37447338834, 37443031839, 37441398628, 37432300541, 37416651852, 37412952480, 37410263615, 37406163745, 37404223561, 37402195110, 37375759489.
- Successful master CI: 37559718806, 37558132503, 37556010231, 37555584201, 37503503350, 37494673327, 37483921354, 37473733393, 37447871276, 37441462948, 37438416753, 37432369821, 37430614429, 37430095428, 37428887708, 37417017523, 37413351390, 37406796851, 37404581103, 37376295510, 37344076794.
- Failed CI metadata: 37490258518, 37488130095, 37412104176, 37368319732, 37340902046.
- Cancelled CI metadata: 37429637772, 37429521413, 37367905403.
- Release runs: 37559724448 (0.1.3), 37417388252 (0.1.2), 37229894481 (0.1.1), 37207301663 (manual recovery), 37206359027 (initial failed attempt).


## 9. Adopted implementation and validation

The implementation preserves required `static`, `browser` and aggregate `probes` checks, the full catalog and the eight native release targets. ADR 0068 records verification ownership and the release DAG; ADR 0066 continues to govern native publication cache isolation. No workflow has been executed on GitHub from these uncommitted changes, and historical timing comparisons do not establish an improvement.

| Area | Adopted behavior |
| --- | --- |
| Release identity (F1) | Identity resolution produces an exact revision. All verification lanes and publication consumers check out that revision; publication boundaries re-resolve the tag. Identity bootstrap disables package caching because it does not install pnpm. Negative mutations reject conditional/softened identity checks. |
| Browser faults and fixtures (F2–F5) | Undeclared API methods/paths return 501 and fail the verdict. Per-context ledgers enforce bounded intentional errors and exact-origin HTTP/WebSocket allowlists, including externally targeted requests subsequently fulfilled by a fixture. Owned Vite readiness tokens refuse peer servers. Owned browser processes and teardown are bounded; per-port artifact namespaces retain timing and failure evidence. |
| Release DAG (F6) | Read-only static, built-browser/demo and three probe shards run after identity resolution, feeding strict aggregates. Native/image publication waits for complete verification. Source checks, image smoke, archive checksums and latest-policy rechecks remain enforced. |
| Probe balancing and decomposition (F7–F8) | Historical sample metadata lives with the reviewed weights; OAuth and system flows have independent contexts and narrower claim ownership. The catalog now contains 62 scenarios. Unmeasured weights are explicitly provisional and never exclude a scenario. Timing reports generate review candidates rather than rewriting the runtime weights. |
| Built PR coverage (F9) | Every PR runs full built acceptance, not an additional built-domain selection planner. P0 remains available as a focused local command. This favors a simpler coverage contract over a second ownership map. |
| Policy validation and docs (F10) | CI/release actions are immutable and checkout credentials do not persist. Parsed semantic validators plus negative mutations cover CI, release and maintenance. Pinned actionlint checks YAML/expression/action syntax separately; shellcheck is not enabled by that command. Maintained Markdown is discovered automatically. |
| Local feedback (F11) | Full-local verification serializes Chromium lanes on the shared host while static checks remain parallel; hosted lanes remain separate parallel jobs. Completed checks report immediately, with detailed output spooled to disk. Local logic selection follows conservative runtime imports into automatically discovered suites; opaque readers and unknown/infrastructure/dependency changes widen. Final and CI logic gates remain full. |
| Maintenance and runtime (F12) | Weekly/manual read-only race, bounded fuzz and advisory lanes retain evidence. macOS/Windows execute host-native SQLite/auth/subpath/embedded-asset smoke after building the SPA, with native caches disabled. Known pnpm advisories retain a failing audit verdict and dated ownership. Reachable Go image-decoder advisories were fixed by the `x/image` update. |
| Demo isolation | Packaging self-tests use independent temporary source/stage directories and exercise rewrites without requiring a prior build. Concurrent self-tests no longer mutate the runtime demo stage. Built demo acceptance remains the real-artifact owner. |
| Native experiment (stage F) | `pnpm benchmark:native` compares serial and bounded two-worker builds while preserving target build flags. Both cases build an immutable source/migration/embedded-SPA snapshot. Reports record source/toolchain/platform/cache state, retain failed priming diagnostics and validate binary metadata. It does not change publication inputs, the production builder or cache trust. |

Strict fault detection exposed existing passive-wheel `preventDefault`, dynamic Input suffix, and tooltip ref warnings; the UI wiring was corrected rather than suppressed. Explicit missing read/hosted-page fixtures and remote-browser download handling were corrected without removing product assertions. The demo dataset is regenerated when frontend source freshness changes.

### Verification ledger

- Targeted packaging, identity/publication, maintenance workflow, guard and lifecycle self-tests: passed, with negative mutations.
- Real Chromium harness: passed injected runtime, console, undeclared endpoint/method, outbound HTTP/WebSocket and fulfilled-outbound cases; the explicitly declared error case passed.
- Failed-scenario reruns: request export, provider model picker, scroll smoothing, touch request list, plugin management and Model Square passed.
- `pnpm test:fast`: 12 affected checks passed. `pnpm check:ui`: all 62 scenarios passed in one invocation (655.3 seconds). `pnpm verify`: passed. The final `pnpm verify:full --probe-port 5183` invocation exited successfully: strict toolchain, SPA build, full static/history/worktree scans, bundle policy, actual Chromium fault injection, 354 built acceptance checks, all 62 probes (653.5 seconds) and all 17 demo routes. The timing artifact contains exactly 62 distinct scenario IDs, no missing catalog entries and no failures. Earlier failed aggregate runs are not counted as passing evidence; the final successful invocation supersedes them. Subsequent workflow-validator, step-label and documentation changes were validated separately; browser behavior and orchestration were unchanged.
- Final focused race lane, including gate contracts: passed. Bounded fuzz: all three targets passed.
- Native runtime smoke: Linux/ARM64 passed. The immutable-input, equally primed warm experiment built all eight targets in both cases (serial 6.37 seconds, two workers 3.20 seconds) and validated binary metadata. These short local warm-cache measurements do not establish a hosted cold-build improvement or authorize publication parallelism.
- Advisory recheck: Go reachable-vulnerability scan passed; pnpm audit remained failed with one high and two moderate findings. Triage retains all three IDs with owners and review dates.
- Independent CodeRabbit reviews prompted evidence, cleanup, cancellation and policy repairs: invalid timing bytes fail the evidence verdict while preserving the damaged artifact; diagnostic capture cannot bypass cleanup; native cancellation joins owned processes before returning; timing uploads cannot soften failures; external reusable workflows require immutable references. Targeted regressions passed. The final review completed with one minor documentation finding. Inspection of the current architecture and testing guides confirmed that both already require full PR acceptance and describe P0 only as an optional local command; the architecture table label now makes that distinction explicit. The reviewer reported unverified findings, so this is review evidence rather than a certification.

### Measurement and rollout boundary

Hosted wall-time, runner cost, cold/warm cache behavior, macOS/Windows execution and publication rehearsal still require their actual runners. Evaluate the section 5 targets on comparable successful runs after merge. Local ARM64 functional passes do not certify hosted performance or non-host execution. The native experiment is not a basis for adopting parallel publication builds until measurements include equivalent cache conditions and packaging/runtime provenance.

The shared-SPA artifact and smoke-tested-digest reuse ideas remain measured follow-up experiments, not part of the adopted release DAG. A new provenance boundary requires a separate decision and rehearsal before publication trusts it.

Build-input ownership also requires the local full runner to finish SPA synchronization
before Go static compilation. Built live-tail acceptance now controls availability of
one precommitted fixture row until Hold is established, then forwards real responses
unchanged; startup duration no longer determines whether the arrival can be observed.
