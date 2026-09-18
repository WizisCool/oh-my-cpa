/**
 * The browser probe scenarios, as a registry rather than a script.
 *
 * Each scenario is a claim only a real engine can establish - geometry, stacking,
 * hit-testing, paint or virtualization - so none of them can move to the pure
 * suite. What they can share is their setup and their fixtures, which is why they
 * live here as data: `verify:probes` runs all of them against the built SPA in the
 * release gate, and `check:ui` runs the relevant subset against the dev server
 * during development.
 *
 * The implementations live in `probes/`, one module per product surface - the
 * provider console, the request records, the dashboard's charts, heatmap and model
 * panels, and the OMC settings page - and this file is the registry that orders
 * them. An id, its name, its route table and its viewport are stated once, here,
 * so the order the release gate runs them in is readable in one place.
 *
 * Nothing in this module or in `probes/` runs on import. That is deliberate:
 * `check:ui --list` and `--plan` must be able to answer without starting a
 * browser, and a module that spawned a server at import time could not support
 * that.
 */
import { dashboardChartMarks, dashboardChartMotion, dashboardRollingReadouts } from './probes/dashboardCharts.mjs';
import {
  chartDashboard,
  chartDashboardModels,
  chartDashboardModelsEmpty,
  chartDashboardModelsWeek,
  chartTokenHeatmap,
  chartTokenHeatmapPruned,
} from './probes/dashboardFixtures.mjs';
import {
  dashboardModelPanelFailures,
  dashboardModelPanelStates,
  dashboardModelPanels,
  dashboardModelPanelsEmpty,
} from './probes/dashboardModelPanels.mjs';
import {
  dashboardTokenHeatmap,
  dashboardTokenHeatmapFailure,
  dashboardTokenHeatmapMobile,
  dashboardTokenHeatmapPruned,
} from './probes/dashboardTokenHeatmap.mjs';
import { omcSettings } from './probes/omcSettings.mjs';
import { overlayBackDismisses } from './probes/overlayHistory.mjs';
import { iconPickerStacking, pickerProvider, providerIconPick } from './probes/providerConsole.mjs';
import {
  alignmentFacets,
  alignmentRecords,
  columnAlignment,
  interactionRecords,
  refreshRecords,
  requestListInteractions,
} from './probes/usageRecords.mjs';

/**
 * Every probe scenario, in the order they run.
 *
 * `shared` marks the fixtures a scenario's route table builds on: a scenario listed
 * against a shared fixture is selected when anything that fixture describes changes.
 * The mapping from a source file to the scenarios it can affect lives in
 * `check-ui-plan.mjs`, which is also where the conservative "unknown frontend path
 * widens the plan" rule is stated.
 *
 * `check` is supplied by the runner rather than imported, so the same registry
 * serves the release gate (which runs all of them) and the development fast path
 * (which runs the relevant subset) without either owning the other's reporting.
 */
