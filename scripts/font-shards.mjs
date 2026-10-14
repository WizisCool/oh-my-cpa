/**
 * The console's typeface, Sarasa Mono SC, ships complete but cut into shards.
 *
 * A subset cut from the console's own copy cannot draw text that arrives at run time - an
 * Agent answer, a model or user label - and it went stale whenever copy was added after it
 * was cut: the browser drew every missing glyph from a system font, so one label could mix
 * two typefaces. The whole font is about 5 MiB per weight, too much to make every first
 * visit wait for, so it is cut into shards declared with `unicode-range`: a browser fetches
 * only the shards whose characters a page actually draws.
 *
 * Shard 000 is the core: ASCII, Latin-1, common punctuation and every character the
 * console's source uses, declared in render-blocking CSS so the first frame needs one file
 * per weight. The rest are registered asynchronously and ordered by how common their
 * characters are - GB2312 level 1, Big5 level 1, GB2312 level 2, Big5 level 2, then
 * everything else by code point - so ordinary Chinese text touches a handful of shards
 * rather than one in every stretch of the CJK block.
 *
 * Everything here is pure; `subset-font.mjs` runs the subsetter and writes the outputs.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FONT_DIRECTORY = 'web/src/assets/fonts/sarasa';
export const MANIFEST_FILE = `${FONT_DIRECTORY}/manifest.json`;
export const CORE_CSS_FILE = `${FONT_DIRECTORY}/core.css`;
export const SHARD_URLS_FILE = `${FONT_DIRECTORY}/shardUrls.ts`;
export const FONT_FAMILY = 'Sarasa Mono SC';
export const FONT_WEIGHTS = [400, 700];
/** Installed copies a browser may use instead of downloading; they keep `local()` priority. */
export const LOCAL_NAMES = { 400: ['Sarasa Mono SC', 'Sarasa UI SC', '更纱黑体 SC'], 700: ['Sarasa Mono SC Bold', 'Sarasa UI SC Bold', '更纱黑体 SC Bold'] };
/** About 40 KiB of woff2 per shard: small enough that a stray character costs little. */
export const SHARD_SIZE = 400;

const SOURCE_EXTENSION = /\.(?:tsx?|jsx?|css|html|json)$/;
const CORE_RANGES = [[0x20, 0x7e], [0xa0, 0xff], [0x2000, 0x206f], [0x3000, 0x303f], [0xff00, 0xffef]];

export function shardFileName(weight, shardName) {
  return `sarasa-mono-sc-${weight}-${shardName}.woff2`;
}

/** Every character in the console's source and HTML shell. */
export function collectSourceCharacters(directory = root) {
  const characters = new Set();
  const addText = (text) => {
    for (const character of text) {
      if (character >= ' ') characters.add(character);
    }
  };
  const scanDirectory = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const fullPath = path.join(folder, entry.name);
      if (entry.isDirectory()) scanDirectory(fullPath);
      else if (SOURCE_EXTENSION.test(entry.name)) addText(fs.readFileSync(fullPath, 'utf8'));
    }
  };
  scanDirectory(path.join(directory, 'web', 'src'));
  const indexHtml = path.join(directory, 'web', 'index.html');
  if (fs.existsSync(indexHtml)) addText(fs.readFileSync(indexHtml, 'utf8'));
  return characters;
}

/** The characters of a double-byte encoding block, in the encoding's own order of commonness. */
function encodedBlock(encoding, leads, trails) {
  const decoder = new TextDecoder(encoding);
  const codePoints = [];
  for (let lead = leads[0]; lead <= leads[1]; lead += 1) {
    for (const [first, last] of trails) {
      for (let trail = first; trail <= last; trail += 1) {
        const character = decoder.decode(new Uint8Array([lead, trail]));
        if ([...character].length === 1 && character !== '\ufffd') codePoints.push(character.codePointAt(0));
      }
    }
  }
  return codePoints;
}

export function frequencyTiers() {
  const gbTrails = [[0xa1, 0xfe]];
  const big5Trails = [[0x40, 0x7e], [0xa1, 0xfe]];
  return [
    encodedBlock('gbk', [0xb0, 0xd7], gbTrails),
    encodedBlock('big5', [0xa4, 0xc6], big5Trails),
    encodedBlock('gbk', [0xd8, 0xf7], gbTrails),
    encodedBlock('big5', [0xc9, 0xf9], big5Trails),
  ];
}

/**
 * Splits a font's code points into shards: the core first, then each frequency tier in
 * shards of at most `shardSize`, then the remainder. Every code point lands in exactly one.
 */
