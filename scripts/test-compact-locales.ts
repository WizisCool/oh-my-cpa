import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactEnglishCatalogPlugin } from './compact-locales.mjs';
import source from '../web/src/i18n/locales/zh/index.ts';
import english from '../web/src/i18n/locales/en/index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const plugin = compactEnglishCatalogPlugin(root);
const englishIndex = path.join(root, 'web/src/i18n/locales/en/index.ts');

// Only the English index is reshaped; every other module is left to Vite and to the type checker.
assert.equal(plugin.load(path.join(root, 'web/src/i18n/locales/ms/index.ts')), null);

const code = plugin.load(englishIndex);
assert.ok(typeof code === 'string', 'the English index is replaced at build time');

/** The emitted module with the source catalog injected, so it can be read without Vite. */
function compiled() {
  const evaluable = code
    .replace(/^import source from '\.\.\/zh';$/m, 'const source = __SOURCE__;')
    .replace(/^export default /m, 'module.exports.default = ');
  assert.ok(evaluable.includes('const source = __SOURCE__;'), 'the emitted module imports the source catalog for its ids');
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('__SOURCE__', 'exports', 'module', evaluable)(source, module.exports, module);
  return module.exports.default;
}

const catalog = compiled();
const ids = Object.keys(source);

// Alignment is the whole point: an id and its sentence come from the same two modules, in the
// order the source declares. Reading the domain files in another order - by name, say - produced a
// console whose English sentences belonged to the wrong ids, and only the built demo noticed.
assert.deepEqual(Object.keys(catalog), ids, 'the built catalog follows the source catalog order');
assert.equal(Object.keys(catalog).length, Object.keys(english).length);
for (const id of ids) assert.equal(typeof catalog[id], 'string', `${id} has a sentence`);

// A sample across areas, chosen wherever the two orders differ, so a re-sorted catalog fails here.
for (const id of ['route_error.copy', 'common.save', 'sys.action_vacuum_short', 'agent.capability.providers_list', 'events.clear_all']) {
  assert.equal(catalog[id], english[id], `${id} keeps its own English sentence`);
}
assert.notEqual(catalog['sys.action_vacuum_short'], english['sys.checkpoint_desc']);
