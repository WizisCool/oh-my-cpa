import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  CORE_CSS_FILE,
  FONT_DIRECTORY,
  MANIFEST_FILE,
  SHARD_URLS_FILE,
  collectSourceCharacters,
  formatUnicodeRange,
  parseUnicodeRange,
  planShards,
  readCmapCodePoints,
  readSfntCodePoints,
  readWoff2Cmap,
  renderCoreCss,
  renderShardUrlsModule,
  shardFileName,
} from './font-shards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A cmap holding one Unicode subtable. */
function cmapWith(subtable, encodingId = 1) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(3, 4);
  header.writeUInt16BE(encodingId, 6);
  header.writeUInt32BE(12, 8);
  return Buffer.concat([header, subtable]);
}

/** Format 4 with a delta segment, an idRangeOffset segment (one unmapped slot) and the 0xFFFF terminator. */
function format4Subtable() {
  const segments = [
    { start: 0x41, end: 0x42, delta: 1, rangeOffset: 0 },
    { start: 0x7ec3, end: 0x7ec4, delta: 0, rangeOffset: 4 },
    { start: 0xffff, end: 0xffff, delta: 1, rangeOffset: 0 },
  ];
  const glyphIds = [7, 0];
  const count = segments.length;
  const table = Buffer.alloc(16 + count * 8 + glyphIds.length * 2);
  table.writeUInt16BE(4, 0);
  table.writeUInt16BE(table.length, 2);
  table.writeUInt16BE(count * 2, 6);
  segments.forEach((segment, i) => {
    table.writeUInt16BE(segment.end, 14 + i * 2);
    table.writeUInt16BE(segment.start, 16 + count * 2 + i * 2);
    table.writeInt16BE(segment.delta, 16 + count * 4 + i * 2);
    // Measured from this segment's own idRangeOffset slot: two slots ahead lands on glyphIds.
    table.writeUInt16BE(segment.rangeOffset, 16 + count * 6 + i * 2);
  });
  glyphIds.forEach((glyph, i) => table.writeUInt16BE(glyph, 16 + count * 8 + i * 2));
  return table;
}

function uIntBase128(value) {
  const bytes = [value & 0x7f];
  for (let rest = value >>> 7; rest > 0; rest >>>= 7) bytes.unshift((rest & 0x7f) | 0x80);
  return Buffer.from(bytes);
}

test('format 4 maps delta and glyph-array segments, skipping unmapped slots', () => {
  const codePoints = readCmapCodePoints(cmapWith(format4Subtable()));
  assert.deepEqual([...codePoints].sort((left, right) => left - right), [0x41, 0x42, 0x7ec3]);
});

test('format 12 is preferred and maps whole groups', () => {
  const table = Buffer.alloc(28);
  table.writeUInt16BE(12, 0);
  table.writeUInt32BE(table.length, 4);
  table.writeUInt32BE(1, 12);
  table.writeUInt32BE(0x5e7f, 16);
  table.writeUInt32BE(0x5e80, 20);
  table.writeUInt32BE(9, 24);
  assert.deepEqual([...readCmapCodePoints(cmapWith(table, 10))], [0x5e7f, 0x5e80]);
});

test('the cmap is found behind a transformed glyph table in the WOFF2 stream', () => {
  const glyf = Buffer.from('transformed glyf bytes');
  const cmap = cmapWith(format4Subtable());
  // glyf with transform version 0 carries a transformLength; cmap with version 0 does not.
  const directory = Buffer.concat([
    Buffer.from([10]), uIntBase128(glyf.length + 100), uIntBase128(glyf.length),
    Buffer.from([0]), uIntBase128(cmap.length),
  ]);
  const compressed = zlib.brotliCompressSync(Buffer.concat([glyf, cmap]));
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'latin1');
  header.write('\0\x01\0\0', 4, 'latin1');
  header.writeUInt16BE(2, 12);
  header.writeUInt32BE(compressed.length, 20);
  assert.deepEqual(readWoff2Cmap(Buffer.concat([header, directory, compressed])), cmap);
});

