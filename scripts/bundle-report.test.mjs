import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ANOMALY_LIMITS, analyzeBundle, collectStartupResources, evaluateBundle, findLoadingViolations, measureBytes, renderBundleSummary, validateReference, walkStaticGraph } from './bundle-report.mjs';
import { runBundleVerification } from './check-bundle-budget.mjs';
import { normalizeModuleId, bundleGraphPlugin } from './bundle-graph.mjs';

const REVISION = 'a'.repeat(40);
function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-bundle-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'index.html'), '<script src="./assets/start.js" type="module"></script><link href="./assets/base.css" rel="stylesheet">');
  fs.writeFileSync(path.join(root, 'assets/base.css'), 'body{}');
  const chunks = [
    { file: 'assets/start.js', imports: ['assets/shared.js'], dynamicImports: ['assets/page.js'], css: [], modules: ['web/src/main.tsx'] },
    { file: 'assets/shared.js', imports: ['assets/start.js'], dynamicImports: [], css: [], modules: ['node_modules/react/index.js'] },
    { file: 'assets/page.js', imports: ['assets/shared.js'], dynamicImports: ['assets/editor.js'], css: [], modules: ['web/src/pages/ConfigPage.tsx'] },
    { file: 'assets/editor.js', imports: [], dynamicImports: [], css: [], modules: ['node_modules/monaco-editor/editor.js'] },
  ];
  for (const chunk of chunks) {
    const code = `console.log(${JSON.stringify(chunk.file)});`;
    fs.writeFileSync(path.join(root, chunk.file), code);
    chunk.sha256 = createHash('sha256').update(code).digest('hex');
  }
  return { root, graph: { version: 1, chunks } };
}

test('static closure deduplicates shared imports and cycles without following lazy edges', (context) => {
  const { root, graph } = fixture(context);
  const report = analyzeBundle(root, graph, REVISION);
  assert.deepEqual(report.initialFiles, ['assets/shared.js', 'assets/start.js']);
  assert.equal(report.violations.length, 0);
  assert.ok(report.metrics.initialJS.raw < report.metrics.totalJS.raw);
  assert.equal(report.metrics.initialCSS.raw, 6);
  assert.equal(report.metrics.totalDist.raw, Object.values(report.files).reduce((sum, file) => sum + file.raw, 0));
});

test('renaming a chunk cannot hide eager pages, charts, shell, Markdown or editor', (context) => {
  const { root, graph } = fixture(context);
  for (const moduleId of ['web/src/pages/ConfigPage.tsx', 'web/src/components/common/AppLayout.tsx', 'node_modules/@antv/g2/index.js', 'node_modules/monaco-editor/editor.js', 'node_modules/react-markdown/index.js']) {
    graph.chunks[1].modules = [moduleId];
    const report = analyzeBundle(root, graph, REVISION);
    assert.match(evaluateBundle(report).failures.join('\n'), new RegExp(moduleId.replaceAll('/', '\\/')));
  }
});

test('a modulepreload link is eager even when the entry only dynamically imports it', (context) => {
  const { root, graph } = fixture(context);
  fs.appendFileSync(path.join(root, 'index.html'), '<link rel="modulepreload" href="./assets/page.js">');
  const report = analyzeBundle(root, graph, REVISION);
  assert.ok(report.initialFiles.includes('assets/page.js'));
  assert.ok(report.violations.some((message) => message.includes('ConfigPage')));
});

test('the editor stays deferred even after the configuration route loads', (context) => {
  const { root, graph } = fixture(context);
  assert.equal(analyzeBundle(root, graph, REVISION).violations.length, 0);
  graph.chunks[2].imports.push('assets/editor.js');
  const report = analyzeBundle(root, graph, REVISION);
  assert.ok(!report.initialFiles.includes('assets/editor.js'));
  assert.match(evaluateBundle(report).failures.join('\n'), /on-demand editor/);
});

