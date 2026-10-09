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
  fs.mkdirSync(path.join(directory, 'web/src/nested'), { recursive: true });
  return directory;
}

test('component discovery is automatic, recursive and nonempty in the real tree', t => {
  const directory = fixture(t);
  assert.throws(() => componentCommand(directory), /nonempty/);
  fs.writeFileSync(path.join(directory, 'web/src/nested/One.component.test.tsx'), '');
  fs.writeFileSync(path.join(directory, 'web/src/Two.component.test.tsx'), '');
  fs.writeFileSync(path.join(directory, 'web/src/nested/not-a-test.tsx'), '');
  assert.deepEqual(componentTestFiles(directory), ['web/src/Two.component.test.tsx', 'web/src/nested/One.component.test.tsx']);
  const command = componentCommand(directory);
  assert.deepEqual(command.files, componentTestFiles(directory));
  assert.equal(command.cwd, directory);
  assert.deepEqual(command.args.slice(1), ['run', '--root', path.join(directory, 'web'), '--config', path.join(directory, 'web/vitest.config.ts')]);
  assert.ok(componentTestFiles().length > 0);
});

test('component claims run for frontend, own test infrastructure and dependency changes', () => {
  for (const file of ['web/src/hooks/usePreference.ts', 'web/src/hooks/usePreference.component.test.tsx', 'web/vitest.config.ts', 'scripts/test-components.mjs', 'web/src/test/componentSetup.ts', 'pnpm-lock.yaml']) {
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
