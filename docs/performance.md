# Console responsiveness audit

## Scope and method

This audit was measured on October 1, 2026, starting from commit `6b2d7e1` on
`perf/responsive-console`. It covers the embedded console, its HTTP delivery and the
usage read path. Measurements use the Go demo fixture, not production credentials or
an external CPA deployment.

The browser is Chromium at 1440 × 900, with 4× CPU throttling and a simulated remote
link: 60 ms latency, 20 Mbps down and 5 Mbps up. First-load measurements use a fresh
browser context. Two menu-navigation passes distinguish cold route code/data from
cached visits. The navigation observation ends when a representative page element
is visible; long tasks are observed through the subsequent chart-mount interval.
These are synthetic diagnostic timings, not production latency guarantees.

The measurement binaries use disposable data directories, loopback listeners and
`scripts/acceptance/environment.mjs`'s `isolatedAppEnvironment`, with demo mode enabled.
`scripts/demo-smoke.mjs` documents the corresponding fixture setup. Use Chrome DevTools
Protocol's `Network.emulateNetworkConditions`, `Emulation.setCPUThrottlingRate` and
`Profiler` to reproduce the throttle and CPU attribution. A `PerformanceObserver` for
`longtask` distinguishes transfer delay from main-thread blocking. Profile samples
identify hotspots; they are not additional elapsed time to add to navigation timings.

## Findings

### Rendering dominated cached navigation

The baseline Dashboard revisit took about three seconds despite cached code and data.
Its longest uninterrupted main-thread task exceeded two seconds. The heatmap repeatedly
converted the same first-stored/as-of instants to zoned calendar dates for each cell and
constructed an Intl date formatter for each accessible cell name. CPU self-time included
about 521 ms in dayjs's timezone conversion and 268 ms in heatmap date formatting.

The first implementation round resolves the two observation days once per revision and
uses a bounded locale/options-aware Intl formatter cache. The deployment's timezone and
per-instant DST interpretation still come from the shared time helpers. Civil dates are
formatted through a UTC carrier, including dates that did not exist in the browser's
local calendar. Agent clock labels reuse the same formatter cache with an explicit zone.

### HTTP delivered text uncompressed

The binary previously sent embedded JS/CSS/SVG and API JSON as identity representations.
The supplied reverse-proxy examples did not add compression either. The implemented
server-side gzip negotiation works with the existing proxy configuration and sub-path.
Immutable text assets reuse bounded compressed representations; ordinary JSON uses
pooled best-speed encoders. Streaming events and downloads keep their delivery behavior.
`docs/architecture.md` records the eligibility, cache bounds and header contracts.

### Cold route code started at navigation

Pages are lazy, and a cold navigation waits on its page's module before mounting it.
The menu now preloads the target module on hover, keyboard focus or touch start, sharing
that import with navigation. It does not start the page's queries or mount effects.
Sign-in and the configuration page's on-demand YAML editor retain their loading boundary.

Preloading moves code delivery ahead of a click when there is an intent lead-in; it does
not make page computation cheaper. Immediate click navigation showed variable results,
so it is not credited with a general cached-navigation speedup.

### Backend reads were usually small compared with browser work

The demo audit found ordinary endpoints mostly in the 1–30 ms range. A 90-day usage facet
read took approximately 120–130 ms and the annual token heatmap about 47–49 ms. Gzip
reduces their transfer size but does not reduce their database work. `GetUsageFacets`
performed ten grouped scans in round one; `BenchmarkUsageFacets` remains
the independent way to evaluate a future query change. SQLite's single connection and
WAL policy remain as documented in `docs/ops/sqlite-operations.md`.

The System page's CPA latency is a management-read duration, not network RTT.
`healthDTO` times `Client.Health`, which reads and decodes the complete credential list.
A cold/expired v8 gate may add its probe; `API_SUPPORT_TTL` is five minutes. Co-location
alone therefore does not imply this reading should approach zero. Neither the health
measurement nor its response shape was changed in this round.

## Measurements

Representative navigation samples from the same harness:

| Metric | Baseline | Heatmap/formatters | Plus intent preload | Plus gzip |
| --- | ---: | ---: | ---: | ---: |
| First load: DOMContentLoaded | 1,195 ms | 1,161 ms | 1,176 ms | 689 ms |
| Cached Dashboard switch | 2,988 ms | 2,153 ms | 1,907 ms | 2,033 ms |
| Cached Dashboard's longest task | 2,275 ms | 1,428 ms | 1,440 ms | 1,500 ms |

