/**
 * The request-to-dataset map.
 *
 * The console asks for a window by name - `preset=24h` - while the exported dataset
 * holds closed windows captured on a fixed instant. This module is the translation
 * between them, and it is deliberately explicit: every entry names the console surface
 * it serves, so a read that has no entry is a visible gap rather than a silent 404 on
 * a page somebody is looking at.
 *
 * The dataset itself is imported rather than fetched. It is generated, it is small
 * (around 400 KB) and it is the same for every request, so reading it at start-up of
 * the isolate costs less than any alternative and removes a moving part.
 */
import dataset from './data/responses.json' with { type: 'json' };

export const DATASET = dataset;

/** The instant the dataset's history is anchored to. */
export const REFERENCE_MS = dataset.reference_ms;

/**
 * Dashboard presets, which the console offers as a picker and the dataset holds as one
 * captured window each.
 */
const PRESETS = new Set(['15m', '1h', '6h', '24h', '7d', '30d', '90d']);

/** The preset a request is asking for, defaulting to the console's own default. */
export function presetOf(url) {
  const preset = (url.searchParams.get('preset') ?? '24h').toLowerCase();
  return PRESETS.has(preset) ? preset : '24h';
}

/**
 * Routes that take no parameter, mapped from their path.
 *
 * A route whose answer does not depend on the query is served from a fixed name, which
 * keeps this table readable and means a request with an unexpected parameter still
 * gets the surface's data rather than a 404.
 */
const FIXED_ROUTES = new Map([
  ['/api/v1/resources', 'resources'],
  ['/api/v1/preferences', 'preferences'],
  ['/api/v1/pricing', 'pricing'],
  ['/api/v1/management/overview', 'overview'],
  ['/api/v1/management/system', 'system'],
  ['/api/v1/management/system/releases', 'system-releases'],
  ['/api/v1/management/system/maintenance', 'system-maintenance'],
  ['/api/v1/management/config', 'config'],
  ['/api/v1/management/config/source', 'config-source'],
  ['/api/v1/management/providers', 'providers'],
  ['/api/v1/management/api-keys', 'api-keys'],
  ['/api/v1/management/client-key-aliases', 'client-key-aliases'],
  ['/api/v1/management/plugins', 'plugins'],
  ['/api/v1/management/plugin-store', 'plugin-store'],
  ['/api/v1/management/auth-files', 'auth-files'],
  ['/api/v1/management/auth-files/model-aliases', 'auth-files-model-aliases'],
  ['/api/v1/management/oauth/providers', 'oauth-providers'],
  ['/api/v1/management/quota', 'quota'],
  ['/api/v1/management/logs/status', 'logs-status'],
  ['/api/v1/management/request-error-logs', 'request-error-logs'],
  ['/api/v1/management/audit/events', 'audit-events'],
  ['/api/v1/management/audit/export', 'audit-export'],
  ['/api/v1/usage/ingest-status', 'usage-ingest-status'],
  ['/api/v1/usage/facets', 'usage-facets'],
  ['/api/v1/usage/events', 'usage-events'],
  // The session endpoint sits under `/api/auth`, NOT under `/api/v1`: the console
  // builds it from its own auth root. Getting this wrong left every page on the login
  // card, because the console never learns it is signed in and renders the sign-in
  // view instead of the console - which is exactly the failure mode a missing session
  // has.
  ['/api/auth/session', 'session'],
  // The health check, which the console's header reads for `cpa_connected` to decide
  // whether it reports the gateway as reachable. It was answered by a hardcoded response
  // in the Worker first, which is why it went missing here: the hand-written answer hid
  // the fact that this table had no entry for it, and the header then read a body without
  // the field it needed.
  ['/api/healthz', 'healthz'],
]);

/**
 * Routes whose answer depends on which window the console is showing.
 *
 * They are checked before the fixed table because their paths are distinct, and the
 * name they produce carries the preset: `dashboard-7d` is a different captured window
 * from `dashboard-24h`, not the same response relabelled.
 */
const PRESET_ROUTES = new Map([
  ['/api/v1/management/dashboard', (preset) => `dashboard-${preset}`],
  ['/api/v1/management/dashboard/tail', (preset) => `dashboard-tail-${preset}`],
  ['/api/v1/management/dashboard/providers', (preset) => `dashboard-providers-${preset}`],
  ['/api/v1/management/client-key-usage', (preset) => `client-key-usage-${preset}`],
]);

/** Routes that take a parameter the console chooses, with the value it sends. */
const PARAMETERISED_ROUTES = [
  // The heatmap answers in the viewer's own zone, so the timezone is part of the ask.
  // The dataset holds a UTC and a non-UTC capture; anything else is answered from UTC,
  // which is the same calendar for most viewers and never wrong about the totals.
  {
    path: '/api/v1/management/dashboard/token-heatmap',
    resolve: (url) =>
      (url.searchParams.get('tz') ?? 'UTC').toUpperCase() === 'UTC'
        ? 'dashboard-token-heatmap-utc'
        : 'dashboard-token-heatmap-kuala-lumpur',
  },
  {
    path: '/api/v1/management/dashboard/models',
    resolve: (url) => {
      const preset = presetOf(url);
      const grouping = url.searchParams.get('group_by') === 'model' ? 'model' : 'call';
      return `dashboard-models-${grouping}-${preset}`;
    },
  },
  // One credential's model list. The dataset captured the console's own picker, and
  // the answer is the same for every credential because the fixture lists one model
  // set per provider family.
  { path: '/api/v1/management/auth-files/models', resolve: () => 'auth-files-models' },
  { path: '/api/v1/management/capabilities/oauth', resolve: () => 'capabilities-oauth' },
  { path: '/api/v1/management/oauth/status', resolve: () => 'oauth-status' },
  { path: '/api/v1/management/logs', resolve: () => 'logs' },
  { path: '/api/v1/management/quota/auth-codex-01', resolve: () => 'quota-codex' },
  { path: '/api/v1/usage/events/13574', resolve: () => 'usage-event-detail' },
];

/**
 * The dataset entry that answers a request, or undefined when nothing does.
 *
 * The query is read for the parameters that actually select a response - the preset,
 * the grouping and the timezone - and ignored otherwise, because the console sends
 * filters that the captured windows already account for.
 */
export function responseNameFor(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  const byPreset = PRESET_ROUTES.get(path);
  if (byPreset) return byPreset(presetOf(url));

  const parameterised = PARAMETERISED_ROUTES.find((route) => route.path === path);
  if (parameterised) return parameterised.resolve(url);

  return FIXED_ROUTES.get(path);
}
