/**
 * Self-test for the style-token checker. Each rule fails a fixture for its own reason and passes
 * the corrected one, because a rule that stops matching looks exactly like a clean stylesheet.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findViolations, runCheck } from './check-style-tokens.mjs';

const TOKENS = ':root { --text-sm: 12px; --text-md: 13px; --radius-xs: 2px; --radius-sm: 4px; }\n';
const silent = { log() {}, error() {} };

function messages(t, files) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-style-tokens-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const sourceDirectory = path.join(projectRoot, 'web', 'src');
  fs.mkdirSync(sourceDirectory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(sourceDirectory, name), contents);
  }
  return runCheck({ projectRoot, output: silent }).failures.map((failure) => failure.message).join('\n');
}

test('a tree with no stylesheets fails rather than passing on nothing', (t) => {
  assert.match(messages(t, {}), /no stylesheets scanned/);
});

test('a font size on the scale must be its token', (t) => {
  assert.match(messages(t, { 'a.css': `${TOKENS}.a { font-size: 12px; }\n` }), /var\(--text-sm\)/);
  assert.equal(messages(t, { 'a.css': `${TOKENS}.a { font-size: var(--text-sm); }\n` }), '');
});

test('a fractional font size is refused, a display size is not', (t) => {
  assert.match(messages(t, { 'a.css': `${TOKENS}.a { font-size: 12.5px; }\n` }), /between two steps/);
  assert.equal(messages(t, { 'a.css': `${TOKENS}.a { font-size: 34px; }\n` }), '');
});

test('a custom property that merely ends in font-size is not a font size', (t) => {
  assert.equal(messages(t, { 'a.css': `${TOKENS}.a { --ant-notification-icon-font-size: 12px; }\n` }), '');
});

test('a small corner radius must be its token, in shorthand and longhand', (t) => {
  assert.match(messages(t, { 'a.css': `${TOKENS}.a { border-radius: 4px; }\n` }), /var\(--radius-sm\)/);
  assert.match(messages(t, { 'a.css': `${TOKENS}.a { border-radius: 0 3px 3px 0; }\n` }), /var\(--radius-xs\)/);
  assert.match(messages(t, { 'a.css': `${TOKENS}.a { border-top-left-radius: 2px; }\n` }), /var\(--radius-xs\)/);
  assert.equal(messages(t, { 'a.css': `${TOKENS}.a { border-radius: 0 var(--radius-sm) 50% 999px; }\n` }), '');
});

test('a token reference must resolve and carry no fallback', (t) => {
  assert.match(messages(t, { 'a.css': `${TOKENS}.a { border-radius: var(--radius-tiny); }\n` }), /not defined/);
  assert.match(messages(t, { 'a.css': `${TOKENS}.a { font-size: var(--text-md, 13px); }\n` }), /carries a fallback/);
  // A definition in another stylesheet counts: the variables live in one file and are used in all.
  assert.equal(messages(t, { 'tokens.css': TOKENS, 'a.css': '.a { border-radius: var(--radius-xs); }\n' }), '');
});

test('a commented-out declaration is not a violation', (t) => {
  assert.equal(messages(t, { 'a.css': `${TOKENS}/* .a { font-size: 12px; } */\n` }), '');
});

test('a value on the line after its property is still checked, and reported where it starts', (t) => {
  assert.match(messages(t, { 'a.css': `${TOKENS}.a {\n  font-size:\n    12px;\n}\n` }), /var\(--text-sm\)/);
  assert.match(messages(t, { 'a.css': `${TOKENS}.a {\n  border-radius:\n    0\n    4px;\n}\n` }), /var\(--radius-sm\)/);
  assert.match(messages(t, { 'a.css': `${TOKENS}.a {\n  font-size: var(\n    --text-md,\n    13px\n  );\n}\n` }), /carries a fallback/);
  assert.deepEqual(
    findViolations('.a {\n  color: red;\n  font-size:\n    12px;\n}\n', new Set()).map((violation) => violation.line),
    [3],
  );
});
