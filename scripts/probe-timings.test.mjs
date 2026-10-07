import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendProbeTiming } from './acceptance/probe-timings.mjs';

test('timing evidence appends across batches and corruption remains an explicit failure', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-probe-timings-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'timings.json');
  const first = { id: 'first', durationMs: 1, status: 'passed' };
  const second = { id: 'second', durationMs: 2, status: 'failed' };
  assert.equal(appendProbeTiming(filename, first), undefined);
  assert.equal(appendProbeTiming(filename, second), undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename)), [first, second]);
  fs.writeFileSync(filename, '{damaged evidence');
  assert.ok(appendProbeTiming(filename, first) instanceof Error);
  assert.equal(fs.readFileSync(`${filename}.invalid`, 'utf8'), '{damaged evidence');
  assert.deepEqual(JSON.parse(fs.readFileSync(filename)), [first]);
  fs.writeFileSync(filename, '{}');
  assert.match(appendProbeTiming(filename, second).message, /array/);
  assert.equal(fs.readFileSync(`${filename}.invalid`, 'utf8'), '{damaged evidence');
});
