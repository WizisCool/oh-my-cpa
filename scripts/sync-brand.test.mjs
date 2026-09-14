/**
 * Tests for the brand-artwork sync.
 *
 * The property being protected is that the README's artwork cannot drift from the console's accent.
 * That is not hypothetical: the repository used to hold four hand-maintained SVGs whose blue was
 * `#00A3FD` while the theme's accent was `#007AFF`, so the logo and the rest of the console were
 * already two different blues and nothing connected them. These tests drive the real script and
 * assert both halves of the fix - that the generated files carry the accent they are given, and that
 * the committed files are not stale.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { README_BRAND_COLORS, brandArtifacts, renderBrandSvg, syncBrand } from './sync-brand.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every drawing renders both of its groups with the colours it was given', () => {
  const svg = renderBrandSvg('wordmark', README_BRAND_COLORS.dark);
  // Both groups are present: the letterforms, and the accent marks inside them.
  assert.match(svg, /id="main-text" fill="#FFFFFF"/, 'the letterforms carry the ink colour');
  assert.match(svg, /id="accent-text" fill="#00a2fb"/, 'the accent marks carry the accent colour');
  // No placeholder survives into the file, which is what a stale extraction would leave behind.
  assert.ok(!svg.includes('__INK__') && !svg.includes('__ACCENT__'), 'no placeholder survives');
  assert.ok(svg.startsWith('<svg '), 'the output is an SVG document');
});

test('the two themes render different files', () => {
  const dark = renderBrandSvg('wordmark', README_BRAND_COLORS.dark);
  const light = renderBrandSvg('wordmark', README_BRAND_COLORS.light);
  // A shared file would make the README unreadable in one of the two GitHub themes.
  assert.notEqual(dark, light, 'the two themes are not the same drawing');
  assert.match(light, /id="main-text" fill="#181A1F"/, 'the light drawing uses near-black ink');
});

test('the mark only draws the accent where the artwork has accent marks', () => {
  // The standalone `o` is monochrome: it is the wordmark's leading letter, with no hyphens or
  // coloured letters in it. A placeholder left in it would render as literal text.
  const mark = renderBrandSvg('o', README_BRAND_COLORS.dark);
  assert.match(mark, /fill="#FFFFFF"/, 'the mark carries the ink colour');
  assert.ok(!mark.includes('__'), 'the mark has no unsubstituted placeholder');
});

test('the committed README artwork is not stale', () => {
  // The same check `pnpm check-brand` runs. Its value is that a change to the accent cannot leave
  // the READMEs drawing the old one.
  const stale = syncBrand({ check: true, quiet: true });
  assert.deepEqual(stale, [], `stale brand artwork: ${stale.join(', ')}`);
});

test('the artifacts the READMEs reference are the files that exist', () => {
  const files = brandArtifacts().map((artifact) => artifact.file);
  assert.equal(files.length, 2, 'one drawing per theme');
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} exists`);
  }
  // And both READMEs point at exactly these, so a rename cannot leave a broken image behind.
  for (const readme of ['README.md', 'README.zh-CN.md']) {
    const text = fs.readFileSync(path.join(root, readme), 'utf8');
    for (const file of files) {
      assert.ok(text.includes(file), `${readme} references ${file}`);
    }
  }
});

test('an unknown shape is refused rather than rendered empty', () => {
  // A silent empty drawing would ship an invisible logo; the extraction asserts instead.
  assert.throws(() => renderBrandSvg('nope', README_BRAND_COLORS.dark), /no drawing named/, 'an unknown shape throws');
});
