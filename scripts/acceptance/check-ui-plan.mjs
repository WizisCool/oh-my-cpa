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
  'dashboard-model-panels',
  'dashboard-model-panels-states',
  'dashboard-model-panels-failure',
  'dashboard-model-panels-empty',
  'dashboard-heatmap',
  'dashboard-heatmap-mobile',
  'dashboard-heatmap-pruned',
  'dashboard-heatmap-error',
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
  // The provider console and its icon picker: the drawer/modal stacking assertion
  // is about those two overlays specifically.
  {
    prefix: 'web/src/components/IconPickerModal',
    scenarios: ['icon-picker-stacking'],
  },
  {
    prefix: 'web/src/pages/ProvidersPage',
    scenarios: ['icon-picker-stacking'],
  },
  // The dashboard: the sparkline marks its tiles draw and the daily-token calendar
  // beneath them. Both live on this page, and the page is what the scenarios load,
  // so a page change can move either one.
  {
    prefix: 'web/src/pages/DashboardPage',
    scenarios: DASHBOARD_SCENARIOS,
  },
  {
    prefix: 'web/src/charts/',
    scenarios: ['dashboard-charts'],
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
    scenarios: ['omc-settings', 'dashboard-charts', 'dashboard-model-panels', 'dashboard-model-panels-states', 'dashboard-model-panels-failure', 'dashboard-model-panels-empty'],
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
  'scripts/acceptance/check-ui-plan.mjs',
  'scripts/browser-probes.mjs',
  'scripts/check-ui.mjs',
];

export function isProbeFramework(file) {
  return PROBE_FRAMEWORK.includes(file);
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
