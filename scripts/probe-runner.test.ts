import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import config from './testing/probe-config.ts';
import { validateProbeEvidence } from './testing/probes.ts';
import { SCENARIOS } from './acceptance/scenarios.mjs';

const PLAYWRIGHT = createRequire(import.meta.url).resolve('@playwright/test/cli');

test('native collection includes each catalog claim exactly once and keeps frame claims exclusive', () => {
  const ids = SCENARIOS.map(scenario => scenario.id);
  const collected: string[] = [];
  for (const phase of ['shared', 'exclusive']) {
    const result = spawnSync(process.execPath, [PLAYWRIGHT, 'test', '--config', 'scripts/testing/probe-config.ts', '--list', '--reporter=json'], {
      encoding: 'utf8',
      env: { ...process.env, OMC_PROBE_CATALOG: 'probes', OMC_PROBE_IDS: JSON.stringify(ids), OMC_PROBE_PHASE: phase },
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const suites = report.suites.flatMap((suite: { suites: { title: string }[] }) => suite.suites);
    const expected = SCENARIOS.filter(scenario => Boolean(scenario.shouldRunAlone) === (phase === 'exclusive')).map(scenario => scenario.id);
    assert.deepEqual(suites.map((suite: { title: string }) => suite.title), expected);
    collected.push(...expected);
  }
  assert.deepEqual(collected.sort(), ids.sort());
  assert.equal(config.retries, 0);
  assert.equal(config.forbidOnly, true);
});

test('missing, corrupt, duplicate or foreign timing evidence cannot produce a passing gate', () => {
  const first = { id: 'first', status: 'passed', durationMs: 1 };
  const second = { id: 'second', status: 'failed', durationMs: 2 };
  assert.doesNotThrow(() => validateProbeEvidence(['first', 'second'], [first, second]));
  for (const records of [null, {}, [], [first], [first, first], [first, { ...second, id: 'foreign' }], [first, { ...second, status: 'skipped' }], [first, { ...second, durationMs: -1 }]]) {
    assert.throws(() => validateProbeEvidence(['first', 'second'], records));
  }
});

test('a failed shared run still executes exclusive frame claims, and evidence cannot turn red green', async context => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runProbeCatalog } = await import('./testing/probes.ts');
  const directory = mkdtempSync(join(tmpdir(), 'omc-probe-policy-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const shared = SCENARIOS.find(scenario => !scenario.shouldRunAlone)!;
  const exclusive = SCENARIOS.find(scenario => scenario.shouldRunAlone)!;
  for (const shouldFailProcess of [true, false]) {
    const phases: string[] = [];
    const hasPassed = await runProbeCatalog({ port: 5180, workers: 2, ids: [shared.id, exclusive.id] }, async env => {
      phases.push(env.OMC_PROBE_PHASE!);
      const file = join(directory, 'tmp/probe-timings/5180.json');
      const records = JSON.parse(readFileSync(file, 'utf8'));
      records.push({ id: env.OMC_PROBE_PHASE === 'shared' ? shared.id : exclusive.id, durationMs: 1, status: env.OMC_PROBE_PHASE === 'shared' ? 'failed' : 'passed' });
      writeFileSync(file, JSON.stringify(records));
      return shouldFailProcess && env.OMC_PROBE_PHASE === 'shared' ? 1 : 0;
    }, directory);
    assert.equal(hasPassed, false);
    assert.deepEqual(phases, ['shared', 'exclusive']);
  }
});

test('complete local catalogs retain the CI partitions and their independent budgets', async context => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runProbeCatalog } = await import('./testing/probes.ts');
  const directory = mkdtempSync(join(tmpdir(), 'omc-probe-partitions-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const observed: string[] = [];
  const batches = new Set<string>();
  const hasPassed = await runProbeCatalog({ port: 5180, workers: 2, ids: SCENARIOS.map(scenario => scenario.id) }, async env => {
    batches.add(env.OMC_PROBE_BATCH!);
    assert.ok(Number(env.OMC_PROBE_BUDGET_MS) > 0 && Number(env.OMC_PROBE_BUDGET_MS) <= 480_000);
    const ids: string[] = JSON.parse(env.OMC_PROBE_IDS!);
    const selected = SCENARIOS.filter(scenario => ids.includes(scenario.id) && Boolean(scenario.shouldRunAlone) === (env.OMC_PROBE_PHASE === 'exclusive'));
    const file = join(directory, 'tmp/probe-timings/5180.json');
    const records = JSON.parse(readFileSync(file, 'utf8'));
    for (const scenario of selected) {
      observed.push(scenario.id);
      records.push({ id: scenario.id, status: 'passed', durationMs: 1 });
    }
    writeFileSync(file, JSON.stringify(records));
    return 0;
  }, directory);
  assert.equal(hasPassed, true);
  assert.deepEqual([...batches], ['1', '2', '3']);
  assert.deepEqual(observed.sort(), SCENARIOS.map(scenario => scenario.id).sort());
  assert.equal(config.globalTimeout, 480_000);
});


test('native shared and exclusive phases consume one unchanged partition deadline', async context => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runProbeCatalog } = await import('./testing/probes.ts');
  const directory = mkdtempSync(join(tmpdir(), 'omc-probe-budget-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const shared = SCENARIOS.find(scenario => !scenario.shouldRunAlone)!;
  const exclusive = SCENARIOS.find(scenario => scenario.shouldRunAlone)!;
  for (const elapsed of [12_000, 480_001]) {
    let clock = 0;
    const budgets: number[] = [];
    const result = await runProbeCatalog({ port: 5180, workers: 2, ids: [shared.id, exclusive.id] }, async env => {
      budgets.push(Number(env.OMC_PROBE_BUDGET_MS));
      const file = join(directory, 'tmp/probe-timings/5180.json');
      const records = JSON.parse(readFileSync(file, 'utf8'));
      records.push({ id: env.OMC_PROBE_PHASE === 'shared' ? shared.id : exclusive.id, status: 'passed', durationMs: 1 });
      writeFileSync(file, JSON.stringify(records));
      clock += elapsed;
      return 0;
    }, directory, () => clock);
    assert.equal(result, elapsed < 480_000);
    assert.deepEqual(budgets, elapsed < 480_000 ? [480_000, 468_000] : [480_000]);
  }
});
