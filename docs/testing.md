# Testing a change

This is the working guide for writing and running tests in this repository. It says
where a new test belongs, what to run while developing, and what a change must pass
before it is pushed. `docs/architecture.md` §12 explains why the layers are split the
way they are; `docs/adr/0032-ci-owns-the-full-browser-catalog.md` records the decision
behind the verification moments.

The goal is short feedback with the same or stronger failure detection. A new test that
is slow, sleeps, or duplicates a claim another layer already makes is a cost every later
change pays. Keep to the rules below instead of inventing a new runner, a new gate or a
new registration list.

## 1. Where a new test belongs

Put each claim in the **lowest layer that can make it fail for the reason its name
gives**. Move a claim up a layer only when the lower one cannot observe it.

| The claim is about | Layer | Where | Runs in |
| --- | --- | --- | --- |
| Server behaviour: handlers, DTO allowlists, redaction, auth, repository queries, migrations, write serialisation, background loops | Go test | `*_test.go` beside the package | `go test ./...` |
| A frontend decision that is a pure function: URL/state derivation, formatting, poll and debounce policy, sorting, validation | Logic suite (`node:test`) | `scripts/test-<topic>.ts`, importing from `web/src` | `pnpm test:logic` |
| Something only a real browser engine shows: geometry, stacking, hit-testing, scroll, focus, Back, touch, paint, request ordering under a held response, StrictMode double invocation | Probe scenario | a module under `scripts/acceptance/probes/` plus an entry in `scripts/acceptance/scenarios.mjs` | `pnpm check:ui`, CI `probes` |
| The built binary, embedded SPA, fake CPA and seeded SQLite together: sign-in, route rendering, secret boundaries, cross-stack writes | Cross-stack acceptance | the domain module under `scripts/acceptance/` | `pnpm verify:browser` (P0 subset on pull requests) |
| The public demonstration | Demo acceptance | route table in `scripts/demo-readiness.mjs` | `pnpm verify:demo` |
| The Go binary's own demonstration mode: isolated settings, read-only refusals, permitted non-durable edits | Go demo smoke | `scripts/demo-smoke.mjs` | `pnpm verify:demo:go` (opt-in; not part of CI or `verify:full`) |
| A repository script or gate itself | Script self-test (`node:test`) | `scripts/<name>.test.mjs` or `deploy/cloudflare/*.test.mjs` | `pnpm test:self` |

Rules that keep the suite fast and honest:

- **Default to Go or a logic suite.** Most feature logic is a function of its inputs.
  Extract it from the component and test it directly; the browser then needs one
  representative check that the page wires it up, not one per permutation.
- **One owner per claim.** Before adding a browser check, search for an existing one
  that already asserts it. Extend that scenario instead of adding a near-duplicate.
- **No fixed waits.** Wait on something observable: a response (`page.waitForResponse`,
  a route you hold and release), an element state, `until(...)` from
  `scripts/acceptance/harness.mjs`, a Go channel, or an injected interval or clock.
  `scripts/fixed-waits.test.mjs` fails when a fixed wait is added.
  After changing the viewport, wait for responsive controls to adopt their target state
  and call `settleLayout(page)` before measuring geometry. A viewport acknowledgement
  can precede React's breakpoint update and ResizeObserver-driven layout.
  Third-party widgets can schedule further work: a visible popup may still be in its
  alignment prepare step, and matching editor/shell widths may both belong to the old
  desktop layout. Wait for the widget's preparation state or its render surface to
  adopt the current viewport before reading the final geometry assertion.
- **Make time injectable in Go.** A duration a test has to wait out belongs in the
  component's config with a production default, as `ingest.Config.ReadinessGrace` is,
  so the test can set it to milliseconds.
- **Every new check must fail against a broken implementation.** Break the code on
  purpose, watch the test fail, then restore it. A check that cannot fail is removed,
  not kept for coverage.
- **Test behaviour, not spelling.** Do not assert that a source file contains a
  string. Inject the side effects and assert the decision, as
  `scripts/install-chromium.test.mjs` does.
- **Keep the fixtures hermetic.** Browser fixtures build their environment with
  `scripts/acceptance/environment.mjs`; never read the operator's `.env`, network or
  data directory. Calendar fixtures must use the console's configured timezone rather
  than the host timezone; the dashboard heatmap fixtures use the default UTC calendar,
  with a script self-test spanning hosts on opposite sides of a UTC date boundary.

