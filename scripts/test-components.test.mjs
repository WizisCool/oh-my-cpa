import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { componentCommand, componentTestFiles } from './test-components.mjs';
import { planChecks } from './affected-checks.mjs';
import { CHECK_COMMANDS } from './verify-fast.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-component-discovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'web/tests/nested'), { recursive: true });
  return directory;
}

test('component discovery is automatic, recursive and nonempty in the real tree', t => {
  const directory = fixture(t);
  assert.throws(() => componentCommand(directory), /nonempty/);
  fs.writeFileSync(path.join(directory, 'web/tests/nested/One.component.test.tsx'), '');
  fs.writeFileSync(path.join(directory, 'web/tests/Two.component.test.tsx'), '');
  fs.writeFileSync(path.join(directory, 'web/tests/nested/not-a-test.tsx'), '');
  fs.writeFileSync(path.join(directory, 'web/tests/nested/Api.contract.test.ts'), '');
  assert.deepEqual(componentTestFiles(directory), ['web/tests/Two.component.test.tsx', 'web/tests/nested/Api.contract.test.ts', 'web/tests/nested/One.component.test.tsx']);
  const command = componentCommand(directory);
  assert.deepEqual(command.files, componentTestFiles(directory));
  assert.equal(command.cwd, directory);
  assert.deepEqual(command.args.slice(1), ['run', '--root', path.join(directory, 'web'), '--config', path.join(directory, 'web/vitest.config.ts')]);
  assert.ok(componentTestFiles().length > 0);
});

test('component claims run for frontend, own test infrastructure and dependency changes', () => {
  for (const file of ['web/src/hooks/usePreference.ts', 'web/tests/preferences.component.test.tsx', 'web/vitest.config.ts', 'scripts/test-components.mjs', 'web/tests/setup.ts', 'web/tests/preferences.contract.test.ts', 'scripts/acceptance/contracts/preferences.json', 'scripts/acceptance/preferences-fixture.mjs', 'pnpm-lock.yaml']) {
    assert.ok(planChecks([file]).includes('components'), file);
  }
  assert.ok(!planChecks(['docs/testing.md']).includes('components'));
  assert.deepEqual(CHECK_COMMANDS.components.args, ['test:components']);
  assert.ok(!JSON.stringify(CHECK_COMMANDS.components).match(/Chromium|playwright|build|dev:web|fake-cpa/));
});

test('static frontend gate includes component discovery alongside existing logic and type checks', () => {
  const scripts = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
  assert.equal(scripts['test:components'], 'node scripts/test-components.mjs');
  for (const command of ['pnpm type-check', 'pnpm test:logic', 'pnpm test:components', 'pnpm lint:antd']) {
    assert.ok(scripts['verify:static:frontend'].split(' && ').includes(command), command);
  }
});

test('wire corpus changes select both independent handler and frontend consumers', () => {
  const checks = planChecks(['scripts/acceptance/contracts/preferences.json']);
  for (const owner of ['go', 'components', 'self-tests']) assert.ok(checks.includes(owner), owner);
  assert.ok(planChecks(['scripts/acceptance/probe.mjs']).includes('self-tests'));
});


test('integration tests stay outside product source discovery but inside type checking', () => {
  assert.ok(componentTestFiles().every(file => file.startsWith('web/tests/')));
  const config = JSON.parse(fs.readFileSync(new URL('../web/tsconfig.json', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''));
  assert.ok(config.include.includes('tests'));
  assert.ok(componentTestFiles().some(file => file.endsWith('.component.test.tsx')));
  assert.ok(componentTestFiles().some(file => file.endsWith('.contract.test.ts')));
});


test('test-only frontend paths do not invent browser reachability', async () => {
  const { planScenarios } = await import('./acceptance/check-ui-plan.mjs');
  assert.deepEqual(planScenarios(['web/tests/preferences.contract.test.ts'], ['representative']).ids, []);
  assert.ok(planChecks(['web/tests/preferences.contract.test.ts']).includes('components'));
});
