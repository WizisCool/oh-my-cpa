/**
 * Which probe scenarios a working-tree change can affect.
 *
 * The fast path's value depends entirely on this being **conservative**: a plan that
 * silently omits a scenario is a green run that verified nothing, which is worse than
 * a slow one. So the rules are a small explicit map, refined only by evidence the
 * caller supplies (`ui-impact.mjs`: the runtime import graph and the translation
 * additions-only rule; `probe-impact.mjs`: which scenarios probe code belongs to).
 * Two properties are structural rather than per-file:
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
 * to a server. `web/index.html` is the document every route is loaded into: it names
 * the module entry and seeds `window.__OMCPA_CONFIG__` with the base path, so it sits
 * here rather than with the page it happens to look like.
 */
const SHELL_PATHS = [
  'web/index.html',
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

const AGENT_SCENARIOS = ['agent', 'agent-question', 'agent-live', 'agent-views', 'agent-failure', 'agent-stream', 'agent-narrow'];

/**
 * A source path maps to the scenarios it can affect.
 *
 * The order matters: the first entry whose prefix matches wins, so a more specific
 * path must be listed before a broader one. Matching is by path prefix, so a whole
 * directory can be named without listing its files.
 */
const SCENARIO_PATHS = [
  { prefix: 'web/src/pages/agent/', scenarios: AGENT_SCENARIOS },
  { prefix: 'web/src/pages/playground/', scenarios: ['playground', 'playground-narrow'] },
  // The run protocol, stream reader and exports: the Agent runs on all of it, and the Playground
  // reads its stream and writes its export with the same modules.
  { prefix: 'web/src/agent/', scenarios: [...AGENT_SCENARIOS, 'playground', 'playground-narrow'] },
  // The conversation frame both workspaces are composed from.
  { prefix: 'web/src/components/workspace/', scenarios: [...AGENT_SCENARIOS, 'playground', 'playground-narrow'] },
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
      'pricing-request-list',
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
    scenarios: ['icon-picker-stacking', 'provider-icon-pick', 'provider-model-picker', 'phone-lists', 'overlay-back'],
  },
  // The provider console's own modules: the list table, the editor drawer, the
  // writes and the icon overlay. The page renders nothing but these, so a change
  // to any of them reaches exactly what a change to the page reaches - and the
  // drawer is one of the two overlays the stacking assertion is about.
  {
    prefix: 'web/src/components/providers/',
    scenarios: ['icon-picker-stacking', 'provider-icon-pick', 'provider-model-picker', 'phone-lists', 'overlay-back'],
  },
  // The unified OAuth workspace owns its density, connection drawer, quota body,
  // task panels and phone reflow. Its scenario is the measured equivalent of the
  // three retired pages' UI claims; overlay-back covers the shared history layer.
  {
    prefix: 'web/src/pages/oauthManagement/',
    scenarios: ['oauth-management', 'overlay-back'],
  },
  {
    prefix: 'web/src/pages/oauthProviderLogic',
    scenarios: ['oauth-management', 'overlay-back'],
  },
  {
    prefix: 'web/src/pages/LegacyOAuthManagementRedirect',
    scenarios: ['oauth-management', 'overlay-back'],
  },
  {
    prefix: 'web/src/components/authFiles/',
    scenarios: ['oauth-management', 'overlay-back'],
  },
  {
    prefix: 'web/src/pages/quota/',
    scenarios: ['oauth-management', 'overlay-back'],
  },
  // The remaining list surfaces ADR 0012 converted. Each renders rows on a phone and a table
  // otherwise, and `phone-lists` is the scenario that reads both renderings of each; without a
  // rule they fall through to "an unrecognised frontend path widens the plan", which is safe but
  // runs every scenario for a one-line change to a page a single scenario covers.
  // Routed pages no probe loads. Their behaviour is covered by the cross-stack acceptance
  // run and the logic suites; every probe scenario would observe nothing of them, so
  // naming them with no scenario is what keeps an edit from running the whole catalog.
  // The configuration page and the source editor behind it. The planner used to name the page
  // with no scenario at all, because nothing probed it; the source view now does, for the one
  // claim a browser alone can settle - that the editor's widget glyphs are painted with the icon
  // font its slim build has to register itself.
  //
  // The key page's own list scenario comes along because this directory is not the config page's
  // alone: the key list is derived by resolving `ALL_CONFIG_FIELDS`'s `apiKeys` field against the
  // document through `getFieldSemanticValue`, so a change to the draft layer or the schema can
  // empty that page's table without touching a file under `pages/ApiKeysPage/`. `overlay-back` and
  // `touch-ergonomics` are deliberately not named: nothing here owns an overlay or a hit target.
  {
    prefix: 'web/src/components/config/',
    scenarios: ['config-source-editor', 'phone-lists'],
  },
  { prefix: 'web/src/pages/ConfigPage', scenarios: ['config-source-editor'] },
  { prefix: 'web/src/types/configSchema', scenarios: ['config-source-editor', 'phone-lists'] },
  { prefix: 'web/src/pages/QuickStartPage', scenarios: [] },
  // The key list page: the phone rendering, the touch rules and the modal Back dismissal
  // each load `/api-keys`.
  { prefix: 'web/src/pages/ApiKeysPage', scenarios: ['phone-lists', 'touch-ergonomics', 'overlay-back'] },
  {
    prefix: 'web/src/pages/PluginsPage',
    scenarios: ['plugin-management', 'plugin-management-narrow'],
  },
  {
    prefix: 'web/src/components/plugins/',
    scenarios: ['plugin-management', 'plugin-management-narrow'],
  },
  {
    prefix: 'web/src/pages/pricing/',
    scenarios: ['phone-lists', 'pricing-book'],
  },
  // The shared pricing layer: the editor drawer every cost surface opens, and the breakdown the
  // request drawer shows. The request list is the surface that opens it without the book.
  {
    prefix: 'web/src/components/pricing/',
    scenarios: ['pricing-book', 'pricing-request-list'],
  },
  {
    prefix: 'web/src/types/pricing',
    scenarios: ['phone-lists', 'pricing-book', 'pricing-request-list'],
  },
  {
    prefix: 'web/src/pages/LogsPage',
    scenarios: ['phone-lists', 'logs-sources'],
  },
  {
    prefix: 'web/src/components/logs/',
    scenarios: ['phone-lists', 'logs-sources'],
  },
  {
    prefix: 'web/src/hooks/useServiceLogTail',
    scenarios: ['logs-sources'],
  },
  {
    prefix: 'web/src/hooks/useLogTail',
    scenarios: ['logs-sources', 'phone-lists'],
  },
  {
    prefix: 'web/src/types/audit',
    scenarios: ['audit-trail', 'audit-trail-narrow'],
  },
  {
    prefix: 'web/src/pages/AuditPage',
    scenarios: ['logs-sources', 'audit-trail', 'audit-trail-narrow'],
  },
  {
    prefix: 'web/src/components/audit/',
    scenarios: ['audit-trail', 'audit-trail-narrow'],
  },
  {
    prefix: 'web/src/types/logs',
    scenarios: ['logs-sources', 'phone-lists'],
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
 * Anything the console's document loads that no rule places widens the plan: the whole
 * point of this function is to distinguish "no impact" from "not yet classified", and
 * only the former may select nothing. `web/index.html` is the document itself; the
 * entries under `web/public/` are served verbatim and are copied from `web/public`
 * rather than imported, so an edit there cannot move a scenario's assertions.
 */
const FRONTEND_SOURCE = 'web/src/';
const DOCUMENT_SHELL = 'web/index.html';

/**
 * The probe framework itself.
 *
 * A change here can invalidate any scenario's result - the runner owns the browser,
 * the contexts and the mock - and it previously selected *nothing*, because no rule
 * placed a `scripts/` path and `isBrowserRelevant` only looks at `web/src`. That is
 * the same hole `verify:fast` had for test suites: the code that decides whether the
 * checks are meaningful was itself unchecked. Without attribution context a change
 * to any of these widens the plan to every scenario; with it, `probe-impact.mjs`
 * narrows a probe module or registry edit to the scenarios that use it and keeps the
 * runner itself at "every scenario".
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
  'scripts/acceptance/ui-impact.mjs',
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
  return file.startsWith(FRONTEND_SOURCE) || file === DOCUMENT_SHELL;
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

/** The router's roots: every page is imported by them, so reaching one is not "shared". */
const ROUTER_ROOTS = new Set(['web/src/App.tsx', 'web/src/main.tsx']);

/** Translation catalogs, where an edit that only adds entries cannot move a scenario. */
const I18N_CATALOG = /^web\/src\/i18n\/(?:index\.tsx|locales\/[^/]+\.ts)$/;

function ruleFor(file) {
  return SCENARIO_PATHS.find((candidate) => file.startsWith(candidate.prefix));
}

/**
 * Follows a file's runtime importers until each chain ends at a page the router
 * loads, a shared-layer module, or a module nothing imports.
 *
 * Returns `{ all: reason }` when the change reaches the shared layer or a routed page
 * no rule names; otherwise the scenarios of every rule met on the way. Traversal
 * continues through a mapped module rather than stopping at it, because a shared
 * component can also be imported by a page its own rule does not list.
 */
function reachScenarios(file, importers) {
  const found = new Set();
  const via = [];
  const queue = [file];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const node = queue.shift();
    for (const importer of importers.get(node) ?? []) {
      if (ROUTER_ROOTS.has(importer)) {
        if (!ruleFor(node)) return { all: `${node} is loaded by the router and no scenario rule names it` };
        continue;
      }
      if (isShellPath(importer)) return { all: `${file} reaches the shared layer through ${importer}` };
      const rule = ruleFor(importer);
      if (rule) {
        rule.scenarios.forEach((id) => found.add(id));
        via.push(importer);
      }
      if (!seen.has(importer)) {
        seen.add(importer);
        queue.push(importer);
      }
    }
  }
  return { found, via };
}

/**
 * planScenarios maps changed paths to the scenarios worth running.
 *
 * It returns the scenario ids in registry order, plus the reason the plan is as wide
 * as it is, so a caller can say *why* rather than only *what*. `check:ui --plan`
 * prints exactly this.
 *
 * `impact` is optional context from `ui-impact.mjs`: the reverse runtime import graph
 * and whether a translation catalog only gained entries. Without it the planner uses
 * the path rules alone and widens on any file they do not place.
 */
export function planScenarios(files, allIds, impact) {
  if (files.length === 0) {
    return { ids: [], reason: 'no changed files', reasons: [{ kind: 'none', detail: 'no changed files' }] };
  }

  // The harness is checked before anything else: a change to how scenarios are run,
  // listed or selected makes every scenario's result suspect, including the ones the
  // path rules would narrow away.
  const framework = files.filter(isProbeFramework);
  const selected = new Set();
  const reasons = [];
  if (framework.length > 0 && impact?.probeChange) {
    // With the registry and module graph available, probe code is attributed to the
    // scenarios that run it (see `probe-impact.mjs`), and only the runner widens.
    const attributed = impact.probeChange(files);
    if (attributed.all) {
      return { ids: [...allIds], reason: attributed.all, reasons: [{ kind: 'all', detail: attributed.all }] };
    }
    attributed.ids.forEach((id) => selected.add(id));
    reasons.push(...attributed.reasons);
  } else if (framework.length > 0) {
    return {
      ids: [...allIds],
      reason: `the probe framework changed (${framework.join(', ')})`,
      reasons: [{ kind: 'all', detail: `probe framework changed: ${framework.join(', ')}` }],
    };
  }

  const runtimeInputs = files.filter((file) => !(impact?.isManifestScriptsOnly?.(file) ?? false)).filter((file) =>
    ['package.json', 'web/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'].includes(file)
      || /^web\/(?:vite\.config\.|tsconfig)/.test(file),
  );
  if (runtimeInputs.length > 0) {
    return {
      ids: [...allIds],
      reason: `frontend runtime inputs changed (${runtimeInputs.join(', ')})`,
      reasons: [{ kind: 'all', detail: `frontend runtime inputs: ${runtimeInputs.join(', ')}` }],
    };
  }

  const skipped = [];
  const relevant = files.filter(isBrowserRelevant).filter((file) => {
    if (impact && I18N_CATALOG.test(file) && impact.isAdditionOnly(file)) {
      skipped.push({ kind: 'skip', detail: `${file}: only new catalog entries, which only the code that uses them can render` });
      return false;
    }
    return true;
  });
  if (relevant.length === 0) {
    const attributed = [...reasons, ...skipped];
    return {
      ids: allIds.filter((id) => selected.has(id)),
      reason: selected.size > 0 ? 'probe changes attributed to their scenarios'
        : skipped.length > 0 ? 'only new translation entries changed' : 'no frontend source changed',
      reasons: attributed.length > 0 ? attributed : [{ kind: 'none', detail: 'no frontend source changed' }],
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

  reasons.push(...skipped);
  if (impact && impact.unresolved.length > 0) {
    return {
      ids: [...allIds],
      reason: `the import graph has unresolved local imports (${impact.unresolved.join(', ')})`,
      reasons: [...reasons, { kind: 'all', detail: `unresolved imports: ${impact.unresolved.join(', ')}` }],
    };
  }

  const unplaced = [];
  for (const file of relevant) {
    const rule = ruleFor(file);
    if (rule) {
      for (const id of rule.scenarios) selected.add(id);
      reasons.push({ kind: 'map', detail: `${file} -> ${rule.scenarios.join(', ')}` });
    }
    if (!impact) {
      if (!rule) unplaced.push(file);
      continue;
    }
    // Only a TypeScript module can be proven unused at runtime: an asset or a
    // stylesheet can also be referenced from CSS `url()` or the HTML shell, which
    // the graph does not read.
    const isModule = /\.(?:ts|tsx)$/.test(file);
    const importers = impact.importers.get(file);
    if (!importers || (importers.size === 0 && !isModule)) {
      if (!rule) unplaced.push(file);
      continue;
    }
    const reach = reachScenarios(file, impact.importers);
    if (reach.all) {
      return {
        ids: [...allIds],
        reason: reach.all,
        reasons: [...reasons, { kind: 'all', detail: reach.all }],
      };
    }
    for (const id of reach.found) selected.add(id);
    if (reach.via.length > 0) {
      reasons.push({ kind: 'map', detail: `${file} -> imported by ${reach.via.join(', ')} -> ${[...reach.found].join(', ')}` });
    } else if (!rule) {
      reasons.push({ kind: 'map', detail: `${file} -> no runtime importer (type-only or unused), covered by the type check` });
    }
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
    reason: impact ? 'matched by path and runtime imports' : 'matched by path',
    reasons,
  };
}
