import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestCase, TestResult } from '@playwright/test/reporter';
import ProbeReporter from './testing/probe-reporter.ts';

test('timing damage overrides an otherwise passing native result and retains invalid bytes', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'omc-native-reporter-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'timings.json');
  const testCase = { title: 'claim', annotations: [{ type: 'scenario', description: 'claim' }] } as TestCase;
  const result = { status: 'passed', duration: 1, steps: [] } as unknown as TestResult;
  const healthy = new ProbeReporter({ file });
  healthy.onTestEnd(testCase, result);
  assert.equal(await healthy.onEnd(), undefined);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [{ id: 'claim', durationMs: 1, status: 'passed', steps: [] }]);

  writeFileSync(file, '{damaged evidence');
  const report = new ProbeReporter({ file });
  const log = context.mock.method(console, 'error', () => {});
  report.onTestEnd(testCase, result);
  assert.deepEqual(await report.onEnd(), { status: 'failed' });
  assert.equal(log.mock.callCount(), 1);
  assert.equal(readFileSync(`${file}.invalid`, 'utf8'), '{damaged evidence');
});