The final sample reduced cached Dashboard switch time by about 32% and its longest task
by about 34%. The heatmap/date CPU hotspots left the leading functions. The isolated
heatmap step establishes the main CPU improvement; differences of a few hundred
milliseconds between later runs should not be attributed to preload or gzip on a cached
page. G2 initialization and native layout/paint still dominate the residual work.

With 300 ms of hover lead-in, three independent cold-route samples produced these median
click-to-page timings: Config 531 → 505 ms and Logs 618 → 569 ms. Every optimized sample
requested its module before the click; none of the baseline samples did. These modest
improvements are distinct from the warmed Dashboard result above.

Direct identity/gzip requests against the same seeded binary, after establishing its
session, measured response-body bytes (not HTTP header overhead):

| Response | Identity | Gzip | Reduction |
| --- | ---: | ---: | ---: |
| Five eager JS files linked by the entry document | 1,773,291 B | 678,089 B | 62% |
| Request records, limit 200 | 159,596 B | 19,852 B | 88% |
| Annual token heatmap | 73,577 B | 17,035 B | 77% |
| Usage facets, 90-day preset | 2,642 B | 1,010 B | 62% |

Initial compression of the largest eager JS file added about 8 ms in a loopback request;
its representation is then cached. JSON samples remained dominated by handler/query
work. Response sizes can vary with the fixture's observation instant, and compressed
representation parity is asserted separately in Go tests.

## Second round: chart pacing and facet reads

The comparison baseline is the verified first-round binary. The same viewport, link
and CPU throttle were retained. Three fresh contexts warmed Dashboard and System,
then clicked Dashboard from System. A frame callback scheduled by that click records
the first opportunity to paint/respond; the completion condition separately requires
all eight canvases to contain ink, not merely a chart placeholder. Median timings:

| Metric | Round-one baseline | Chart pacing and stable references | Change |
| --- | ---: | ---: | ---: |
| First animation-frame callback after click | 1,682 ms | 1,198 ms | −29% |
| Dashboard tiles observed | 2,328 ms | 1,998 ms | −14% |
| All eight chart canvases contain ink | 2,407 ms | 2,794 ms | +16% |
| Longest task through chart arrival | 1,662 ms | 1,181 ms | −29% |

The table uses the final built binary. The earlier chart-only step measured 1,171 ms
to the first frame and 2,473 ms to all eight canvases. Final chart arrival ranged from
2,451 to 2,879 ms: the queue trades simultaneous creation for responsiveness, and
all-chart completion must be tracked rather than assumed unchanged. This is earlier
main-thread availability, not a faster all-chart completion claim.
The frame callback is a paint opportunity, not a measurement of input event dispatch.
The original navigation/profile harness was also run after stabilizing callbacks and
after adding the queue. Stable callbacks alone did not materially improve cached
navigation (2,171 → 2,141 ms, longest task 1,426 → 1,424 ms); they instead eliminate
redundant configuration/geometry work during unchanged refreshes, asserted by the
browser probe. Chart pacing reduced the harness's longest task to 1,123 ms; the final built-binary
rerun measured 2,027 ms cached navigation and a 1,077 ms longest task.
CPU attribution for the chart bundle dropped from about 1,273 to 792 ms in the sampled
navigation profile; native layout remained substantial.

`ChartMount` commits only one G2 creation in each frame-following task. Its slot keeps
its dimensions, queued jobs cancel on unmount, and the browser pauses the queue in a
hidden tab. Existing instances are updated immediately, with the same motion, hover,
exact tooltip and reduced-motion contracts. Model chart boundaries are memoized too.

### Facets: one detail-table walk, SQL-owned grouping

The adopted query materializes just the eleven facet/mask columns of the selected
instance/time window once. Ten capped grouped reads then scan this narrow temporary
relation within the same statement. It preserves inclusive bounds, binary value ties,
count ordering, empty arrays and the maximum nonempty normalized caller-key mask.
The SQLite connection count, indexes, DTOs and query cadence are unchanged.

Three benchmark samples per strategy on 100,000 events produced these medians:

