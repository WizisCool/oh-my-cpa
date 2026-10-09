# Behavior-preserving architecture and verification governance

## Scope and baseline

Baseline: `02b29672f0dde5a6aa91d88f940afbd425cdd33a` (2026-10-09).
Work proceeds on `refactor/architecture-governance`. The user authorized pushing
only this branch and opening a Draft PR to measure hosted CI; no merge, tag,
publication, access change or production connection is authorized. Preserve business decisions, DTOs, permission
and persistence semantics, DOM structure, styles, motion and responsive behavior.
Observable bug fixes are separate proposals, not incidental refactoring.

This audit combines current source inspection, import-graph analysis, test discovery,
read-only hosted CI observations and local measurements. It is not a claim that every
line has been audited or that a local pass certifies every production workload.
`docs/plans/ci-testing-optimization.md` and ADRs 0032/0068 cover earlier governance;
retain those decisions rather than rebuilding their runners or reducing coverage.

### Inventory

At baseline, excluding embedded distribution and Go tests: 29 internal Go packages,
87 internal dependency edges, 214 Go implementation files (60,270 lines), 370
frontend TS/TSX files (76,463 lines, including generated catalogs), 185 Go test files,
69 discovered TypeScript logic suites plus the deployment-path suite, 50 repository
Node self-test files and 65 registered browser scenarios. The transpiled frontend
runtime graph contains 416 source/assets, 1,487 edges, zero unresolved local imports
and zero multi-module strongly connected components. Go package compilation forbids
cycles; no compile-time package cycle was found.

Large files are not inherently broken boundaries. The translation catalogs and
configuration schema are data; splitting them solely by line count would add indirection.
The API facade intentionally composes 25 internal packages, while `operations`
coordinates capability execution. Repository dependencies on pricing and usage reflect
persisted attribution. Do not move security gates, single-writer ownership or ordinary
DTO allowlists in pursuit of superficially lower fan-in.

## Findings and priorities

| Priority | Finding and evidence | Compatible treatment |
| --- | --- | --- |
| P1 | The real lazy-page registry is missing from the planner's route boundary. A change to `web/src/pages/playground/state.ts` selects all 65 scenarios through `web/src/routePages.ts`, even though its path rule is scoped. The existing real-tree test searches only direct page imports of App and therefore passes vacuously. | Recognize proven literal dynamic imports at the registry, retain full widening for registry edits, eager imports, unmapped routes and uncertainty; assert the real registry is nonempty and scoped. |
| P1 | Agent uses Playground state for ID generation, inline thinking, images and transcript model reading. Thirteen runtime modules import a 728-line page-domain module. | Move shared primitives to neutral leaf modules; preserve the page exports for callers and tests; leave domain adapters explicitly typed. Measure import reach and byte/visual equivalence. |
| P2 | Browser costs include repeated layout/focus/paint checks, real image decoding and lifecycle races. Playground, OAuth and system scenarios have both logic and integration claims. | Keep engine-specific assertions. Migrate decision permutations only when a lower-layer owner and a representative wiring assertion exist; record each claim in the coverage table, not a test-count target. |
| P2 | The API client has 57 direct runtime importers; global feedback, i18n and icon modules have high fan-in. A monolithic client edit legitimately widens many pages. | Keep transport/auth/error policy shared. Consider domain client entrypoints only with a measured local-edit benefit and stable public facade; avoid duplicate clients and query-cache behavior changes. |
| P2 | Full local catalogs restart Vite and Chromium in three sequential watchdog-bounded batches. | Measure startup versus scenario work before changing ownership. Do not add browser concurrency on the four-CPU host, increase timeouts, or reuse scenario contexts. |
| P2 | Runtime hot paths already use shared transports, indexed joins, query caching, memoized projections, bounded event journals and a cancellable FIFO SQLite write gate. | Benchmark actual hot paths before altering locks, pooling, polling, SQL or render cadence. Existing quota cadence and request ordering are contracts, not tuning knobs. |
| P3 | Complex orchestration remains in OAuth, provider management and system components, but many decisions already have pure-function owners. | Extract only independently verifiable responsibilities. Preserve hook ordering, subscription lifetimes and cancellation semantics; do not replace files with empty wrapper layers. |

