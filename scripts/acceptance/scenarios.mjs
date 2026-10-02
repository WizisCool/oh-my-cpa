import { routeRenderError, routeLazyError } from './probes/routeError.mjs';
import { agentWorkspace, agentFailureCopy, agentStream, agentNarrow, agentLive, agentQuestion, agentViews, agentFixtures } from './probes/agent.mjs';
import { playground, playgroundFixtures, playgroundNarrow } from './probes/playground.mjs';
/**
 * The browser probe scenarios, as a registry rather than a script.
 *
 * Each scenario is a claim only a real engine can establish - geometry, stacking,
 * hit-testing, paint or virtualization - so none of them can move to the pure
 * suite. What they can share is their setup and their fixtures, which is why they
 * live here as data: `verify:probes` runs the full catalog against the dev server in CI, and
 * `check:ui` runs the relevant subset against the same server during development.
 *
 * The implementations live in `probes/`, one module per product surface - the
 * provider console, the request records, the dashboard's charts, heatmap and model
 * panels, and the OMC settings page - and this file is the registry that orders
 * them. An id, its name, its route table and its viewport are stated once, here,
 * so the order the full catalog runs them in is readable in one place.
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
import { auditTrail, auditTrailNarrow, logsFixtures, logsSources } from './probes/logsPage.mjs';
import {
  providerRateMarks,
  providerRateOverview,
  providerRateProviders,
  providerRateTraffic,
} from './probes/providerRateMarks.mjs';
import { overlayBackDismisses } from './probes/overlayHistory.mjs';
import { phoneListRendering } from './probes/phoneLists.mjs';
import { pluginManagement, pluginManagementFixtures, pluginManagementNarrow } from './probes/pluginManagement.mjs';
import { pricingBook, pricingFixtures, pricingFromRequestList } from './probes/pricingBook.mjs';
import { touchErgonomics } from './probes/touchErgonomics.mjs';
import { scrollSmoothing } from './probes/scrollSmoothing.mjs';
import { requestListTouch } from './probes/requestListTouch.mjs';
import { oauthManagement, oauthManagementFixtures, oauthManagementProbeRoutes } from './probes/oauthManagement.mjs';
import { customIconLibrary, customIconProbeRoutes, iconPickerStacking, pickerCatalog, pickerProvider, providerIconPick, providerModelPicker } from './probes/providerConsole.mjs';
import { routePreloading } from './probes/routePreloading.mjs';
import { systemInformationNarrow, systemInformationPage, systemFixtures } from './probes/systemInformation.mjs';
import { configSourceEditor, configSourceFixtures } from './probes/configSourceEditor.mjs';
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
/** The audit queries the audit scenario's page sent, read back by the scenario's own checks. */
const auditRequests = [];
/** The writes the plugin management scenario's page sent, read back by its own checks. */
const pluginManagementWrites = [];
const pricingBookWrites = [];

