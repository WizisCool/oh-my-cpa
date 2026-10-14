/**
 * Which shards of the sharded console font a piece of text needs.
 *
 * Kept free of Vite imports so the logic suites can load it directly; the asset wiring
 * lives in `sarasaFont.ts`.
 */

export interface FontShard {
  name: string;
  unicodeRange: string;
}

type CodePointRange = readonly [start: number, end: number];

export function parseUnicodeRange(value: string): CodePointRange[] {
  return value.split(',').map((part) => {
    const [start, end = start] = part.trim().replace(/^U\+/i, '').split('-');
    return [Number.parseInt(start, 16), Number.parseInt(end, 16)] as const;
  });
}

interface ShardRange { start: number; end: number; shard: FontShard }

const sortedRangesByShards = new WeakMap<readonly FontShard[], ShardRange[]>();

function sortedRanges(shards: readonly FontShard[]): ShardRange[] {
  let ranges = sortedRangesByShards.get(shards);
  if (!ranges) {
    ranges = shards.flatMap((shard) => parseUnicodeRange(shard.unicodeRange).map(([start, end]) => ({ start, end, shard })))
      .sort((left, right) => left.start - right.start);
    sortedRangesByShards.set(shards, ranges);
  }
  return ranges;
}

function shardForCodePoint(ranges: readonly ShardRange[], codePoint: number): FontShard | undefined {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = ranges[middle];
    if (codePoint < range.start) high = middle - 1;
    else if (codePoint > range.end) low = middle + 1;
    else return range.shard;
  }
  return undefined;
}

/** The shards that draw at least one character of `text`, in manifest order. */
export function shardsForText(text: string, shards: readonly FontShard[]): FontShard[] {
  const ranges = sortedRanges(shards);
  const needed = new Set<FontShard>();
  for (const character of new Set(text)) {
    const shard = shardForCodePoint(ranges, character.codePointAt(0)!);
    if (shard) needed.add(shard);
  }
  return shards.filter((shard) => needed.has(shard));
}