test('missing resources, broken edges, duplicate chunks and stale graph fail closed', (context) => {
  const { root, graph } = fixture(context);
  for (const mutate of [
    (copy) => { copy.chunks[0].imports = ['missing.js']; },
    (copy) => { copy.chunks[0].dynamicImports = ['missing.js']; },
    (copy) => { copy.chunks[0].css = ['missing.css']; },
    (copy) => { copy.chunks[0].sha256 = '0'.repeat(64); },
    (copy) => { copy.chunks.push(copy.chunks[0]); },
    (copy) => { copy.version = 2; },
    (copy) => { copy.chunks = []; },
  ]) {
    const copy = structuredClone(graph);
    mutate(copy);
    assert.throws(() => analyzeBundle(root, copy, REVISION));
  }
  fs.unlinkSync(path.join(root, 'assets/page.js'));
  assert.throws(() => analyzeBundle(root, graph, REVISION), /Stale/);
});

test('HTML resource parsing supports attribute order, quotes and mount prefix; external resources fail', () => {
  const resources = collectStartupResources("<script src='/omc/assets/start.js' type='module'></script><link href='./assets/shared.js' rel='modulepreload'>");
  assert.equal(resources.entry, 'assets/start.js');
  assert.deepEqual(resources.scripts, ['assets/start.js', 'assets/shared.js']);
  assert.throws(() => collectStartupResources('<script type="module" src="https://cdn.invalid/assets/main.js"></script>'), /External/);
  assert.throws(() => collectStartupResources('<script src="main.js"></script>'), /exactly one/);
});

test('ordinary growth is advisory, while each anomaly ceiling remains a hard gate', (context) => {
  const { root, graph } = fixture(context);
  const report = analyzeBundle(root, graph, REVISION);
  const reference = structuredClone(report);
  report.metrics.entry.raw = 400 * 1024; // Crosses the former 314 KiB quota.
  let result = evaluateBundle(report, reference);
  assert.equal(result.failures.length, 0);
  assert.ok(result.warnings.some((message) => message.includes('entry raw')));
  for (const [metric, limits] of Object.entries(ANOMALY_LIMITS)) {
    for (const [encoding, limit] of Object.entries(limits)) {
      const copy = structuredClone(reference);
      copy.metrics[metric][encoding] = limit;
      assert.equal(evaluateBundle(copy).failures.length, 0);
      copy.metrics[metric][encoding] += 1;
      assert.ok(evaluateBundle(copy).failures.some((message) => message.includes(`${metric} ${encoding}`)));
    }
  }
});

test('exact-revision, finite nonnegative metrics are required for comparisons', (context) => {
  const { root, graph } = fixture(context);
  const report = analyzeBundle(root, graph, REVISION);
  assert.equal(validateReference(report, REVISION), true);
  assert.equal(validateReference(report, 'b'.repeat(40)), false);
  for (const value of [null, {}, { ...report, version: 2 }, { ...report, metrics: {} }]) assert.equal(validateReference(value, REVISION), false);
  report.metrics.entry.raw = -1;
  assert.equal(validateReference(report, REVISION), false);
});

test('raw and level-6 gzip are measured separately; summary makes missing comparison explicit', (context) => {
  assert.ok(measureBytes(Buffer.from('repeat '.repeat(500))).gzip < 100);
  const { root, graph } = fixture(context);
  const report = analyzeBundle(root, graph, REVISION);
  const summary = renderBundleSummary(report, null, evaluateBundle(report));
  assert.match(summary, /comparison not performed/);
  assert.match(summary, /not measured transfer/);
  assert.match(summary, /\| initialJS \|/);
});