No product bug or incompatible change is authorized by this plan. A suspected
observable defect is recorded with reproduction and impact before any repair.

## Test ownership and migration ledger

| Risk | Current lowest-layer owner | Browser ownership retained | Planned treatment |
| --- | --- | --- | --- |
| Local selection misses or widens routed pages | `scripts/ui-impact.test.mjs`, `scripts/check-ui-plan.test.mjs` | Full CI catalog independent of local selection | Add literal-lazy, eager, unknown, mixed-change and real-tree cases. |
| Request endpoint/body, retry snapshots, stored image redaction, stream bounds | `scripts/test-playground.ts`; gateway and API Go tests | `playground`, `playground-narrow`, built inference acceptance | Keep request semantics; relocate shared primitives without dropping assertions. |
| Export status, failure vocabulary and duration presentation | `scripts/test-conversation-labels.ts` plus page integration assertions | Agent/Playground downloads, standalone controls, images and print | Move exact policies below pages; retain both vocabularies, page exports and export content. |
| Agent parts, resume, capabilities and permissions | Agent logic suites and `internal/agent`, `internal/capability`, `internal/mcpbridge`, `internal/api` tests | Agent catalog, built approval/write flows | Preserve reducers and native capability gates. |
| OAuth join ambiguity, filters and quota target eligibility | `scripts/test-oauth-workspace.ts`, `scripts/test-quota*.ts`, quota/API Go tests | Seven OAuth contexts plus model rules; image/file/focus and request sequencing | Existing extraction is substantial; do not duplicate pure rules in a new DOM harness. |
| Provider attribution and serialized writes | Dashboard/provider logic suites, API write-gate tests | Provider picker, phone and overlay checks | Retain exact identity and ambiguity rules; no normalization change. |
| Dashboard series and heatmap rules | Dashboard/heatmap logic suites and repository tests | Geometry, paint, chart motion, live query sequencing | Do not migrate canvas/DOM geometry to a simulated environment. |
| Browser exceptions, undeclared requests, network isolation, teardown | Harness self-tests and real negative browser harness | Full harness and probes | All fault ledgers, deadlines and evidence remain mandatory. |

### Component-test framework evaluation

Current test discovery already supports pure TypeScript without a transformation
framework. Vitest's official documentation (retrieved using Context7 on 2026-10-09)
provides Node, jsdom/happy-dom and real Browser Mode environments; it explicitly
distinguishes DOM simulation from real layout, focus and browser APIs. React Testing
Library would be a component-wiring tool, not an engine substitute.

Decision for the initial pilots: do not introduce Vitest/RTL or a simulated DOM yet.
The identified critical path is an incorrect reachability boundary, not absence of a
component runner. Shared primitive relocation can be proved with existing logic suites,
real browser wiring and production artifacts. Reconsider a component layer when a
specific hook/component integration claim cannot be tested as a pure function and
moving it out of the browser produces measured savings. Require automatic discovery,
negative tests, cleanup isolation and one claim owner; retain Chromium for geometry,
focus, scrolling, image encoding, accessibility interactions and StrictMode races.

## Staged implementation

1. **Audit and selection boundary:** establish full local and hosted baseline, fix
   route reachability conservatively, add non-vacuous tests and report actual affected
   plans. This changes verification internals only.
2. **Shared conversation primitives:** separate page-independent ID, thinking and
   image handling from Playground, preserving re-exports and function implementations.
   Compare import graph, scoped feedback and production artifact/visual evidence.
3. **Evidence-led runtime pilot:** select a measured CPU/allocation hotspot, retain a
   differential oracle and benchmark small/large inputs. No speculative SQL, query or
   lifecycle redesign.
