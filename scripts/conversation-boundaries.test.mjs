import assert from 'node:assert/strict';
import test from 'node:test';
import { buildImporterGraph } from './acceptance/ui-impact.mjs';

const PLAYGROUND_STATE = 'web/src/pages/playground/state.ts';
const CONVERSATION_LEAVES = new Set([
  'web/src/utils/ids.ts',
  'web/src/utils/thinking.ts',
  'web/src/types/requestModel.ts',
  'web/src/components/workspace/imageAttachments.ts',
]);

function findBoundaryViolations({ importers }) {
  const violations = new Set();
  for (const [dependency, owners] of importers) {
    for (const owner of owners) {
      if (dependency === PLAYGROUND_STATE && !owner.startsWith('web/src/pages/playground/')) {
        violations.add(`${owner} -> ${dependency}`);
      }
      if (CONVERSATION_LEAVES.has(owner) && dependency.startsWith('web/src/pages/')) {
        violations.add(`${owner} -> ${dependency}`);
      }
    }
  }
  return [...violations];
}

function graphOf(sources) {
  return buildImporterGraph({ files: Object.keys(sources), readFile: file => sources[file] });
}

test('conversation boundaries detect eager and lazy page-state dependencies, not erased types', () => {
  const sources = {
    [PLAYGROUND_STATE]: 'export const createID = () => "id"; export interface Turn { id: string }',
    'web/src/agent/snapshot.ts': `import type { Turn } from '../pages/playground/state'; export const snapshot = (turn: Turn) => turn.id;`,
    'web/src/pages/agent/run.ts': `export { createID } from '../playground/state';`,
    'web/src/utils/ids.ts': `export const createID = () => import('../pages/playground/state');`,
  };
  assert.deepEqual(findBoundaryViolations(graphOf(sources)).sort(), [
    `web/src/pages/agent/run.ts -> ${PLAYGROUND_STATE}`,
    `web/src/utils/ids.ts -> ${PLAYGROUND_STATE}`,
  ]);
  delete sources['web/src/pages/agent/run.ts'];
  sources['web/src/utils/ids.ts'] = 'export const createID = () => "id";';
  assert.deepEqual(findBoundaryViolations(graphOf(sources)), []);
});

test('the real runtime graph keeps shared conversation primitives below page state', () => {
  const graph = buildImporterGraph();
  assert.deepEqual(graph.unresolved, []);
  assert.ok(graph.importers.get(PLAYGROUND_STATE)?.size > 0, 'discover actual Playground consumers');
  assert.deepEqual(findBoundaryViolations(graph), []);
  for (const leaf of CONVERSATION_LEAVES) assert.ok(graph.importers.get(leaf)?.size > 0, `discover consumers of ${leaf}`);
});
