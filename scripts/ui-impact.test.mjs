/**
 * The UI planner's narrowing inputs: the runtime import graph, the translation
 * additions-only rule, the manifest rule and the attribution of probe changes.
 *
 * Every narrowing here trades a scenario run for a claim, so each claim has a case
 * where it must NOT narrow. The last tests pin properties of the real tree that the
 * narrowing depends on, and fail with the fix a future change needs.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { planScenarios } from './acceptance/check-ui-plan.mjs';
import { buildImporterGraph, isCatalogAdditionOnly, isManifestScriptsOnly } from './acceptance/ui-impact.mjs';
import { planProbeChange } from './acceptance/probe-impact.mjs';
import { SCENARIOS } from './acceptance/scenarios.mjs';

const ALL = SCENARIOS.map((scenario) => scenario.id);

function graphOf(sources) {
  return buildImporterGraph({ files: Object.keys(sources), readFile: (file) => sources[file] });
}

function impactOf(sources, overrides = {}) {
  return { ...graphOf(sources), isAdditionOnly: () => false, isManifestScriptsOnly: () => false, ...overrides };
}

// A small console: the router loads two mapped pages and one unmapped page.
const CONSOLE = {
  'web/src/App.tsx': "import SystemPage from './pages/SystemPage';\nimport ApiKeysPage from './pages/ApiKeysPage';\nimport Orphan from './pages/UnmappedPage';\nexport const pages = [SystemPage, ApiKeysPage, Orphan];",
  'web/src/pages/SystemPage.tsx': "import { formatBytes } from '../utils/format';\nimport type { SystemInfo } from '../types/system';\nexport default function SystemPage(info: SystemInfo) { return formatBytes(info.size); }",
  'web/src/pages/ApiKeysPage.tsx': "import { formatBytes } from '@/utils/format';\nexport default function ApiKeysPage() { return formatBytes(1); }",
  'web/src/pages/UnmappedPage.tsx': "import { shared } from '../utils/onlyUnmapped';\nexport default function Orphan() { return shared; }",
  'web/src/utils/format.ts': 'export function formatBytes(value: number) { return `${value} B`; }',
  'web/src/utils/onlyUnmapped.ts': 'export const shared = 1;',
  'web/src/utils/viaShell.ts': 'export const shell = 1;',
  'web/src/components/common/AppLayout.tsx': "import { shell } from '../../utils/viaShell';\nexport const layout = shell;",
  'web/src/types/system.ts': 'export interface SystemInfo { size: number }',
  'web/src/assets/fonts/inter.woff2': '',
};

test('an import used only as a type is not a runtime edge; a value import is', () => {
  const { importers, unresolved } = graphOf(CONSOLE);
  assert.deepEqual([...importers.get('web/src/types/system.ts')], []);
  assert.deepEqual([...importers.get('web/src/utils/format.ts')].sort(), ['web/src/pages/ApiKeysPage.tsx', 'web/src/pages/SystemPage.tsx']);
  assert.deepEqual(unresolved, []);
});

test('dynamic imports are edges and an unresolved local import is reported', () => {
  const { importers, unresolved } = graphOf({
    'web/src/App.tsx': "const Page = () => import('./pages/Lazy');\nimport { gone } from './utils/missing';\nexport { Page, gone };",
    'web/src/pages/Lazy.tsx': 'export default 1;',
  });
  assert.deepEqual([...importers.get('web/src/pages/Lazy.tsx')], ['web/src/App.tsx']);
  assert.deepEqual(unresolved, ['web/src/App.tsx -> ./utils/missing']);
});

test('a helper selects the scenarios of the pages that import it', () => {
  const plan = planScenarios(['web/src/utils/format.ts'], ALL, impactOf(CONSOLE));
  assert.deepEqual(new Set(plan.ids), new Set(['system-information', 'system-information-narrow', 'phone-lists', 'touch-ergonomics', 'overlay-back', 'mobile-console']));
});

test('reaching the shared layer or an unnamed routed page still selects everything', () => {
  assert.equal(planScenarios(['web/src/utils/viaShell.ts'], ALL, impactOf(CONSOLE)).ids.length, ALL.length);
  assert.equal(planScenarios(['web/src/utils/onlyUnmapped.ts'], ALL, impactOf(CONSOLE)).ids.length, ALL.length);
});

test('a type-only module selects nothing, an unimported asset selects everything', () => {
  assert.deepEqual(planScenarios(['web/src/types/system.ts'], ALL, impactOf(CONSOLE)).ids, []);
  assert.equal(planScenarios(['web/src/assets/fonts/inter.woff2'], ALL, impactOf(CONSOLE)).ids.length, ALL.length);
});

test('an unresolved import anywhere widens the plan', () => {
  const impact = { ...impactOf(CONSOLE), unresolved: ['web/src/App.tsx -> ./nowhere'] };
  assert.equal(planScenarios(['web/src/utils/format.ts'], ALL, impact).ids.length, ALL.length);
});

const CATALOG = "import { x } from './x';\nexport const DICT = {\n  'a.one': ['一', 'One'],\n  'a.two': [\n    '二',\n    'Two',\n  ],\n};\nexport function t(key: string) { return DICT[key]; }\n";

test('a catalog edit is additions-only only when nothing that existed changed', () => {
  const added = CATALOG.replace("  'a.one'", "  'a.new': ['新', 'New'],\n  'a.one'");
  assert.equal(isCatalogAdditionOnly('web/src/i18n/index.tsx', CATALOG, added), true);
  for (const current of [
    CATALOG.replace("'One'", "'Uno'"),
    CATALOG.replace("  'a.one': ['一', 'One'],\n", ''),
    CATALOG.replace('return DICT[key];', 'return DICT[key] ?? key;'),
    `${CATALOG}export const EXTRA = { 'b.one': 'One' };\n`,
  ]) {
    assert.equal(isCatalogAdditionOnly('web/src/i18n/index.tsx', CATALOG, current), false, current);
  }
  assert.equal(isCatalogAdditionOnly('web/src/i18n/index.tsx', undefined, CATALOG), false);
});

test('a catalog that only gained entries selects no scenario; any other catalog edit selects all', () => {
  const additions = impactOf(CONSOLE, { isAdditionOnly: () => true });
  assert.deepEqual(planScenarios(['web/src/i18n/index.tsx', 'web/src/i18n/locales/ms.ts'], ALL, additions).ids, []);
  assert.equal(planScenarios(['web/src/i18n/index.tsx'], ALL, impactOf(CONSOLE)).ids.length, ALL.length);
});

test('a manifest edit confined to scripts is not a runtime input', () => {
  const base = JSON.stringify({ scripts: { a: 'x' }, devDependencies: { vite: '6.1.0' } });
  assert.equal(isManifestScriptsOnly('package.json', base, JSON.stringify({ scripts: { a: 'y', b: 'z' }, devDependencies: { vite: '6.1.0' } })), true);
  assert.equal(isManifestScriptsOnly('package.json', base, JSON.stringify({ scripts: { a: 'x' }, devDependencies: { vite: '6.2.0' } })), false);
  assert.equal(isManifestScriptsOnly('pnpm-lock.yaml', 'a', 'a'), false);
  const scriptsOnly = impactOf(CONSOLE, { isManifestScriptsOnly: () => true });
  assert.deepEqual(planScenarios(['package.json'], ALL, scriptsOnly).ids, []);
  assert.equal(planScenarios(['package.json'], ALL, impactOf(CONSOLE)).ids.length, ALL.length);
});

// A two-scenario registry whose scenarios use different probe modules.
const REGISTRY = `import { alpha } from './probes/alpha.mjs';
import { beta } from './probes/beta.mjs';
const fixtures = { rows: 1 };
const derived = { ...fixtures };
export const SCENARIOS = [
  { id: 'first', run: alpha },
  { id: 'second', run: beta, options: derived },
];
`;
const PROBES = {
  'scripts/acceptance/scenarios.mjs': REGISTRY,
  'scripts/acceptance/probes/alpha.mjs': "import { until } from '../harness.mjs';\nexport const alpha = until;",
  'scripts/acceptance/probes/beta.mjs': 'export const beta = 1;',
  'scripts/acceptance/harness.mjs': 'export const until = 1;',
  'scripts/acceptance/probe.mjs': "import { beta } from './probes/beta.mjs';\nexport const runProbes = beta;",
};

function attribute(files, current = {}, base = {}) {
  return planProbeChange(files, {
    readBase: (file) => (file in base ? base[file] : PROBES[file]),
    readCurrent: (file) => current[file] ?? PROBES[file],
    acceptanceFiles: Object.keys(PROBES),
  });
}

test('a probe module selects the scenarios that use it, through shared helpers', () => {
  assert.deepEqual([...attribute(['scripts/acceptance/probes/alpha.mjs']).ids], ['first']);
  assert.deepEqual([...attribute(['scripts/acceptance/harness.mjs']).ids], ['first']);
});

test('a registry edit selects the changed and added entries and what their bindings reach', () => {
  const edited = REGISTRY.replace("{ id: 'first', run: alpha }", "{ id: 'first', run: alpha, options: { viewport: 1 } }");
  assert.deepEqual([...attribute(['scripts/acceptance/scenarios.mjs'], { 'scripts/acceptance/scenarios.mjs': edited }).ids], ['first']);
  const added = REGISTRY.replace('];', "  { id: 'third', run: alpha },\n];");
  assert.deepEqual([...attribute(['scripts/acceptance/scenarios.mjs'], { 'scripts/acceptance/scenarios.mjs': added }).ids], ['third']);
  const fixture = REGISTRY.replace('rows: 1', 'rows: 2');
  assert.deepEqual([...attribute(['scripts/acceptance/scenarios.mjs'], { 'scripts/acceptance/scenarios.mjs': fixture }).ids], ['second']);
});

test('the runner, anything it imports and unattributable registry edits select all; planners select none', () => {
  assert.ok(attribute(['scripts/acceptance/probe.mjs']).all);
  assert.ok(attribute(['scripts/acceptance/probes/beta.mjs']).all, 'the runner imports beta');
  const statement = `${REGISTRY}console.log('side effect');\n`;
  assert.ok(attribute(['scripts/acceptance/scenarios.mjs'], { 'scripts/acceptance/scenarios.mjs': statement }).all);
  assert.ok(attribute(['scripts/acceptance/scenarios.mjs'], {}, { 'scripts/acceptance/scenarios.mjs': undefined }).all);
  const planner = attribute(['scripts/acceptance/probe-shards.mjs']);
  assert.equal(planner.all, undefined);
  assert.equal(planner.ids.size, 0);
});

// ── properties of the real tree the narrowing depends on ──────────────────────

const realGraph = buildImporterGraph();

test('every local import in the console resolves', () => {
  // An unresolved import makes the imported file look unused. The planner widens
  // while this list is non-empty; extend `RESOLVE_EXTENSIONS` in ui-impact.mjs or
  // fix the import instead of leaving it.
  assert.deepEqual(realGraph.unresolved, []);
});

test('every page the router loads has a scenario rule', () => {
  // Without one, any change that reaches the page selects the whole catalog. Add a
  // rule to SCENARIO_PATHS in check-ui-plan.mjs naming the scenarios that load its
  // route - or `scenarios: []` when no probe loads it.
  const routed = [...realGraph.importers].filter(([, importers]) => importers.has('web/src/App.tsx')).map(([file]) => file)
    .filter((file) => file.startsWith('web/src/pages/'));
  const unnamed = routed.filter((file) => planScenarios([file], ALL, { ...realGraph, isAdditionOnly: () => false }).ids.length === ALL.length);
  assert.deepEqual(unnamed, []);
});

test('the real registry can be attributed', () => {
  const registry = fs.readFileSync(new URL('./acceptance/scenarios.mjs', import.meta.url), 'utf8');
  const acceptanceFiles = execFileSync('git', ['ls-files', 'scripts/acceptance'], { encoding: 'utf8' }).split('\n').filter((file) => file.endsWith('.mjs'));
  const result = planProbeChange(['scripts/acceptance/scenarios.mjs'], {
    readBase: () => registry,
    readCurrent: (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined),
    acceptanceFiles,
  });
  assert.equal(result.all, undefined, result.all);
  assert.equal(result.ids.size, 0);
});

test('the real phone sweep and unrelated probes retain separate attribution', () => {
  const acceptanceFiles = fs.readdirSync('scripts/acceptance/probes').filter((file) => file.endsWith('.mjs'))
    .map((file) => `scripts/acceptance/probes/${file}`);
  acceptanceFiles.push('scripts/acceptance/scenarios.mjs', 'scripts/acceptance/probe.mjs',
    'scripts/acceptance/probe-batches.mjs', 'scripts/acceptance/probe-shards.mjs');
  const read = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  const options = { readBase: read, readCurrent: read, acceptanceFiles };
  assert.ok(planProbeChange(['scripts/acceptance/probe-batches.mjs'], options).all,
    'batch orchestration is part of the runner, so it cannot silently narrow coverage');
  const sweep = planProbeChange(['scripts/acceptance/probes/mobileConsole.mjs'], options);
  assert.equal(sweep.all, undefined);
  assert.deepEqual([...sweep.ids], ['mobile-console']);
  const source = planProbeChange(['scripts/acceptance/probes/configSourceEditor.mjs'], options);
  assert.equal(source.all, undefined);
  assert.deepEqual(new Set(source.ids), new Set(['route-preloading', 'config-source-editor', 'config-backups', 'mobile-console']));
  const settings = planProbeChange(['scripts/acceptance/probes/omcSettings.mjs'], options);
  assert.equal(settings.all, undefined);
  assert.deepEqual([...settings.ids], ['omc-settings']);
});
