import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { definedClasses, referencedClasses, runCheck } from './check-css-modules.mjs';

const checker = fileURLToPath(new URL('./check-css-modules.mjs', import.meta.url));

function fixture(t, moduleCss, consumer) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-css-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const sourceDirectory = path.join(projectRoot, 'web', 'src');
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.writeFileSync(path.join(sourceDirectory, 'Panel.module.css'), moduleCss);
  fs.writeFileSync(path.join(sourceDirectory, 'Panel.tsx'), consumer);
  return projectRoot;
}

const MODULE = ".panel-head {\n  color: red;\n}\n\n.panel-head :global(.ant-btn) {\n  color: blue;\n}\n";

test('definedClasses reads line-initial class selectors only', () => {
  assert.deepEqual([...definedClasses(MODULE)], ['panel-head']);
});

test('referencedClasses accepts dot and bracket access', () => {
  const keys = referencedClasses("styles.panelHead; styles['panel-head']; styles.other");
  assert.deepEqual([...keys].sort(), ['other', 'panel-head', 'panelHead']);
});

test('accepts a consumer whose references all resolve', (t) => {
  const projectRoot = fixture(
    t,
    MODULE,
    "import styles from './Panel.module.css';\nexport const Panel = () => <div className={styles['panel-head']} />;\n",
  );
  assert.deepEqual(runCheck({ projectRoot, output: { log() {}, error() {} } }), []);
});

test('reports a renamed or deleted class that tsc cannot see', (t) => {
  const projectRoot = fixture(
    t,
    MODULE,
    "import styles from './Panel.module.css';\nexport const Panel = () => <div className={styles.panelTitle} />;\n",
  );
  const findings = runCheck({ projectRoot, output: { log() {}, error() {} } });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'undefined-class');
  assert.match(findings[0].detail, /panelTitle/);
});

test('reports a CSS module import that does not exist', (t) => {
  const projectRoot = fixture(
    t,
    MODULE,
    "import styles from './Gone.module.css';\nexport const Panel = () => <div className={styles.panelHead} />;\n",
  );
  const findings = runCheck({ projectRoot, output: { log() {}, error() {} } });
  assert.equal(findings[0].kind, 'missing-module');
});

test('command exits non-zero when a class reference is undefined', (t) => {
  const projectRoot = fixture(
    t,
    MODULE,
    "import styles from './Panel.module.css';\nexport const Panel = () => <div className={styles.gone} />;\n",
  );
  const result = spawnSync(process.execPath, [checker, '--root', projectRoot], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNDEFINED-CLASS/);
});