4. **Shared export presentation:** remove the remaining shared export hook imports
   of Agent state and Playground errors. Move the exact presentation policies to a
   neutral leaf, retaining page exports and separate domain vocabularies. Extend the
   nonempty graph guard and compare real exports and screenshots.
5. **Delivery:** run the appropriate static, full build/harness/browser/demo/catalog
   gates, scan documentation and secrets, review the diff and make atomic local commits.
   Record remaining scope and hosted after-measurement limits explicitly.

## Measurements

Local host: Linux ARM64, four logical CPUs, approximately 24 GiB RAM. Runs use the
repository's hermetic fixtures, never the operator environment. Raw local logs and
resource/timing samples are under `tmp/architecture-governance`; durable summaries
belong here. GNU time maximum RSS is the maximum individual child high-water mark,
not simultaneous total process-tree memory. Distinguish cold/warm caches and concurrent
host activity from code effects; elapsed differences alone do not establish causality.

### Hosted baseline (read-only, no new workflow triggered)

Successful push CI run `37915661696` on the baseline SHA: 2026-10-09 10:07:40–10:12:18
UTC, 278 seconds workflow elapsed. Jobs started at 10:07:43 UTC: static 96 s,
browser 269 s, probe shards 225/190/251 s, aggregate 2 s. Completed checks are not a
measurement of the proposed changes. Post-change hosted wall time will be captured from the authorized Draft PR
after local implementation and validation.

Local measurement results and commit evidence are appended as each stage completes.

### Local baseline and stage 1 evidence

- `pnpm check:ui --all`: 65/65 scenarios passed; runner 729.2 s, command wall
  731.49 s, user/system CPU 345.09/152.89 s, GNU time maximum RSS 542,568 KiB.
  Browser runs were serial; read-only audit/graph/documentation activity overlapped
  parts of this baseline, so use it as functional and host-cost evidence, not a
  controlled percentage speedup claim.
- Baseline Playground-state plan: 65/65 scenarios, graph+plan 4.90 s. Widening reason:
  the route registry was treated as an unmapped page loaded by the router.
- New selector tests first failed against the baseline: lazy fixture isolation and
  the actual routed-page rule check. The nonempty real registry exposed a missing
  PluginPageHost mapping; existing plugin probes visit that route, so the explicit
  rule retains their ownership rather than assigning an empty scenario set.
- Stage 1 changes verification scripts and documentation only; no product source,
  DTO, schema, stylesheet, layout or motion is changed. No ADR is needed for this
  reversible correction of existing selection intent.

The stage 1 planner also refuses to treat a lazily loaded shared helper as a page and
widens when a source read fails. Both negative cases failed before their guards were
added; 47 combined planner tests now pass. Representative real plans (not measured
rerun times): Playground state 13 scenarios, OAuth workspace logic 9, provider
management 7, Dashboard page 13, System page 5. Their baseline scenario-duration sums
are respectively 178.83, 159.14, 106.63, 96.91 and 81.99 seconds, excluding startup
and planner overhead. These sums are estimates for scope review, not an observed
post-change speedup. The actual current worktree changes only planners/docs and
`pnpm check:ui` correctly starts no browser.

Stage 1 complete-gate evidence: `pnpm verify:full` exited zero, wall 960.27 s,
user/system CPU 585.44/184.58 s, maximum individual-child RSS 3,284,292 KiB.
This includes strict toolchain/static/history/worktree-secret and production-bundle
gates, browser-harness negative checks, 376 built cross-stack checks, all 65 probes
(runner 706.3 s) and all 18 demo routes. This is a complete-gate cost, not a scoped
local-edit speedup. The final planner guards were also checked independently after
this run's static lane; product/browser sources remained unchanged throughout.

### Stage 2: conversation dependency ownership

