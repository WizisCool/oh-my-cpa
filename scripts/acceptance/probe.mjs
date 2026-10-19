/**
 * Context-local API fixtures shared by the probe catalog. Scenario routes take
 * precedence over defaults, and undeclared reads/writes remain faults rather than
 * permissive success responses. Lifecycle and scheduling belong to Playwright Test.
 */
import { createPreferenceFixture } from './preferences-fixture.mjs';
import { createSystemUpdaterFixture } from './system-updater-fixture.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fulfillFixture } from './browser-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const probeRoot = root;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A well-formed dashboard body.
 *
 * Every route's shell reads the dashboard, so a scenario that does not care about it
 * still needs a valid response: returning `{}` crashes the page on `window.bucket_ms`
 * and takes the scenario's own assertion down with it, which is a failure that says
 * nothing about what the scenario was testing.
 *
 * `series` is overridable because the sparkline probe needs buckets that reach the
 * plot floor; an empty series is the right default for a scenario that never looks
 * at the tiles.
 */
export function dashboardBody(series = [], { bucketMS = 60_000, preset = '1h' } = {}) {
  const total = series.reduce((sum, point) => sum + point.v, 0);
  const tokens = series.reduce((sum, point) => sum + (point.tokens ?? 0), 0);
  const now = Date.now();
  return {
    window: {
      preset,
      from: now - 60 * bucketMS,
      to: now,
      bucket_ms: bucketMS,
      minutes: 60,
      complete: true,
      open_end: false,
    },
    requests: { total, success: total, failed: 0, success_rate: total > 0 ? 100 : null, series },
    tokens: {
      total: tokens,
      input: tokens,
      output: 0,
      reasoning: 0,
      cached: 0,
      cache_read: 0,
      cache_creation: 0,
      series,
    },
    metrics: { rpm: 0, tpm: 0, cache_rate: 0, cost: 0, cost_source: 'none', cost_note: '', avg_latency_ms: 0, avg_ttft_ms: 0 },
    coverage: { rollup_requests: 0, detail_requests: 0, pending_inbox: 0, has_usage: false },
    partial_errors: [],
  };
}

/**
 * The API surface every probe mocks, as a table of `[matches, respond]`.
 *
 * Probes compose this with their own responses rather than restating the session,
 * preference and health endpoints each time.
 *
 * The preferences document is stateful rather than always empty, because a probe that
 * asserts a setting survives a write needs the mock to remember it. A store per
 * `installRoutes` call keeps the state inside one scenario's context, which is where
 * the isolation lives: a write in one scenario cannot be read by another.
 */
/** A product whose releases have not been read, which draws no update indicator. */
function uncheckedVersion(product) {
  return {
    product, running_version: 'probe', latest_version: '', state: 'indeterminate', reason: 'not_checked_yet',
    repository: '', repository_url: '', checked_at_ms: null, attempted_at_ms: null, check_error: '', checking: false,
    merge_count: 0, range_complete: true, notes_available: false,
  };
}

