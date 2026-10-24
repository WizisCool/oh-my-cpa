import { SHARED_INPUTS } from '../ci-scope.mjs';

/**
 * Which probe scenarios a working-tree change can affect.
 *
 * The plan has to be **conservative**: a plan that silently omits a scenario is a
 * green run that verified nothing, which is worse than a slow one. So the rules are a
 * small explicit map, and two properties are structural rather than per-file:
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
  'web/src/routePages.ts',
  'web/src/index.css',
  'web/src/api/client.ts',
  'web/src/i18n/index.tsx',
  'web/src/i18n/messages/',
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
  'dashboard-layout',
  'provider-rate-marks',
  'mobile-console',
];

const AGENT_SCENARIOS = ['agent', 'agent-external', 'agent-question', 'agent-live', 'agent-views', 'agent-replace', 'agent-attach', 'agent-failure', 'agent-stream', 'agent-narrow', 'mobile-console'];

/**
 * A source path maps to the scenarios it can affect.
 *
 * The order matters: the first entry whose prefix matches wins, so a more specific
 * path must be listed before a broader one. Matching is by path prefix, so a whole
 * directory can be named without listing its files.
 */
const SCENARIO_PATHS = [
  { prefix: 'web/src/pages/agent/', scenarios: AGENT_SCENARIOS },
  { prefix: 'web/src/pages/insights/', scenarios: ['insights', 'insights-phone'] },
  { prefix: 'web/src/charts/echarts/', scenarios: ['insights', 'insights-phone'] },
  { prefix: 'web/src/pages/playground/', scenarios: ['playground', 'playground-narrow', 'mobile-console'] },
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
    scenarios: ['column-alignment', 'request-list-interactions', 'request-export', 'request-facet-marks', 'mobile-console'],
  },
  {
    prefix: 'web/src/components/usage/',
    scenarios: [
      'column-alignment',
      'refresh-sequencing',
      'search-dev-server',
      'request-list-interactions',
      'request-export',
      'request-facet-marks',
      'scroll-smoothing',
      'request-list-touch',
      'overlay-back',
      'pricing-request-list',
      'mobile-console',
    ],
  },
  {
    prefix: 'web/src/pages/UsageEventsPage',
    scenarios: [
      'column-alignment',
      'refresh-sequencing',
      'search-dev-server',
      'request-list-interactions',
      'request-export',
      'request-facet-marks',
      'request-list-touch',
      'mobile-console',
    ],
  },
  // The system page renders a release's Markdown body, which is untrusted remote text. The
  // scenario that belongs to it asserts the two things only an engine can: that no element or
  // inline handler from the body is executed, and that the page fetches nothing from a host the
  // body names. A change to the page, or to the Markdown renderer it imports, moves that claim.
  {
    prefix: 'web/src/pages/SystemPage',
    scenarios: ['system-information', 'system-version-feedback', 'system-health-anomalies', 'system-update-indicator', 'system-information-narrow', 'mobile-console'],
  },
  // The overlay history layer and everything it is wired into. Named as one rule because the
  // claim is about the layer plus a representative overlay of each kind: the navigation sheet
  // from the shell, the request detail and filter drawers from the request list, and the
  // provider editor. A change to the hook itself moves all of them.
  {
    prefix: 'web/src/hooks/useOverlayHistory',
    scenarios: ['overlay-back', 'config-source-editor', 'config-backups', 'model-square', 'mobile-console'],
  },
  {
    prefix: 'web/src/hooks/overlayHistory',
    scenarios: ['overlay-back', 'config-source-editor', 'config-backups', 'model-square', 'mobile-console'],
  },
  // The console's global stylesheet is already a shared path, and the touch rules live in it, so
  // any change to the shell selects the touch scenario too. Named here rather than folded into
  // SHELL_PATHS because it is about the rules those files carry, not about every scenario.
  {
    prefix: 'web/src/hooks/useIsPhoneViewport',
    scenarios: ['phone-lists', 'touch-ergonomics', 'agent-narrow', 'playground-narrow', 'config-source-editor', 'config-backups', 'model-square', 'mobile-console'],
  },
  {
    prefix: 'web/src/components/common/PhoneRow',
    scenarios: ['phone-lists', 'touch-ergonomics', 'mobile-console'],
  },
  // The list surfaces whose phone rendering ADR 0012 introduced, and the shared pieces that
  // rendering is derived from: a change to either reaches every one of them.
  {
    prefix: 'web/src/components/common/phoneRowFields',
    scenarios: ['phone-lists', 'mobile-console'],
  },
  {
    prefix: 'web/src/components/keys/',
    scenarios: ['phone-lists', 'mobile-console'],
  },
  // The provider console and its icon picker: the drawer/modal stacking assertion
  // is about those two overlays specifically, picking a mark from the picker is the
  // page's own write path, and the table is where the phone rendering lives (ADR 0012).
  // A rule that named only the first two would let a change to the provider phone row
  // run no scenario that covers it - which is the silent omission this planner exists to
  // prevent, and the reason its own test pins this mapping.
  {
    prefix: 'web/src/components/IconPickerModal',
    scenarios: ['icon-picker-stacking', 'provider-icon-pick', 'custom-icon-library'],
  },
  {
    prefix: 'web/src/components/CustomIconLibrary',
    scenarios: ['custom-icon-library'],
  },
  {
    prefix: 'web/src/pages/ProvidersPage',
    scenarios: ['icon-picker-stacking', 'provider-icon-pick', 'custom-icon-library', 'provider-model-picker', 'phone-lists', 'overlay-back', 'mobile-console'],
  },
  // The provider console's own modules: the list table, the editor drawer, the
  // writes and the icon overlay. The page renders nothing but these, so a change
  // to any of them reaches exactly what a change to the page reaches - and the
  // drawer is one of the two overlays the stacking assertion is about.
  {
    prefix: 'web/src/components/providers/',
    scenarios: ['icon-picker-stacking', 'provider-icon-pick', 'custom-icon-library', 'provider-model-picker', 'phone-lists', 'overlay-back', 'mobile-console'],
  },
  // The unified OAuth workspace owns its density, connection drawer, quota body,
  // task panels and phone reflow. Its scenario is the measured equivalent of the
  // three retired pages' UI claims; overlay-back covers the shared history layer.
  {
    prefix: 'web/src/pages/oauthManagement/',
    scenarios: ['oauth-management', 'oauth-vertex-import', 'oauth-model-rules', 'oauth-token-capacity', 'oauth-authorization-outcomes', 'oauth-workspace-scale', 'oauth-plugin-connections', 'overlay-back', 'mobile-console'],
  },
  {
    prefix: 'web/src/pages/oauthProviderLogic',
    scenarios: ['oauth-management', 'oauth-vertex-import', 'oauth-model-rules', 'oauth-token-capacity', 'oauth-authorization-outcomes', 'oauth-workspace-scale', 'oauth-plugin-connections', 'overlay-back', 'mobile-console'],
  },
  {
    prefix: 'web/src/pages/LegacyOAuthManagementRedirect',
    scenarios: ['oauth-management', 'oauth-vertex-import', 'oauth-model-rules', 'oauth-token-capacity', 'oauth-authorization-outcomes', 'oauth-workspace-scale', 'oauth-plugin-connections', 'overlay-back', 'mobile-console'],
  },
  {
    prefix: 'web/src/components/authFiles/',
    scenarios: ['oauth-management', 'oauth-vertex-import', 'oauth-model-rules', 'oauth-token-capacity', 'oauth-authorization-outcomes', 'oauth-workspace-scale', 'oauth-plugin-connections', 'overlay-back', 'mobile-console'],
  },
  {
    prefix: 'web/src/pages/quota/',
    scenarios: ['oauth-management', 'oauth-vertex-import', 'oauth-model-rules', 'oauth-token-capacity', 'oauth-authorization-outcomes', 'oauth-workspace-scale', 'oauth-plugin-connections', 'overlay-back', 'mobile-console'],
  },
  // The remaining list surfaces ADR 0012 converted. Each renders rows on a phone and a table
  // otherwise, and `phone-lists` is the scenario that reads both renderings of each; without a
  // rule they fall through to "an unrecognised frontend path widens the plan", which is safe but
  // runs every scenario for a one-line change to a page a single scenario covers.
  // The configuration page and the source editor behind it. The planner used to name the page
  // with no scenario at all, because nothing probed it; the source view now does, for the one
  // claims that need a browser: widget glyph paint, focused editing, draft continuity and save decisions. The backup dialog is raised from the page's
  // toolbar and restores through a confirmation stacked above it, which `config-backups` owns.
  //
  // The key page's own list scenario comes along because this directory is not the config page's
  // alone: the key list is derived by resolving `ALL_CONFIG_FIELDS`'s `apiKeys` field against the
  // document through `getFieldSemanticValue`, so a change to the draft layer or the schema can
  // empty that page's table without touching a file under `pages/ApiKeysPage/`. `overlay-back` and
  // `touch-ergonomics` remain separately scoped; the source scenario owns focused editing overlays.
  {
    prefix: 'web/src/components/config/',
    scenarios: ['config-source-editor', 'config-backups', 'phone-lists', 'mobile-console'],
  },
  { prefix: 'web/src/pages/ConfigPage', scenarios: ['config-source-editor', 'config-backups', 'mobile-console'] },
  { prefix: 'web/src/types/configSchema', scenarios: ['config-source-editor', 'phone-lists', 'mobile-console'] },
  { prefix: 'web/src/pages/ModelSquarePage', scenarios: ['model-square', 'mobile-console'] },
  { prefix: 'web/src/types/modelSquare', scenarios: ['model-square', 'mobile-console'] },
  // The key list page: the phone rendering, the touch rules and the modal Back dismissal
  // each load `/api-keys`.
  { prefix: 'web/src/pages/ApiKeysPage', scenarios: ['phone-lists', 'touch-ergonomics', 'overlay-back', 'mobile-console'] },
  {
    prefix: 'web/src/pages/PluginPageHost',
    scenarios: ['plugin-management', 'plugin-management-narrow', 'mobile-console'],
  },
  {
    prefix: 'web/src/pages/PluginsPage',
    scenarios: ['plugin-management', 'plugin-management-narrow', 'mobile-console'],
  },
  {
    prefix: 'web/src/components/plugins/',
    scenarios: ['plugin-management', 'plugin-management-narrow', 'mobile-console'],
  },
  {
    prefix: 'web/src/pages/pricing/',
    scenarios: ['phone-lists', 'pricing-book', 'mobile-console'],
  },
  // The shared pricing layer: the editor drawer every cost surface opens, and the breakdown the
  // request drawer shows. The request list is the surface that opens it without the book.
  {
    prefix: 'web/src/components/pricing/',
    scenarios: ['pricing-book', 'pricing-request-list', 'mobile-console'],
  },
  {
    prefix: 'web/src/types/pricing',
    scenarios: ['phone-lists', 'pricing-book', 'pricing-request-list', 'mobile-console'],
  },
  {
    prefix: 'web/src/pages/LogsPage',
    scenarios: ['phone-lists', 'logs-sources', 'mobile-console'],
  },
  {
    prefix: 'web/src/components/logs/',
    scenarios: ['phone-lists', 'logs-sources', 'mobile-console'],
  },
  {
    prefix: 'web/src/hooks/useServiceLogTail',
    scenarios: ['logs-sources', 'mobile-console'],
  },
  {
    prefix: 'web/src/hooks/useLogTail',
    scenarios: ['logs-sources', 'phone-lists', 'mobile-console'],
  },
  {
    prefix: 'web/src/types/audit',
    scenarios: ['audit-trail', 'audit-trail-narrow', 'mobile-console'],
  },
  {
    prefix: 'web/src/pages/AuditPage',
    scenarios: ['logs-sources', 'audit-trail', 'audit-trail-narrow', 'mobile-console'],
  },
  {
    prefix: 'web/src/components/audit/',
    scenarios: ['audit-trail', 'audit-trail-narrow', 'mobile-console'],
  },
  {
    prefix: 'web/src/types/logs',
    scenarios: ['logs-sources', 'phone-lists', 'mobile-console'],
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
    scenarios: ['dashboard-charts', 'dashboard-chart-motion', 'mobile-console'],
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
    scenarios: ['dashboard-charts', 'dashboard-model-panels', 'insights', 'insights-phone', 'mobile-console'],
  },
  // The dashboard's own panels. Both scenarios read the page, so a panel change
  // reaches both: the heatmap is a sibling of the tiles, not a child of a chart.
  {
    prefix: 'web/src/components/dashboard/',
    scenarios: DASHBOARD_SCENARIOS,
  },
  // The arrangement model decides what the board draws and in which order, so every scenario that
  // reads the dashboard can move with it.
  {
    prefix: 'web/src/types/dashboardLayout',
    scenarios: DASHBOARD_SCENARIOS,
  },
  {
    prefix: 'web/src/types/tokenHeatmap',
    scenarios: ['dashboard-heatmap', 'dashboard-heatmap-mobile', 'dashboard-heatmap-pruned', 'dashboard-heatmap-error', 'mobile-console'],
  },
  // The OMC settings page and the preference layer behind it. The page is what the scenario loads,
  // so a change to the page, its controls or the shared token-display layer reaches it; the token
  // layer and the preference hook also govern the dashboard's own readouts, which is why the
  // dashboard's model panels and the OMC page move together.
  {
    prefix: 'web/src/pages/OmcSettingsPage',
    scenarios: ['omc-settings', 'sidebar-customization', 'font-library', 'scroll-smoothing', 'mobile-console'],
  },
  // The typeface roles: the settings controls, the document-level applier and the role rules.
  // They repaint every page, but what can break is reached from the settings page the scenario
  // drives, plus the phone console that renders the same page narrow.
  {
    prefix: 'web/src/components/settings/FontSettings',
    scenarios: ['font-library', 'omc-settings', 'mobile-console'],
  },
  // The rail's layout panel, the model it lists and the hook it writes through. The panel is what
  // the scenario drives and the rail it redraws is the shell's, which is why the scenario is its
  // own rather than folded into the settings page's: the claim spans the page and the navigation
  // that page governs - both what it shows and the order it shows it in - and the phone console
  // renders the same page narrow.
  {
    prefix: 'web/src/components/settings/SidebarNavSettings',
    scenarios: ['sidebar-customization', 'omc-settings', 'mobile-console'],
  },
  {
    prefix: 'web/src/types/sidebarNav',
    scenarios: ['sidebar-customization', 'omc-settings', 'mobile-console'],
  },
  {
    prefix: 'web/src/hooks/useNavLayout',
    scenarios: ['sidebar-customization', 'omc-settings', 'mobile-console'],
  },
  {
    prefix: 'web/src/theme/fontLibrary',
    scenarios: ['font-library', 'omc-settings'],
  },
  {
    prefix: 'web/src/types/fonts',
    scenarios: ['font-library'],
  },
  {
    prefix: 'web/src/hooks/useFonts',
    scenarios: ['font-library', 'omc-settings'],
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
      'mobile-console',
    ],
  },
  {
    // The animated shape of a reading: the contract every readout on the dashboard's KPI tiles is
    // built from. Only those tiles construct one, so the dashboard scenarios and the OMC settings
    // scenario - which reads the same tiles back when it asserts the unit style they print in - are
    // what a change here can reach.
    prefix: 'web/src/types/rollingNumber',
    scenarios: ['omc-settings', ...DASHBOARD_SCENARIOS, 'mobile-console'],
  },
  {
    prefix: 'web/src/hooks/usePreference',
    scenarios: ['omc-settings', 'sidebar-customization', 'font-library', 'dashboard-model-panels-states', 'dashboard-heatmap', 'column-alignment', 'request-list-interactions', 'scroll-smoothing', 'mobile-console'],
  },
  // The console-wide wheel and keyboard glide. It intercepts every wheel and scrolling key, so the
  // scenarios that drive the wheel or the keyboard on a scroller are reached as well as its own.
  {
    prefix: 'web/src/utils/scrollSmoothing',
    scenarios: ['scroll-smoothing', 'request-list-interactions', 'pricing-book', 'dashboard-heatmap', 'mobile-console'],
  },
  {
    prefix: 'web/src/hooks/useScrollSmoothing',
    scenarios: ['scroll-smoothing', 'request-list-interactions', 'pricing-book', 'dashboard-heatmap', 'mobile-console'],
  },
];