### Container and release acceptance

`scripts/release-plan.test.mjs` tests tag/package validation, image identity, numeric
latest selection, backports, immutable action revisions, checkout credential isolation
and browser provisioning before the full release gates, plus parsed release-job
ordering, including negative
mutations. `scripts/deployment.test.mjs` parses the shipped Compose topology and tests
`latest` image defaults, loopback bindings, image-only installs, collection/proxy settings and gateway bootstrap
configuration. Both are automatically discovered repository self-tests.

`internal/config/config_test.go` pins embedded build-version fallback and operator
precedence. Existing `internal/release` tests own version ordering, GitHub-feed/cache/
rate-limit behavior and failed-check retention; packaged version assertions do not
replace those tests.

`scripts/docker-smoke.mjs` is opt-in locally and required before image publication in
`.github/workflows/release.yml`. It needs Docker and a built native image, creates only
isolated containers/volumes, waits on health-status events, and tests the actual image's
non-root/read-only runtime, SQLite writes, normalized base paths, sign-in, embedded SPA
and running-version endpoints. It is not part of `test:fast` or ordinary static gates.
Release verification provisions and launch-probes Chromium with
`scripts/install-chromium.mjs`, then runs `pnpm verify:full` before this additional
container check. Dependency installation alone does not install the browser binary.

## 2. Registering a new test

Discovery is automatic wherever it can be, so a test cannot be written and then never
run:

| Test | Registration |
| --- | --- |
| Go test | none |
| Logic suite `scripts/test-*.ts` | none: `scripts/test-logic.mjs` discovers the files |
| Script self-test `*.test.mjs` | none: `scripts/test-self.mjs` discovers them |
| Probe scenario | an entry in `scripts/acceptance/scenarios.mjs` (unique `id`). Optionally its measured seconds in `PROBE_WEIGHTS` in `scripts/acceptance/probe-shards.mjs`, which only affects shard balance |
| New console page | a rule in `SCENARIO_PATHS` in `scripts/acceptance/check-ui-plan.mjs` naming the scenarios that load its route, or `scenarios: []` if none does. `scripts/ui-impact.test.mjs` fails until the rule exists |
| New console read or response shape | `pnpm demo:generate` (pins `TZ=UTC` for deterministic deployment metadata), review the diff, commit the dataset (see `docs/ops/cloudflare-demo.md`) |

## 3. What to run, and when

| Moment | Command | What it does |
| --- | --- | --- |
| While editing | `pnpm test:fast` | Only the static checks the changed files need; the frontend type check is incremental. `--plan` prints the selection, `--base <ref>` includes committed changes |
| While editing UI | `pnpm check:ui` | Only the probe scenarios the change can reach, on the dev server. `--plan` explains the selection; `--scenario <id>` runs one |
| A feature is complete, and before pushing | `pnpm verify` and `pnpm check:ui` | The full static gates, the worktree secret scan and the affected browser scenarios |
| Pull request (CI) | automatic | Static gates, secret scans, build, loading boundaries and bundle reports, the P0 cross-stack acceptance, the **whole** probe catalog in three shards, and the demo acceptance |
| Optional locally | `pnpm verify:full` | Everything CI runs, in one local command. Use it for changes to the build, the browser harness or the workflow, or to reproduce a CI failure |
| Opt-in | `pnpm verify:demo:go` | The Go binary's own demo mode: a browser against a locally started binary with its own route assertions. It generates the dataset, so it is not part of CI |

How `check:ui` chooses scenarios (`scripts/acceptance/check-ui-plan.mjs`):

- A path rule names the scenarios for a page or component directory.
- Any other `web/src` file is followed through the **runtime** import graph
  (`scripts/acceptance/ui-impact.mjs`) to the pages that import it. Imports used only
  as types are not edges, so a pure type change selects nothing and is covered by the
  type check.
- Reaching the shared layer (`web/index.html`, `App.tsx`'s shell, `components/common/`,
  the theme, the API client, the global stylesheet) selects every scenario, as does a
  routed page with no rule, an unresolved import, a dependency or Vite change, or an
  asset the graph cannot see.
- A translation catalog edit that only adds entries selects nothing; changing or
  removing existing copy selects every scenario.
