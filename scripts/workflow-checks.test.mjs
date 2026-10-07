import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { parse } from 'yaml';
import { validateArtifactGates, validateBrowserPhases, validateProbeJobs, validateActionSecurity } from './workflow-checks.mjs';

const workflow = parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));

test('CI collects browser evidence after bundle failure and then enforces its verdict', () => {
  assert.doesNotThrow(() => validateArtifactGates(workflow.jobs.browser.steps));
});

test('missing, bypassed or reordered bundle verification is refused', () => {
  for (const mutate of [
    (steps) => { steps.find((step) => step.id === 'prepare').run += '\npnpm check:bundle'; },
    (steps) => { steps.find((step) => step.id === 'prepare').run = 'go build -trimpath -o tmp/oh-my-cpa-browser\npnpm build'; },
    (steps) => { delete steps.find((step) => step.id === 'bundle')['continue-on-error']; },
    (steps) => { steps.find((step) => step.id === 'bundle').run = 'true'; },
    (steps) => { steps.find((step) => step.id === 'bundle').if = 'false'; },
    (steps) => { steps.splice(steps.findIndex((step) => step.id === 'bundle'), 1); },
    (steps) => { steps.find((step) => step.name === 'Require bundle verification success').run = 'true'; },
    (steps) => { steps.find((step) => step.name === 'Require bundle verification success').if = 'success()'; },
    (steps) => { steps.find((step) => step.name === 'Require bundle verification success').env.BUNDLE_OUTCOME = '${{ steps.bundle.conclusion }}'; },
    (steps) => { steps.find((step) => step.name === 'Require bundle verification success')['continue-on-error'] = true; },
    (steps) => { steps.splice(steps.findIndex((step) => step.name === 'Require bundle verification success'), 1); },
    (steps) => { steps.find((step) => step.with?.name === 'bundle-report').if = 'success()'; },
    (steps) => { steps.find((step) => step.name === 'Verify generated state before browser tests').run = 'git diff --check'; },
  ]) {
    const steps = structuredClone(workflow.jobs.browser.steps);
    mutate(steps);
    assert.throws(() => validateArtifactGates(steps), undefined, mutate.toString());
  }
});

test('CI runs full built acceptance once on every event', () => {
  validateBrowserPhases(workflow.jobs.browser.steps);
  for (const mutate of [
    steps => { steps.find(step => step.run === 'pnpm verify:browser')['continue-on-error'] = true; },
    steps => { steps.find(step => step.run === 'pnpm verify:browser:harness').if = 'false'; },
    steps => { steps.find(step => step.run === 'pnpm verify:browser').if = "github.event_name != 'pull_request'"; },
    steps => { steps.splice(steps.findIndex(step => step.run === 'pnpm verify:browser'), 1); },
    steps => { delete steps.find(step => step.run === 'pnpm verify:browser').env; },
    steps => { steps.push(structuredClone(steps.find(step => step.run === 'pnpm verify:browser'))); },
  ]) {
    const steps = structuredClone(workflow.jobs.browser.steps); mutate(steps);
    assert.throws(() => validateBrowserPhases(steps));
  }
});

test('action pinning and credential isolation are invariant', () => {
  validateActionSecurity(workflow);
  for (const mutate of [
    value => { value.jobs.static.steps[0].uses = 'actions/checkout@v7'; },
    value => { delete value.jobs.static.steps[0].with['persist-credentials']; },
  ]) {
    const broken = structuredClone(workflow); mutate(broken);
    assert.throws(() => validateActionSecurity(broken));
  }
});

test('the probe catalog runs as complete shards on every event, behind one required check', () => {
  assert.doesNotThrow(() => validateProbeJobs(workflow.jobs));
  const probeRun = (jobs) => jobs.probes.steps.find((step) => /verify:probes/.test(step.run ?? ''));
  for (const mutate of [
    (jobs) => { delete jobs.probes; },
    jobs => { jobs.probes['continue-on-error'] = true; },
    jobs => { probeRun(jobs).if = 'false'; },
    jobs => { probeRun(jobs)['continue-on-error'] = true; },
    jobs => { jobs['probes-complete'].steps[0].if = 'false'; },
    jobs => { jobs['probes-complete']['continue-on-error'] = true; },
    jobs => { jobs.probes.steps.find(step => step.with?.path === 'tmp/probe-timings/').if = 'success()'; },
    jobs => { jobs.probes.steps.find(step => step.with?.path === 'tmp/probe-timings/')['continue-on-error'] = true; },
    (jobs) => { jobs.probes.if = "github.event_name != 'pull_request'"; },
    (jobs) => { jobs.probes.strategy.matrix.shard.pop(); },
    (jobs) => { jobs.probes.strategy.matrix.shard = [1, 3, 2]; },
    (jobs) => { jobs.probes.strategy['fail-fast'] = true; },
    (jobs) => { probeRun(jobs).run = 'pnpm verify:probes'; },
    (jobs) => { probeRun(jobs).run = 'pnpm verify:probes --shard ${{ matrix.shard }}/4'; },
    (jobs) => { jobs.probes.steps = jobs.probes.steps.filter((step) => !step.uses?.startsWith('actions/upload-artifact@')); },
    (jobs) => { delete jobs['probes-complete']; },
    (jobs) => { delete jobs['probes-complete'].if; },
    (jobs) => { jobs['probes-complete'].steps[0].run = 'true'; },
  ]) {
    const jobs = structuredClone(workflow.jobs);
    mutate(jobs);
    assert.throws(() => validateProbeJobs(jobs), undefined, mutate.toString());
  }
});

test('reusable workflows cannot evade external reference pinning', () => {
  for (const reference of ['./.github/workflows/local.yml', `owner/project/.github/workflows/shared.yml@${'a'.repeat(40)}`]) {
    const changed = structuredClone(workflow);
    changed.jobs.reusable = { uses: reference };
    assert.doesNotThrow(() => validateActionSecurity(changed));
  }
  for (const reference of ['owner/project/.github/workflows/shared.yml@main', 'owner/project/.github/workflows/shared.yml@v1', './.github/workflows/local.yml@main']) {
    const changed = structuredClone(workflow);
    changed.jobs.reusable = { uses: reference };
    assert.throws(() => validateActionSecurity(changed), /reusable workflows/);
  }
  const changed = structuredClone(workflow);
  changed.jobs.probes.steps.find(step => step.with?.path === 'tmp/probe-timings/')['continue-on-error'] = false;
  assert.doesNotThrow(() => validateProbeJobs(changed.jobs));
});
