import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildLucideIcons, LUCIDE_ICONS_PATH } from './generate-lucide-icons.mjs';

test('the committed Lucide icon data matches the installed package', async () => {
  assert.equal(fs.readFileSync(LUCIDE_ICONS_PATH, 'utf8'), await buildLucideIcons(), 'run `pnpm icons:generate`');
});

test('every alias leads to drawing data, and nodes carry no script-capable attribute', () => {
  const icons = JSON.parse(fs.readFileSync(LUCIDE_ICONS_PATH, 'utf8'));
  assert.ok(Object.keys(icons).length > 1500);
  for (const [name, entry] of Object.entries(icons)) {
    const nodes = typeof entry === 'string' ? icons[entry] : entry;
    assert.ok(Array.isArray(nodes), `${name} does not resolve to nodes`);
    for (const [tag, attributes] of nodes) {
      assert.match(tag, /^(path|circle|rect|line|polyline|polygon|ellipse)$/, `${name} uses <${tag}>`);
      for (const key of Object.keys(attributes)) assert.doesNotMatch(key, /^on|href/i, `${name} carries ${key}`);
    }
  }
});
