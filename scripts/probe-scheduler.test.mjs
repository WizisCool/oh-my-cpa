import assert from 'node:assert/strict';
import test from 'node:test';
import { runScenarioQueue } from './acceptance/probe-scheduler.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

test('the serial default retains catalog order and does not overlap tasks', async () => {
  const seen = [];
  let isRunning = false;
  await runScenarioQueue([1, 2, 3], async id => {
    assert.equal(isRunning, false);
    isRunning = true;
    await Promise.resolve();
    seen.push(id);
    isRunning = false;
  });
  assert.deepEqual(seen, [1, 2, 3]);
});

test('two workers are bounded, visit each scenario once and join admitted work', async () => {
  const ready = deferred();
  const release = deferred();
  const seen = [];
  let active = 0;
  let maximum = 0;
  const run = runScenarioQueue([1, 2, 3, 4], async id => {
    active++;
    maximum = Math.max(maximum, active);
    seen.push(id);
    if (seen.length === 2) ready.resolve();
    await release.promise;
    active--;
  }, { concurrency: 2 });
  await ready.promise;
  assert.deepEqual(seen, [1, 2]);
  assert.equal(active, 2);
  release.resolve();
  await run;
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4]);
});

test('shutdown stops queue admission without abandoning already owned tasks', async () => {
  const ready = deferred();
  const release = deferred();
  const seen = [];
  let shouldStop = false;
  const run = runScenarioQueue([1, 2, 3], async id => {
    seen.push(id);
    if (seen.length === 2) ready.resolve();
    await release.promise;
  }, { concurrency: 2, shouldStop: () => shouldStop });
  await ready.promise;
  shouldStop = true;
  release.resolve();
  await run;
  assert.deepEqual(seen, [1, 2]);
});

test('a worker error joins its peer before returning a failing verdict', async () => {
  const ready = deferred();
  const release = deferred();
  let hasJoined = false;
  const run = runScenarioQueue([1, 2], async id => {
    if (id === 1) throw new Error('injected worker failure');
    ready.resolve();
    await release.promise;
    hasJoined = true;
  }, { concurrency: 2 });
  const failure = assert.rejects(run, error => error instanceof AggregateError && error.errors[0].message === 'injected worker failure');
  await ready.promise;
  assert.equal(hasJoined, false);
  release.resolve();
  await failure;
  assert.equal(hasJoined, true);
});

test('empty queues admit no work; invalid concurrency is refused before admission', async () => {
  let calls = 0;
  const run = async () => { calls++; };
  await runScenarioQueue([], run, { concurrency: 2 });
  for (const concurrency of [0, 3, -1, NaN, '2']) await assert.rejects(runScenarioQueue([1], run, { concurrency }), /one or two/);
  assert.equal(calls, 0);
});

test('a scenario that runs alone waits for the shared queue and has no sibling', async () => {
  const alone = { id: 'alone', shouldRunAlone: true };
  const seen = [];
  let active = 0;
  let activeBesideAlone = 0;
  await runScenarioQueue([1, alone, 2, 3], async scenario => {
    active++;
    seen.push(scenario === alone ? 'alone' : scenario);
    if (scenario === alone) activeBesideAlone = active - 1;
    await Promise.resolve();
    active--;
  }, { concurrency: 2 });
  assert.equal(seen.at(-1), 'alone');
  assert.equal(activeBesideAlone, 0);
  assert.deepEqual(seen.slice(0, 3).sort(), [1, 2, 3]);
});

test('a shared failure still runs the scenarios that run alone, and both errors are reported', async () => {
  const alone = { id: 'alone', shouldRunAlone: true };
  const seen = [];
  const run = runScenarioQueue([1, alone], async scenario => {
    seen.push(scenario === alone ? 'alone' : scenario);
    throw new Error(scenario === alone ? 'alone failed' : 'shared failed');
  }, { concurrency: 2 });
  await assert.rejects(run, error => error instanceof AggregateError
    && error.errors.map(cause => cause.message).join() === 'shared failed,alone failed');
  assert.deepEqual(seen, [1, 'alone']);
});
