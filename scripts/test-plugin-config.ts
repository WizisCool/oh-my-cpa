import assert from 'node:assert/strict';
import { parsePluginConfig, pluginConfigsEqual, pluginConfigSummary } from '../web/src/components/plugins/pluginConfig.ts';
import {
  buildPluginConfigDraft,
  composePluginConfig,
  isPluginFieldChanged,
  pluginFieldKind,
  undeclaredPluginKeys,
} from '../web/src/components/plugins/pluginConfigForm.ts';
import {
  filterStorePlugins,
  normalizePluginSettingsDraft,
  storeFilterCounts,
  storeListingsByPluginId,
  validatePluginSettingsDraft,
} from '../web/src/components/plugins/pluginStoreLogic.ts';
import type { PluginConfigField, StorePluginItem } from '../web/src/types/plugin.ts';

assert.equal(parsePluginConfig('').error, 'object-required');
assert.deepEqual(parsePluginConfig('{"level":"info"}'), { value: { level: 'info' } });
assert.equal(parsePluginConfig('[]').error, 'object-required');
assert.equal(parsePluginConfig('null').error, 'object-required');
assert.equal(parsePluginConfig('{oops').error, 'invalid-json');

// A repeated member is refused rather than silently resolved to its last value: the
// submitted object has to be the text the operator reviewed and the preview showed.
assert.deepEqual(parsePluginConfig('{"level":"info","level":"debug"}'), { error: 'duplicate-key', key: 'level' });
assert.deepEqual(
  parsePluginConfig('{"retry":{"count":1,"count":2}}'),
  { error: 'duplicate-key', key: 'count' },
);
assert.deepEqual(
  parsePluginConfig('{"a":[{"b":1},{"b":2}]}'),
  { value: { a: [{ b: 1 }, { b: 2 }] } },
);
assert.deepEqual(parsePluginConfig('{"a":1,"b":{"a":2}}'), { value: { a: 1, b: { a: 2 } } });
// Escaping must not hide a repeated name: both members decode to `a`.
assert.deepEqual(parsePluginConfig('{"\\u0061":1,"a":2}'), { error: 'duplicate-key', key: 'a' });
// An escaped quote inside a name is part of the name, not the end of the string.
assert.deepEqual(
  parsePluginConfig('{"a\\"b":1,"a\\"b":2}'),
  { error: 'duplicate-key', key: 'a"b' },
);
assert.deepEqual(parsePluginConfig('{"text":"}\\"","text2":1}'), { value: { text: '}"', text2: 1 } });
assert.equal(pluginConfigsEqual({ z: 1, a: { y: 2, x: 3 } }, { a: { x: 3, y: 2 }, z: 1 }), true);
assert.equal(pluginConfigsEqual({ z: 1 }, { z: 2 }), false);

assert.deepEqual(
  pluginConfigSummary({ z: 1, a: true, list: [1, 2], none: null }),
  [
    { key: 'a', type: 'boolean' },
    { key: 'list', type: 'array[2]' },
    { key: 'none', type: 'null' },
    { key: 'z', type: 'number' },
  ],
);

console.log('plugin config parsing and structure summaries passed.');

// ── the settings form ──────────────────────────────────────────────────────
const FIELDS: PluginConfigField[] = [
  { name: 'level', type: 'enum', enum_values: ['debug', 'info'] },
  { name: 'rate', type: 'number' },
  { name: 'retries', type: 'integer' },
  { name: 'verbose', type: 'boolean' },
  { name: 'headers', type: 'array' },
  { name: 'matrix', type: 'array' },
  { name: 'labels', type: 'object' },
  { name: 'note', type: 'string' },
];

assert.equal(pluginFieldKind({ name: 'x', type: 'enum', enum_values: [] }), 'string');
assert.equal(pluginFieldKind({ name: 'x', type: 'mystery' }), 'string');
assert.equal(pluginFieldKind({ name: 'x', type: 'INTEGER' }), 'integer');

const SAVED = {
  enabled: true,
  level: 'info',
  rate: 0.5,
  headers: ['authorization'],
  matrix: [[1, 2]],
  labels: { team: 'a' },
  legacy: 'kept',
};
const draft = buildPluginConfigDraft(FIELDS, SAVED, false);
assert.equal(draft.enabled, true);
assert.equal(draft.fields.level.text, 'info');
// A list of strings is edited as tags, any other array as JSON.
assert.equal(draft.fields.headers.isList, true);
assert.equal(draft.fields.matrix.isList, false);
assert.equal(draft.fields.retries.isSet, false);
assert.deepEqual(undeclaredPluginKeys(SAVED, FIELDS), ['legacy']);

// An untouched draft composes back to exactly the saved document, undeclared keys included.
assert.deepEqual(composePluginConfig(draft, FIELDS, SAVED), { value: SAVED, errors: {} });

// An absent `enabled` is not written until it changes, so opening the editor is not an edit.
const bare = buildPluginConfigDraft(FIELDS, {}, true);
assert.deepEqual(composePluginConfig(bare, FIELDS, {}).value, {});
assert.deepEqual(composePluginConfig({ ...bare, enabled: false }, FIELDS, {}).value, { enabled: false });