export function planShards(fontCodePoints, sourceCharacters, tiers = frequencyTiers(), shardSize = SHARD_SIZE) {
  const remaining = new Set(fontCodePoints);
  const take = (codePoints) => {
    const taken = [...new Set(codePoints)].filter((codePoint) => remaining.has(codePoint)).sort((left, right) => left - right);
    taken.forEach((codePoint) => remaining.delete(codePoint));
    return taken;
  };
  const core = take([
    ...CORE_RANGES.flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, i) => start + i)),
    ...[...sourceCharacters].map((character) => character.codePointAt(0)),
  ]);
  const shards = [core];
  for (const tier of [...tiers, [...remaining]]) {
    const codePoints = take(tier);
    for (let i = 0; i < codePoints.length; i += shardSize) shards.push(codePoints.slice(i, i + shardSize));
  }
  return shards.filter((codePoints) => codePoints.length > 0)
    .map((codePoints, index) => ({ name: String(index).padStart(3, '0'), codePoints }));
}

/** A sorted code point list as a CSS `unicode-range` value, consecutive runs collapsed. */
export function formatUnicodeRange(codePoints) {
  const sorted = [...codePoints].sort((left, right) => left - right);
  const parts = [];
  for (let i = 0; i < sorted.length;) {
    let end = i;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end += 1;
    const hex = (codePoint) => codePoint.toString(16).toUpperCase();
    parts.push(end === i ? `U+${hex(sorted[i])}` : `U+${hex(sorted[i])}-${hex(sorted[end])}`);
    i = end + 1;
  }
  return parts.join(',');
}

export function parseUnicodeRange(value) {
  return value.split(',').map((part) => {
    const [start, end = start] = part.trim().replace(/^U\+/i, '').split('-');
    return [Number.parseInt(start, 16), Number.parseInt(end, 16)];
  });
}

/** The render-blocking declarations: the core shard of each weight. */
export function renderCoreCss(manifest) {
  const core = manifest.shards[0];
  const faces = manifest.weights.map((weight) => [
    '@font-face {',
    `  font-family: "${manifest.family}";`,
    `  src: ${manifest.local[weight].map((name) => `local("${name}")`).join(', ')},`,
    `       url("./${shardFileName(weight, core.name)}") format("woff2");`,
    `  font-weight: ${weight};`,
    '  font-style: normal;',
    '  font-display: swap;',
    `  unicode-range: ${core.unicodeRange};`,
    '}',
  ].join('\n'));
  return `/* Generated by \`pnpm subset-font\` from ${manifest.source}; see scripts/font-shards.mjs. */\n${faces.join('\n\n')}\n`;
}

/**
 * A module of every shard's URL, each a literal `new URL('./file', import.meta.url)`. Vite turns
 * each into the hashed asset at build time and serves the file as-is in development, so neither a
 * built module nor the dev server's module graph carries a path per shard: a `?url` import would
 * cost the dev server one module request per shard on every page load, and an
 * `import.meta.glob` map would keep each source path as a key, which the demonstration's asset
 * rewrite would then mistake for a relative reference.
 */
export function renderShardUrlsModule(manifest) {
  const entries = manifest.weights.flatMap((weight) => manifest.shards.map((shard) =>
    `  '${weight}-${shard.name}': new URL('./${shardFileName(weight, shard.name)}', import.meta.url).href,`));
  return [
    `// Generated by \`pnpm subset-font\` from ${manifest.source}; see scripts/font-shards.mjs.`,
    '',
    '/** Shard URLs keyed by `<weight>-<shard name>`. */',
    'export const SHARD_URLS: Readonly<Record<string, string>> = {',
    ...entries,
    '};',
    '',
  ].join('\n');
}

/** Code points in an OpenType/TrueType file, read from its cmap. */
export function readSfntCodePoints(buffer) {
  const tableCount = buffer.readUInt16BE(4);
  for (let i = 0; i < tableCount; i += 1) {
    const record = 12 + i * 16;
    if (buffer.toString('latin1', record, record + 4) !== 'cmap') continue;
    const offset = buffer.readUInt32BE(record + 8);
    return readCmapCodePoints(buffer.subarray(offset, offset + buffer.readUInt32BE(record + 12)));
  }
  throw new Error('font: no cmap table');
}

function readUIntBase128(bytes, state) {
  let value = 0;
  for (let i = 0; i < 5; i += 1) {
    const byte = bytes[state.offset++];
    if (i === 0 && byte === 0x80) throw new Error('woff2: UIntBase128 has a leading zero');
    if (value & 0xfe000000) throw new Error('woff2: UIntBase128 overflows');
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return value >>> 0;
  }
  throw new Error('woff2: UIntBase128 is longer than five bytes');
}

