import assert from 'node:assert/strict';
import { parsePluginConfig, pluginConfigSummary } from '../web/src/components/plugins/pluginConfig.ts';

assert.deepEqual(parsePluginConfig(''), { value: {} });
assert.deepEqual(parsePluginConfig('{"level":"info"}'), { value: { level: 'info' } });
assert.equal(parsePluginConfig('[]').error, 'object-required');
assert.equal(parsePluginConfig('null').error, 'object-required');
assert.equal(parsePluginConfig('{oops').error, 'invalid-json');

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
