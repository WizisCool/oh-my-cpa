import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProbeOptions } from './acceptance/probe-options.mjs';

test('explicit probe ports change resource ownership without selecting less coverage', () => {
  assert.deepEqual(parseProbeOptions([]), { port: 5180, workers: 2 });
  assert.deepEqual(parseProbeOptions(['--port', '5183']), { port: 5183, workers: 2 });
  assert.deepEqual(parseProbeOptions(['--shard', '2/3', '--port', '5183']), { port: 5183, workers: 2, shard: { index: 2, count: 3 } });
  for (const arguments_ of [['--port'], ['--port', '0'], ['--port', '1023'], ['--port', '65536'], ['--port', '5180.1'], ['--port', '5180x'], ['--port', '5183', '--port', '5184'], ['--skip'], ['--shard']]) {
    assert.throws(() => parseProbeOptions(arguments_));
  }
});


test('bounded workers change scheduling, never shard membership or coverage', () => {
  const serial = parseProbeOptions(['--shard', '2/3', '--port', '5183', '--workers', '1']);
  const concurrent = parseProbeOptions(['--workers', '2', '--shard', '2/3', '--port', '5183']);
  assert.deepEqual(concurrent, { ...serial, workers: 2 });
  for (const values of [['--workers'], ['--workers','0'], ['--workers','3'], ['--workers','2.0'], ['--workers','two'], ['--workers','2','--workers','1']]) assert.throws(() => parseProbeOptions(values), /workers|duplicate/);
});
