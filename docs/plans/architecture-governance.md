# Behavior-preserving architecture and verification governance

## Scope and baseline

Baseline: `02b29672f0dde5a6aa91d88f940afbd425cdd33a` (2026-10-09).
Work proceeds on `refactor/architecture-governance`, with no push, publication,
access change or production connection. Preserve business decisions, DTOs, permission
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
4. **Delivery:** run the appropriate static, full build/harness/browser/demo/catalog
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
measurement of the proposed changes. Post-change hosted wall time requires an approved
push/PR and is unavailable while this work remains local.

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