| Window / populated dimension cardinality | Ten independent queries | Materialized window | Change |
| --- | ---: | ---: | ---: |
| Full window, 20 values in variable dimensions | 1,586 ms | 1,107 ms | −30% |
| Full window, 10,000 values in variable dimensions | 1,573 ms | 1,096 ms | −30% |
| Narrow 1,000-row window, high cardinality | 17.5 ms | 15.2 ms | −13% |

The existing sparse 100k-row benchmark improved from roughly 930 to 460–540 ms.
The populated fixtures are the more representative evidence; a sparse-only result
would overstate the benefit. The strategy benchmarks share a seeded repository and
exclude fixture creation from timing. These are local synthetic costs, not service SLAs.

Nine authenticated loopback reads against each demo binary measured a median
`/usage/facets?preset=90d` HTTP duration of 134.9 → 95.4 ms (−29%). Facet values were
identical; the response's resolved sliding-window instants naturally differed between
runs. Dataset regeneration produced no semantic or committed-file differences.

The trade-off is SQLite temporary storage proportional to selected rows and field
width, rather than an unbounded Go map proportional to distinct values. Returned Go
allocations stay tied to at most 2,000 facet values. The high-cardinality benchmark
reported approximately 276 → 293 KiB of Go allocations per operation; this is not a
measure of SQLite's total temporary-storage footprint. Larger production windows
still require measurement; this query is not constant-memory or constant-time.

## Third implementation round

### Heatmap popup ownership and layout scheduling

The annual grid now mounts plain memoized cells instead of a resident antd Tooltip
for every day. Clicking creates one tooltip with an invisible stationary anchor
portaled into the active cell; further clicks switch or toggle that one instance.
Antd retains placement, viewport adjustment, scroll tracking, arrows and motion.
The cell's ARIA description/open ring follow that popup. Outside pointer and Escape
close it; Escape from the drill-down link restores cell focus. Ordinary data refreshes
retain valid active cells, while navigation and calendar changes remove the instance.

Initial heatmap positioning uses the first nonzero ResizeObserver delivery, then
sets the container to the browser-clamped end once per mount. It no longer reads
scroll extents in the mount effect. This step alone did not materially improve
navigation: the next synchronous layout flush appeared at the shell's unconditional
`scrollTo`. The shell now records its scroll state from root scroll events and resets
only after scrolling, without reading the newly mounted page's geometry. A fitted
desktop field stays at zero, and a phone opens on today while retaining its chosen
week through refreshes.

The same three-context warmed Dashboard → System → Dashboard measurement produced
these medians. No verification suites ran during the final measurement rerun.

| Metric | Round-two baseline | On-demand tooltip | After heatmap layout scheduling | Final, with conditional shell reset |
| --- | ---: | ---: | ---: | ---: |
| First animation-frame callback after click | 1,210 ms | 597 ms | 603 ms | 616 ms |
| Dashboard tiles observed | 1,866 ms | 1,250 ms | 1,263 ms | 1,247 ms |
| All eight chart canvases contain ink | 2,513 ms | 1,875 ms | 1,896 ms | 1,864 ms |
| Longest task through chart arrival | 1,192 ms | 579 ms | 585 ms | 338 ms |

The final round reduces these measures by approximately 49%, 33%, 26% and 72%,
respectively. The separate navigation harness measured 1,864 → 1,436 ms for its
cached Dashboard revisit; its longest task measured 1,043 → 624 ms. These observation
intervals differ, so their task maxima must not be substituted for one another.
An earlier final-code run measured 625 ms to the first frame, 1,272 ms to tiles,
1,898 ms to all canvases and a 339 ms longest task. The frame callback remains only
a paint opportunity, not a direct input-dispatch/readiness measurement.

In the CPU-profile sample, antd self-attribution fell from 488 to 172 ms and React
from 389 to 159 ms. Chart self-attribution was roughly unchanged (754 → 775 ms).
The final profile no longer attributes roughly 273 ms of forced layout to a heatmap
extent getter or shell scroll reset; native layout/paint still exists and the console
is not stall-free. Avoiding redundant synchronous flushes is not a claim that all
layout work disappeared.

The existing heatmap and navigation probes pin popup geometry/ownership, ARIA,
dismissal, keyboard focus, rapid switching, route cleanup, synchronous extent reads,
phone positioning/refresh preservation and shell reset behavior. They use observable
states rather than added sleeps. See `docs/testing.md` for ownership of these browser
claims and the earlier logic/server tests.

## Round four: request-row mount work

