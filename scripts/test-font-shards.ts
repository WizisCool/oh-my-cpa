/**
 * Which font shards a text needs: what an exported conversation embeds.
 *
 * An export that misses a shard draws those characters from the reader's own fonts; one
 * that takes every shard carries the whole typeface. The committed manifest is used as
 * well as a hand-written one, so a regenerated font is held to the same answers: the
 * runtime parses its ranges as the generator does, and common text stays in few shards.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import manifest from '../web/src/assets/fonts/sarasa/manifest.json' with { type: 'json' };
import { parseUnicodeRange, shardsForText } from '../web/src/theme/fontShards.ts';
import { parseUnicodeRange as generatorParseUnicodeRange } from './font-shards.mjs';

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

test('the most common Chinese characters fill the shards right after the core', () => {
  // GB2312 level 1, rows B0-D7, is the first frequency tier: ordinary text outside the
  // console's copy should need only the shards just after the core.
  const decoder = new TextDecoder('gbk');
  let levelOne = '';
  for (let lead = 0xb0; lead <= 0xd7; lead += 1) {
    for (let trail = 0xa1; trail <= 0xfe; trail += 1) {
      const character = decoder.decode(new Uint8Array([lead, trail]));
      if (character !== '\ufffd') levelOne += character;
    }
  }
  const core = manifest.shards[0];
  const outsideCore = [...levelOne].filter((character) => shardsForText(character, manifest.shards)[0] !== core).join('');
  const expectedCount = Math.ceil([...outsideCore].length / 400);
  assert.deepEqual(
    shardsForText(outsideCore, manifest.shards).map((shard) => shard.name),
    Array.from({ length: expectedCount }, (_, i) => String(i + 1).padStart(3, '0')),
  );
  const poem = shardsForText('床前明月光疑是地上霜举头望明月低头思故乡', manifest.shards);
  assert.ok(poem.every((shard) => Number(shard.name) <= expectedCount), poem.map((shard) => shard.name).join(','));
});
