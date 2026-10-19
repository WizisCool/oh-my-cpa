import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { validateStaticJobs } from './workflow-checks.mjs';

const WORKFLOW = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));

test('isolated static lanes preserve the stable fail-closed required check', () => {
  assert.doesNotThrow(() => validateStaticJobs(WORKFLOW.jobs));
  const reordered = structuredClone(WORKFLOW.jobs);
  reordered['static-checks'].strategy.matrix.lane.reverse();
  assert.doesNotThrow(() => validateStaticJobs(reordered));
  const mutations = [
    (jobs: typeof WORKFLOW.jobs) => { jobs['static-checks'].strategy.matrix.lane.pop(); },
    (jobs: typeof WORKFLOW.jobs) => { jobs['static-checks'].strategy['fail-fast'] = true; },
    (jobs: typeof WORKFLOW.jobs) => { jobs['static-checks'].if = 'false'; },
    (jobs: typeof WORKFLOW.jobs) => { jobs['static-checks'].if = false; },
    (jobs: typeof WORKFLOW.jobs) => { jobs['static-checks'].strategy.matrix.exclude = [{ lane: 'repository' }]; },
    (jobs: typeof WORKFLOW.jobs) => { jobs['static-checks'].strategy.matrix.include = [{ lane: 'go' }]; },
    (jobs: typeof WORKFLOW.jobs) => { jobs['static-checks'].steps.find((step: { name: string }) => step.name === 'Verify static lane').if = 'false'; },
    (jobs: typeof WORKFLOW.jobs) => { jobs['static-checks'].steps.find((step: { name: string }) => step.name === 'Verify static lane').if = false; },
    (jobs: typeof WORKFLOW.jobs) => { jobs['static-checks'].steps.find((step: { name: string }) => step.name === 'Scan worktree and history')['continue-on-error'] = true; },
    (jobs: typeof WORKFLOW.jobs) => { jobs['static-checks'].steps[0].with['fetch-depth'] = 1; },
    (jobs: typeof WORKFLOW.jobs) => { jobs.static.if = 'success()'; },
    (jobs: typeof WORKFLOW.jobs) => { jobs.static['continue-on-error'] = true; },
    (jobs: typeof WORKFLOW.jobs) => { jobs.static.steps[0].run = 'true'; },
    (jobs: typeof WORKFLOW.jobs) => { jobs.static.steps[0].if = false; },
  ];
  for (const mutate of mutations) {
    const jobs = structuredClone(WORKFLOW.jobs);
    mutate(jobs);
    assert.throws(() => validateStaticJobs(jobs));
  }
});
