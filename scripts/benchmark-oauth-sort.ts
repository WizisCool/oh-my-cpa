import assert from 'node:assert/strict';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { sortOAuthWorkspaceRecords } from '../web/src/pages/oauthManagement/oauthWorkspaceLogic';
import { createOAuthSortRecords, legacyOAuthSort, OAUTH_SORT_KEYS } from './fixtures/oauth-sort';

const results = [];
for (const size of [12, 120, 2300]) {
  const records = createOAuthSortRecords(size);
  for (const sort of OAUTH_SORT_KEYS) {
    assert.deepEqual(sortOAuthWorkspaceRecords(records, sort), legacyOAuthSort(records, sort));
    const implementations = [['legacy', legacyOAuthSort], ['current', sortOAuthWorkspaceRecords]] as const;
    for (const [, run] of implementations) for (let iteration = 0; iteration < 3; iteration++) run(records, sort);
    const samples: Record<string, number[]> = {legacy: [], current: []};
    for (let iteration = 0; iteration < 15; iteration++) {
      for (const [name, run] of iteration % 2 ? [...implementations].reverse() : implementations) {
        const startedAt = performance.now();
        run(records, sort);
        samples[name].push(performance.now() - startedAt);
      }
    }
    for (const [implementation, values] of Object.entries(samples)) {
      values.sort((left, right) => left - right);
      results.push({size, sort, implementation, medianMS: values[7], p95MS: values[14]});
    }
  }
}
const retainedHeap = [];
const forceGC = (globalThis as typeof globalThis & {gc?: () => void}).gc;
if (forceGC) {
  const records = createOAuthSortRecords(2300);
  for (const [implementation, run] of [['legacy', legacyOAuthSort], ['current', sortOAuthWorkspaceRecords]] as const) {
    forceGC();
    const before = process.memoryUsage().heapUsed;
    for (let iteration = 0; iteration < 10; iteration++) run(records, 'name-asc');
    forceGC();
    retainedHeap.push({implementation, beforeBytes: before, afterBytes: process.memoryUsage().heapUsed});
  }
}
console.log(JSON.stringify({node: process.version, platform: process.platform, arch: process.arch,
  cpus: os.cpus().length, locale: Intl.DateTimeFormat().resolvedOptions().locale,
  resourceUsage: process.resourceUsage(), memory: process.memoryUsage(), retainedHeap, results}, null, 2));