export function defaultRoutes() {
  const respondPreference = createPreferenceFixture();
  return [
    [(url, method) => method === 'GET' && url.pathname.endsWith('/api/auth/session'), () => ({ authenticated: true })],
    [
      (url, method) => url.pathname.endsWith('/preferences') && method === 'GET',
      (url, method) => respondPreference(url, method),
    ],
    [
      (url, method) => url.pathname.includes('/preferences/') && method === 'PUT',
      (url, method, request) => respondPreference(url, method, request.postData()),
    ],

    // The live usage stream answers as a deployment without a collector does, so
    // every reader falls back to its poll and a scenario's fixtures stay the only
    // source of records. A probe about the stream itself declares its own entry.
    [(url, method) => method === 'GET' && url.pathname === '/omc/api/v1/usage/live', () => ({ status: 204, json: undefined })],
    // The dashboard's live routing panel: a quiet gateway, unless a scenario says otherwise.
    [(url, method) => method === 'GET' && url.pathname === '/omc/api/v1/usage/routing', () => ({
      as_of_ms: Date.now(), window_ms: 60_000, records: [], has_more: false, cooldowns: [],
    })],
    [(url, method) => method === 'GET' && url.pathname === '/omc/api/v1/management/config', () => ({ scalars: {} })],
    [(url, method) => method === 'GET' && url.pathname.endsWith('/custom-icons'), () => ({ icons: [] })],
    [(url, method) => method === 'GET' && url.pathname.endsWith('/api/v1/fonts'), () => ({ fonts: [] })],
    [(url, method) => method === 'GET' && url.pathname.endsWith('/management/auth-files'), () => ({ files: [], total: 0 })],
    [(url, method) => method === 'GET' && url.pathname.endsWith('/management/quota'), () => ({ summary: { total_credentials: 0, healthy_count: 0, warning_count: 0, exhausted_count: 0, cooldown_count: 0, attention_count: 0 }, quotas: [], total: 0 })],
    [(url, method) => method === 'GET' && url.pathname.endsWith('/management/providers'), () => ({ providers: [], total: 0 })],
    [(url, method) => method === 'GET' && url.pathname.endsWith('/health'), () => ({ cpa_connected: true, version: 'probe', status: 'ok' })],
    [(url, method) => method === 'GET' && url.pathname === '/omc/api/healthz', () => ({ cpa_connected: true, version: 'probe', status: 'ok' })],
    [(url, method) => method === 'GET' && url.pathname === '/omc/api/v1/management/plugins', () => ({ plugins: [], total: 0 })],
    [(url, method) => method === 'GET' && url.pathname === '/omc/api/v1/management/system/repository', () => ({ stargazers_count: null })],
    [(url, method) => method === 'GET' && url.pathname === '/omc/api/v1/management/system/updates', () => ({ omc_version: uncheckedVersion('omc'), cpa_version: uncheckedVersion('cpa') })],
    // A native install: the state in which the page draws nothing about updating, so scenarios
    // that are not about it see the page they were written against.
    [(url, method) => method === 'GET' && url.pathname === '/omc/api/v1/management/system/updater', (url, method) => createSystemUpdaterFixture({ state: 'not_containerised' })(url, method).json],
    [(url, method) => method === 'GET' && url.pathname === '/omc/api/v1/management/api-keys', () => ({ keys: [], total: 0 })],
    [(url, method) => method === 'GET' && url.pathname === '/omc/api/v1/pricing/attention', () => ({ unpriced: [] })],
    [(url, method) => method === 'GET' && url.pathname === '/omc/api/v1/management/dashboard/models', () => ({ window: dashboardBody().window, total_tokens: 0, models: [], partial_errors: [] })],
    [(url, method) => method === 'GET' && url.pathname === '/omc/api/v1/management/dashboard/providers', () => ({ window: dashboardBody().window, providers: [], partial_errors: [] })],
    // The shell every route mounts reads these, so they are defaults rather than
    // per-scenario fixtures.
    [(url, method) => method === 'GET' && url.pathname.endsWith('/dashboard'), () => dashboardBody()],
    [(url, method) => method === 'GET' && url.pathname.endsWith('/dashboard/tail'), () => dashboardBody()],
    [
      (url, method) => method === 'GET' && url.pathname.endsWith('/management/overview'),
      () => ({
        cpa: { connected: true, version: 'probe', latency_ms: 1 },
        counts: { management_keys: 1, provider_keys: 0, credentials: 0, models: 0 },
        providers: [],
        credentials: { total: 0, active: 0, disabled: 0, unavailable: 0, by_type: [] },
        traffic: {
          bucket_minutes: 10,
          window_minutes: 60,
          buckets: [],
          total_success: 0,
          total_failure: 0,
          total: 0,
          success_rate: null,
        },
        partial_errors: [],
      }),
    ],
  ];
}

/**
 * Installs the API mock for one context.
 *
 * `extra` is checked before the defaults, so a scenario expresses only what it
 * changes. One dispatcher checks scenario entries first and shared defaults last,
 * so a default cannot override a scenario's method-specific response.
 */
export async function installRoutes(context, extra = [], ledger) {
  const table = [...extra, ...defaultRoutes()];
  await context.route('**/omc/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    for (const [matches, respond] of table) {
      if ((matches.length < 2 && method !== 'GET') || !matches(url, method)) continue;
      const body = await respond(url, method, request);
      // A scenario that needs to prove something about a failing request returns a
      // `{ status, json }` envelope; everything else is a successful body. Without an
      // error path a scenario could only assert the happy state, which is how a panel
      // that hangs on a first-load failure goes unnoticed.
      if (body && typeof body === 'object' && typeof body.status === 'number' && 'json' in body) {
        return fulfillFixture(route, { status: body.status, json: body.json, ...(body.headers ? { headers: body.headers } : {}) });
      }
      if (body?.contentType && typeof body.body === 'string') {
        return route.fulfill({ status: 200, contentType: body.contentType, body: body.body });
      }
      return route.fulfill({ status: 200, json: body });
    }
    ledger?.record({ kind: 'fixture', method, url: request.url(), message: 'Undeclared API fixture' });
    return route.fulfill({ status: 501, json: { error: 'undeclared_probe_fixture', method, path: url.pathname } });
  });
}