- A probe module or registry edit selects the scenarios that use it
  (`scripts/acceptance/probe-impact.mjs`); an edit to the probe runner selects all.

Complete local catalogs in `check:ui` and unsharded `verify:probes` reuse the existing three-way
partition as sequential batches through `scripts/acceptance/probe-batches.mjs`. Every selected
scenario runs exactly once; batches do not overlap browsers, keep the existing 480-second watchdog,
aggregate failures and preserve earlier failure artifacts. Explicit CI shards and focused UI runs
keep one runner invocation. `scripts/probe-batches.test.mjs` pins coverage, order, cleanup ownership,
sequential execution and failure retention without starting a browser.

Never add a skip switch or narrow a planner rule to make a slow run go away. If the
selection is wider than the change warrants, add a path rule or a scenario mapping,
with a test in `scripts/ui-impact.test.mjs` or `scripts/check-ui-plan.test.mjs`.

Agent/Playground recovery assertions belong at the lowest boundary that owns the behaviour:
channel-driven facade tests for execution lifetime and replay, injectable transport logic tests
for connection failures, and the existing `agent-live` / `playground` probes for actual browser
reload and rendering. Live elapsed labels are independent external-store consumers: their clock
and hidden-tab suspension are logic tests, while the Agent probe checks visible tenths and the
light Stop border. Stream-coalescing probes exclude only elapsed-label mutations, not answer
mutations, because the clock does not publish through the transcript's run hook.

### Dashboard model-view regressions

The existing `dashboard-model-panels-states` probe owns window selection, manual refresh,
model grouping persistence, optimistic selection and rejected-write rollback. Grouping assertions
read the native radios' checked state, not antd's animation-owned selected CSS class: a moving
thumb temporarily removes that class without changing the selected value. The refusal fixture
holds only the model-view PUT until the optimistic radio is observed, then explicitly releases
its 500 response and waits for rollback. It does not depend on animation completion or a fixed delay.

### Plugin row regressions

The existing `plugin-management` probe owns the installed row's matching action geometry,
auth-provider capability wording, overflow links and uninstall handoff. It verifies that
opening or dismissing confirmation sends no delete, cancel/Escape return focus to the
row action, and confirming removes only the chosen plugin. `plugin-management-narrow` checks the row, overflow and confirmation at
320px as well as the existing phone tab sweep. Portal geometry is measured after layout
settles, not after a fixed delay.

### Plugin connection regressions

`scripts/test-oauth-providers.ts` owns the distinction between auth-provider capability
and login method, registered-page precedence, disabled/built-in deduplication, and flow
resolution from successful CPA responses (including absent or unknown labels, device-code
precedence, both session-token fields, and incomplete responses that stay plugin-managed).
The existing `oauth-management` probe owns the connection wiring: an API-key plugin
opens its hosted page without an OAuth start request, and pageless interactive plugins
switch to device or callback controls only after explicit Start. Credential membership
and identity remain covered by the workspace and plugin-logo logic suites.

### Feedback regressions

- `scripts/test-feedback-surfaces.ts` pins short acknowledgement lifetimes, the second-line and
  shortcut reading budgets, persistent-report precedence and explicit duration overrides. These
  policy decisions belong in the logic suite rather than browser tests that wait for real time.
- `scripts/check-feedback.test.mjs` checks Ant Design feedback bindings and aliases (named and namespace
  imports, `App.useApp()` results and modal hooks), scope shadowing, false positives in comments,
  strings and type-only imports, legal confirmations, diagnostic locations and the
  feedback module exemption. It is automatically discovered by the repository self-test runner.
- The `oauth-management` browser scenario checks that ordinary copy acknowledgements cannot evict
  a persistent quota report, another refresh replaces it, and its close action removes it. It also
  checks one credential-aware authorization toast for a unique new credential, an ambiguous result
  and a failed credential-list refresh, including the action that reveals the provider collection.
  Cross-stack OAuth acceptance dismisses the completion toast before exercising drawer reopening,
  so the notification cannot cover the close action or consume the bounded success-state window.
- The `agent-failure` scenario retries a failed capability-directory read without losing the
  composer draft, then checks the refused-message retry and the accepted-run failure surfaces.

## 4. When CI fails

