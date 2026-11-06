/**
 * Which font shards a text needs: what an exported conversation embeds.
 *
 * An export that misses a shard draws those characters from the reader's own fonts; one
 * that takes every shard carries the whole typeface. The CJK side comes from Google Fonts,
 * narrowed to the characters the bundle leaves out. The committed manifest is used as
 * well as a hand-written one, so a regenerated font is held to the same answers: the
 * runtime parses its ranges as the generator does, and common text stays in few shards.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import manifest from '../../src/assets/fonts/sarasa/manifest.json' with { type: 'json' };
import { parseUnicodeRange, shardsForText } from '../../src/theme/fontShards.ts';
import { SERVED_ELSEWHERE_RANGES, parseUnicodeRange as generatorParseUnicodeRange } from '../../../scripts/font-shards.mjs';
import { CJK_STYLESHEET_URL, SERVED_RANGES, facesForText, narrowUnicodeRange, parseCJKFaces } from '../../src/theme/cjkFont.ts';
import { isOptional } from '../../../scripts/acceptance/browser-guard.mjs';

const SHARDS = [
  { name: '000', unicodeRange: 'U+20-7E,U+4EEA' },
  { name: '001', unicodeRange: 'U+7EC3,U+5E7F-5E80' },
  { name: '002', unicodeRange: 'U+9F98' },
];

test('a range list parses single code points and spans', () => {
  assert.deepEqual(parseUnicodeRange('U+20-7E, U+4EEA,u+5e7f-5e80'), [[0x20, 0x7e], [0x4eea, 0x4eea], [0x5e7f, 0x5e80]]);
});

test('only the shards holding a character of the text are chosen, in manifest order', () => {
  assert.deepEqual(shardsForText('练 OK', SHARDS).map((shard) => shard.name), ['000', '001']);
  assert.deepEqual(shardsForText('龘广', SHARDS).map((shard) => shard.name), ['001', '002']);
});

test('characters no shard holds choose nothing', () => {
  assert.deepEqual(shardsForText('😀\u{1F600}', SHARDS), []);
  assert.deepEqual(shardsForText('', SHARDS), []);
});

test('the runtime and the generator read every committed range alike', () => {
  for (const shard of manifest.shards) {
    assert.deepEqual(parseUnicodeRange(shard.unicodeRange), generatorParseUnicodeRange(shard.unicodeRange), shard.name);
  }
});

test('the CJK faces keep only the ranges the bundle leaves out, in their own weights', () => {
  // Google's Noto also declares Latin and emoji; those must not draw over Sarasa or colour emoji.
  const css = [
    "@font-face{font-family:'Noto Sans SC';font-style:normal;font-weight:600;src:url(https://fonts.gstatic.com/s/a.woff2) format('woff2');unicode-range:U+0020-007e,U+4e00-4e05,U+1f300;}",
    "@font-face{font-family:'Noto Sans SC';font-style:normal;font-weight:400;src:url(https://fonts.gstatic.com/s/b.woff2) format('woff2');unicode-range:U+0000-00ff,U+1f600;}",
    "@font-face{font-family:'Noto Sans SC';font-style:normal;font-weight:400;src:url(https://example.com/c.woff2) format('woff2');unicode-range:U+4e00;}",
    "@font-face{font-family:'Noto Sans SC';font-style:normal;font-weight:400;src:url(https://fonts.gstatic.com/s/d.woff2) format('woff2');unicode-range:U+abfe-ac01,U+20000-2a6df;}",
  ].join('\n');
  assert.deepEqual(parseCJKFaces(css), [
    { weight: 600, url: 'https://fonts.gstatic.com/s/a.woff2', unicodeRange: 'U+4E00-4E05' },
    { weight: 400, url: 'https://fonts.gstatic.com/s/d.woff2', unicodeRange: 'U+AC00-AC01,U+20000-2A6DF' },
  ]);
  assert.equal(narrowUnicodeRange('U+4e00'), 'U+4E00');
});

test('an export embeds the CJK faces its text needs in every weight', () => {
  const face = (weight: number, unicodeRange: string) => ({ weight, url: `https://fonts.gstatic.com/s/${weight}-${unicodeRange}.woff2`, unicodeRange });
  const faces = [face(400, 'U+4E00'), face(400, 'U+4E01'), face(600, 'U+4E00'), face(600, 'U+4E01'), face(700, 'U+4E00')];
  assert.deepEqual(facesForText('一', faces).map((chosen) => chosen.weight), [400, 600, 700]);
  assert.deepEqual(facesForText('丁', faces).map((chosen) => `${chosen.weight} ${chosen.unicodeRange}`), ['400 U+4E01', '600 U+4E01']);
});

test('the browser checks exempt only the console\'s own CJK stylesheet request', () => {
  assert.ok(isOptional(CJK_STYLESHEET_URL));
  assert.ok(!isOptional('https://fonts.gstatic.com/s/tracker.png'));
  assert.ok(!isOptional('https://fonts.googleapis.com/css2?family=Other'));
});

test('the bundle and the CJK faces split the code points along the same line', () => {
  assert.deepEqual(SERVED_RANGES, SERVED_ELSEWHERE_RANGES);
});
