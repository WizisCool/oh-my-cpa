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
import {
  providerRateMarks,
  providerRateOverview,
  providerRateProviders,
  providerRateTraffic,
} from './probes/providerRateMarks.mjs';
import { overlayBackDismisses } from './probes/overlayHistory.mjs';
import { phoneListRendering } from './probes/phoneLists.mjs';
import { touchErgonomics } from './probes/touchErgonomics.mjs';
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
          safe_yaml: 'api-keys:\\n  - omc-fixture-key-aaaaaaaaaaaaaaaa\\n',
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
           traffic: one of either produces no row at all. */
        [(url) => url.pathname.endsWith('/management/dashboard/providers'), () => ({
          window: { preset: '1h', from: Date.now() - 3_600_000, to: Date.now(), bucket_ms: 60_000 },
          providers: [
            { id: 'codex-api-key', total: 12, success: 12, failure: 0, success_rate: 1, buckets: [] },
          ],
          partial_errors: [],
        })],
        [(url) => url.pathname.endsWith('/management/overview'), () => ({
          cpa: { connected: true, version: 'probe', latency_ms: 1 },
          counts: { management_keys: 1, provider_keys: 1, credentials: 1, models: 1 },
          providers: [{
            id: 'codex-api-key',
            credentials: 1,
            success: 12,
            failure: 0,
            total: 12,
            success_rate: 1,
            buckets: [{ success: 12, failed: 0 }],
          }],
          credentials: { total: 1, active: 1, disabled: 0, unavailable: 0, by_type: [] },
          traffic: { bucket_minutes: 10, window_minutes: 60, buckets: [], total_success: 12, total_failure: 0, total: 12, success_rate: 1 },
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
        [(url) => url.pathname.endsWith('/management/config'), () => ({ scalars: {}, supported_keys: [], revision: 'fixture-r1', safe_yaml: 'api-keys:\n  - omc-fixture-key-aaaaaaaaaaaaaaaa\n' })],
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
          safe_yaml: 'api-keys:\n  - omc-fixture-key-aaaaaaaaaaaaaaaa\n  - omc-fixture-key-bbbbbbbbbbbbbbbb\n',
        })],
        [(url) => url.pathname.endsWith('/management/providers'), () => ({
          providers: [
            pickerProvider,
            {
              id: 'claude-api-key-0',
              family: 'claude-api-key',
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
        [(url) => url.pathname.endsWith('/management/plugins'), () => ({
          plugins: [
            {
              id: 'fixture-logger',
              name: 'Request Logger Plugin',
              version: '1.0.0',
              author: 'cpa-official',
              description: 'Audits and logs request metadata to internal store',
              permissions: ['read_request', 'write_log'],
              enabled: true,
              config: {},
            },
            {
              id: 'fixture-auth',
              name: 'iFlow Alliance Auth',
              version: '1.0.0',
              author: 'cpa-official',
              permissions: ['oauth'],
              enabled: false,
              config: {},
            },
          ],
        })],
        [(url) => url.pathname.endsWith('/management/pricing') || url.pathname.endsWith('/pricing'), () => ({
          source: 'models.dev',
          models: [
            {
              model: 'gpt-5-codex',
              prompt_price_per_1m: 1.25,
              completion_price_per_1m: 10,
              cache_read_price_per_1m: 0.125,
              cache_write_price_per_1m: 1.25,
              price_multiplier: 1,
              source: 'models.dev',
              synced_at_ms: Date.now() - 3_600_000,
              updated_at_ms: Date.now() - 3_600_000,
            },
            {
              model: 'claude-sonnet-4-5-20250929',
              prompt_price_per_1m: 3,
              completion_price_per_1m: 15,
              cache_read_price_per_1m: 0.3,
              cache_write_price_per_1m: 3.75,
              price_multiplier: 1.2,
              source: 'manual',
              synced_at_ms: 0,
              updated_at_ms: Date.now() - 7_200_000,
            },
          ],
          unpriced: ['vendor/unpriced-fixture-model'],
          sync: {
            known: true,
            running: false,
            state: {
              source: 'models.dev',
              last_error: '',
              last_matched: 2,
              last_unmatched: 1,
              last_success_at_ms: Date.now() - 3_600_000,
              updated_at_ms: Date.now() - 3_600_000,
              auto_sync_interval_hours: 24,
              next_sync_at_ms: Date.now() + 86_400_000,
            },
          },
        })],
        [(url) => url.pathname.endsWith('/management/request-error-logs'), () => ({
          files: [
            { name: 'errors-2026-09-19.log', size: 262144, modified: Math.floor(Date.now() / 1000) - 600 },
            { name: 'errors-2026-09-18.log', size: 1048576, modified: Math.floor(Date.now() / 1000) - 86_400 },
          ],
        })],
        [(url) => url.pathname.endsWith('/management/logs'), () => ({ lines: [], latest_after: 0, next_cursor: '', cursor_reset: false, limit: 2000 })],
        [(url) => url.pathname.endsWith('/management/logs/status'), () => ({ logging_to_file: true, request_log: false })],
        [(url) => url.pathname.endsWith('/management/plugin-store'), () => ({
          plugins: [
            {
              id: 'store-fixture',
              name: 'Store Fixture Plugin',
              version: '2.1.0',
              author: 'community',
              description: 'A plugin the store offers',
              permissions: ['read_request'],
              installed: false,
            },
          ],
        })],
      ],
    },
    run: phoneListRendering,
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