- Probe shards upload `tmp/probe-failure/`: for every failed scenario, whether a check
  failed or it threw, a screenshot, the DOM, the URL, page errors, and the page's console
  warnings and navigations. A scenario that threw also prints the last of those in the job
  log. Reproduce with `pnpm check:ui --scenario <id>`.
- Cross-stack acceptance uploads `tmp/browser-acceptance-failure/`. Reproduce with
  `pnpm build` and `pnpm verify:browser` (or `verify:browser:p0`).
- Rerun only the failed command. A failure that passes on rerun is a flake to fix at
  its assertion, never a reason to add a retry or lengthen a wait.

### Responsiveness regressions

- `scripts/test-date-time-format.ts` checks formatter reuse, locale/zone isolation,
  civil dates on hosts with skipped midnights, Agent clock parity, and exactly two
  timezone conversions per heatmap observation regardless of cell count.
- `scripts/test-route-loader.ts` checks no eager imports, in-flight/success reuse,
  and recovery after a failed speculative import.
- The `route-preloading` browser scenario observes module requests from actual menu
  hover, focus and touch events, verifies that sign-in loads no page modules and intent
  triggers no business reads or YAML editor load, then navigates to the preloaded page.
- `internal/api/compression_test.go` checks gzip negotiation, decoded-response parity,
  preserved status/cache headers, identity variation, GET/HEAD representation parity,
  bounded concurrent asset caching, unlocked compression work, publication rechecks for
  overlapping cold misses, sub-path routing and immediate SSE flush delivery.

- `scripts/test-chart-mount-queue.ts` injects task scheduling to check one FIFO mount per
  task, cancellation, StrictMode cleanup/setup and recovery after a failed mount.
- The existing `dashboard-charts` probe observes distinct browser frames for KPI canvas
  creation, waits for all six marks to paint, and counts chart-container measurements
  during an identical refresh. The `dashboard-chart-motion` and model-panel probes
  continue to own update morphs, reduced motion, hover and exact readouts.
- `internal/repository/usage_facets_test.go` compares the combined SQL read with independent
  grouped queries across windows, instances, empty/whitespace values, binary ordering,
  per-dimension caps and normalized masks, and checks canceled/uninitialized reads. Its
  strategy benchmarks compare populated and high-cardinality windows without duplicating
  benchmark fixture creation inside the timed portion.

- The existing `dashboard-heatmap` probe owns active popup anchor geometry, one-popup
  ownership, its cell's ARIA description, pointer/keyboard dismissal, focus restoration,
  rapid switching, active-cell data refresh and route cleanup. It instruments scroll extent getters before navigation
  to detect synchronous mount measurements; these portal, focus and layout claims require
  Chromium rather than a pure logic test. The phone scenario continues to own initial
  today visibility, swiping and scroll preservation through a refresh.

- `route-preloading` also checks shell scroll-reset calls: top-of-page navigation must
  issue none, while leaving a genuinely scrolled Dashboard resets the content column
  once. Its Dashboard reads use the shared chart/heatmap fixtures, keeping the scenario
  hermetic while exercising real overflowing content.

- `scripts/test-request-timestamp.ts` pins the row's two labels against the existing
  dayjs interpretation across fractional offsets, date rollovers, milliseconds and both
  DST boundaries, and counts one conversion per instant. The `column-alignment` probe
  changes the shared timezone while a request row stays mounted, detecting a stale memo
  without replacing the DOM node. That subscription claim requires the browser.
- `scripts/test-theme-presets.ts` pins the Listy estimate to the request row's CSS
  minimum across every built-in palette using antd's computed font height.
  `request-list-interactions` observes the initial peak of mounted rows against the holder's
  geometry, then checks the first and final records under source/client grouping before
  returning to chronological rows. Its bottom-of-list, resize and drawer assertions and
  the existing smoothing/touch scenarios continue to validate measured heights.

- The request probes also own the shared tooltip's exact timestamp/cache hints, one-popup
  ownership, stationary anchor geometry, cell DOM and ARIA preservation, hover transfer
  to its text, Escape dismissal with price-button focus retained, active label revisions,
  virtual-list scrolling and route cleanup. `column-alignment` keeps the popup open while
  the shared timezone changes, asserting both the short label and full tooltip on the
  same mounted cell. The cross-page cleanup check uses the shared System fixtures and
  waits for its rendered card before navigating back, so module-cache timing cannot hide
  an incomplete response fixture. These event, portal and virtualizer claims belong in Chromium.

