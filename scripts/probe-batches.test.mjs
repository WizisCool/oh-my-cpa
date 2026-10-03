import assert from 'node:assert/strict';
import test from 'node:test';
import { runProbeBatches } from './acceptance/probe-batches.mjs';
import { SCENARIOS } from './acceptance/scenarios.mjs';

const catalog = SCENARIOS.map(({ id }) => ({ id }));

test('complete local catalogs cover every scenario exactly once in sequential bounded batches', async () => {
  const calls = [];
  let isRunning = false;
  const result = await runProbeBatches({ port: 5181, scenarios: catalog, batchCount: 3 }, async (options) => {
    assert.equal(isRunning, false, 'batches never share a running browser');
    isRunning = true;
    assert.equal(options.port, 5181);
    assert.equal(options.watchdogMs, undefined, 'the existing runner owns its unchanged watchdog');
    assert.equal(options.shouldResetDiagnostics, calls.length === 0, 'later batches preserve earlier failure artifacts');
    calls.push(options.scenarios.map(({ id }) => id));
    await Promise.resolve();
    isRunning = false;
    return { passed: options.scenarios.length, failures: [] };
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.flat().sort(), catalog.map(({ id }) => id).sort());
  assert.equal(new Set(calls.flat()).size, catalog.length);
  assert.deepEqual(result, { passed: catalog.length, failures: [] });
});

test('explicit shards and focused runs retain their order and one runner invocation', async () => {
  const focused = catalog.slice(0, 2);
  const calls = [];
  const result = await runProbeBatches({ port: 5180, scenarios: focused }, async (options) => {
    calls.push(options.scenarios);
    return { passed: 2, failures: [] };
  });
  assert.deepEqual(calls, [focused]);
  assert.equal(result.passed, 2);
});

test('failed batches remain failed while later batches still provide evidence, without retry', async () => {
  const calls = [];
  const result = await runProbeBatches({ scenarios: catalog, batchCount: 3 }, async ({ scenarios }) => {
    calls.push(scenarios);
    return calls.length === 1
      ? { passed: scenarios.length - 1, failures: ['first failure'] }
      : { passed: scenarios.length, failures: [] };
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(result, { passed: catalog.length - 1, failures: ['first failure'] });
});

test('empty inputs start no browser and duplicate identities are refused', async () => {
  let calls = 0;
  const execute = async () => { calls += 1; return { passed: 0, failures: [] }; };
  assert.deepEqual(await runProbeBatches({ scenarios: [], batchCount: 3 }, execute), { passed: 0, failures: [] });
  assert.equal(calls, 0);
  await assert.rejects(runProbeBatches({ scenarios: [{ id: 'duplicate' }, { id: 'duplicate' }] }, execute), /unique scenario IDs/);
  assert.equal(calls, 0);
});
