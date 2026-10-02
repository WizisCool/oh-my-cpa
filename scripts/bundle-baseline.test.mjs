import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadBundleReference, selectBaselineRun } from './bundle-baseline.mjs';

const REVISION = 'a'.repeat(40);
function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-reference-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  const reference = { version: 1, revision: REVISION, metrics: Object.fromEntries(['entry', 'initialJS', 'initialCSS', 'largestJS', 'totalJS', 'totalDist', 'lobeSVG'].map((metric) => [metric, { raw: 100, gzip: 30 }])) };
  const logs = [];
  return { root, reference, logs, options: { root, revision: REVISION, repository: 'owner/repo', token: 'fixture', log: (message) => logs.push(message) } };
}

test('baseline selection only accepts successful push runs for the exact revision', () => {
  const matching = { id: 1, head_sha: REVISION, event: 'push', conclusion: 'success' };
  const runs = [matching, { ...matching, id: 2 }, { ...matching, id: 3, event: 'pull_request' }, { ...matching, id: 4, head_sha: 'b'.repeat(40) }, { ...matching, id: 5, conclusion: 'failure' }];
  assert.equal(selectBaselineRun(runs, REVISION).id, 2);
  assert.equal(selectBaselineRun(runs, 'c'.repeat(40)), undefined);
});

test('bootstrap reference is used only for its recorded commit without accessing GitHub', (context) => {
  const { root, reference, options } = fixture(context);
  fs.writeFileSync(path.join(root, 'scripts/bundle-reference.json'), JSON.stringify(reference));
  assert.deepEqual(loadBundleReference({ ...options, run: () => assert.fail('must not access GitHub') }), reference);
  assert.equal(loadBundleReference({ ...options, revision: 'b'.repeat(40), token: null }), null);
});

test('explicit local references fail on wrong revision or invalid metrics', (context) => {
  const { root, reference, options } = fixture(context);
  const file = path.join(root, 'local.json');
  fs.writeFileSync(file, JSON.stringify(reference));
  assert.deepEqual(loadBundleReference({ ...options, file }), reference);
  assert.throws(() => loadBundleReference({ ...options, file, revision: 'b'.repeat(40) }), /does not match/);
  reference.metrics.entry.raw = '100';
  fs.writeFileSync(file, JSON.stringify(reference));
  assert.throws(() => loadBundleReference({ ...options, file }), /schema/);
});

test('exact-base artifact download is validated and ignores other workflow events', (context) => {
  const { root, reference, options } = fixture(context);
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'run') {
      fs.writeFileSync(path.join(args.at(-1), 'report.json'), JSON.stringify(reference));
      return '';
    }
    if (args[2]?.endsWith('/artifacts') || args[1]?.endsWith('/artifacts')) return JSON.stringify({ artifacts: [{ name: 'bundle-report', expired: false }] });
    return JSON.stringify({ workflow_runs: [{ id: 7, head_sha: REVISION, event: 'push', conclusion: 'success' }] });
  };
  assert.deepEqual(loadBundleReference({ ...options, run }), reference);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].includes(`head_sha=${REVISION}`));
  assert.equal(calls[2][2], '7');
  assert.ok(fs.existsSync(path.join(root, 'tmp/bundle/reference/report.json')));
});

test('missing, expired or malformed remote baselines are explicitly unavailable, not guessed', (context) => {
  const { options, logs } = fixture(context);
  for (const run of [
    () => { throw new Error('network'); },
    () => JSON.stringify({ workflow_runs: [] }),
    (args) => args.includes('--method') ? JSON.stringify({ workflow_runs: [{ id: 7, head_sha: REVISION, event: 'push', conclusion: 'success' }] }) : JSON.stringify({ artifacts: [{ name: 'bundle-report', expired: true }] }),
  ]) assert.equal(loadBundleReference({ ...options, run }), null);
  assert.equal(logs.length, 3);
  assert.ok(logs.every((message) => message.includes('comparison not performed')));
  assert.equal(loadBundleReference({ ...options, revision: 'untrusted' }), null);
});
