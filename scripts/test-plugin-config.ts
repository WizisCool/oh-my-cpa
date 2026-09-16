import assert from 'node:assert/strict';
import { parsePluginConfig, pluginConfigsEqual, pluginConfigSummary } from '../web/src/components/plugins/pluginConfig.ts';

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
