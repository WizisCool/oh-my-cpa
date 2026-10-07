import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkflowLint } from './lint-workflows.mjs';

test('workflow lint discovers and validates repository files from an unrelated cwd', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-workflow-cwd-'));
  const original = process.cwd();
  context.after(() => { process.chdir(original); fs.rmSync(directory, { recursive: true, force: true }); });
  process.chdir(directory);
  const root = fileURLToPath(new URL('../', import.meta.url));
  let hasCheckedWorkflows = false;
  runWorkflowLint((command, args, options) => {
    if (command === 'go') {
      assert.equal(path.resolve(options.cwd), path.resolve(root));
      return path.join(directory, 'go');
    }
    if (args[0] === '-version') return 'v1.7.12\n';
    const files = args.slice(1);
    assert.deepEqual(files.map(file => path.basename(file)).sort(), fs.readdirSync(path.join(root, '.github/workflows')).filter(file => /\.ya?ml$/.test(file)).sort());
    assert.ok(files.length > 0);
    for (const file of files) assert.ok(fs.readFileSync(file, 'utf8').includes('jobs:'));
    hasCheckedWorkflows = true;
  });
  assert.ok(hasCheckedWorkflows);
});