/** The probe harness: a change here can move any scenario. */
const PROBE_INFRASTRUCTURE = ['scripts/acceptance/', 'scripts/testing/', 'scripts/check-ui.ts'];

/**
 * The scenarios a set of changed files can affect. A shared file, a probe file or an
 * unmapped frontend file selects every scenario: over-running costs background minutes,
 * a missed scenario costs a regression.
 */
export function planScenarios(files, allIds) {
  const selected = new Set();
  for (const file of files) {
    if (SHARED_INPUTS.test(file)) return { ids: allIds, reason: `${file} is shared by every scenario` };
    const isFrontend = file.startsWith('web/');
    const isProbe = PROBE_INFRASTRUCTURE.some(prefix => file.startsWith(prefix));
    if (!isFrontend && !isProbe) continue;
    if (isProbe || SHELL_PATHS.some(prefix => file.startsWith(prefix))) return { ids: allIds, reason: `${file} is shared by every scenario` };
    const rule = SCENARIO_PATHS.find(candidate => file.startsWith(candidate.prefix));
    if (!rule) return { ids: allIds, reason: `${file} has no scenario rule` };
    for (const id of rule.scenarios) selected.add(id);
  }
  return {
    ids: allIds.filter(id => selected.has(id)),
    reason: selected.size ? 'mapped frontend paths' : 'no browser-relevant change',
  };
}
