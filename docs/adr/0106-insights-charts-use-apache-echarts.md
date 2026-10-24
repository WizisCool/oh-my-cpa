# ADR 0106: Dashboard and Insights charts share Apache ECharts

- Status: Accepted
- Date: 2026-10-24
- Supersedes: ADR 0004
- Amends: ADR 0008 (shared motion policy, SVG runtime and first-paint reveal)

## Context

Insights needs a pivotable trend, a dragged span that becomes the next window and
traffic flows from client keys through models to providers. It already uses a
modular ECharts runtime. The dashboard's separate AntV runtime adds another lazy
chunk and theme/lifecycle adapter for six sparklines, a model trend and a ring.
Sharing a runtime removes that duplication while keeping charts off the startup
path and gives both surfaces the same instance-preserving updates and hover states.

## Decision

- Dashboard and Insights use **Apache ECharts 6.1.0**, pinned in `web/package.json`.
  `web/src/charts/echarts/core.ts` registers bar, line, pie and sankey series;
  grid, tooltip, brush (with hidden toolbox), mark line, mark area and aria components.
  The dashboard adds only the pie module to the existing registered chart types.
- The renderer is **SVG**. Both surfaces draw a bounded number of marks, and SVG
  keeps labels in the console's typeface and geometry observable by browser probes.
- `EChart.tsx` owns creation, merged options, theme updates with `setTheme`,
  `ResizeObserver` and disposal. `ChartMount` queues creation without deferring
  updates. Omitted height fills a caller-owned container, including the square ring.
- All updates use the `MOTION_ROLL` token through `echartsMotion`; reduced motion
  explicitly disables library animation. Sparklines reveal left to right; the ring
  appears complete. Subsequent readings morph in the same instance. Hover feedback
  uses the 120ms fast token, with series-level timings pinned so runtime defaults
  cannot override the console policy.
- A single lazy `vendor-echarts` chunk serves both pages. The AntV dependency and
  `vendor-charts` chunk are retired. The bundle gate keeps chart modules out of the
  startup graph; no runtime or asset comes from a CDN.
- DOM owns legends, ranked lists and the ring's centre. Trend legend hover emphasizes
  its series and blurs peers. Slice/list hover shows the selected model's tokens and
  share in the centre, restoring the response's window total on leave.
- Tooltips use `renderChartTooltip` for escaped content and one shared palette shell.
  Tables, matrices and weekday-by-hour grids remain DOM rather than runtime marks.

## Consequences

- There is one chart theme, lifecycle and reduced-motion adapter to maintain.
  Opening either page loads the same runtime; visiting both does not download a
  second chart engine. Pie support is the only new chart-type registration.
- Stable series IDs preserve data identity through revisions. Model ranks own color
  assignment; rank one is painted last and the tooltip retains legend order,
  including measured zero buckets.
- Browser probes inspect actual SVG paint, geometry and instance identity. They
  verify both motion preferences and light/dark palette ink, not merely options or
  the presence of a chart container.
- ECharts upgrades and registrations remain deliberate dependency changes, verified
  by bundle and built-artifact acceptance as well as browser probes.
