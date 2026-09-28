import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { parse } from 'yaml';
import { validateArtifactGates, validateBrowserPhases, validateProbeJobs } from './workflow-checks.mjs';

const workflow = parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));

test('CI enforces the complete artifact gate before paying for browser tests', () => {
  assert.doesNotThrow(() => validateArtifactGates(workflow.jobs.browser.steps));
});

test('missing, late or partial artifact checking is refused', () => {
  for (const mutate of [
    (steps) => { steps.find((step) => step.name === 'Prepare Chromium and build embedded SPA').run = 'pnpm build\ngo build -trimpath -o tmp/oh-my-cpa-browser'; },
    (steps) => { steps.find((step) => step.name === 'Prepare Chromium and build embedded SPA').run = 'pnpm check:bundle\npnpm build\ngo build -trimpath -o tmp/oh-my-cpa-browser'; },
    (steps) => { steps.push(...steps.splice(steps.findIndex((step) => step.name === 'Verify generated state before browser tests'), 1)); },
    (steps) => { steps.find((step) => step.name === 'Verify generated state before browser tests').run = 'git diff --check'; },
    (steps) => { steps.find((step) => step.name === 'Verify generated state before browser tests').run = 'git status --porcelain'; },
  ]) {
    const steps = structuredClone(workflow.jobs.browser.steps);
    mutate(steps);
    assert.throws(() => validateArtifactGates(steps));
  }
});

test('CI runs P0 on pull requests and the whole acceptance on master', () => {
  assert.doesNotThrow(() => validateBrowserPhases(workflow.jobs.browser.steps));
  for (const mutate of [
    (steps) => { steps.find((step) => step.run === 'pnpm verify:browser:p0').if = "github.event_name != 'pull_request'"; },
    (steps) => { steps.splice(steps.findIndex((step) => step.run === 'pnpm verify:browser'), 1); },
    (steps) => { delete steps.find((step) => step.run === 'pnpm verify:browser').env; },
  ]) {
    const steps = structuredClone(workflow.jobs.browser.steps);
    mutate(steps);
    assert.throws(() => validateBrowserPhases(steps));
  }
});

test('the probe catalog runs as complete shards on every event, behind one required check', () => {
  assert.doesNotThrow(() => validateProbeJobs(workflow.jobs));
  const probeRun = (jobs) => jobs.probes.steps.find((step) => /verify:probes/.test(step.run ?? ''));
  for (const mutate of [
    (jobs) => { delete jobs.probes; },
    (jobs) => { jobs.probes.if = "github.event_name != 'pull_request'"; },
    (jobs) => { jobs.probes.strategy.matrix.shard.pop(); },
    (jobs) => { jobs.probes.strategy.matrix.shard = [1, 3, 2]; },
    (jobs) => { jobs.probes.strategy['fail-fast'] = true; },
    (jobs) => { probeRun(jobs).run = 'pnpm verify:probes'; },
    (jobs) => { probeRun(jobs).run = 'pnpm verify:probes --shard ${{ matrix.shard }}/4'; },
    (jobs) => { jobs.probes.steps = jobs.probes.steps.filter((step) => step.uses !== 'actions/upload-artifact@v7'); },
    (jobs) => { delete jobs['probes-complete']; },
    (jobs) => { delete jobs['probes-complete'].if; },
    (jobs) => { jobs['probes-complete'].steps[0].run = 'true'; },
  ]) {
    const jobs = structuredClone(workflow.jobs);
    mutate(jobs);
    assert.throws(() => validateProbeJobs(jobs), undefined, mutate.toString());
  }
});
