import assert from 'node:assert/strict';
import test from 'node:test';
import { findLoadingViolations, walkStaticGraph } from './bundle-report.mjs';

function makeChunk(file, modules, { imports = [], dynamicImports = [] } = {}) {
  return { file, modules, imports, dynamicImports, css: [] };
}

function validGraph() {
  return [
    makeChunk('assets/index.js', ['web/src/main.tsx', 'web/src/App.tsx'], {
      dynamicImports: ['assets/AppLayout.js', 'assets/ConfigPage.js', 'assets/sandbox.js'],
    }),
    makeChunk('assets/AppLayout.js', ['web/src/components/common/AppLayout.tsx', 'web/src/components/common/HeaderNav.tsx'], {
      imports: ['assets/index.js'],
      dynamicImports: ['assets/sandbox.js'],
    }),
    makeChunk('assets/ConfigPage.js', ['web/src/pages/ConfigPage.tsx'], {
      imports: ['assets/index.js'],
      dynamicImports: ['assets/YamlSourceEditor.js'],
    }),
    makeChunk('assets/YamlSourceEditor.js', [
      'web/src/components/config/YamlSourceEditor.tsx',
      'node_modules/monaco-editor/esm/vs/editor/editor.api.js',
    ]),
    makeChunk('assets/sandbox.js', ['web/src/demo/sandbox.ts']),
  ];
}

test('allows deferred demo sandbox and YAML editor when reached only through dynamic imports', () => {
  const chunks = validGraph();
  const initialFiles = walkStaticGraph(chunks, ['assets/index.js']);
  assert.deepEqual(findLoadingViolations(chunks, initialFiles), []);
});

test('rejects web/src/demo/sandbox.ts in the initial startup graph', () => {
  const chunks = validGraph();
  chunks[0] = makeChunk('assets/index.js', ['web/src/main.tsx', 'web/src/App.tsx'], {
    imports: ['assets/sandbox.js'],
    dynamicImports: ['assets/AppLayout.js', 'assets/ConfigPage.js'],
  });
  const initialFiles = walkStaticGraph(chunks, ['assets/index.js']);
  const violations = findLoadingViolations(chunks, initialFiles);
  assert.ok(
    violations.some((entry) => entry.includes('web/src/demo/sandbox.ts is eager through assets/sandbox.js')),
    `expected eager sandbox violation, got: ${JSON.stringify(violations)}`,
  );
});

test('rejects AppLayout statically reaching web/src/demo/sandbox.ts directly or transitively', () => {
  const directChunks = validGraph();
  directChunks[1] = makeChunk('assets/AppLayout.js', ['web/src/components/common/AppLayout.tsx', 'web/src/components/common/HeaderNav.tsx'], {
    imports: ['assets/index.js', 'assets/sandbox.js'],
  });
  const directViolations = findLoadingViolations(directChunks, ['assets/index.js']);
  assert.deepEqual(directViolations, [
    'web/src/demo/sandbox.ts loads with AppLayout instead of the on-demand demo sandbox through assets/sandbox.js',
  ]);

  const transitiveChunks = [
    ...validGraph().filter((chunk) => chunk.file !== 'assets/AppLayout.js'),
    makeChunk('assets/AppLayout.js', ['web/src/components/common/AppLayout.tsx'], {
      imports: ['assets/index.js', 'assets/HeaderNav.js'],
    }),
    makeChunk('assets/HeaderNav.js', ['web/src/components/common/HeaderNav.tsx'], {
      imports: ['assets/sandbox.js'],
    }),
  ];
  const transitiveViolations = findLoadingViolations(transitiveChunks, ['assets/index.js']);
  assert.deepEqual(transitiveViolations, [
    'web/src/demo/sandbox.ts loads with AppLayout instead of the on-demand demo sandbox through assets/sandbox.js',
  ]);
});

test('fails closed when AppLayout or ConfigPage module ownership is missing', () => {
  const chunksWithoutAppLayout = validGraph().filter((chunk) => chunk.file !== 'assets/AppLayout.js');
  const violations = findLoadingViolations(chunksWithoutAppLayout, ['assets/index.js']);
  assert.ok(
    violations.some((entry) => entry.includes('Missing AppLayout module ownership')),
    `expected missing AppLayout ownership violation, got: ${JSON.stringify(violations)}`,
  );
});

test('rejects ConfigPage statically importing the YAML editor or monaco-editor', () => {
  const chunks = validGraph();
  chunks[2] = makeChunk('assets/ConfigPage.js', ['web/src/pages/ConfigPage.tsx'], {
    imports: ['assets/index.js', 'assets/YamlSourceEditor.js'],
  });
  const violations = findLoadingViolations(chunks, ['assets/index.js']);
  assert.equal(violations.length, 2);
  assert.ok(violations.some((entry) => entry.includes('web/src/components/config/YamlSourceEditor.tsx loads with ConfigPage')));
  assert.ok(violations.some((entry) => entry.includes('node_modules/monaco-editor/esm/vs/editor/editor.api.js loads with ConfigPage')));
});
