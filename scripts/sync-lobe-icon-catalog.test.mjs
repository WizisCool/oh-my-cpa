import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { lobeIconSlug, projectLobeIconCatalog, readTarEntry } from './sync-lobe-icon-catalog.mjs';

const require = createRequire(new URL('../web/package.json', import.meta.url));
const assets = path.join(path.dirname(require.resolve('@lobehub/icons-static-svg/package.json')), 'icons');

function tarOf(name, content) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write(`${Buffer.byteLength(content).toString(8).padStart(11, '0')}\0`, 124, 'utf8');
  const body = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / 512) * 512);
  body.write(content, 0, 'utf8');
  return Buffer.concat([header, body, Buffer.alloc(1024)]);
}

test('the committed catalog names only marks the pinned SVG package ships', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../web/src/generated/lobeIconCatalog.json', import.meta.url), 'utf8'));
  assert.ok(catalog.length > 300);
  for (const entry of catalog) {
    const slug = lobeIconSlug(entry.id);
    assert.ok(fs.existsSync(path.join(assets, `${slug}.svg`)), `${entry.id} has no SVG; run \`pnpm icons:lobe\``);
    assert.equal(fs.existsSync(path.join(assets, `${slug}-color.svg`)), entry.hasColor, `${entry.id} colour flag is stale; run \`pnpm icons:lobe\``);
  }
});

test('availability comes from the shipped files, not from the upstream declaration', () => {
  const shipped = new Set(['alpha.svg', 'beta.svg', 'beta-color.svg']);
  const catalog = projectLobeIconCatalog([
    { id: 'Gamma', title: 'g', fullTitle: 'G', docsUrl: 'g', desc: '', group: 'model', param: { hasColor: true } },
    { id: 'Beta', title: 'b', fullTitle: 'B', docsUrl: 'b', desc: '', group: 'model', param: { hasColor: false }, color: '#000' },
    { id: 'Alpha', title: 'a', fullTitle: 'A', docsUrl: 'a', desc: '', group: 'provider', param: { hasColor: true } },
  ], name => shipped.has(name));
  assert.deepEqual(catalog.map(entry => [entry.id, entry.hasColor]), [['Alpha', false], ['Beta', true]]);
  assert.deepEqual(Object.keys(catalog[0]), ['id', 'title', 'fullTitle', 'docsUrl', 'desc', 'group', 'hasColor']);
});

test('a tar entry is found by its full name and an absent one is not invented', () => {
  const archive = Buffer.concat([tarOf('package/a.json', 'x'.repeat(600)).subarray(0, 512 + 1024), tarOf('package/es/toc.json', '[1]')]);
  assert.equal(readTarEntry(archive, 'package/es/toc.json').toString('utf8'), '[1]');
  assert.equal(readTarEntry(archive, 'package/missing.json'), undefined);
});