The ID generator, inline-thinking parser and image admission/encoding implementations
were relocated intact. Effective-model reading keeps the same body and accepts a
page-independent structural request type. Playground re-exports the original names;
Agent run IDs, canvas IDs, transcript parsing, image attachments and conversation
snapshots import neutral leaves. The fallback counter is still one shared singleton.
No JSX, styles, request fields, persistence code or lifecycle scheduling changed.

- Playground-state runtime importers: 13 to 8, now exclusively its own page domain.
  Its representative UI plan contracts from 13 to 3 scenarios (Playground desktop,
  narrow and shared mobile-console); a genuinely shared primitive still selects all
  13 conversation scenarios. A real-tree guard failed on the five cross-domain edges
  before extraction and passes afterward, with eager/lazy and erased-type fixtures.
- Two existing ID/thinking logic tests moved without losing assertions into
  `scripts/test-conversation-primitives.ts`. The suite adds throwing-crypto,
  singleton-counter, Unicode/partial-thinking, exact override and image-admission
  boundaries. Four deliberate implementation mutations are detected. Playground
  retains the request-model integration assertions and an export-identity check.
  Real decode/encode, pasted attachments, stream/reconnect, canvas, export, focus,
  layout, scrolling and Back assertions remain in Chromium.
- `pnpm test:fast`: all 8 affected checks passed; the slowest concurrent check was
  repository self-tests at 27.41 s (including the real import-graph guard).
- `pnpm check:ui`: all 13 affected scenarios passed, runner 169.3 s, command wall
  175.25 s, user/system CPU 124.88/53.47 s, individual-child maximum RSS 543,156 KiB.
  This observed scoped run is not a claim that the full catalog became faster.
- Ten before/after screenshots cover Agent/Playground composers and their directory/
  parameter surfaces at 1440×900 and 320×850, plus OAuth at both widths. Seven PNGs
  are byte-identical; the remaining images differ at 4, 4 and 27 rounded-border pixels
  respectively, by at most one channel level out of 255. There is no layout/content
  displacement. No tolerance or assertion in the browser suites was weakened.
  Local screenshots, DOM captures and exact comparison diagnostics remain under
  `tmp/architecture-governance`; production CSS comparison is recorded below.

These are reversible ownership moves under the existing leaf-module convention,
not a new state framework or API. An additional ADR would duplicate that convention.

The stage 2 production build and bundle gate pass. All 28 CSS assets are byte-identical
(379,255 raw bytes / 76,664 gzip bytes), with the same 279 JavaScript assets. Initial
JavaScript remains 1,897.72 KiB raw / 613.62 KiB gzip, initial CSS 70.18 / 13.51 KiB.
Total JavaScript changes by -378 raw / +164 gzip bytes due to module/chunk placement;
this is not a bundle-size optimization. The loading boundaries remain enforced.

Stage 2 completion gates: `pnpm verify`, production build, `pnpm check:bundle`
and all 376 deterministic built-browser checks pass. CodeRabbit reviewed all 16
staged files with zero findings; worktree secret scans and documentation validation
pass. No hosted workflow was triggered.

### Stage 3: measured OAuth sort setup

The baseline name comparator repeats numeric/base-sensitive locale comparison setup
for each comparison. Reuse one lazy `Intl.Collator` within a sort invocation, not a
global cache: empty/singleton inputs and rankings with no name ties do no setup,
and every new sort still resolves the runtime default locale. The same immutable
copy, record identities, numeric defaults, tie handling and unknown-key fallback
remain. Do not unify the separate auth-file list's plain-name ranking ties.

The opt-in benchmark alternates the frozen baseline and current implementation,
warms each three times, then records 15 samples per sort/size. Correctness tests
cover 0/1/12/120/2,300 inputs, Unicode/combining/numeric/equivalent names and frozen
input objects. They detect a deliberately broken numeric comparator. Tests pass in
processes with verified default locales en-US, de-DE and tr-TR (set `LC_ALL`, not
only `LANG`, since the host already sets a higher-priority locale).

Warm medians on this host, 2,300 credentials (milliseconds):

