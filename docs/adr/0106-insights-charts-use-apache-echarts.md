# ADR 0106: Insights charts use Apache ECharts

- Status: Accepted
- Date: 2026-10-24
- Supplements: ADR 0004 (the dashboard keeps `@ant-design/charts`)

## Context

The Insights page (`/insights`) is the console's analytical surface. It needs figures the
dashboard never drew: a trend whose stacked marks morph when the reader regroups or
narrows it, a dragged span on that trend that becomes the next window, and a flow figure
that follows each client key's traffic through the model it asked for to the provider
that served it. `@ant-design/charts` (ADR 0004) has no flow (sankey) figure. Its G2 runtime
replaces marks on a data change instead of interpolating them. A brush on it means
handling selection geometry by hand.

The page also reads one snapshot per window and pivots it in the browser, so every
filter, grouping and metric switch is a new option for a chart that already exists. A
runtime that merges a new option into a live instance makes that cheap and makes
transitions smooth.

## Decision

- Insights charts use **Apache ECharts 6.1.0**, pinned exactly in `web/package.json` and
  registered piece by piece through `echarts/core` (`web/src/charts/echarts/core.ts`):
  bar, line and sankey series; grid, tooltip, brush (with its toolbox registered and
  hidden), mark line, mark area and aria components.
- The renderer is **SVG**. The page draws a few hundred marks at most. SVG text is laid
  out by the browser in the console's own typeface, and every mark is an element a probe
  can read.
- One wrapper, `EChart.tsx`, creates, updates and disposes each instance. A palette change
  calls `setTheme` with a theme built from `ThemePalette` (`echartsTheme.ts`), so ink always
  comes from the tokens. Motion uses the `roll` token, and reduced motion turns animation
  off.
- The runtime is its own lazily loaded chunk (`vendor-echarts`), separate from the
  dashboard's `vendor-charts`. Neither page downloads the other's runtime. The bundle report
  keeps both runtimes out of the startup graph.
- The dashboard is not migrated. Tables, the matrix and the rhythm's weekday × hour grid
  stay DOM (the hourly rhythm is an ECharts bar chart), and sparklines stay inline SVG paths.

## Consequences

- The console now carries two chart runtimes. Each is loaded only by the page that draws
  it, so a reader pays for one at a time. The cost is two theming adapters to keep in step
  with `ThemePalette`.
- If the dashboard later needs morphing, a brush or a flow figure, moving it to the same
  runtime retires `vendor-charts`. That migration is the moment to re-evaluate ADR 0004.
- An ECharts upgrade is a deliberate dependency change. A missing registration shows up
  as a console error in the browser probes, not as a blank chart.
