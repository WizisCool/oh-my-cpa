# ADR 0004: Adopt @ant-design/charts for dashboard and data visualization

- Status: Accepted
- Date: 2026-09-14

## Context

Previously, Oh My CPA rendered dashboard KPI sparklines using hand-rolled SVG paths (`web/src/charts/chartTheme.ts`), reflecting an early design constraint documented in `docs/design.md` §6 to avoid shipping any charting runtime. While that kept initial bundle weight minimal for simple trends, the product roadmap requires richer data visualizations (including request waterfall gantt charts, token density heatmaps, and structured usage telemetry).

Continuing to hand-roll custom SVG paths and canvas rendering creates compounding maintenance costs, bespoke geometry bugs, and inconsistent interaction ergonomics across complex visualizations.

## Decision

Adopt `@ant-design/charts` (version 2, powered by `@antv/g2`) as the standard charting library for Oh My CPA:

1. Replace the hand-rolled dashboard KPI tile sparklines with `@ant-design/charts` area marks (`web/src/charts/DashboardTrendChart.tsx`). The mark is an area because the backend zero-fills a fixed bucket grid: a bar mark renders each empty bucket as an invisible gap that reads as missing data, while an area carries the series to its baseline. See `docs/design.md` §6 for the full reasoning.
2. Supersede the earlier constraint in `docs/design.md` §6 that prohibited charting runtimes.
3. Apply three mandatory mitigations to prevent bundle weight regressions from impacting the application shell:
   - **Dedicated manual chunk**: Route all `node_modules/@antv/`, `node_modules/@ant-design/charts`, and `node_modules/@ant-design/plots` modules into an isolated `vendor-charts` chunk in `web/vite.config.ts`.
   - **Lazy loading**: Load the chart runtime dynamically (`React.lazy(() => import(...))`) so that only routes rendering charts (such as `/dashboard`) fetch the chunk; the application shell and authentication gate (`/login`) never pull `vendor-charts` into their graph.
   - **Enforced bundle budget**: Add an explicit `vendor charts` chunk budget (1600 kB limit against ~1435 kB measured minified) and update aggregate JavaScript and distribution budgets in `scripts/check-bundle-budget.mjs`.
4. Enforce strict visual invariants:
   - Disable chart library animations explicitly (`animate: false`) per `docs/design.md` §7 rule 5.
   - Bridge palette tokens directly (`sparkColor(mode, tone)`) rather than hardcoding colors.
   - Retain lightweight app-owned HTML `.chart-tooltip` overlays styled via CSS custom properties.

## Consequences

### Positive

- Provides a robust, declarative visualization runtime capable of scaling to future requirements (heatmaps, gantt waterfalls, multi-axis series) without accreting bespoke math and rendering code.
- Operates fully offline with zero CDN dependencies, embedding cleanly into the single Go application binary.
- Clean architectural boundary: `vendor-charts` is isolated and only loaded on demand.

### Trade-offs

- Substantial bundle size increase: adding `@ant-design/charts` introduces ~1435 kB minified (+434 kB gzip) into `vendor-charts`.
- Requires raising aggregate bundle budgets:
  - `total JavaScript`: 6075.41 kB -> 7510.13 kB (budget raised from 6300 kB to 7800 kB).
  - `total web/dist`: 7544.73 kB -> 8979.53 kB (budget raised from 7800 kB to 9300 kB).

## Alternatives considered

- **Continue hand-rolling SVG marks**: Keeps the bundle smaller by ~1.4 MB, but fails long-term when implementing complex charts (gantt, heatmaps) where hand-rolled rendering becomes brittle, expensive, and bug-prone.
- **ECharts (`echarts-for-react`)**: Powerful, but incurs comparable bundle weight without integrating naturally with Ant Design theme tokens and design patterns.