| Mode | Node baseline | Node current | Chromium baseline | Chromium current |
| --- | ---: | ---: | ---: | ---: |
| Name ascending | 157.79 | 7.23 | 172.4 | 9.4 |
| Name descending | 159.87 | 7.15 | 177.1 | 9.5 |
| Requests descending | 122.83 | 5.69 | 127.6 | 7.8 |
| Priority descending | 142.99 | 6.54 | 150.2 | 8.8 |
| Weight descending | 151.14 | 7.13 | 167.7 | 9.7 |

Node name-ascending medians at 12/120 records are 0.232/2.831 ms baseline versus
0.021/0.133 ms current. Chromium checks every resulting key order against the
baseline. These are CPU microbenchmarks, not full-page rendering/TTI or CI speedup
claims. Paired-process maximum RSS is essentially flat: 176,536 KiB before versus
176,000 KiB after; terminal heap samples depend on GC phase and are not retention
measurements. The benchmark optionally provides an untimed post-GC heap sample.
All raw samples include engine, platform, locale and resource metadata.


Stage 3 completion evidence: all seven affected fast checks and `pnpm verify` pass;
all nine affected browser scenarios pass (182.6 s runner / 188.47 s command wall,
74.58/27.88 s user/system CPU, maximum individual-child RSS 451,708 KiB). OAuth
desktop and phone screenshots are byte-identical to the baseline. CodeRabbit reviewed
all seven staged files with zero findings; documentation and diff checks pass.
The optional GC experiment reports current retained heap 10,484,280 to 10,484,864
bytes after 10 sorts: no evidence of a retained collator cache. This single-process
observation is not a universal memory bound.


### Stage 4: shared export presentation ownership

The shared `useConversationExport` hook imported Agent state and Playground errors
solely for presentation policies. `conversationLabels.ts` now owns the exact status
admission, separate error dictionaries and duration formatter. Existing page exports
are preserved; no snapshot, HTML renderer, download, hook order or JSX/style changes
are made. The real-tree guard first detected both edges; it now also protects Agent
state and all shared workspace modules from importing page runtime internals. Type-only
references remain erased and permitted.

Four duration assertions move intact from the Agent workspace suite to the neutral
logic suite, with additional threshold/rounding cases. Existing failure/status domain
assertions stay in the Agent suite. New tests pin export identities, separate fallback
vocabularies and unknown status behavior; three deliberate mutations are detected.
Source comparison confirms that every status array, dictionary and function body is
byte-preserved. Browser export/download/lifecycle assertions remain unchanged.


#### Observable defect held outside this refactor

CodeRabbit identified the existing duration formatter's carry behavior: 119,600 ms
reads `1m 60s`, while 59,999 ms reads `60.0s`. The new characterization cases retain
those results rather than silently normalizing them. Rounding before choosing/splitting
units would change Agent and exported duration labels; it is a separate user-visible
fix requiring explicit approval. It does not block preserving current behavior. The
review completed over all ten staged files with this one minor finding and no other
findings; the recommendation is recorded, not implemented in this scope.


Stage 4 completion evidence: all seven affected fast checks pass (slowest check
26.07 s), `pnpm verify` passes, and all 13 affected browser scenarios pass (169.2 s
runner / 175.14 s command wall, 123.92/54.07 s user/system CPU, maximum individual-child
RSS 615,704 KiB). The final ten desktop/phone composer/directory/parameter/OAuth
screenshots are all byte-identical to the baseline. Real Agent/Playground HTML
downloads differ only at their observed clock timestamps; after replacing those
displayed dates, the entire files are identical. No test fixture or browser assertion
was changed to achieve that comparison. Exported PNG and standalone-reader browser
checks pass unchanged.

Agent-state direct runtime consumers fall from nine to eight, exclusively within its
page domain; its future edit plan selects 11 rather than 13 scenarios. Playground
errors fall from four to three page-domain consumers and select three scenarios.
The shared presentation leaf still selects all 13 conversation scenarios. Narrowing
is ownership-based, not a blanket reduction in coverage. These reversible moves
follow the existing module boundary contract and need no replacement state framework
or irreversible architecture decision.

