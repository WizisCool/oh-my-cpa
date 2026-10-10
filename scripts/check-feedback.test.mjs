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

test('a raw antd Switch is refused, and the console\'s own is not', () => {
  assert.deepEqual(rules("import { Button, Switch } from 'antd';"), ['raw-switch']);
  assert.deepEqual(rules("import * as Antd from 'antd'; const toggle = Antd.Switch;"), ['raw-switch']);
  assert.deepEqual(rules("import { Switch } from '../common/Switch'; const toggle = Switch;"), []);
  assert.deepEqual(rules("import type { SwitchProps } from 'antd';"), []);
});

test('antd message and notification are refused, imported or taken from useApp', () => {
  assert.deepEqual(rules("import { message } from 'antd';"), ['raw-toast']);
  assert.deepEqual(rules("import { notification } from 'antd';"), ['raw-toast']);
  assert.deepEqual(rules("import { App as AntdApp } from 'antd'; const { message, modal } = AntdApp.useApp();"), ['raw-toast']);
  assert.deepEqual(rules("import { App } from 'antd'; const { notification } = App.useApp();"), ['raw-toast']);
});

test('raw feedback resolves namespaces, useApp results and local aliases', () => {
  for (const [source, rule] of [
    ["import * as Antd from 'antd'; const banner = Antd.Alert;", 'raw-alert'],
    ["import * as Antd from 'antd'; Antd.message.success('saved');", 'raw-toast'],
    ["import * as Antd from 'antd'; const { notification: notices } = Antd;", 'raw-toast'],
    ["import { App } from 'antd'; const app = App.useApp(); app.message.success('saved');", 'raw-toast'],
    ["import { App as Shell } from 'antd'; const app = Shell.useApp(); const alias = app; alias.notification.info({});", 'raw-toast'],
    ["import { App } from 'antd'; const app = App.useApp(); const { message: toast } = app; toast.success('saved');", 'raw-toast'],
    ["import * as Antd from 'antd'; const { App: Shell } = Antd; Shell.useApp().notification.info({});", 'raw-toast'],
    ["import { App } from 'antd'; const app = App.useApp(); app['message'].success('saved');", 'raw-toast'],
  ]) assert.deepEqual(rules(source), [rule], source);
});

test('raw feedback ignores comments, strings, types and unrelated or shadowed bindings', () => {
  for (const source of [
    "// import { Alert } from 'antd';\n/* import { message, notification } from 'antd'; */",
    'const example = "import { Alert } from \'antd\';"; const template = `const { message } = App.useApp()`;',
    "import type { Alert, message } from 'antd'; import { type notification } from 'antd';",
    "import { App } from './app'; const app = App.useApp(); app.message.success('saved');",
    "const Other = { useApp() {} }; const { message } = Other.useApp();",
    "import { App } from 'antd'; function render(App) { const { message } = App.useApp(); message.success('saved'); }",
    "import { App } from 'antd'; const app = App.useApp(); function render(app) { app.notification.info({}); }",
    "import * as Antd from 'antd'; function render(Antd) { return Antd.Alert; }",
    "const app = { message: { success() {} } }; app.message.success('saved');",
  ]) assert.deepEqual(rules(source), [], source);
});

test('raw feedback diagnostics retain import and access lines', () => {
  const violations = findViolations("// import { Alert } from 'antd';\nimport { Alert as Banner, App } from 'antd';\nconst app = App.useApp();\napp.notification.info({});");
  assert.deepEqual(violations.map(({ line, rule }) => [line, rule]), [[2, 'raw-alert'], [4, 'raw-toast']]);
});

test('an information-only dialog is refused; a confirmation is not', () => {
  const imports = "import { Modal, App as AntdApp } from 'antd'; const { modal } = AntdApp.useApp();";
  assert.deepEqual(rules(`${imports} modal.warning({ title: 'x' });`), ['notice-dialog']);
  assert.deepEqual(rules(`${imports} Modal.info({ title: 'x' });`), ['notice-dialog']);
  assert.deepEqual(rules(`${imports} modal.confirm({ title: 'x' });`), []);
  assert.deepEqual(rules(imports), []);
});

test('modal calls resolve imports, hook bindings and aliases', () => {
  for (const source of [
    "import { Modal as Dialog } from 'antd'; Dialog.error({});",
    "import { App as Shell } from 'antd'; const { modal: dialog } = Shell.useApp(); dialog.success({});",
    "import { Modal } from 'antd'; const dialog = Modal; dialog.warning({});",
    "import * as Antd from 'antd'; Antd.Modal.info({});",
    "import { App } from 'antd'; const app = App.useApp(); app.modal.error({});",
    "import { Modal } from 'antd'; const [dialog] = Modal.useModal(); dialog.info({});",
  ]) assert.deepEqual(rules(source), ['notice-dialog'], source);
});

test('modal detection ignores comments, strings, unrelated objects and shadowed bindings', () => {
  for (const source of [
    '// Modal.info({});\n/* modal.warning({}); */',
    'const example = "modal.error({})"; const template = `Modal.success({})`;',
    'const modal = { info() {} }; modal.info({});',
    "import { Modal } from './dialog'; Modal.info({});",
    "import { App } from './app'; const { modal } = App.useApp(); modal.error({});",
    "import { Modal } from 'antd'; function render(Modal) { Modal.info({}); }",
    "import { App } from 'antd'; const { modal } = App.useApp(); function render(modal) { modal.info({}); }",
    "import type { Modal } from 'antd'; Modal.info({});",
    "import { Modal } from 'antd'; const text = 'Modal.info({})'; // Modal.error({})",
  ]) assert.deepEqual(rules(source), [], source);
});

test('modal diagnostics retain the call line and alias', () => {
  const violations = findViolations("import { Modal as Dialog } from 'antd';\n// Dialog.info({})\nDialog.success({});");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 3);
  assert.match(violations[0].message, /Dialog\.success/);
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
