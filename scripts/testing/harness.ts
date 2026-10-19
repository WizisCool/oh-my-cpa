import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPlaywright } from './probes.ts';

type Suite = { suites?: Suite[]; specs?: { title: string; tests: { status: string; results: { errors: { message?: string }[] }[] }[] }[] };
const REPORT = fileURLToPath(new URL('../../tmp/browser-harness-report.json', import.meta.url));
const FAULTS = ['pageerror', 'console', 'fixture', 'method', 'outbound', 'fulfilled-outbound', 'socket', 'assertion', 'setup'];
for (const workers of [1, 2]) {
  rmSync(REPORT, { force: true });
  const code = await runPlaywright({ OMC_PROBE_CATALOG: 'harness', OMC_PROBE_WORKERS: String(workers), OMC_PROBE_PORT: '5182', OMC_PROBE_PHASE: 'shared' });
  const report = JSON.parse(readFileSync(REPORT, 'utf8')) as { suites: Suite[] };
  const specs = (suite: Suite): NonNullable<Suite['specs']> => [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(specs)];
  const results = report.suites.flatMap(specs);
  assert.equal(code, 1, 'negative controls must fail the actual Playwright process');
  assert.equal(results.length, FAULTS.length + 4, 'setup failure must not omit a peer test');
  for (const fault of FAULTS) {
    const result = results.find(result => result.title === `rejects ${fault}`)?.tests[0];
    assert.equal(result?.status, 'unexpected', fault);
    const error = result.results.flatMap(value => value.errors.map(error => error.message ?? '')).join('\n');
    const cause = fault === 'method' ? /"method": "POST"/ : fault === 'socket' ? /Undeclared WebSocket origin/
      : fault === 'outbound' || fault === 'fulfilled-outbound' ? /Undeclared network origin/
      : fault === 'fixture' ? /Undeclared API fixture/ : new RegExp(`injected ${fault === 'assertion' ? 'failed assertion' : fault}`);
    assert.match(error, cause, fault);
  }
  for (const name of ['accepts explicit HTTP failure', 'accepts declared isolated popup', 'isolates alpha state', 'isolates beta state']) {
    assert.equal(results.find(result => result.title === name)?.tests[0].status, 'expected', name);
  }
  console.log(`Browser harness: all fault and positive controls verified with ${workers} worker(s).`);
}
