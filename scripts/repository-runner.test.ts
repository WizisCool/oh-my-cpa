import assert from 'node:assert/strict';
import test from 'node:test';
import { repositoryTestFiles, runSelfChecks } from './testing/repository.ts';

test('self-tests discover each repository test file once without selecting browsers or builds', () => {
  const files = repositoryTestFiles();
  assert.ok(files.includes('scripts/repository-runner.test.ts'));
  assert.ok(files.includes('scripts/affected-checks.test.mjs'));
  assert.ok(files.includes('deploy/cloudflare/worker.test.mjs'));
  assert.ok(files.includes('deploy/cloudflare/filters.test.mjs'));
  assert.equal(new Set(files).size, files.length);
  assert.ok(files.every((file) => /\.test\.(?:mjs|ts)$/.test(file)));
});

test('the self-test runner preserves failed results and always schedules freshness checking', async () => {
  for (const isPassed of [false, true]) {
    const result = await runSelfChecks(async (checks) => {
      assert.equal(checks.length, 2);
      assert.deepEqual(checks[0].args, ['--import', 'tsx', '--test', '--test-concurrency=2', ...repositoryTestFiles()]);
      assert.deepEqual(checks[1].args, ['--import', 'tsx', 'scripts/check-demo.ts']);
      assert.ok(checks.every((check) => check.command === 'node'));
      return isPassed;
    });
    assert.equal(result, isPassed);
  }
});