### Custom icon regression coverage

Image parsing, bounds, MIME consistency, static-format detection and SVG security belong in `internal/iconasset/image_test.go`. Repository tests cover persistence, quota, legacy mapping counts, atomic reference clearing with unrelated assets/preferences preserved, stale/missing deletion guards, deletion-failure rollback and concurrent assignment/deletion; handler tests cover authenticated CRUD, private ETag revalidation, bounded input and metadata projection. Operations tests exercise Agent/MCP declarations and deletion confirmation. The automatically discovered custom-icon logic suite checks reference parsing, search, immutable assignment cleanup, save eligibility and failed-selection policy.

The `custom-icon-library` probe owns file selection, validated preview, Base64 replacement, immediate repaint of a mounted provider, selection failure, invalid-replacement save prevention, retained inputs after save/delete failure, reload persistence, referenced deletion with default restoration, cancellation, reload persistence of resets, full-width empty states, focus restoration the narrow editor/confirmation overlay above the provider drawer and automatic reset of its unsaved icon selection. Provider-console planner rules include it alongside the existing picker scenarios, with pinned union and negative cases. Assertions wait on observable state rather than fixed delays.

### Configuration backup regression coverage

`internal/repository/config_backups_test.go` owns encryption at rest, deduplication against the newest copy, the separate pre-v8 retention, the operator's retention and its immediate pruning, and deletion. `internal/cpa/management/client_config_test.go` owns the pre-write hook: a copy before every write, the reason each write names (an outer operation's name winning), and refusal when a copy cannot be kept. `internal/api/management_config_backups_test.go` owns the routes: the server-side restore and its whole-document write, the pre-v8 `409`, the manual copy's `created` flag, retention bounds and deletion. The `config-backups` probe owns the dialog: reason labels, the withheld pre-v8 restore, the retention write, the restore confirmation stacking above the dialog, the restore request and the editor reload after it. The configuration page and `web/src/components/config/` planner rules select it, with a negative case for the schema.

### Route error recovery regression coverage

`scripts/test-route-error-diagnostics.ts` owns diagnostic projection, HTTP route
responses, unknown/cyclic/hostile thrown values, bounded output, credential
redaction (including query/fragment removal on bracketed relative paths) and the
copied report's fields. It is automatically discovered.
The `route-render-error` and `route-lazy-error` probes intercept a real page module
to cause a render exception or an import failure; the render probe also fails the
shell to prove the fallback is independent of it. The lazy-import probe holds
and rejects the shell download, checking its placeholder, localized accessible
status name and the rough-progress bar reporting the held download as unfinished, diagnostic copy and full-document recovery after the
shell becomes available. They assert the
root route's brand, localized title and diagnostic copy in all four languages, light/dark
rendering, phone overflow and touch-sized controls, heading focus, stack
expansion, redacted clipboard output, and keyboard-driven full-document reload
and dashboard navigation under the deployment sub-path. Recovery is observed
after replacing the failed module with a healthy fixture; no production
fault-injection route is introduced. These router, focus and document-lifetime
claims require Chromium. Built-artifact theme/brand acceptance waits for the
rendered shell content (and the desktop wordmark) as well as theme hydration
before measuring geometry and SVG fills, because the shell download can complete after theme hydration.

### Loading feedback regression coverage

`scripts/test-load-progress.ts` owns task accounting and rough estimation (ADRs 0052 and 0054):
batch opening/completion, full settled credit, capped pending credit, late/restarted tasks, the
200ms show delay, frame-rate-independent monotonic smoothing, the final-pending-task boundary,
and registry/source merging. `scripts/test-progress-controller.ts` injects the clock, render and
scheduler to own invisible fast batches, frequent notifications without clock resets, late work
holding progress, one-base-beat completion, new episodes during completion/fading, event-only
reduced motion, live preference switches, hidden/resumed documents and disposal. No test waits
on wall-clock time.