The next CPU profiles covered System → Requests, System → Pricing and System → OAuth
with the same production binary, dataset and 4× CPU throttle. In the request sample,
antd accounted for 435 ms of self-attributed work and React for 191 ms; dayjs timezone
conversion accounted for 29 ms. A select input's synchronous width read accounted for
129 ms. Pricing attributed 170 ms to scrollbar measurement, while OAuth attributed
370 ms to antd and 233 ms to React. These samples identify priorities, not exclusive
wall-clock slices or proof that one formatter explains a whole page's stall.

Request rows now resolve their timestamp once for both the short label and full,
millisecond-precision tooltip. The pair is memoized by timestamp and display timezone;
selection and token-display changes reuse it. A five-sample, alternating Node benchmark
of 1,000 fresh New York instants measured a median 278 → 144 ms (about 48% less), with
identical labels. This is a formatter benchmark at native speed, not a browser-navigation
or input-readiness claim.

The request renderer supplies a taller, custom row than Listy's default estimate. Its
component-token projection now starts the virtualizer at the existing 68 px row minimum,
while the row CSS continues owning visible padding and the library measures actual item
and group-header heights. Three independent, alternating baseline/optimized browser
contexts measured warmed System → Requests switches on the same 60 ms link:

| Metric | Round-three baseline | Round-four request changes |
| --- | ---: | ---: |
| Peak request rows mounted during navigation | 11 | 9 |
| First animation-frame callback after click | 555 ms | 523 ms |
| First request row observed | 763 ms | 730 ms |
| Longest task through row arrival and the following observation interval | 540 ms | 512 ms |
| Total long-task duration in that interval | 633 ms | 578 ms |

Every sample mounted two fewer rows (18% less initial row work). The timing differences
are modest: the unchanged Pricing control measured 669 → 640 ms to its first row, so
the small elapsed-time delta alone is not conclusive evidence of a route-wide gain.
The broad navigation harness similarly measured Requests at 983 → 988 ms. The retained
improvements have deterministic conversion/mount-work reductions; they do not establish
that the request page is now stall-free or that every navigation is faster.

The follow-up request CPU sample attributed 18 ms to timezone conversion, while the
select width read still accounted for 142 ms. Pricing and credential page commits,
resident interaction components and synchronous layout remain higher-priority follow-up
work than further date-format changes. The new logic tests pin exact timestamp semantics,
one conversion and the row estimate; the existing request probes cover timezone changes
on mounted DOM, peak mounts, scrolling, geometry, resize, detail actions and touch.

## Round five: one on-demand request tooltip

Measured on October 1, 2026 (UTC), this round replaces the resident tooltip trigger trees in
request rows with plain cells and one list-owned popup. The existing virtual window,
exact timestamp/cache/TPS hints, price action, antd styling and exit motion remain.
Pointer intent or keyboard focus creates the popup; opening it does not replace the
cell or rerender the page. An active-only observer follows label revisions and removed
virtual rows, while scroll/resize invalidate the snapshot anchor. A stationary,
pointer-transparent body portal leaves the row's grid and focus untouched.

Three alternating production-binary browser-context comparisons used the same fixture,
1440 × 900 viewport, 4× CPU throttle and simulated link as the prior rounds. The
observation is warmed System → Requests through row arrival plus 600 ms, not the
broader navigation harness or the Dashboard chart-completion scope.

| Metric | Round-four baseline in this run | Shared request tooltip |
| --- | ---: | ---: |
| Peak request rows mounted | 9 | 9 |
| First animation-frame callback after click | 510 ms | 468 ms |
| First request row observed | 720 ms | 677 ms |
| Longest task in the observation interval | 498 ms | 457 ms |
| Total long-task duration in that interval | 556 ms | 510 ms |

Every paired request sample improved first-frame, first-row and longest-task timings.
Median improvements are approximately 8%, 6% and 8%, respectively. The unchanged
Pricing control measured 655 → 682 ms to first-row arrival and 539 → 564 ms for its
longest task, so the request result is not credited to a universal harness speedup.
This is a small three-context synthetic sample, not a production percentile or proof
that input is now ready in 468 ms: a RAF callback is not an input-latency measurement.