## Runtime and resource audit conclusion

Current source supports retaining the modular monolith rather than creating new
service boundaries. `internal/repository/db.go` owns the SQLite WAL pool and gated
driver; independent pools share one gate per DB. `internal/repository/usage_performance_test.go` already
provides opt-in seeded benchmarks, and query/result caches and pricing attribution
have their own existing tests. No backend, SQL, pool, lock, migration or transport
implementation changes are needed for the measured frontend/planner findings.

An isolated backend reference run used:

```sh
go test ./internal/repository -run '^$' -bench 'BenchmarkUsage(Status|Span)$' -benchmem -benchtime=100ms -count=3
```

Medians of three samples on the audit host:

| Read | 1,000 rows | 100,000 rows | Allocations per operation |
| --- | ---: | ---: | --- |
| Usage pipeline status | 0.201 ms | 12.497 ms | 2,176 bytes / 56 allocations |
| Usage time span | 0.037 ms | 0.038 ms | 784 bytes / 19 allocations |

Fixture creation is excluded from timed operations; the command itself takes
66.04 s and maximum individual-child RSS is 220,644 KiB, including setup. These
are workload references, not before/after improvements: backend source is unchanged.
Status cost grows with row count while indexed span lookup stays approximately
flat. Consider a further status-query profile only with a real workload/latency
budget; introducing materialized counters would change write/recovery complexity.

Frontend inspection found existing ownership mechanisms worth keeping:

- `web/src/pages/oauthManagement/OAuthManagementPage.tsx` memoizes provider choices, projection, filters/sort and
  pagination. The measured sort runs when its record/filter/sort inputs change;
  no render cadence or query keys need to change. Its file refresh, quota freshness
  and provider-logo reads retain their existing policy.
- `web/src/pages/DashboardPage.tsx` separates full-window reads and resolution-paced tail reads,
  refuses a tail while the previous window is placeholder data and avoids polling
  closed windows. Flattening these reads or changing caching would change freshness
  semantics, not merely improve performance.
- `web/src/pages/oauthManagement/useOAuthSessions.ts` keeps timers and generation guards outside drawer lifetime.
  `web/src/pages/playground/usePlaygroundRun.ts` and `web/src/pages/agent/useAgentRun.ts` retain abort ownership, bounded publish
  schedules and replay/reconnect safeguards. No effect dependencies, timers,
  subscriptions or cancellation order changed.
- `web/src/components/providers/useProviderManagement.ts` legitimately coordinates one form,
  validation, approval/mutation and refresh mechanism. Its size alone is not evidence
  that splitting state from writes improves maintainability. Pure provider policies
  and payload tests remain the lower-layer decision owners.

## Representative development feedback

For the same whitespace-only Playground-state edit in isolated detached worktrees,
with identical dependencies and the same five selected fast checks:

| Run | Before primitive extraction | After primitive extraction |
| --- | ---: | ---: |
| Cold incremental type cache | 25.63 s | 25.84 s |
| Warm incremental type cache | 10.18 s | 10.83 s |
| Warm maximum individual-child RSS | 593,992 KiB | 592,404 KiB |

The before worktree is stage 1 (`15a4180`); the after worktree is stage 2 (`4daec6a`).
This experiment isolates primitive ownership rather than attributing selector repair
or toolchain/cache warming to a runtime speedup. There is no meaningful fast-lane
speedup here: warm feedback already meets the 10–30 s target and cold type checking
still dominates. New audit/test/benchmark files conservatively select more suites;
normal page edits retain affected selection.