test('source characters come from web/src text files and the HTML shell only', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'font-shards-'));
  try {
    fs.mkdirSync(path.join(directory, 'web', 'src', 'i18n'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'web', 'src', 'i18n', 'index.tsx'), "'操练场'");
    fs.writeFileSync(path.join(directory, 'web', 'src', 'logo.svg'), '<text>图</text>');
    fs.writeFileSync(path.join(directory, 'web', 'index.html'), '<title>广</title>');
    const characters = collectSourceCharacters(directory);
    assert.ok(['操', '练', '场', '广'].every((character) => characters.has(character)));
    assert.equal(characters.has('图'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an sfnt file is read through its table directory', () => {
  const cmap = cmapWith(format4Subtable());
  const header = Buffer.alloc(12 + 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(1, 4);
  header.write('cmap', 12, 'latin1');
  header.writeUInt32BE(header.length, 20);
  header.writeUInt32BE(cmap.length, 24);
  assert.deepEqual([...readSfntCodePoints(Buffer.concat([header, cmap]))].sort((left, right) => left - right), [0x41, 0x42, 0x7ec3]);
});

test('unicode ranges collapse consecutive runs and parse back', () => {
  const value = formatUnicodeRange([0x7ec3, 0x41, 0x42, 0x43, 0x5e7f]);
  assert.equal(value, 'U+41-43,U+5E7F,U+7EC3');
  assert.deepEqual(parseUnicodeRange(value), [[0x41, 0x43], [0x5e7f, 0x5e7f], [0x7ec3, 0x7ec3]]);
});

test('the plan puts the core first, then each tier in bounded shards, each code point once', () => {
  const font = [0x41, 0x42, 0x4e00, 0x4e01, 0x4e02, 0x4e03, 0x4e04, 0x9fa5, 0xac00];
  // U+4E04 is used by the source, so the core takes it before its tier can.
  const plan = planShards(font, new Set(['\u4e04']), [[0x4e04, 0x4e01, 0x4e03], [0x9fa5]], 2);
  assert.deepEqual(plan, [
    { name: '000', codePoints: [0x41, 0x42, 0x4e04] },
    { name: '001', codePoints: [0x4e01, 0x4e03] },
    { name: '002', codePoints: [0x9fa5] },
    { name: '003', codePoints: [0x4e00, 0x4e02] },
    { name: '004', codePoints: [0xac00] },
  ]);
});

test('the committed shards, manifest, core stylesheet and URL module agree', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_FILE), 'utf8'));
  assert.equal(fs.readFileSync(path.join(root, CORE_CSS_FILE), 'utf8'), renderCoreCss(manifest));
  assert.equal(fs.readFileSync(path.join(root, SHARD_URLS_FILE), 'utf8'), renderShardUrlsModule(manifest));
  const expectedFiles = manifest.weights.flatMap((weight) => manifest.shards.map((shard) => shardFileName(weight, shard.name))).sort();
  const files = fs.readdirSync(path.join(root, FONT_DIRECTORY)).filter((file) => file.endsWith('.woff2')).sort();
  assert.deepEqual(files, expectedFiles);
  const owners = new Map();
  for (const shard of manifest.shards) {
    const declared = new Set(parseUnicodeRange(shard.unicodeRange)
      .flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, i) => start + i)));
    for (const codePoint of declared) {
      assert.equal(owners.has(codePoint), false, `U+${codePoint.toString(16)} is in shards ${owners.get(codePoint)} and ${shard.name}`);
      owners.set(codePoint, shard.name);
    }
    for (const weight of manifest.weights) {
      const drawn = readCmapCodePoints(readWoff2Cmap(fs.readFileSync(path.join(root, FONT_DIRECTORY, shardFileName(weight, shard.name)))));
      // A shard may map more: a glyph it keeps can also be another character's. Its
      // unicode-range, not its cmap, decides what it is asked to draw.
      const undrawnHere = [...declared].filter((codePoint) => !drawn.has(codePoint));
      assert.deepEqual(undrawnHere, [], `${weight}-${shard.name} draws everything it declares`);
    }
  }
  // A character Sarasa cannot draw would come from a system font; colour emoji are meant to.
  const undrawn = [...collectSourceCharacters(root)]
    .filter((character) => !/^\p{Emoji_Presentation}$/u.test(character) && !owners.has(character.codePointAt(0)));
  assert.deepEqual(undrawn, []);
});