A separate three-context alternating hover check measured the first timestamp hint
at 201 → 201 ms, including the existing 100 ms intent delay and browser-observed
visibility. Neither version produced a ≥50 ms task through popup arrival plus 300 ms.
This guards against moving navigation work into a noticeably slower first hint; it is
not a click-to-paint or INP measurement. The broader two-pass navigation rerun measured
cached Requests at 988 → 979 ms and its longest task at 584 → 539 ms. The small elapsed
difference in that distinct scope does not establish a route-wide speedup; do not mix
its task maximum with the System → Requests table above.

The follow-up request CPU sample attributed 427 ms to antd and 182 ms to React,
compared with 470 ms and 203 ms in the round-four follow-up profile. The same Select
input width read still accounted for 138 ms (previously 142 ms). Dormant popup removal
reduces component work but does not remove this synchronous layout hotspot or the
roughly 450 ms route task. Active tooltip behavior is pinned by the request interaction
and timezone probes; no endpoint, response shape or database policy changed.

## Round six: request rows while scrolling

Measured on October 7, 2026 (UTC) against the dev server with 4x CPU throttling,
wheel-scrolling a 100-row request list end to end under a CPU profile and a trace.
Unthrottled, the same scroll holds 60 frames per second with no long task; the
throttled run is what exposes per-row cost.

| Cost | Before | After |
| --- | ---: | ---: |
| Native layout, style and paint time (`(program)`) | about 5.1 s | about 3.4 s |
| `formatRequestTimestamp`, inclusive | 296 ms | 20 ms |
| react-query observer per row (`useQuery` under `ProviderBrandIcon`) | 95 ms | 16 ms |

Three changes produce these numbers. Each row declares `contain: layout style`, so
measuring one row no longer lays out its neighbours. The row timestamp is formatted by
one `Intl.DateTimeFormat` per display timezone rather than a zoned dayjs instance per
row. `ProviderBrandIcon` creates a plugin-list observer only for deployment custom
artwork.

What remains is the virtual list's own height collection: after each commit it reads
`offsetHeight` and the computed margins of every mounted row, about 1.3 s of self time
in the throttled run, and the throttled frame distribution is still set by it (roughly
45% of frames over 33 ms). It is library behaviour and was left alone. The figures are
dev-server figures, which overstate React's share; they were not repeated against a
production build.

## Remaining work, in priority order

1. **Dashboard page commit and layout.** The third-round responsiveness harness
   still observes a roughly 338 ms task at 4× CPU, and the broader navigation
   harness observes a 624 ms task. Profile the remaining page commit and native
   layout/paint before changing rendering or readiness feedback. Track first frame,
   all-chart completion and meaningful interaction together.
2. **High-density page commits.** Request records, pricing and credential navigation
   still show hundreds-of-milliseconds tasks under the same throttle. Profile their
   first meaningful interaction and the identified select/scrollbar measurements before
   changing interaction components or virtualization further.
3. **Large-window temporary storage.** Check facet costs and SQLite temporary-storage
   pressure against production retention and cardinality, without changing the
   single-connection policy casually.
4. **Health read semantics.** A lightweight authenticated management probe or clearer
   latency labeling would make the System readout easier to interpret. Treat that as a
   distinct behavior/copy change, with its API and localization tests.

The six rounds reduce render work and improve responsiveness and transfer/query cost without claiming to
remove every main-thread stall. Follow-up work should retain the same throttle and
report both first-visible content and meaningful interaction readiness.

## Regression policy after the loading-progress change

ADR 0053 replaces narrow per-chunk quotas with production loading-boundary checks,
raw/gzip reporting and broad anomaly ceilings. The baseline in
`scripts/bundle-reference.json` records commit `6e76d9e` with unchanged runtime
sources, measured by the new graph collector: entry 313.97 KiB, startup JS
1742.63 KiB raw / 563.77 KiB level-6 gzip estimate, startup CSS 63.30 / 12.26 KiB,
all JS 10696.46 KiB and distribution 12423.51 KiB. This is a size reference, not
another browser timing audit. The graph/report metadata stays outside dist.

Startup is the static closure of the HTML module entry and modulepreloads, not
just the entry file. Page/shell/chart/Markdown/editor modules cannot enter it;
the configuration route additionally retains its on-demand editor boundary.
Ordinary growth produces comparison evidence and warnings rather than requiring
routine quota changes. Absolute ceilings still detect gross expansion; their
values and the exact-base artifact policy are in `docs/testing.md` and
`scripts/bundle-report.mjs`. Gzip estimates do not remove CPU costs, and these
checks do not substitute for the browser timings and profiling methodology above.
