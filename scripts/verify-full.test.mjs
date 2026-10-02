import assert from 'node:assert/strict';
import test from 'node:test';
import { runFullVerification } from './verify-full.mjs';

async function runFixture(failedLabels, isSerial = false) {
  const groups = [];
  const hasPassed = await runFullVerification({ isSerial, execute: async (checks) => {
    groups.push(checks.map((check) => check.label));
    return checks.every((check) => !failedLabels.includes(check.label));
  } });
  return { hasPassed, groups, labels: groups.flat() };
}

test('bundle failure remains blocking but still collects browser, probes and demo evidence', async () => {
  for (const isSerial of [false, true]) {
    const result = await runFixture(['bundle'], isSerial);
    assert.equal(result.hasPassed, false);
    assert.deepEqual(result.labels.slice(-4), ['bundle', 'browser', 'probes', 'demo']);
  }
});

test('browser failures still allow independent demo evidence and cannot become green', async () => {
  const result = await runFixture(['browser']);
  assert.equal(result.hasPassed, false);
  assert.equal(result.labels.at(-1), 'demo');
});

test('unsafe or incomplete prerequisites stop all serving phases', async () => {
  for (const label of ['toolchain', 'static', 'history-secrets', 'build', 'worktree-secrets']) {
    const result = await runFixture([label]);
    assert.equal(result.hasPassed, false);
    assert.ok(!result.labels.includes('browser'));
    assert.ok(!result.labels.includes('bundle'));
  }
});

test('serial and parallel gates cover the same commands, passing only when every verdict passes', async () => {
  const parallel = await runFixture([]);
  const serial = await runFixture([], true);
  assert.equal(parallel.hasPassed, true);
  assert.equal(serial.hasPassed, true);
  assert.deepEqual(parallel.labels.flatMap((label) => label === 'static' ? ['static-go', 'static-frontend', 'static-repository'] : [label]), serial.labels);
  assert.ok(serial.groups.every((group) => group.length === 1));
  assert.ok(parallel.groups.some((group) => group.length > 1));
  assert.equal((await runFixture(['demo'])).hasPassed, false);
});

test('serial fallback also serializes the static sub-gates', async () => {
  const commands = [];
  assert.equal(await runFullVerification({ isSerial: true, execute: async (checks) => {
    commands.push(...checks.map((check) => check.args.join(' ')));
    return true;
  } }), true);
  assert.ok(!commands.includes('verify:static'));
  assert.ok(commands.includes('verify:static:go'));
  assert.ok(commands.includes('verify:static:frontend'));
  assert.ok(commands.includes('verify:static:repository'));
});