The after worktree's actual `pnpm check:ui` selects three Playground/mobile scenarios
and passes in 90.9 s runner / 96.72 s command wall, 70.28/26.41 s user/system CPU,
maximum individual-child RSS 516,692 KiB. Baseline selection incorrectly included
all 65 scenarios (731.49 s measured full command); shared conversation changes still
select 13 and require about 175 s on this host. The improvement is avoiding unrelated
work, not making every browser assertion cheaper. Browser-specific edits are not
claimed to meet the 10–30 s logic target.

## Residual risks and next decisions

- Full local/CI catalogs retain every browser claim and their existing cost. Their
  geometry, image decoding, focus, scroll, StrictMode and lifecycle assertions cannot
  be certified by a simulated DOM. Profile setup versus scenario work and runner
  capacity before changing orchestration; context reuse, retries and skips are not
  acceptable shortcuts.
- The real import graph covers transpiled literal imports, with conservative widening
  for unknown/unresolved/shared/eager paths. Computed or new loading mechanisms require
  corresponding evidence and negative cases. The full CI catalog remains independent
  of local selection, so narrowing is not a merge gate omission.
- API-client and other genuine global changes still widen plans. Consider domain
  entrypoints only with a measured local feedback cost and unchanged transport/auth/
  error behavior. Do not introduce duplicate clients or a new caching framework.
- Keep the shared conversation leaf guard and existing lowest-layer claim owners.
  Add a component integration environment only for a concrete wiring claim with
  measurable savings, not as a uniform framework replacement.
- The ordinary facade DTO allowlists, Plugin Host exception, request shapes, permission
  gates, schema, offline resources and `/omc` subpath remain unchanged. Source proof,
  differential logic, real browser/visual evidence and production checks together
  establish compatibility within covered fixtures, not a claim about all future
  workloads or every supported host/browser combination.
- Duration carry normalization is the one identified user-visible repair proposal.
  It remains unchanged and requires a separate decision; no incompatible optimization
  was needed or implemented in this work.

## Reproduction and rollback

Inspect plans without launching a browser using `pnpm test:fast --base <ref> --plan`
and `pnpm check:ui --base <ref> --plan`. For a typical edit, use the fast lane first;
then use the selected browser lane when the claim needs Chromium. Build/harness/workflow
changes use `pnpm verify:full`, while PR CI always owns complete catalog coverage.
Run the opt-in sorting benchmark with the command in `docs/testing.md`; verify locale
via `LC_ALL` and the reported effective locale, not by assuming a `LANG` override wins.

Local raw evidence remains in `tmp/architecture-governance`: gate logs/resources,
per-scenario timings, baseline/final screenshot and DOM captures, actual export diffs,
paired Node/Chromium sort samples, negative-test/mutation output, artifact comparisons
and hosted run metadata. These ignored artifacts are evidence, not new product assets.
Existing Agent/Playground browser probes reproduce downloads and standalone reader
screenshots under `tmp/conversation-export`; existing fixture routes isolate all API
reads from operator deployments. Durable results and limitations are recorded here.

Each implementation stage is independently revertible with Git. Page compatibility
exports keep callers stable; no migration, persisted-format rewrite or deployment
rollback is involved. If reverting a leaf extraction, revert its associated boundary
and claim-owner tests together. Do not revert only a test guard to permit a broken
boundary. This task introduced no irreversible architectural choice requiring a new
ADR; ADRs 0032/0068 and the existing leaf-module contract remain authoritative.

## Hosted before/after evidence

The authorized Draft PR is number 166 on `refactor/architecture-governance`, targeting
`master`. No merge, tag or publication was executed. Successful after run
`37926750823` tested branch head `2baa4f80ce9bfb6d160b0097e178f6273c7909af`
(checkout/build revision is GitHub's synthetic PR merge
`2e90f7026d4d1386fd59fc8ea9594a87c2e8426f`). It ran on 2026-10-09
11:55:38–12:00:01 UTC. Baseline run `37915661696` is the earlier successful push
run at the baseline SHA; these are single observations of different hosted runners
and event/cache states, not a controlled throughput benchmark.

