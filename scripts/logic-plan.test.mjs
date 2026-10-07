import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planLogicSuites } from './logic-plan.mjs';

test('transitive and direct changes select isolated suites; unknowns and infrastructure widen', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'omc-logic-plan-'));
  try {
    const sources={'one.ts':"import './shared.ts';",'two.ts':"import './other.ts';",'shared.ts':"export * from './leaf.ts';",'leaf.ts':'export const leaf=1;','other.ts':'export const other=2;'};
    for(const [name,text] of Object.entries(sources))fs.writeFileSync(path.join(root,name),text);
    const suites=[{script:'one.ts'},{script:'two.ts'}];
    assert.deepEqual(planLogicSuites(['leaf.ts'],suites,root),[suites[0]]);
    assert.deepEqual(planLogicSuites(['two.ts'],suites,root),[suites[1]]);
    assert.deepEqual(planLogicSuites(['leaf.ts','other.ts'],suites,root),suites);
    for(const files of [['unowned.ts'],['pnpm-lock.yaml'],['scripts/logic-plan.mjs'],['web/package.json'],['one.ts','deleted.ts']]) {
      assert.deepEqual(planLogicSuites(files,suites,root),suites);
    }
    fs.writeFileSync(path.join(root,'two.ts'),"import('./'+name);");
    assert.deepEqual(planLogicSuites(['leaf.ts'],suites,root),suites);
    fs.writeFileSync(path.join(root,'two.ts'),"import './missing.ts';");
    assert.deepEqual(planLogicSuites(['leaf.ts'],suites,root),suites);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('cycles terminate and unresolved aliases or transitive filesystem readers always select their suite', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-logic-opaque-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = { 'one.ts': "import './leaf.ts';", 'leaf.ts': "import './one.ts';", 'two.ts': "import './reader.ts';", 'reader.ts': 'export const reading = 1;' };
  for (const [file, text] of Object.entries(sources)) fs.writeFileSync(path.join(root, file), text);
  const suites = [{ script: 'one.ts' }, { script: 'two.ts' }];
  assert.deepEqual(planLogicSuites(['leaf.ts'], suites, root), [suites[0]]);
  for (const content of ["import { readFileSync as read } from 'node:fs'; read('fixture.json');", "import thing from '#internal-alias';", "import thing from '@/leaf';", "import('./' + file);"]) {
    fs.writeFileSync(path.join(root, 'reader.ts'), content);
    assert.deepEqual(planLogicSuites(['leaf.ts'], suites, root), suites, content);
  }
});
