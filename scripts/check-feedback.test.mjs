import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findViolations, runCheck } from './check-feedback.mjs';

const rules = (source) => findViolations(source).map((violation) => violation.rule);

test('a raw antd Alert is refused', () => {
  assert.deepEqual(rules("import { Alert, Button } from 'antd';"), ['raw-alert']);
  assert.deepEqual(rules("import { Button, Alert as Banner } from 'antd';"), ['raw-alert']);
});

test('antd message and notification are refused, imported or taken from useApp', () => {
  assert.deepEqual(rules("import { message } from 'antd';"), ['raw-toast']);
  assert.deepEqual(rules("import { notification } from 'antd';"), ['raw-toast']);
  assert.deepEqual(rules('const { message, modal } = AntdApp.useApp();'), ['raw-toast']);
  assert.deepEqual(rules('const { notification } = App.useApp();'), ['raw-toast']);
});

test('an information-only dialog is refused; a confirmation is not', () => {
  assert.deepEqual(rules("modal.warning({ title: 'x' });"), ['notice-dialog']);
  assert.deepEqual(rules("Modal.info({ title: 'x' });"), ['notice-dialog']);
  assert.deepEqual(rules("modal.confirm({ title: 'x' });"), []);
  assert.deepEqual(rules("const { modal } = AntdApp.useApp();"), []);
});

test('what merely shares a name is not a violation', () => {
  // A field called `message` on an error, a type import and an unrelated `Alert` identifier
  // are not the antd APIs this gate guards.
  assert.deepEqual(rules("const text = error.message; import { Button } from 'antd';"), []);
  assert.deepEqual(rules("import { Alert } from './Alert';"), []);
});

test('the feedback module itself may use the raw APIs', (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-feedback-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const feedback = path.join(projectRoot, 'web', 'src', 'components', 'feedback');
  const pages = path.join(projectRoot, 'web', 'src', 'pages');
  fs.mkdirSync(feedback, { recursive: true });
  fs.mkdirSync(pages, { recursive: true });
  fs.writeFileSync(path.join(feedback, 'Notice.tsx'), "import { Alert } from 'antd';\n");
  fs.writeFileSync(path.join(pages, 'Page.tsx'), "import { Button } from 'antd';\n\nimport { Alert } from 'antd';\n");
  const failures = runCheck({ projectRoot, output: { log() {}, error() {} } });
  assert.deepEqual(failures.map((failure) => [failure.file, failure.line, failure.rule]), [
    ['web/src/pages/Page.tsx', 3, 'raw-alert'],
  ]);
});
