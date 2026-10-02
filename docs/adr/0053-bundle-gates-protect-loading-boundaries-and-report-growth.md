# ADR 0053: Bundle gates protect loading boundaries and report growth

- Status: Accepted
- Date: 2026-10-02

## Context

The embedded, offline console still ships resources to a browser, so cold transfer,
parse and execution costs matter. However, lazy route inventories are not startup
costs, and a named entry chunk is not its transitive dependency graph. Per-chunk
quotas repeatedly approached ordinary feature/copy growth: after PR 114 the entry
was 313.97 KiB against 314 KiB. Tens of bytes of remaining margin did not represent
a measured user-experience boundary. Conversely, moving code into another eager
chunk could satisfy an entry quota without reducing startup work.

The old CI preparation step stopped before production browser acceptance on any
budget failure, losing independent correctness evidence from an otherwise valid
build. Limits must detect architectural mistakes without becoming a routine
feature tax or preventing diagnosis.

## Decision

1. Capture Rollup chunk ownership and static/dynamic imports outside the served
   distribution. Validate chunk hashes and edges against production artifacts.
   Walk the HTML entry/modulepreload static closure, not filename conventions.
2. Refuse eager route, authenticated shell, chart, Markdown and Monaco modules.
   Also enforce the configuration page's on-demand YAML editor boundary.
3. Report raw and level-6 per-file gzip estimates, startup JS/CSS, entry, largest
   JS, total JS, icon SVGs and dist. Retain per-file/source evidence for attribution.
4. Compare only with an exact-revision baseline, fetched from a successful push
   CI report or supplied explicitly. A single measured bootstrap reference
   supports the first deployment of the policy. Missing evidence is stated;
   unrelated revisions are never substituted. Ordinary growth is advisory.
5. Keep broad absolute anomaly ceilings: startup JS 3 MiB raw / 1 MiB gzip,
   startup CSS 256 / 96 KiB, largest JS 4 MiB raw, total JS 16 MiB raw, total
   dist 20 MiB raw, Lobe SVGs 2 MiB raw. These allow material headroom relative
   to the measured baseline, not a claim about acceptable latency. Change them
   deliberately with measurements rather than as part of each feature.
6. Separate the bundle verdict from valid-build browser/demo evidence. CI and
   full local verification remain failed when the bundle gate fails, after
   collecting the other results. Build, secret and toolchain prerequisites remain.

## Consequences

Normal localized copy and page-local dependencies no longer require quota edits.
Actual dependency edges prevent renamed/shared chunks from hiding eager heavy
modules. Script fixtures can falsify graph, baseline and verdict decisions without
paying for a browser per case. Production acceptance still validates embedded
resources, paths and behavior; size reporting is not a latency benchmark.

CI retains reports for 30 days with read-only Actions access. Artifact expiration,
unavailable successful base runs or retrieval failures reduce comparison coverage
and are visible in the report, but cannot disable structural or absolute checks.
The collector adds temporary build metadata and compression/report work; it adds
no runtime dependency, resource endpoint or deployed metadata.