const routeErrorFixtures = () => [
  [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
  [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
  [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
];

export const SCENARIOS = [
  {
    id: 'route-render-error',
    name: 'route render failures show branded recovery in every language and theme',
    options: { routes: routeErrorFixtures() },
    run: routeRenderError,
  },
  {
    id: 'route-lazy-error',
    name: 'lazy route failures recover through full-document reload and home navigation',
    options: { routes: routeErrorFixtures() },
    run: routeLazyError,
  },
  {
    id: 'route-preloading',
    name: 'navigation intent preloads code without mounting pages or their reads',
    options: {
      routes: [
        ...systemFixtures(),
        ...configSourceFixtures(),
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
      ],
    },
    run: routePreloading,
  },
  { id: 'agent', name: 'Agent data notice, reasoning effort, inline one-click authorization, remembered target and server conversation recovery', options: { routes: agentFixtures() }, run: agentWorkspace },
  { id: 'agent-question', name: 'Agent asks a question in the composer and continues once it is answered', options: { routes: agentFixtures() }, run: agentQuestion },
  { id: 'agent-live', name: 'Agent shows a sent message at once, queues the next one and keeps its reasoning', options: { routes: agentFixtures() }, run: agentLive },
  { id: 'agent-views', name: 'Agent draws display calls from their frozen rows as tables and charts', options: { routes: agentFixtures() }, run: agentViews },
  { id: 'agent-failure', name: 'Agent hands a refused message back and reports a failure as a sentence, not a code', options: { routes: agentFixtures() }, run: agentFailureCopy },
  { id: 'agent-stream', name: 'Agent coalesces a token burst into bounded repaints', options: { routes: agentFixtures() }, run: agentStream },
  { id: 'agent-narrow', name: 'Agent keeps its target visible and its side panel follows native Back on phones', options: { routes: agentFixtures(), viewport: { width: 320, height: 850 } }, run: agentNarrow },
  { id: 'playground', name: 'ephemeral multimodal playground streams and inspects safe requests', options: { routes: playgroundFixtures() }, run: playground },
  { id: 'playground-narrow', name: 'playground settings follow native Back and fit a phone', options: { routes: playgroundFixtures(), viewport: { width: 320, height: 850 } }, run: playgroundNarrow },
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
    id: 'oauth-management',
    name: 'unified OAuth workspace density, connection intent and phone reflow',
    options: {
      viewport: { width: 1440, height: 900 },
      routes: oauthManagementProbeRoutes(),
    },
    run: oauthManagement,
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
    id: 'custom-icon-library',
    name: 'custom icons upload, Base64, replacement, referenced deletion resets and phone overlays',
    options: { routes: customIconProbeRoutes() },
    run: customIconLibrary,
  },
  {
    id: 'provider-model-picker',
    name: 'a fetched catalog is picked in one step and the key field is not a password field',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/management/providers/pull-models'), () => ({ models: pickerCatalog })],
        [(url) => url.pathname.endsWith('/management/providers'), () => ({ providers: [pickerProvider], total: 1 })],
      ],
    },
    run: providerModelPicker,
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
    id: 'provider-rate-marks',
    name: 'the provider rows paint each rate in its band, in both themes',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
        [(url) => url.pathname.endsWith('/management/dashboard/providers'), () => providerRateTraffic],
        [(url) => url.pathname.endsWith('/management/providers'), () => providerRateProviders],
        [(url) => url.pathname.endsWith('/management/overview'), () => providerRateOverview],
      ],
    },
    run: providerRateMarks,
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
        ...oauthManagementFixtures.routes,
        /* The key page's own data, so its add dialog is reachable: the dialog is the Modal-class
           overlay this scenario covers. */
        [(url) => url.pathname.endsWith('/management/api-keys'), () => ({
          keys: [
            { index: 0, key: 'omc-fixture-key-aaaaaaaaaaaaaaaa', fingerprint: 'fp-1', usage_fingerprint: 'ufp-1', length: 30, alias: 'Primary caller', alias_version: 1 },
          ],
          total: 1,
        })],
        [(url) => url.pathname.endsWith('/management/client-key-usage'), () => ({
          window: { from: Date.now() - 86_400_000, to: Date.now() },
          usage: [{ key_fingerprint: 'ufp-1', requests: 1284, failed: 3, total_tokens: 918_000, last_used_ms: Date.now() - 60_000 }],
        })],
        [(url) => url.pathname.endsWith('/management/config'), () => ({
          scalars: {},
          supported_keys: [],
          revision: 'fixture-r1',
          safe_yaml: 'access:\n  api-keys:\n    - omc-fixture-key-aaaaaaaaaaaaaaaa\n',
        })],
      ],
    },
    run: overlayBackDismisses,
  },
  /**
   * The console's touch rules, on a context that has a coarse pointer and no hover.
   *
   * `hasTouch` is the whole point of this scenario: the rules live in `@media (pointer: coarse)`
   * and `@media (hover: none)`, so on an ordinary context they are never exercised and the
   * scenario would pass while testing nothing. See `createProbePage` for why it is `hasTouch`
   * without Playwright's `isMobile`.
   */
  {
    id: 'touch-ergonomics',
    name: 'the console obeys its touch rules on a coarse pointer',
    options: {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
        [(url) => url.pathname.endsWith('/management/providers'), () => ({ providers: [pickerProvider], total: 1 })],
        /* The dashboard's provider rows, which is what its reveal-on-hover arrow lives on. Both
           halves are supplied because the panel aggregates configured providers with the window's
           traffic: one of either produces no row at all. `success_rate` is a percentage, so a row
           that served all 12 of its requests reads 100 - and therefore green, which is the row
           this scenario means to be looking at. */
        [(url) => url.pathname.endsWith('/management/dashboard/providers'), () => ({
          window: { preset: '1h', from: Date.now() - 3_600_000, to: Date.now(), bucket_ms: 60_000 },
          providers: [
            { id: 'codex', total: 12, success: 12, failure: 0, success_rate: 100 },
          ],
          partial_errors: [],
        })],
        [(url) => url.pathname.endsWith('/management/overview'), () => ({
          cpa: { connected: true, version: 'probe', latency_ms: 1 },
          counts: { management_keys: 1, provider_keys: 1, credentials: 1, models: 1 },
          providers: [{
            id: 'codex',
            credentials: 1,
            success: 12,
            failure: 0,
            total: 12,
            success_rate: 100,
            buckets: [{ success: 12, failed: 0 }],
          }],
          credentials: { total: 1, active: 1, disabled: 0, unavailable: 0, by_type: [] },
          traffic: { bucket_minutes: 10, window_minutes: 60, buckets: [], total_success: 12, total_failure: 0, total: 12, success_rate: 100 },
          partial_errors: [],
        })],
        [(url) => url.pathname.endsWith('/management/api-keys'), () => ({
          keys: [
            { index: 0, key: 'omc-fixture-key-aaaaaaaaaaaaaaaa', fingerprint: 'fp-1', usage_fingerprint: 'ufp-1', length: 30, alias: 'Primary caller', alias_version: 1 },
          ],
          total: 1,
        })],
        [(url) => url.pathname.endsWith('/management/client-key-usage'), () => ({
          window: { from: Date.now() - 86_400_000, to: Date.now() },
          usage: [{ key_fingerprint: 'ufp-1', requests: 1284, failed: 3, total_tokens: 918_000, last_used_ms: Date.now() - 60_000 }],
        })],
        [(url) => url.pathname.endsWith('/management/config'), () => ({ scalars: {}, supported_keys: [], revision: 'fixture-r1', safe_yaml: 'access:\n  api-keys:\n    - omc-fixture-key-aaaaaaaaaaaaaaaa\n' })],
        [(url) => url.pathname.endsWith('/usage/facets'), () => alignmentFacets],
        [(url) => url.pathname.includes('/usage/events'), () => ({ items: interactionRecords, has_more: false, limit: 100 })],
        [(url) => url.pathname.endsWith('/usage/ingest-status'), () => ({ enabled: true, healthy: true, collector: { mode: 'http_pull', captured: 500, coverage_gaps: 0 }, stats: { pending: 0 } })],
      ],
    },
    run: touchErgonomics,
  },
  /**
   * A list at a phone width, and the same list at a desktop width.
   *
   * The scenario owns its viewport changes rather than being run twice, because the claim is the
   * *pairing*: a response to width, not one layout that happens to exist. Its fixtures are the
   * list surfaces the phone rendering was measured for (ADR 0012), each one a row in the probe's
   * own table.
   */
  {
    id: 'phone-lists',
    name: 'a list renders rows on a phone and a table on a desktop',
    options: {
      viewport: { width: 1440, height: 900 },
      routes: [
        [(url) => url.pathname.endsWith('/management/api-keys'), () => ({
          keys: [
            { index: 0, key: 'omc-fixture-key-aaaaaaaaaaaaaaaa', fingerprint: 'fp-1', usage_fingerprint: 'ufp-1', length: 30, alias: 'Primary caller', alias_version: 1 },
            { index: 1, key: 'omc-fixture-key-bbbbbbbbbbbbbbbb', fingerprint: 'fp-2', usage_fingerprint: 'ufp-2', length: 30, alias_version: 0 },
          ],
          total: 2,
        })],
        [(url) => url.pathname.endsWith('/management/client-key-usage'), () => ({
          window: { from: Date.now() - 86_400_000, to: Date.now() },
          usage: [
            { key_fingerprint: 'ufp-1', requests: 1284, failed: 3, total_tokens: 918_000, last_used_ms: Date.now() - 60_000 },
            { key_fingerprint: 'ufp-2', requests: 12, failed: 0, total_tokens: 4_000, last_used_ms: Date.now() - 3_600_000 },
          ],
        })],
        [(url) => url.pathname.endsWith('/management/config'), () => ({
          scalars: {},
          supported_keys: [],
          revision: 'fixture-r1',
          safe_yaml: 'access:\n  api-keys:\n    - omc-fixture-key-aaaaaaaaaaaaaaaa\n    - omc-fixture-key-bbbbbbbbbbbbbbbb\n',
        })],
        [(url) => url.pathname.endsWith('/management/providers'), () => ({
          providers: [
            pickerProvider,
            {
              id: 'claude-0',
              family: 'claude',
              name: 'Claude relay',
              protocol: 'Anthropic Messages',
              base_url: 'https://relay.example.test',
              disabled: true,
              key_configured: true,
              models: [],
            },
          ],
          total: 2,
        })],
        ...pricingFixtures([]),
        [(url) => url.pathname.endsWith('/management/request-error-logs'), () => ({
          files: [
            { name: 'errors-2026-09-19.log', size: 262144, modified: Math.floor(Date.now() / 1000) - 600 },
            { name: 'errors-2026-09-18.log', size: 1048576, modified: Math.floor(Date.now() / 1000) - 86_400 },
          ],
        })],
        [(url) => url.pathname.endsWith('/management/logs'), () => ({ lines: [], latest_after: 0, next_cursor: '', cursor_reset: false, limit: 2000 })],
        [(url) => url.pathname.endsWith('/management/logs/status'), () => ({ logging_to_file: true, request_log: false })],
      ],
    },
    run: phoneListRendering,
  },
  {
    id: 'pricing-book',
    name: 'the provider-grouped price book paginates models and edits prices in place',
    options: { routes: pricingFixtures(pricingBookWrites) },
    run: (context) => pricingBook({ ...context, writes: pricingBookWrites }),
  },
  {
    id: 'pricing-request-list',
    name: 'an unpriced request prices its model without opening the record',
    options: {
      routes: [
        ...pricingFixtures([]),
        [(url) => url.pathname.endsWith('/usage/facets'), () => alignmentFacets],
        [(url) => url.pathname.includes('/usage/events'), () => ({ items: interactionRecords, has_more: false, limit: 100 })],
        [
          (url) => url.pathname.endsWith('/usage/ingest-status'),
          () => ({ enabled: true, healthy: true, collector: { mode: 'http_pull', captured: 500, coverage_gaps: 0 }, stats: { pending: 0 } }),
        ],
      ],
    },
    run: (context) => pricingFromRequestList({ ...context, writes: [] }),
  },
  {
    id: 'request-list-interactions',
    name: 'request list interactions',
    options: {
      routes: [
        ...systemFixtures(),
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
  {
    id: 'scroll-smoothing',
    name: 'a wheel notch glides on an ordinary scroller and on the virtualized request list, as the preference says',
    options: {
      viewport: { width: 1280, height: 560 },
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
    run: scrollSmoothing,
  },
  {
    id: 'request-list-touch',
    name: 'on a phone the request list is the only scroller, and a finger folds and unfolds its header',
    options: {
      // A phone short enough that the unfolded header leaves the list less than half the screen.
      viewport: { width: 390, height: 664 },
      hasTouch: true,
      routes: [
        [(url) => url.pathname.endsWith('/usage/facets'), () => alignmentFacets],
        [
          (url) => url.pathname.includes('/usage/events'),
          () => ({ items: interactionRecords, has_more: false, limit: 100 }),
        ],
      ],
    },
    run: requestListTouch,
  },
  {
    id: 'plugin-management',
    name: 'plugin management shows store cards with their artwork and links, gates a third-party install, and edits declared fields as typed controls',
    options: { routes: pluginManagementFixtures(pluginManagementWrites) },
    run: (context) => pluginManagement({ ...context, writes: pluginManagementWrites }),
  },
  {
    id: 'plugin-management-narrow',
    name: 'the plugin page fits a phone on every tab',
    options: { routes: pluginManagementFixtures([]), viewport: { width: 375, height: 812 } },
    run: pluginManagementNarrow,
  },
  {
    id: 'logs-sources',
    name: 'the logs page keeps the gateway and service sources apart, and sends an old audit link to the audit page',
    options: { routes: logsFixtures([]) },
    run: logsSources,
  },
  {
    id: 'audit-trail',
    name: 'the audit page lists the trail as sentences on the shared list surface, opens an entry in a drawer, counts it from the summary and filters on the server',
    options: { routes: logsFixtures(auditRequests) },
    run: (context) => auditTrail({ ...context, auditRequests }),
  },
  {
    id: 'audit-trail-narrow',
    name: 'the audit trail reads as one tappable row per entry on a phone',
    options: { routes: logsFixtures([]), viewport: { width: 360, height: 800 } },
    run: auditTrailNarrow,
  },
  {
    id: 'system-information',
    name: 'the system page renders untrusted release notes without reaching outside the origin',
    options: {
      routes: systemFixtures(),
    },
    run: systemInformationPage,
  },
  {
    // A 320px screen, because the page's defects appeared there and at no wider size. The
    // failure was an overlap rather than an overflow: the card title and its action drew on
    // top of each other, and the product title was covered by its status tag. Measuring widths
    // reported the layout as clean, so the assertion has to compare geometry instead.
    id: 'system-information-narrow',
    name: 'the system page keeps its card heads and product rows from overlapping at 320px',
    options: {
      routes: systemFixtures(),
      viewport: { width: 320, height: 1200 },
    },
    run: systemInformationNarrow,
  },
  {
    id: 'config-source-editor',
    name: "the YAML source editor's find box is drawn with its loaded icon font",
    options: { routes: configSourceFixtures() },
    run: configSourceEditor,
  },
];
