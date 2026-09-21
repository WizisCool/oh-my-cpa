/**
 * Which probe scenarios a working-tree change can affect.
 *
 * The fast path's value depends entirely on this being **conservative**: a plan that
 * silently omits a scenario is a green run that verified nothing, which is worse than
 * a slow one. So the rules are a small explicit map rather than a dependency graph,
 * and two properties are structural rather than per-file:
 *
 *   - A path that touches the shell or the shared layer selects **every** scenario.
 *     Those files are imported by every page, so narrowing their blast radius would
 *     be a guess.
 *   - A frontend path no rule recognises **widens** the plan rather than selecting
 *     nothing. An unrecognised file is not evidence of no impact.
 *
 * Backend-only and documentation-only changes select no scenario at all. That is the
 * one case where the empty plan is correct: the dev server serves the SPA against
 * mocked routes, so a Go change or a Markdown edit cannot alter what the browser
 * probes observe. `check:ui` reports the widening explicitly in every other case.
 */

/**
 * Files that every scenario depends on. A change here means the plan is "all of
 * them": `App.tsx` and the layout render on every route, the theme and global
 * stylesheet paint every page, and the API client is the only way any of them talks
 * to a server.
 */
const SHELL_PATHS = [
  'web/src/App.tsx',
  'web/src/main.tsx',
  'web/src/index.css',
  'web/src/api/client.ts',
  'web/src/i18n/index.tsx',
  'web/src/components/common/',
  'web/src/theme/',
];

/**
 * Everything the dashboard page renders, which is what a change to it can move.
 *
 * Named once rather than repeated per rule: the page hosts all of these panels, and a
 * rule that listed only some of them would let a change pass with the panel it broke
 * unverified.
 */
const DASHBOARD_SCENARIOS = [
  'dashboard-charts',
  'dashboard-chart-motion',
  'dashboard-rolling-readouts',
  'dashboard-model-panels',
  'dashboard-model-panels-states',
  'dashboard-model-panels-failure',
  'dashboard-model-panels-empty',
  'dashboard-heatmap',
  'dashboard-heatmap-mobile',
  'dashboard-heatmap-pruned',
  'dashboard-heatmap-error',
  'provider-rate-marks',
];

/**
 * A source path maps to the scenarios it can affect.
 *
 * The order matters: the first entry whose prefix matches wins, so a more specific
 * path must be listed before a broader one. Matching is by path prefix, so a whole
 * directory can be named without listing its files.
 */