/** The uncompressed `cmap` table of a single-font WOFF2 file. */
export function readWoff2Cmap(buffer) {
  if (buffer.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a WOFF2 file');
  if (buffer.toString('latin1', 4, 8) === 'ttcf') throw new Error('woff2: font collections are not supported');
  const numTables = buffer.readUInt16BE(12);
  const totalCompressedSize = buffer.readUInt32BE(20);
  const state = { offset: 48 };
  let streamOffset = 0;
  let cmap = null;
  for (let i = 0; i < numTables; i += 1) {
    const flags = buffer[state.offset++];
    const tagIndex = flags & 0x3f;
    const transformVersion = flags >> 6;
    const tag = tagIndex === 0x3f ? buffer.toString('latin1', state.offset, (state.offset += 4)) : tagIndex;
    const originalLength = readUIntBase128(buffer, state);
    // glyf (10) and loca (11) are transformed unless their version is 3; every other table is
    // transformed only by a non-zero version.
    const isGlyphTable = tag === 10 || tag === 11 || tag === 'glyf' || tag === 'loca';
    const isTransformed = isGlyphTable ? transformVersion !== 3 : transformVersion !== 0;
    const storedLength = isTransformed ? readUIntBase128(buffer, state) : originalLength;
    if (tag === 0 || tag === 'cmap') cmap = { offset: streamOffset, length: storedLength };
    streamOffset += storedLength;
  }
  if (!cmap) throw new Error('woff2: no cmap table');
  const stream = zlib.brotliDecompressSync(buffer.subarray(state.offset, state.offset + totalCompressedSize));
  return stream.subarray(cmap.offset, cmap.offset + cmap.length);
}

/** Code points the `cmap` maps to a real glyph, from its best Unicode subtable. */
export function readCmapCodePoints(cmap) {
  const subtables = [];
  for (let i = 0; i < cmap.readUInt16BE(2); i += 1) {
    const record = 4 + i * 8;
    const offset = cmap.readUInt32BE(record + 4);
    subtables.push({ platformId: cmap.readUInt16BE(record), encodingId: cmap.readUInt16BE(record + 2), offset, format: cmap.readUInt16BE(offset) });
  }
  const isUnicode = ({ platformId, encodingId }) => platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10));
  const subtable = subtables.find((entry) => isUnicode(entry) && entry.format === 12)
    ?? subtables.find((entry) => isUnicode(entry) && entry.format === 4);
  if (!subtable) throw new Error('cmap: no Unicode format 4 or 12 subtable');

  const codePoints = new Set();
  const base = subtable.offset;
  if (subtable.format === 12) {
    const groupCount = cmap.readUInt32BE(base + 12);
    for (let i = 0; i < groupCount; i += 1) {
      const group = base + 16 + i * 12;
      const start = cmap.readUInt32BE(group);
      const end = cmap.readUInt32BE(group + 4);
      const startGlyph = cmap.readUInt32BE(group + 8);
      for (let codePoint = start; codePoint <= end; codePoint += 1) {
        if (startGlyph + codePoint - start !== 0) codePoints.add(codePoint);
      }
    }
    return codePoints;
  }

  const segmentCount = cmap.readUInt16BE(base + 6) / 2;
  const endCodes = base + 14;
  const startCodes = endCodes + segmentCount * 2 + 2;
  const idDeltas = startCodes + segmentCount * 2;
  const idRangeOffsets = idDeltas + segmentCount * 2;
  for (let i = 0; i < segmentCount; i += 1) {
    const start = cmap.readUInt16BE(startCodes + i * 2);
    const end = cmap.readUInt16BE(endCodes + i * 2);
    const delta = cmap.readInt16BE(idDeltas + i * 2);
    const rangeOffsetPosition = idRangeOffsets + i * 2;
    const rangeOffset = cmap.readUInt16BE(rangeOffsetPosition);
    for (let codePoint = start; codePoint <= end && codePoint !== 0xffff; codePoint += 1) {
      let glyph;
      if (rangeOffset === 0) glyph = (codePoint + delta) & 0xffff;
      else {
        const glyphIndex = cmap.readUInt16BE(rangeOffsetPosition + rangeOffset + (codePoint - start) * 2);
        glyph = glyphIndex === 0 ? 0 : (glyphIndex + delta) & 0xffff;
      }
      if (glyph !== 0) codePoints.add(codePoint);
    }
  }
  return codePoints;
}