// An undeclared key spelled `__proto__` is carried through as a key, not as a prototype.
const protoSaved = JSON.parse('{"__proto__":{"polluted":true},"level":"info"}') as Record<string, unknown>;
const protoComposed = composePluginConfig(buildPluginConfigDraft(FIELDS, protoSaved, false), FIELDS, protoSaved).value!;
assert.equal(Object.prototype.hasOwnProperty.call(protoComposed, '__proto__'), true);
assert.equal(Object.getPrototypeOf(protoComposed), Object.prototype);
assert.equal(JSON.stringify(protoComposed), '{"__proto__":{"polluted":true},"level":"info"}');

// Typed values are written with their types; clearing a field removes its key.
const edited = {
  ...draft,
  priority: '5',
  fields: {
    ...draft.fields,
    rate: { ...draft.fields.rate, text: '2.5' },
    retries: { ...draft.fields.retries, isSet: true, text: '3' },
    verbose: { ...draft.fields.verbose, isSet: true, checked: true },
    labels: { ...draft.fields.labels, isSet: false },
  },
};
assert.deepEqual(composePluginConfig(edited, FIELDS, SAVED).value, {
  enabled: true, priority: 5, level: 'info', rate: 2.5, retries: 3, verbose: true,
  headers: ['authorization'], matrix: [[1, 2]], legacy: 'kept',
});
assert.equal(isPluginFieldChanged(FIELDS[1], edited.fields.rate, SAVED), true);
assert.equal(isPluginFieldChanged(FIELDS[0], edited.fields.level, SAVED), false);
assert.equal(isPluginFieldChanged(FIELDS[6], edited.fields.labels, SAVED), true);

// Invalid values are reported per field and no document is produced.
const broken = {
  ...draft,
  priority: '1.5',
  fields: {
    ...draft.fields,
    level: { ...draft.fields.level, text: 'trace' },
    retries: { ...draft.fields.retries, isSet: true, text: '3.2' },
    matrix: { ...draft.fields.matrix, text: '{"a":1}' },
    labels: { ...draft.fields.labels, text: '[1' },
  },
};
assert.deepEqual(composePluginConfig(broken, FIELDS, SAVED), {
  errors: { priority: 'invalid-integer', level: 'invalid-enum', retries: 'invalid-integer', matrix: 'expected-array', labels: 'invalid-json' },
});

// ── the store ──────────────────────────────────────────────────────────────
function entry(overrides: Partial<StorePluginItem>): StorePluginItem {
  return {
    store_id: 'official/x', source_id: 'official', source_name: 'official', id: 'x', name: 'X', tags: [], platforms: [],
    is_official: true, auth_required: false, auth_configured: false, installed: false, effective_enabled: false,
    update_available: false, ...overrides,
  };
}
const STORE = [
  entry({ store_id: 'official/limiter', id: 'limiter', name: 'Rate Limiter', tags: ['network'] }),
  entry({ store_id: 'official/logger', id: 'logger', name: 'Logger', installed: true, update_available: true, install_source_status: 'matched' }),
  entry({ store_id: 'mirror/logger', source_id: 'mirror', id: 'logger', name: 'Logger', is_official: false, installed: true, install_source_status: 'different', description: 'mirror copy' }),
];
assert.deepEqual(storeFilterCounts(STORE), { all: 3, installed: 2, available: 1, updates: 1 });
assert.deepEqual(filterStorePlugins(STORE, 'NETWORK', 'all').map((item) => item.store_id), ['official/limiter']);
assert.deepEqual(filterStorePlugins(STORE, '', 'updates').map((item) => item.store_id), ['official/logger']);
// The listing an installed card borrows is the one it was installed from.
assert.equal(storeListingsByPluginId(STORE).get('logger')?.store_id, 'official/logger');

// ── plugin system settings ─────────────────────────────────────────────────
assert.deepEqual(
  validatePluginSettingsDraft(
    ['https://a.example/r.json', '', 'ftp://b.example', 'https://a.example/r.json'],
    [
      { match: '', apply_to: [], type: 'none', allow_insecure: false },
      { match: 'https://x/', apply_to: [], type: 'basic', username_env: 'USER', password_env: 'bad name', allow_insecure: false },
      { match: 'https://x/', apply_to: [], type: 'header', header_name: 'bad header', header_value_env: 'V', allow_insecure: false },
    ],
  ),
  [
    { kind: 'source-url', index: 2 },
    { kind: 'source-duplicate', index: 3 },
    { kind: 'rule-match', index: 0 },
    { kind: 'rule-env', index: 1, field: 'password_env' },
    { kind: 'rule-header', index: 2 },
  ],
);
// Switching a rule's type drops the variables the new type does not read.
assert.deepEqual(
  normalizePluginSettingsDraft([' https://a.example/r.json ', ''], [
    { match: ' https://x/ ', apply_to: ['artifact', 'registry'], type: 'bearer', token_env: 'T', username_env: 'STALE', allow_insecure: false },
  ]),
  {
    storeSources: ['https://a.example/r.json'],
    storeAuth: [{
      match: 'https://x/', apply_to: ['registry', 'artifact'], type: 'bearer', token_env: 'T',
      username_env: undefined, password_env: undefined, header_name: undefined, header_value_env: undefined, allow_insecure: false,
    }],
  },
);

console.log('plugin settings form, store filters and plugin system settings passed.');
