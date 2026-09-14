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

import { brandArtifacts, paletteValue, readmeBrandColors, renderBrandSvg, syncBrand } from './sync-brand.mjs';

const brandColors = readmeBrandColors();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every drawing renders both of its groups with the colours it was given', () => {
  const svg = renderBrandSvg('wordmark', brandColors.dark);
  // Both groups are present: the letterforms, and the accent marks inside them.
  assert.ok(svg.includes(`id="main-text" fill="${brandColors.dark.ink}"`), 'the letterforms carry the ink colour');
  assert.ok(svg.includes(`id="accent-text" fill="${brandColors.dark.accent}"`), 'the accent marks carry the accent colour');
  // No placeholder survives into the file, which is what a stale extraction would leave behind.
  assert.ok(!svg.includes('__INK__') && !svg.includes('__ACCENT__'), 'no placeholder survives');
  assert.ok(svg.startsWith('<svg '), 'the output is an SVG document');
});

test('the two themes render different files', () => {
  const dark = renderBrandSvg('wordmark', brandColors.dark);
  const light = renderBrandSvg('wordmark', brandColors.light);
  // A shared file would make the README unreadable in one of the two GitHub themes.
  assert.notEqual(dark, light, 'the two themes are not the same drawing');
  assert.ok(light.includes(`id="main-text" fill="${brandColors.light.ink}"`), 'the light drawing uses the light ink');
});

test('the mark only draws the accent where the artwork has accent marks', () => {
  // The standalone `o` is monochrome: it is the wordmark's leading letter, with no hyphens or
  // coloured letters in it. A placeholder left in it would render as literal text.
  const mark = renderBrandSvg('o', brandColors.dark);
  assert.ok(mark.includes(`fill="${brandColors.dark.ink}"`), 'the mark carries the ink colour');
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

test('the README colours are read from the app palette, not held as literals', () => {
  // The property the whole script exists for. Holding the accent as a literal here while reading
  // the drawings from the markup module would connect one half and leave the other free to drift:
  // the staleness check would pass while the README and the console disagreed, which is exactly the
  // defect the four hand-maintained SVGs had. This asserts the connection rather than the values.
  assert.equal(brandColors.dark.accent, paletteValue('dark', 'accent'), 'the dark accent comes from the palette');
  assert.equal(brandColors.light.accent, paletteValue('light', 'accent'), 'the light accent comes from the palette');
  assert.equal(brandColors.dark.ink, paletteValue('dark', 'fg'), 'the dark ink comes from the palette');
  assert.equal(brandColors.light.ink, paletteValue('light', 'fg'), 'the light ink comes from the palette');
  // And the palette is not vacuous: an accent that was not there would have thrown above, so the
  // values are real colours rather than an empty match.
  assert.match(brandColors.dark.accent, /^#[0-9a-f]{6}$/i, 'the accent is a colour');
});

test('a palette value that does not exist is refused rather than rendered empty', () => {
  // The failure that would otherwise ship as artwork with no accent in it.
  assert.throws(() => paletteValue('dark', 'notAColour'), /no notAColour colour/, 'an unknown key throws');
  assert.throws(() => paletteValue('chartreuse', 'accent'), /no chartreuse palette/, 'an unknown mode throws');
});

test('an unknown shape is refused rather than rendered empty', () => {
  // A silent empty drawing would ship an invisible logo; the extraction asserts instead.
  assert.throws(() => renderBrandSvg('nope', brandColors.dark), /no drawing named/, 'an unknown shape throws');
});
