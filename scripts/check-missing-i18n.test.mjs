import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findMissingKeys } from './check-missing-i18n.mjs';

const checker = fileURLToPath(new URL('./check-missing-i18n.mjs', import.meta.url));

function fixture(t, dictionary, sources) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-i18n-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dictionaryFile = path.join(root, 'i18n.tsx');
  const sourceDirectory = path.join(root, 'src');
  fs.mkdirSync(sourceDirectory);
  fs.writeFileSync(dictionaryFile, dictionary);
  for (const [name, content] of Object.entries(sources)) {
    fs.writeFileSync(path.join(sourceDirectory, name), content);
  }
  return { dictionaryFile, sourceDirectory };
}

test('accepts source keys defined by the bilingual dictionary', (t) => {
  const files = fixture(t, "export const DICT = { 'page.title': ['标题', 'Title'] };", {
    'Page.tsx': "export const Page = () => t('page.title');",
  });
  const result = findMissingKeys(files);
  assert.deepEqual(result.missing, []);
});

test('reports every missing source key', (t) => {
  const files = fixture(t, "export const DICT = { 'page.title': ['标题', 'Title'] };", {
    'Page.tsx': "t('page.title'); t('page.missing');",
    'Other.ts': "t(\"action.missing\");",
  });
  const result = findMissingKeys(files);
  assert.deepEqual(result.missing.map((item) => item.key).sort(), ['action.missing', 'page.missing']);
});

test('command exits non-zero when a translation key is missing', (t) => {
  const files = fixture(t, "export const DICT = { 'page.title': ['标题', 'Title'] };", {
    'Page.tsx': "t('page.missing');",
  });
  const result = spawnSync(process.execPath, [checker, '--dictionary', files.dictionaryFile, '--source', files.sourceDirectory], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MISSING KEY/);
});
