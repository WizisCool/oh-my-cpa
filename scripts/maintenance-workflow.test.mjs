import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import YAML from 'yaml';
import { validateMaintenanceWorkflow } from './maintenance-workflow.mjs';

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/maintenance.yml', import.meta.url), 'utf8'));
test('weekly robustness and host-native checks preserve read-only gates and artifact evidence', () => {
  validateMaintenanceWorkflow(workflow);
});
test('maintenance rejects reduced coverage, conditional gates and native cache restoration', () => {
  const mutations = [
    value => { value.jobs.robustness.strategy.matrix.mode.pop(); },
    value => { value.jobs.robustness['continue-on-error'] = true; },
    value => { value.jobs.robustness.steps.find(step => step.run?.includes('maintenance-checks.mjs')).if = 'false'; },
    value => { value.jobs.robustness.steps.find(step => step.uses?.startsWith('actions/upload-artifact@')).if = 'success()'; },
    value => { value.jobs['native-runtime'].strategy.matrix.os.pop(); },
    value => { value.jobs['native-runtime'].steps.find(step => step.uses?.startsWith('actions/setup-go@')).with.cache = true; },
    value => { value.jobs['native-runtime'].steps.find(step => step.run === 'pnpm build').if = 'false'; },
    value => { value.jobs['native-runtime'].steps.find(step => step.run?.includes('native-runtime-smoke.mjs'))['continue-on-error'] = true; },
    value => { value.permissions.contents = 'write'; },
  ];
  for (const mutate of mutations) {
    const broken = structuredClone(workflow); mutate(broken);
    assert.throws(() => validateMaintenanceWorkflow(broken));
  }
});