The existing `route-lazy-error` probe owns real browser wiring. Its helper in
`scripts/acceptance/probes/loadingProgress.mjs` holds genuine tasks and samples the real CSS
activity animation with a controlled animation clock: movement during a held fill, invisible
wrap, clipping at the rough frontier, 2px/64px/16%/16px geometry, theme color and opacity,
root/animation identity, layout stability and omitted numeric accessibility claims. It exercises
shell, sign-in and console bars at desktop and phone widths, and the sign-in theme control selects
light and dark. A held real dashboard refresh checks query-driven activity and retention of data. The probe retains held-module failure/recovery, live reduced-motion batch preservation
and freezing of both placeholder and activity animation, plus cancellation of a completed
sign-in bar's actual opacity fade. Assertions observe state or animation frames, never fixed waits.
Existing page scenarios retain their coverage of silent polls and placeholder geometry.

The motion checker self-test pins the local waiting-activity duration exception in both
directions, including its reduced-motion requirement and rejection of unrelated raw durations.
Placeholder breathing's existing exception remains independently pinned.

## Production loading boundaries and bundle reports

`pnpm build` writes a Rollup ownership/import graph to `tmp/bundle/graph.json`,
not to the served or embedded distribution. `pnpm check:bundle` checks its chunk
hashes and dependency edges, then walks the HTML entry/modulepreloads and static
imports. Pages, authenticated shell, charts, Markdown and Monaco must stay outside
startup. The configuration page must defer its YAML editor until requested.

The hard size checks are broad anomaly ceilings, not per-chunk feature quotas:
startup JS 3 MiB raw / 1 MiB gzip; startup CSS 256 / 96 KiB; largest JS 4 MiB raw;
all JS 16 MiB raw; distribution 20 MiB raw; Lobe SVGs 2 MiB raw. Gzip values are
level-6 per-file estimates, including binary files in aggregate estimates, not
actual served bytes or browser-performance measurements. Growth greater than both
10% and 16 KiB for entry/startup metrics, or 128 KiB for other metrics, is advisory.

CI selects the exact PR base or preceding push revision's successful push report,
with `scripts/bundle-reference.json` as a one-commit bootstrap. Missing/expired
artifacts are reported as unavailable, not replaced by a different revision.
Locally, `BUNDLE_BASE_SHA` defaults to `origin/master`; `BUNDLE_BASELINE` supplies
a saved report for that exact revision. GitHub retrieval additionally requires
`GITHUB_REPOSITORY` and `GH_TOKEN`. JSON and Markdown evidence live in `tmp/bundle/`
and CI retains reports for 30 days. The JSON includes per-file raw/gzip sizes and
chunk source ownership; the summary identifies the largest JS files and startup
membership. Reference artifacts are data, never executed source.

Self-tests are automatically discovered:
- `scripts/bundle-report.test.mjs`: static closures/cycles, HTML preloads, deferred
  editor, ownership independent of chunk names, missing/stale resources including
  deferred CSS, size and
  compression calculations, advisory growth and every hard-ceiling boundary.
- `scripts/bundle-baseline.test.mjs`: exact SHA/event/conclusion selection, bootstrap
  and explicit references, artifact retrieval and missing/invalid evidence.
- `scripts/workflow-checks.test.mjs`: independent browser evidence and a mandatory
  final bundle outcome verdict, retained reports and existing browser/probe gates.
- `scripts/verify-full.test.mjs`: injected runner failures, prerequisites, all
  independent evidence and identical serial/parallel gate coverage.

A bundle failure remains blocking, but no longer prevents production browser/demo
acceptance after a valid build. CI's final verdict reads `steps.bundle.outcome`,
not its success-shaped conclusion after `continue-on-error`. Full local runners
likewise return failure after collecting the other verdicts. This preserves the
failure while making it diagnosable. A secret or build failure still stops serving.
For changes here, run affected self-tests, `pnpm verify`, `pnpm check:ui` and
`pnpm verify:full`; do not add a browser scenario for a pure graph or runner decision.

### Time range picker regression coverage

- `scripts/test-time-range-draft.ts` pins the picker's rules as pure logic, automatically
  discovered: the six-week grid, the two-press range and its restart, inclusive ends at day and
  minute granularity, the offset in force on the picked date across a DST change, the three
  refusals (incomplete, reversed, future) and the round trip from a committed window back to
  its draft.
- `scripts/test-usage-events-view-policy.ts` pins that every request-list preset is listed once.
- The request-list acceptance sections cover the wiring only: the picker stays inside the
  viewport as a popover and as a sheet with its custom range open, the calendar stays closed
  until it is asked for, a preset and a custom range each reach the URL, and a half-picked
  range does not.