| Wall time | Baseline run | After implementation run |
| --- | ---: | ---: |
| Workflow elapsed | 278 s | 263 s |
| Static job | 96 s | 117 s |
| Built-browser job | 269 s | 259 s |
| Probe shards 1 / 2 / 3 | 225 / 190 / 251 s | 223 / 163 / 248 s |
| Aggregate probe check | 2 s | 3 s |

All after checks succeed. Logs show 376 built-browser checks, all 65 dev-server
scenarios across 22/22/21 shards and 18 demonstration routes, along with bundle,
browser-harness fault checks, secret scans and clean generated state. Static is
21 s slower; no reliable overall CI speedup is inferred from one before/after pair.
The main development improvement remains correct local reachability and domain
ownership, while full CI verification costs are deliberately preserved.

Hosted bundle artifacts compare exact baseline revision to the PR build. Initial
JavaScript changes from 1,943,270 to 1,943,293 raw bytes (+23), gzip 628,348 to 628,346
(-2). Initial CSS is unchanged at 71,866 raw / 13,838 gzip bytes. Total JavaScript
changes from 12,002,434 to 12,002,165 raw (-269), gzip 3,600,001 to 3,600,050 (+49).
Local baseline/final artifact comparison confirms all 28 CSS files are byte-identical
and retains 279 JavaScript files. These tiny placement differences are not a loading
or bundle-size performance improvement. Lazy loading/anomaly gates pass.

The run retains bundle-report and three structured probe-timing artifacts through
2026-11-08. A final documentation-only evidence commit will generate another full
CI run; the measured implementation run above stays identified rather than continually
rewriting this table after every documentation update.


## Commit ledger

| Commit | Independently reversible stage | Synchronized documents |
| --- | --- | --- |
| `15a418040d2f881502e63fe9df20cf8c28d57a6b` | Conservative lazy-route selection and non-vacuous graph evidence | `AGENTS.md`, `docs/architecture.md`, `docs/testing.md`, this ledger |
| `4daec6aae10078422e5d655a614c7f31dbbd3b1a` | Page-independent conversation primitives and claim ownership | `docs/architecture.md`, `docs/testing.md`, this ledger |
| `9cd1f899d5f9bd5efe2fdb18511ee3d1d2160ff9` | Measured per-invocation OAuth locale comparison setup | `docs/architecture.md`, `docs/testing.md`, this ledger |
| `2baa4f80ce9bfb6d160b0097e178f6273c7909af` | Shared export presentation policies and page-boundary guard | `docs/architecture.md`, `docs/testing.md`, this ledger |

The final evidence commit changes only this ledger. Its hash is reported with the
completed delivery; it does not rewrite the tested implementation commits.

## Final local gate

At implementation head `2baa4f80ce9bfb6d160b0097e178f6273c7909af`,
`pnpm verify:full` succeeds: strict toolchain, production build, full static gates,
worktree/history secret scans, bundle loading/anomaly checks, real-browser harness
fault injection, 376 built-browser checks, all 65 probes and 18 demo routes. It keeps
the worktree clean. The final catalog retains every baseline scenario and assertion;
73 automatically discovered logic suites pass.

| Full local cost | Stage 1 after selector correction | Final implementation |
| --- | ---: | ---: |
| Command wall | 960.27 s | 984.21 s |
| Probe runner | 706.3 s | 703.1 s |
| User / system CPU | 585.44 / 184.58 s | 628.19 / 189.95 s |
| Maximum individual-child RSS | 3,284,292 KiB | 3,309,256 KiB |

Full local elapsed time is slightly higher; it has not been optimized away. Shared
framework/bootstrap, static work and real-browser catalog costs remain. One run per
revision is not evidence of a statistical regression or improvement; there is no
large full-suite speedup claim. The strict host toolchain is Node 22.23.2, Go 1.27.1,
pnpm 11.19.0 and Chromium 151.0.7922.34 (revision 1234). The performance wins demonstrated
here are scoped selection, ownership isolation and OAuth comparator CPU cost.