const SCENARIO_PATHS = [
  // The request-records page, its row/column rendering and its stylesheet. Column
  // geometry, the virtualized list, the refresh sequence and the search box all live
  // in this one page, so they move together.
  {
    prefix: 'web/src/components/usage/requestColumns',
    scenarios: ['column-alignment', 'request-list-interactions'],
  },
  {
    prefix: 'web/src/components/usage/',
    scenarios: [
      'column-alignment',
      'refresh-sequencing',
      'search-dev-server',
      'request-list-interactions',
      'overlay-back',
    ],
  },
  {
    prefix: 'web/src/pages/UsageEventsPage',
    scenarios: [
      'column-alignment',
      'refresh-sequencing',
      'search-dev-server',
      'request-list-interactions',
    ],
  },
  // The system page renders a release's Markdown body, which is untrusted remote text. The
  // scenario that belongs to it asserts the two things only an engine can: that no element or
  // inline handler from the body is executed, and that the page fetches nothing from a host the
  // body names. A change to the page, or to the Markdown renderer it imports, moves that claim.
  {
    prefix: 'web/src/pages/SystemPage',
    scenarios: ['system-information', 'system-information-narrow'],
  },
  // The overlay history layer and everything it is wired into. Named as one rule because the
  // claim is about the layer plus a representative overlay of each kind: the navigation sheet
  // from the shell, the request detail and filter drawers from the request list, and the
  // provider editor. A change to the hook itself moves all of them.
  {
    prefix: 'web/src/hooks/useOverlayHistory',
    scenarios: ['overlay-back'],
  },
  {
    prefix: 'web/src/hooks/overlayHistory',
    scenarios: ['overlay-back'],
  },
  // The console's global stylesheet is already a shared path, and the touch rules live in it, so
  // any change to the shell selects the touch scenario too. Named here rather than folded into
  // SHELL_PATHS because it is about the rules those files carry, not about every scenario.
  {
    prefix: 'web/src/hooks/useIsPhoneViewport',
    scenarios: ['phone-lists', 'touch-ergonomics'],
  },
  {
    prefix: 'web/src/components/common/PhoneRow',
    scenarios: ['phone-lists', 'touch-ergonomics'],
  },
  // The list surfaces whose phone rendering ADR 0012 introduced, and the shared pieces that
  // rendering is derived from: a change to either reaches every one of them.
  {
    prefix: 'web/src/components/common/phoneRowFields',
    scenarios: ['phone-lists'],
  },
  {
    prefix: 'web/src/components/keys/',
    scenarios: ['phone-lists'],
  },
  // The provider console and its icon picker: the drawer/modal stacking assertion
  // is about those two overlays specifically, picking a mark from the picker is the
  // page's own write path, and the table is where the phone rendering lives (ADR 0012).
  // A rule that named only the first two would let a change to the provider phone row
  // run no scenario that covers it - which is the silent omission this planner exists to
  // prevent, and the reason its own test pins this mapping.
  {
    prefix: 'web/src/components/IconPickerModal',
    scenarios: ['icon-picker-stacking', 'provider-icon-pick'],
  },
  {
    prefix: 'web/src/pages/ProvidersPage',
    scenarios: ['icon-picker-stacking', 'provider-icon-pick', 'phone-lists', 'overlay-back'],
  },
  // The provider console's own modules: the list table, the editor drawer, the
  // writes and the icon overlay. The page renders nothing but these, so a change
  // to any of them reaches exactly what a change to the page reaches - and the
  // drawer is one of the two overlays the stacking assertion is about.
  {
    prefix: 'web/src/components/providers/',
    scenarios: ['icon-picker-stacking', 'provider-icon-pick', 'phone-lists', 'overlay-back'],
  },
  // The remaining list surfaces ADR 0012 converted. Each renders rows on a phone and a table
  // otherwise, and `phone-lists` is the scenario that reads both renderings of each; without a
  // rule they fall through to "an unrecognised frontend path widens the plan", which is safe but
  // runs all 21 scenarios for a one-line change to a page a single scenario covers.
  {
    prefix: 'web/src/pages/PluginsPage',
    scenarios: ['phone-lists'],
  },
  {
    prefix: 'web/src/pages/PluginStorePage',
    scenarios: ['phone-lists'],
  },
  {
    prefix: 'web/src/pages/pricing/',
    scenarios: ['phone-lists'],
  },
  {
    prefix: 'web/src/pages/LogsPage',
    scenarios: ['phone-lists'],
  },
  {
    prefix: 'web/src/pages/CapabilityPlaceholderPage',
    scenarios: ['phone-lists'],
  },
  // The dashboard: the sparkline marks its tiles draw and the daily-token calendar
  // beneath them. Both live on this page, and the page is what the scenarios load,
  // so a page change can move either one.
  {
    prefix: 'web/src/pages/DashboardPage',
    scenarios: DASHBOARD_SCENARIOS,
  },
  {
    prefix: 'web/src/charts/chartMotion',
    scenarios: ['dashboard-charts', 'dashboard-chart-motion'],
  },
  {
    prefix: 'web/src/hooks/usePrefersReducedMotion',
    scenarios: DASHBOARD_SCENARIOS,
  },
  {
    prefix: 'web/src/charts/',
    // Every scenario that reads a mark's paint: the KPI tiles' sparkline, the model panels' trend and
    // ring - whose chrome ink is asserted in both themes - and the marks' shared palette. A chart file
    // that only one panel imports still selects both, because which file a mark's ink comes from is not
    // something this planner can see; over-selecting is the side this file is required to err on.
    scenarios: ['dashboard-charts', 'dashboard-model-panels'],
  },
  // The dashboard's own panels. Both scenarios read the page, so a panel change
  // reaches both: the heatmap is a sibling of the tiles, not a child of a chart.
  {
    prefix: 'web/src/components/dashboard/',
    scenarios: DASHBOARD_SCENARIOS,
  },
  {
    prefix: 'web/src/types/tokenHeatmap',
    scenarios: ['dashboard-heatmap', 'dashboard-heatmap-mobile', 'dashboard-heatmap-pruned', 'dashboard-heatmap-error'],
  },
  // The OMC settings page and the preference layer behind it. The page is what the scenario loads,
  // so a change to the page, its controls or the shared token-display layer reaches it; the token
  // layer and the preference hook also govern the dashboard's own readouts, which is why the
  // dashboard's model panels and the OMC page move together.
  {
    prefix: 'web/src/pages/OmcSettingsPage',
    scenarios: ['omc-settings'],
  },
  {
    prefix: 'web/src/types/tokenDisplay',
    // Every scenario that renders a surface reading this layer: the OMC page that owns the setting,
    // the dashboard's KPI charts, both model panels, the token activity grid (across its four
    // fixtures), and the request list with its detail drawer, whose row and breakdown both print
    // token counts through it. The rule exists so a change to the unit style cannot land with a
    // surface that renders it left unverified, and a half-listed rule is the silent omission this
    // planner treats as a green run that proved nothing - so the grid and the request list belong
    // here exactly as the panels do.
    scenarios: [
      ...DASHBOARD_SCENARIOS,
      'omc-settings', 'column-alignment', 'request-list-interactions',
    ],
  },
  {
    // The animated shape of a reading: the contract every readout on the dashboard's KPI tiles is
    // built from. Only those tiles construct one, so the dashboard scenarios and the OMC settings
    // scenario - which reads the same tiles back when it asserts the unit style they print in - are
    // what a change here can reach.
    prefix: 'web/src/types/rollingNumber',
    scenarios: ['omc-settings', ...DASHBOARD_SCENARIOS],
  },
  {
    prefix: 'web/src/hooks/usePreference',
    scenarios: ['omc-settings', 'dashboard-model-panels-states', 'dashboard-heatmap', 'column-alignment', 'request-list-interactions'],
  },
];