### Mobile console and focused YAML coverage

- `scripts/test-source-wrap.ts` pins phone/desktop defaults and manual-choice precedence.
- `scripts/test-visible-viewport.ts` tests usable bounds, keyboard/caret panning, invalid/absent
  readings, overscroll and pinch-zoom fallback as pure logic, automatically discovered.
- `mobile-console` navigates all 15 live console routes through the phone navigation at
  320/375/390px, waits for each route's own content, and measures content/header
  overflow and reachable header tools, then checks selected preference state, 44px menu rows,
  Back/focus restoration, 640/641 and 900/901 boundaries, desktop and landscape, plus simulated
  keyboard bounds and Send hit-testing for both conversation workspaces. Each mounted route is
  resized across the three phone widths without repeating navigation. Direct route mappings retain
  the sweep (including Model Square); planner tests pin positive and negative cases.
- `config-source-editor` owns real Monaco widgets, font/gutter/wrapping, long URLs and indentation,
  phone find, in-place focused editing, draft/undo/focus continuity, nested Back, simulated keyboard
  viewport bounds, invalid input, revision conflict, failed saves and single successful confirmation.
  Phone geometry is measured after Monaco's render pass has resized the layers inside the editor.
  It also forces the editor wider than its shell and requires the page not to widen: Monaco corrects
  its pixel width only when its resize observer runs, and the shell clips it until then.
  Neither React option changes nor the editor's own box certify that: its layout pass sizes the
  box first, and until the render pass follows the closed find box keeps its desktop offset.
  `scripts/acceptance/configuration-plugins.mjs` also formats a document from the built SPA to
  exercise production worker asset paths and RPC, complementing the dev-server source scenario.
  Both require native flow-sequence delimiter spacing, which the serializer fallback cannot produce;
  a toast or dirty state alone does not establish worker health. The source screenshot uses a
  repository-root absolute path under `tmp/`, independent of the caller's working directory.
  `pricing-book` also checks the translated synchronization group title in phone tools.
  Existing list/touch assertions remain; `config-backups` also exercises the phone menu-owned
  dialog, local table scrolling and Back closure.
- Automated visible-viewport simulation does not certify iPhone keyboard/selection behaviour. Manual
  Safari acceptance must additionally exercise address-bar collapse, software keyboard, long-press
  selection and caret movement in normal and focused editing; record that evidence separately.


### Quota capacity coverage

- `internal/quota/capacity_scope_test.go` owns complete family/exact identity matching,
  dated model releases and fail-closed aliases/groups. `internal/quota/capacity_test.go`
  pins provider/scope eligibility, including Antigravity group windows. `internal/quota/capacity_history_test.go`
  owns adjacent-cycle selection, final-reading precedence and reset/period/scope refusals.
- `internal/repository/quota_test.go` pins half-open aggregates and served-model precedence.
  `internal/api/management_quota_capacity_test.go` owns current-vs-previous provenance,
  scoped joins, failed refreshes masked by cooldown, unreadable/corrupt history, snapshot
  stripping, fresh observation persistence despite corrupt history, and sticky reset/
  incomplete-history evidence surviving retention until a scheduled reset.
- `scripts/test-quota-capacity.ts` owns historical labels and unavailable copy selection;
  the existing `oauth-management` probe owns current/previous rendering and wrapping at
  desktop and 320/375px, including long token-only previous-cycle estimates in full-digit
  style constrained to their own compact window. This extends the existing scenario without a new runner or list.
- `internal/demo/quota_test.go` pins real normalized observations in the seeded demo
  and credential-specific snapshot/marshal errors that preserve their underlying causes.
  `internal/api/demo_export_test.go` checks scoped and previous-cycle examples from the
  generated handlers, the injected quota clock and preserved half-open usage bounds;
  calendar-day normalization must not erase quota usage ends. Runtime numeric
  measurements remain deterministic with both ordinary and `UseNumber` JSON decoders,
  without altering schema properties, seeded request latency or source-file sizes.
  Measurement classification includes the owner shape, not just a field name.
  Seeded creation/update metadata keeps its reference-clock timestamps.
  Runtime text stamps use the same minute
  precision as shifted numeric stamps, so response latency does not create dataset drift.
  `deploy/cloudflare/worker.test.mjs` verifies usage/reference bounds rebase together without
  changing amounts or basis. The demo freshness digest includes quota parsing, estimation,
  repository joins and observation seeding through `scripts/demo-inputs.mjs`.