export const SCENARIOS = [
  {
    id: 'omc-settings',
    name: 'OMC settings and the unit style it governs',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
      ],
    },
    run: omcSettings,
  },
  {
    id: 'column-alignment',
    name: 'column alignment',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/usage/facets'), () => alignmentFacets],
        [(url) => url.pathname.includes('/usage/events'), () => ({ items: alignmentRecords, has_more: false, limit: 50 })],
        [
          (url) => url.pathname.endsWith('/usage/ingest-status'),
          () => ({ enabled: true, healthy: true, collector: { mode: 'http_pull', captured: 12, coverage_gaps: 0 }, stats: { pending: 0 } }),
        ],
      ],
    },
    run: columnAlignment,
  },
  {
    id: 'icon-picker-stacking',
    name: 'icon picker stacking',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/management/providers'), () => ({ providers: [pickerProvider], total: 1 })],
      ],
    },
    run: iconPickerStacking,
  },
  {
    id: 'provider-icon-pick',
    name: 'the icon picked for a provider is the mark its row draws',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/management/providers'), () => ({ providers: [pickerProvider], total: 1 })],
      ],
    },
    run: providerIconPick,
  },
  {
    id: 'dashboard-charts',
    name: 'dashboard chart marks',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
        [
          (url) => url.pathname.endsWith('/management/overview'),
          () => ({
            cpa: { connected: true, version: 'probe', latency_ms: 1 },
            counts: { management_keys: 1, provider_keys: 0, credentials: 0, models: 0 },
            providers: [],
            credentials: { total: 0, active: 0, disabled: 0, unavailable: 0, by_type: [] },
            traffic: { bucket_minutes: 10, window_minutes: 60, buckets: [], total_success: 0, total_failure: 0, total: 0, success_rate: null },
            partial_errors: [],
          }),
        ],
      ],
    },
    run: dashboardChartMarks,
  },
  {
    id: 'dashboard-chart-motion',
    name: 'dashboard charts: sweep on a revision, and none under reduced motion',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
      ],
    },
    run: dashboardChartMotion,
  },
  {
    id: 'dashboard-rolling-readouts',
    name: 'dashboard KPI tile numbers: formats, sweep, and the unit freeze',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
      ],
    },
    run: dashboardRollingReadouts,
  },
  {
    id: 'dashboard-model-panels',
    name: 'dashboard model trend and usage ring',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
        [
          (url) => url.pathname.endsWith('/management/overview'),
          () => ({
            cpa: { connected: true, version: 'probe', latency_ms: 1 },
            counts: { management_keys: 1, provider_keys: 0, credentials: 0, models: 0 },
            providers: [],
            credentials: { total: 0, active: 0, disabled: 0, unavailable: 0, by_type: [] },
            traffic: { bucket_minutes: 10, window_minutes: 60, buckets: [], total_success: 0, total_failure: 0, total: 0, success_rate: null },
            partial_errors: [],
          }),
        ],
      ],
    },
    run: dashboardModelPanels,
  },
  {
    id: 'dashboard-model-panels-states',
    name: 'dashboard model panels: window, refresh and stale failure',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        // The window picker sends preset=7d when the 7-day range is selected.
        [(url) => url.search.includes('preset=7d') && url.pathname.endsWith('/dashboard/models'), () => chartDashboardModelsWeek],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
      ],
    },
    run: dashboardModelPanelStates,
  },
  {
    id: 'dashboard-model-panels-failure',
    name: 'dashboard model panels: first-load failure',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => ({ status: 503, json: { error: 'database is unavailable' } })],
      ],
    },
    run: dashboardModelPanelFailures,
  },
  {
    id: 'dashboard-model-panels-empty',
    name: 'dashboard model panels: a window with no model traffic',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModelsEmpty],
      ],
    },
    run: dashboardModelPanelsEmpty,
  },
  {
    id: 'dashboard-heatmap',
    name: 'dashboard token heatmap',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
      ],
    },
    run: dashboardTokenHeatmap,
  },
  {
    id: 'dashboard-heatmap-pruned',
    name: 'dashboard token heatmap over pruned history',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmapPruned],
        // The model panels are not what this scenario asserts, but they share the page: without a
        // response they would render their empty state and the probe would be reading a page one
        // panel short of the real one.
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
      ],
    },
    run: dashboardTokenHeatmapPruned,
  },
  {
    id: 'dashboard-heatmap-mobile',
    name: 'dashboard token heatmap on a phone',
    options: {
      viewport: { width: 390, height: 844 },
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
      ],
    },
    run: dashboardTokenHeatmapMobile,
  },
  {
    id: 'dashboard-heatmap-error',
    name: 'dashboard token heatmap failure states',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [
          (url) => url.pathname.endsWith('/dashboard/token-heatmap'),
          () => ({ status: 503, json: { error: 'database is unavailable' } }),
        ],
        // The model panels are a separate read with a separate failure mode, so this scenario leaves
        // them healthy: the claim under test is that the *heatmap* can fail without blanking the page,
        // and failing both would not distinguish "the panels survived" from "the page is wrong".
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
      ],
    },
    run: dashboardTokenHeatmapFailure,
  },
  {
    id: 'refresh-sequencing',
    name: 'refresh sequencing',
    run: refreshRecords(),
  },
  /**
   * The search box, exercised on the **development** server.
   *
   * This scenario exists because the production-bundle suite cannot see the failure
   * it guards. `React.StrictMode` is enabled in `web/src/main.tsx`, and in a
   * development build React runs mount -> unmount -> mount for every component. A
   * hook that creates a disposable controller during render and disposes it in the
   * first cleanup hands the remount a *dead* controller: `change()` returns early
   * forever, so the search box silently stops committing while looking healthy, and
   * every production-bundle check stays green because StrictMode's double-invoke
   * does not run there.
   *
   * That is not hypothetical - it is exactly what happened when the debounce became
   * a controller, and nothing in the suite caught it. So the assertion is made where
   * the failure lives: type into the box, wait past the debounce, and require the
   * committed value to reach the URL. A controller that was replaced by a remount
   * cannot satisfy it, and neither can one that was never installed.
   */
  {
    id: 'search-dev-server',
    name: 'search commits on the dev server',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/usage/facets'), () => alignmentFacets],
        [(url) => url.pathname.includes('/usage/events'), () => ({ items: alignmentRecords, has_more: false, limit: 50 })],
        [
          (url) => url.pathname.endsWith('/usage/ingest-status'),
          () => ({ enabled: false, healthy: false, collector: {}, stats: {} }),
        ],
      ],
    },
    run: async ({ base, page, errors, check: assert }) => {
      await page.goto(`${base}/usage/events?preset=24h`, { waitUntil: 'domcontentloaded' });
      await page.locator('.request-row').first().waitFor({ timeout: 20_000 });

      // The box has to be reachable first: a missing control would make the commit
      // assertion below pass vacuously if it were written as a conditional.
      const input = page.locator('.request-search input');
      assert('the search box is present', (await input.count()) === 1, `inputs=${await input.count()}`);

      const before = new URL(page.url()).search;
      await input.click();
      await page.keyboard.type('gpt', { delay: 20 });
      // A condition wait rather than a flat sleep: it returns as soon as the commit
      // lands and fails loudly - instead of expiring quietly - if it never does.
      await page
        .waitForFunction(() => new URL(location.href).search.includes('q=gpt'), null, { timeout: 5_000 })
        .catch(() => {});
      const after = new URL(page.url()).search;

      assert(
        'a keystroke commits to the URL after the debounce',
        after.includes('q=gpt'),
        `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
      );
      // The failure mode is silent, so a page error is not expected; asserting its
      // absence keeps the check honest about what it observed.
      assert('the search box raises no page error', errors.length === 0, errors.join(' | '));
    },
  },
  /**
   * The platform's Back button, which is the only dismissal a phone has that is always in reach.
   *
   * The fixtures are the minimum each surface needs. The dashboard appears because the probe
   * arrives at every route through a real in-app navigation - a reload replaces the history
   * entry rather than adding one, and Back would then have nowhere to go - and the dashboard is
   * the hop that needs the most of its own data to render. Everything else is one request record
   * for the list and one provider for its editor; a richer fixture would not change what is
   * asserted, which is about the history entry an overlay pushed.
   */
  {
    id: 'overlay-back',
    name: "overlays answer the platform's Back",
    options: {
      // A phone, because that is where the claim comes from: the hardware Back button and the
      // edge gesture are the dismissals a phone always has in reach. The navigation sheet is a
      // phone-only surface anyway, so a desktop viewport could not test it at all.
      viewport: { width: 390, height: 844 },
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
        [(url) => url.pathname.endsWith('/usage/facets'), () => alignmentFacets],
        [
          (url) => url.pathname.includes('/usage/events'),
          () => ({ items: interactionRecords, has_more: false, limit: 100 }),
        ],
        [
          (url) => url.pathname.endsWith('/usage/ingest-status'),
          () => ({ enabled: true, healthy: true, collector: { mode: 'http_pull', captured: 500, coverage_gaps: 0 }, stats: { pending: 0 } }),
        ],
        [(url) => url.pathname.endsWith('/management/providers'), () => ({ providers: [pickerProvider], total: 1 })],
      ],
    },
    run: overlayBackDismisses,
  },
  {
    id: 'request-list-interactions',
    name: 'request list interactions',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/usage/facets'), () => alignmentFacets],
        [
          (url) => url.pathname.includes('/usage/events'),
          () => ({ items: interactionRecords, has_more: false, limit: 100 }),
        ],
        [
          (url) => url.pathname.endsWith('/usage/ingest-status'),
          () => ({ enabled: true, healthy: true, collector: { mode: 'http_pull', captured: 500, coverage_gaps: 0 }, stats: { pending: 0 } }),
        ],
      ],
    },
    run: requestListInteractions,
  },
];
