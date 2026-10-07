import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProbeOptions } from './acceptance/probe-options.mjs';

test('explicit probe ports change resource ownership without selecting less coverage', () => {
  assert.deepEqual(parseProbeOptions([]), { port: 5180 });
  assert.deepEqual(parseProbeOptions(['--port', '5183']), { port: 5183 });
  assert.deepEqual(parseProbeOptions(['--shard', '2/3', '--port', '5183']), { port: 5183, shard: { index: 2, count: 3 } });
  for (const arguments_ of [['--port'], ['--port', '0'], ['--port', '1023'], ['--port', '65536'], ['--port', '5180.1'], ['--port', '5180x'], ['--port', '5183', '--port', '5184'], ['--skip'], ['--shard']]) {
    assert.throws(() => parseProbeOptions(arguments_));
  }
});
