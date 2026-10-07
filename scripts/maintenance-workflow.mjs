import assert from 'node:assert/strict';
import { validateActionSecurity } from './workflow-checks.mjs';

export function validateMaintenanceWorkflow(workflow) {
  validateActionSecurity(workflow);
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
  assert.equal(workflow.on.schedule.length, 1);
  assert.equal(workflow.on.schedule[0].cron, '23 3 * * 1');
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['native-runtime', 'robustness']);
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(!job.if && !job['continue-on-error']);
    assert.equal(job.permissions?.contents ?? workflow.permissions.contents, 'read');
    assert.equal(job.strategy['fail-fast'], false);
    assert.ok(job.timeout_minutes === undefined && job['timeout-minutes'] <= 20);
    for (const step of job.steps) assert.ok(!step['continue-on-error']);
    const installIndex = job.steps.findIndex(step => step.run === 'pnpm install --frozen-lockfile');
    assert.ok(installIndex >= 0 && !job.steps[installIndex].if);
  }
  const robustness = workflow.jobs.robustness;
  assert.deepEqual(robustness.strategy.matrix.mode, ['race', 'fuzz', 'advisories']);
  const gate = robustness.steps.find(step => step.run === 'node scripts/maintenance-checks.mjs ${{ matrix.mode }}');
  assert.ok(gate && !gate.if);
  const artifact = robustness.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(artifact.if, 'always()');
  assert.equal(artifact.with.path, 'tmp/maintenance/');
  assert.equal(artifact.with['retention-days'], 30);
  assert.equal(artifact.with['if-no-files-found'], 'error');
  const native = workflow.jobs['native-runtime'];
  assert.deepEqual(native.strategy.matrix.os, ['macos-15', 'windows-2025']);
  assert.equal(native['runs-on'], '${{ matrix.os }}');
  const node = native.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
  assert.equal(node.with.cache, undefined);
  assert.equal(node.with['package-manager-cache'], false);
  for (const action of ['actions/setup-go@', 'pnpm/action-setup@']) {
    assert.equal(native.steps.find(step => step.uses?.startsWith(action)).with.cache, false);
  }
  assert.ok(!native.steps.some(step => step.uses?.startsWith('actions/cache@')));
  const buildIndex = native.steps.findIndex(step => step.run === 'pnpm build');
  const smokeIndex = native.steps.findIndex(step => step.run?.includes('node scripts/native-runtime-smoke.mjs "$binary"'));
  assert.ok(buildIndex >= 0 && smokeIndex > buildIndex && !native.steps[buildIndex].if && !native.steps[smokeIndex].if);
  const smoke = native.steps[smokeIndex];
  assert.equal(smoke.env.CGO_ENABLED, '0');
  assert.equal(smoke.shell, 'bash');
  assert.ok(smoke.run.includes('binary=tmp/native-smoke.exe'));
  assert.ok(smoke.run.indexOf('go build ') < smoke.run.indexOf('node scripts/native-runtime-smoke.mjs'));
}