### Built request-record filter coverage

The built request-record filter flow explicitly selects a 50-record page in its
initial URL before asserting clear-all restores that page. The assertion must not
depend on asynchronous preference hydration or the console's default page size.

### Model Square

`scripts/test-model-square.ts` owns advertised-identity grouping, maker ordering, shared-name
fanout, search, the maker filter, the row's reference caption, openness classification,
manufacturer artwork, unknown profiles and encoded external reference links.
`scripts/test-model-square-ledger.ts` owns the join with the price book and the request
records: the call-name key, unlisted-means-unpriced, unknown versus zero when a neighbour is
unread or its facet list is full, and a request link the request list's own reader accepts.
Go tests beside `internal/operations/model_square.go`, `internal/api/model_square.go`,
`internal/cpa/management/client_model_definitions.go` and `internal/modelcatalog/catalog.go`
own route projection, server-side client-key authentication, secret-safe responses,
live authority through failed enrichment, native defaults/exclusions, fixed-channel
reads, API-owned response field allowlists, metadata matching (exact evidence, the enumerated
request-variant forms and their negative cases) and safe
weight/resource links. The snapshot generator's self-test checks that ambiguous source aliases and reseller costs are not retained.

The `model-square` probe owns vertically stacked manufacturer sections and their order, the
card's price and connection with no usage figure in the list, the mark-and-count form of
a model served by several connections, the several-column card
grid on a wide page and its single column on phones, click-to-copy of the call name without opening the details, the absence of a page-level
price-book banner, the "Set price" hand-off to the shared editor, the maker filter with its count and URL state,
the details' price and 24-hour figures and request-list link, wrapping names, model profile wiring,
stepping to the next model inside the Drawer, responsive detail geometry, reachable touch
targets and native Back dismissal. Its price book and request counts come from
`modelSquareLedgerFixtures`, kept apart from the directory fixture so `mobile-console` can
pair the directory with its own pricing and facet routes. `mobile-console` includes the populated directory fixture. Planner tests select
both for directory-source changes and retain the detail scenario for shared overlay
changes. Built acceptance waits for the populated `/model-square` directory and opens
a model to check its three lookup destinations. `scripts/fake-cpa.test.mjs` owns the
fixture's gateway/management authentication separation, live client-key rotation and
revocation, identity-only responses and configured model aliases/prefixes. Both demo
checks exercise `/model-square`; the Worker dataset captures the same safe live
directory and models.dev facts. New logic checks, the populated built-directory
assertion and the section geometry check are mutation-tested before delivery.

### OAuth model rules

`scripts/test-oauth-excluded-models.ts` owns normalization, exact/wildcard matching,
validation, catalog coverage and independent exact rules under wildcard coverage.
`scripts/test-oauth-model-alias.ts` pins the new mapping's retain-original default.
Go tests beside the OAuth exclusion facade own provider replacement/deletion,
allowlisted catalog projection, request validation and refused readback. Audit fault
injection checks that a rejected attempt audit prevents the upstream write, while a
rejected success audit still returns the verified rules after the write has landed.
`scripts/fake-cpa.test.mjs` checks that provider exclusion updates and deletions stay
consistent across dedicated reads, JSON configuration and runtime/stored YAML snapshots.
It also owns global exact, wildcard and catch-all OAuth exclusions before alias mapping,
independent credential exclusions, unaffected static catalogs and API-key routes, and
restoration after clearing rules.
The existing `oauth-management` probe owns provider tab names/artwork in the picker,
independent section drafts, section-only saves, trailing-edge close placement, native Back guards and 1440/375/320px
Drawer geometry. Built auth-file acceptance owns both sections' verified
save/close/reopen/clear paths against fake CPA. The generated Worker dataset includes
provider-wide exclusions and static catalogs separately from credential fields.
Demo coverage requires both maps and each exported catalog; Worker tests pin
provider-specific catalog routing, unknown-catalog handling and mutation refusal.
Demo browser acceptance opens both rule sections and checks read-only controls.