test('collector strips workspace and package-manager paths and writes outside dist', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-graph-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(normalizeModuleId(`${root}/web/src/App.tsx`, root), 'web/src/App.tsx');
  assert.equal(normalizeModuleId(`${root}/web/node_modules/.pnpm/monaco-editor@1/node_modules/monaco-editor/api.js?foo`, root), 'node_modules/monaco-editor/api.js');
  assert.equal(normalizeModuleId('\u0000vite/preload-helper', root), null);
  const plugin = bundleGraphPlugin(root);
  plugin.writeBundle({}, { 'assets/main.js': { type: 'chunk', fileName: 'assets/main.js', code: '42;', imports: [], dynamicImports: [], modules: { [`${root}/web/src/App.tsx`]: { renderedLength: 3 }, [`${root}/web/src/pages/UnusedPage.tsx`]: { renderedLength: 0 } } } });
  const graph = JSON.parse(fs.readFileSync(path.join(root, 'tmp/bundle/graph.json'), 'utf8'));
  assert.deepEqual(graph.chunks[0].modules, ['web/src/App.tsx']);
  assert.ok(!fs.existsSync(path.join(root, 'web/dist')));
  assert.deepEqual(walkStaticGraph(graph.chunks, ['assets/main.js']), ['assets/main.js']);
  assert.match(findLoadingViolations(graph.chunks, ['assets/main.js']).join('\n'), /Missing ConfigPage/);
});

test('CLI failure replaces old success evidence when graph validation throws', (context) => {
  const { root } = fixture(context);
  fs.mkdirSync(path.join(root, 'tmp/bundle'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tmp/bundle/report.json'), '{"old":"success"}');
  const hasPassed = runBundleVerification({ root, environment: {}, resolveRevision: () => REVISION, log: () => {}, warn: () => {} });
  assert.equal(hasPassed, false);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'tmp/bundle/report.json'), 'utf8'));
  assert.match(report.error, /Bundle verification failed/);
  assert.equal(report.old, undefined);
  assert.match(fs.readFileSync(path.join(root, 'tmp/bundle/summary.md'), 'utf8'), /FAIL/);
  assert.equal(validateReference(report, REVISION), false);
});

test('missing or empty local base reference does not disable the bundle gate', (context) => {
  const { root, graph } = fixture(context);
  fs.mkdirSync(path.join(root, 'tmp/bundle'), { recursive: true });
  fs.mkdirSync(path.join(root, 'web'));
  fs.renameSync(path.join(root, 'assets'), path.join(root, 'web/assets'));
  const dist = path.join(root, 'web/dist');
  fs.mkdirSync(dist);
  fs.renameSync(path.join(root, 'web/assets'), path.join(dist, 'assets'));
  fs.renameSync(path.join(root, 'index.html'), path.join(dist, 'index.html'));
  fs.writeFileSync(path.join(root, 'tmp/bundle/graph.json'), JSON.stringify(graph));
  for (const environment of [{}, { BUNDLE_BASE_SHA: '' }]) {
    const calls = [];
    const warnings = [];
    const hasPassed = runBundleVerification({ root, environment,
      resolveRevision: reference => { calls.push(reference); return REVISION; },
      log: () => {}, warn: message => warnings.push(message) });
    assert.equal(hasPassed, true);
    assert.deepEqual(calls, environment.BUNDLE_BASE_SHA === undefined ? ['HEAD', 'origin/master'] : ['HEAD']);
    assert.ok(warnings.some(message => message.includes('unavailable')));
    if (environment.BUNDLE_BASE_SHA === undefined) assert.ok(warnings.some(message => message.includes('own baseline')));
  }
});

test('missing ConfigPage ownership cannot silently disable the editor boundary', (context) => {
  const { root, graph } = fixture(context);
  graph.chunks[2].modules = ['web/src/pages/RenamedConfig.tsx'];
  assert.match(evaluateBundle(analyzeBundle(root, graph, REVISION)).failures.join('\n'), /Missing ConfigPage/);
});

test('deferred stylesheet references are validated without inflating startup CSS', (context) => {
  const { root, graph } = fixture(context);
  const stylesheet = 'assets/page.css';
  fs.writeFileSync(path.join(root, stylesheet), '.page{opacity:1}');
  graph.chunks[2].css = [stylesheet];
  const report = analyzeBundle(root, graph, REVISION);
  assert.equal(report.metrics.initialCSS.raw, 6);
  assert.ok(report.files[stylesheet].raw > 0);
  assert.ok(!report.initialCSS.includes(stylesheet));
  fs.unlinkSync(path.join(root, stylesheet));
  assert.throws(() => analyzeBundle(root, graph, REVISION), /Missing built resource: assets\/page\.css/);
});