/**
 * Whether a path is frontend source the planner is expected to understand.
 *
 * Anything under `web/src` that no rule places widens the plan: the whole point of
 * this function is to distinguish "no impact" from "not yet classified", and only the
 * former may select nothing.
 */
const FRONTEND_SOURCE = 'web/src/';

/**
 * The probe framework itself.
 *
 * A change here can invalidate any scenario's result - the runner owns the browser,
 * the contexts and the mock - and it previously selected *nothing*, because no rule
 * placed a `scripts/` path and `isBrowserRelevant` only looks at `web/src`. That is
 * the same hole `verify:fast` had for test suites: the code that decides whether the
 * checks are meaningful was itself unchecked. A change to any of these widens the
 * plan to every scenario.
 */
const PROBE_FRAMEWORK = [
  'scripts/acceptance/probe.mjs',
  'scripts/acceptance/scenarios.mjs',
  // The scenario implementations. They are the claims themselves rather than the
  // runner, but a change to one of them is exactly as unplaceable as a change to
  // the registry that orders them: the planner cannot tell from a filename which
  // scenario a helper two files away is shared with. Enumerating the modules would
  // also mean a new module silently selecting nothing until someone remembered to
  // list it, which is the failure this whole function exists to prevent.
  'scripts/acceptance/probes/',
  'scripts/acceptance/check-ui-plan.mjs',
  'scripts/browser-probes.mjs',
  'scripts/check-ui.mjs',
];

export function isProbeFramework(file) {
  // Prefixes rather than exact paths, so a directory can be named once and a module
  // added to it stays covered. A file the list names exactly is matched by the same
  // rule.
  return PROBE_FRAMEWORK.some((prefix) => file.startsWith(prefix));
}

export function isFrontendSource(file) {
  return file.startsWith(FRONTEND_SOURCE);
}

export function isShellPath(file) {
  return SHELL_PATHS.some((prefix) => file.startsWith(prefix));
}

/** Whether a change can affect what a browser probe observes. */
export function isBrowserRelevant(file) {
  if (!isFrontendSource(file)) return false;
  // A stylesheet under a rule's directory is covered by that rule; one outside any
  // rule widens, which `planScenarios` handles by falling through to "all".
  return true;
}

/**
 * planScenarios maps changed paths to the scenarios worth running.
 *
 * It returns the scenario ids in registry order, plus the reason the plan is as wide
 * as it is, so a caller can say *why* rather than only *what*. `check:ui --plan`
 * prints exactly this.
 */
export function planScenarios(files, allIds) {
  if (files.length === 0) {
    return { ids: [], reasons: [{ kind: 'none', detail: 'no changed files' }] };
  }

  const selected = new Set();
  const reasons = [];

  // The harness is checked before anything else: a change to how scenarios are run,
  // listed or selected makes every scenario's result suspect, including the ones the
  // path rules would narrow away.
  const framework = files.filter(isProbeFramework);
  if (framework.length > 0) {
    return {
      ids: [...allIds],
      reason: `the probe framework changed (${framework.join(', ')})`,
      reasons: [{ kind: 'all', detail: `probe framework changed: ${framework.join(', ')}` }],
    };
  }

  const relevant = files.filter(isBrowserRelevant);
  if (relevant.length === 0) {
    return {
      ids: [],
      reason: 'no frontend source changed',
      reasons: [{ kind: 'none', detail: 'no frontend source changed' }],
    };
  }

  // The shell widens the plan to everything, and that decision is recorded once
  // rather than per file: the answer is the same for each of them.
  const shell = relevant.filter(isShellPath);
  if (shell.length > 0) {
    return {
      ids: [...allIds],
      reason: `shared layer changed (${shell.join(', ')})`,
      reasons: [{ kind: 'all', detail: `shared layer changed: ${shell.join(', ')}` }],
    };
  }

  const unplaced = [];
  for (const file of relevant) {
    const rule = SCENARIO_PATHS.find((candidate) => file.startsWith(candidate.prefix));
    if (!rule) {
      unplaced.push(file);
      continue;
    }
    for (const id of rule.scenarios) selected.add(id);
    reasons.push({ kind: 'map', detail: `${file} -> ${rule.scenarios.join(', ')}` });
  }

  // An unplaced frontend path is not evidence of no impact. Widening here is the
  // whole reason `isBrowserRelevant` and the shell list are separate questions.
  if (unplaced.length > 0) {
    return {
      ids: [...allIds],
      reason: `unrecognised frontend source widened the plan (${unplaced.join(', ')})`,
      reasons: [
        ...reasons,
        { kind: 'all', detail: `unrecognised frontend source: ${unplaced.join(', ')}` },
      ],
    };
  }

  return {
    ids: allIds.filter((id) => selected.has(id)),
    reason: 'matched by path',
    reasons,
  };
}
