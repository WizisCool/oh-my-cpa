import type React from 'react';

export const DEFAULT_REQUEST_ROW_HEIGHT = 72;
export const DEFAULT_REQUEST_GROUP_HEADER_HEIGHT = 39;
export const REQUEST_VIRTUAL_OVERSCAN_PX = 432;
export const REQUEST_VIRTUAL_STRIDE_ROWS = 2;

export interface VirtualWindow {
  readonly totalHeight: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly offsetTop: number;
  readonly offsets: Float64Array;
}

export interface GroupSegmentEntry<T> {
  readonly item: T;
  readonly index: number;
}

export interface GroupSegment<T> {
  readonly groupKey: string;
  readonly items: T[];
  readonly entries: GroupSegmentEntry<T>[];
}

export interface VirtualGroupSlice {
  readonly bodyHeight: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly offsetTop: number;
  readonly offsets: Float64Array;
}

export interface GroupedVirtualWindow {
  readonly totalHeight: number;
  readonly slices: readonly VirtualGroupSlice[];
  readonly rangeKey: string;
}

/**
 * Groups items in first-seen key order while preserving each item's original index,
 * matching the grouping semantics expected by the request stream's source and UA modes.
 */
export function buildGroupSegments<T>(
  items: readonly T[],
  getGroupKey: (item: T) => string,
): GroupSegment<T>[] {
  const map = new Map<string, GroupSegment<T>>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const groupKey = getGroupKey(item);
    let segment = map.get(groupKey);
    if (!segment) {
      segment = { groupKey, items: [], entries: [] };
      map.set(groupKey, segment);
    }
    segment.items.push(item);
    segment.entries.push({ item, index });
  }
  return [...map.values()];
}

const EMPTY_OFFSETS = new Float64Array(1);

function findFirstOverlapping(offsets: Float64Array, count: number, targetPx: number): number {
  let low = 0;
  let high = count - 1;
  let answer = count - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid + 1] > targetPx) {
      answer = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return answer;
}

function findLastOverlapping(offsets: Float64Array, start: number, count: number, targetPx: number): number {
  let low = start;
  let high = count - 1;
  let answer = start;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid] < targetPx) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return answer;
}

/**
 * Computes the overscanned, stride-quantized mounted row window for an ungrouped stream.
 *
 * Returning per-row `offsets` lets each mounted row position itself at its stable scroll-space
 * Y coordinate, so advancing `startIndex` never shifts or repaints surviving rows.
 */
export function computeVirtualWindow({
  itemCount,
  getRowHeight,
  scrollTop,
  viewportHeight,
  overscanPx = REQUEST_VIRTUAL_OVERSCAN_PX,
  strideRows = REQUEST_VIRTUAL_STRIDE_ROWS,
}: {
  itemCount: number;
  getRowHeight: (index: number) => number;
  scrollTop: number;
  viewportHeight: number;
  overscanPx?: number;
  strideRows?: number;
}): VirtualWindow {
  if (itemCount <= 0) {
    return { totalHeight: 0, startIndex: 0, endIndex: -1, offsetTop: 0, offsets: EMPTY_OFFSETS };
  }

  const stride = Math.max(1, strideRows);
  const offsets = new Float64Array(itemCount + 1);
  for (let i = 0; i < itemCount; i += 1) {
    offsets[i + 1] = offsets[i] + Math.max(1, getRowHeight(i));
  }
  const totalHeight = offsets[itemCount];
  const safeViewport = Math.max(1, viewportHeight);
  const clampedScrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - safeViewport)));
  const visibleStartPx = Math.max(0, clampedScrollTop - overscanPx);
  const visibleEndPx = clampedScrollTop + safeViewport + overscanPx;

  const rawStart = findFirstOverlapping(offsets, itemCount, visibleStartPx);
  const rawEnd = findLastOverlapping(offsets, rawStart, itemCount, visibleEndPx);

  const startIndex = Math.floor(rawStart / stride) * stride;
  const endIndex = Math.min(itemCount - 1, Math.ceil((rawEnd + 1) / stride) * stride - 1);

  return {
    totalHeight,
    startIndex,
    endIndex,
    offsetTop: offsets[startIndex],
    offsets,
  };
}

/**
 * Computes per-group virtualized item slices while keeping every group section and sticky
 * header in native CSS flow.
 */
export function computeGroupedVirtualWindow<T>({
  segments,
  getItemKey,
  getHeaderHeight,
  getItemHeight,
  scrollTop,
  viewportHeight,
  overscanPx = REQUEST_VIRTUAL_OVERSCAN_PX,
  strideRows = REQUEST_VIRTUAL_STRIDE_ROWS,
}: {
  segments: readonly GroupSegment<T>[];
  getItemKey: (item: T) => React.Key;
  getHeaderHeight: (groupKey: string) => number;
  getItemHeight: (key: React.Key) => number;
  scrollTop: number;
  viewportHeight: number;
  overscanPx?: number;
  strideRows?: number;
}): GroupedVirtualWindow {
  if (segments.length === 0) {
    return { totalHeight: 0, slices: [], rangeKey: '' };
  }

  const stride = Math.max(1, strideRows);
  const segOffsets: Float64Array[] = new Array(segments.length);
  const segBodyStarts = new Float64Array(segments.length);
  let cursorY = 0;

  for (let s = 0; s < segments.length; s += 1) {
    const seg = segments[s];
    cursorY += Math.max(1, getHeaderHeight(seg.groupKey));
    segBodyStarts[s] = cursorY;
    const count = seg.entries.length;
    const local = new Float64Array(count + 1);
    for (let i = 0; i < count; i += 1) {
      local[i + 1] = local[i] + Math.max(1, getItemHeight(getItemKey(seg.entries[i].item)));
    }
    segOffsets[s] = local;
    cursorY += local[count];
  }

  const totalHeight = cursorY;
  const safeViewport = Math.max(1, viewportHeight);
  const clampedScrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - safeViewport)));
  const visibleStartPx = Math.max(0, clampedScrollTop - overscanPx);
  const visibleEndPx = clampedScrollTop + safeViewport + overscanPx;

  const slices: VirtualGroupSlice[] = new Array(segments.length);
  const keyParts: string[] = [];

  for (let s = 0; s < segments.length; s += 1) {
    const seg = segments[s];
    const count = seg.entries.length;
    const local = segOffsets[s];
    const bodyHeight = local[count];
    const bodyStart = segBodyStarts[s];
    const bodyEnd = bodyStart + bodyHeight;

    if (count === 0 || bodyEnd <= visibleStartPx || bodyStart >= visibleEndPx) {
      slices[s] = { bodyHeight, startIndex: 0, endIndex: -1, offsetTop: 0, offsets: local };
      continue;
    }

    const localStartPx = Math.max(0, visibleStartPx - bodyStart);
    const localEndPx = Math.min(bodyHeight, visibleEndPx - bodyStart);
    const rawStart = findFirstOverlapping(local, count, localStartPx);
    const rawEnd = findLastOverlapping(local, rawStart, count, localEndPx);
    const startIndex = Math.floor(rawStart / stride) * stride;
    const endIndex = Math.min(count - 1, Math.ceil((rawEnd + 1) / stride) * stride - 1);

    slices[s] = {
      bodyHeight,
      startIndex,
      endIndex,
      offsetTop: local[startIndex],
      offsets: local,
    };
    keyParts.push(`${s}:${startIndex}-${endIndex}`);
  }

  return {
    totalHeight,
    slices,
    rangeKey: keyParts.join(','),
  };
}

/** How one drawn row enters the arrival glide. */
export interface ArrivalMove {
  readonly key: React.Key;
  /** The row's offset from its new place when the glide starts: the place it was drawn before. */
  readonly from: number;
  /** A record the list did not hold before, which fades in as it glides. */
  readonly isArrival: boolean;
}

/**
 * Plans the glide that carries newly arrived records into the drawn rows.
 *
 * A row drawn both times starts from where it stood. An arrival has no place of its own to start
 * from, so it travels with the row beneath it (with the row above it when it lands at the end), and
 * the stack reads as one move. `null` means the change is not an arrival to animate: nothing drawn
 * before is still drawn (another page or view), nothing new is drawn (a record left the list, or
 * rows only moved off screen), or a row would travel more than `maxTravel` - a backlog released at
 * once lands as it is rather than streaking past.
 */
export function planArrivalGlide({
  previousKeys,
  previousTops,
  drawnTops,
  maxTravel,
}: {
  previousKeys: ReadonlySet<React.Key>;
  /** Rows drawn last time and where. */
  previousTops: ReadonlyMap<React.Key, number>;
  /** Rows drawn now and where, in drawing order. */
  drawnTops: ReadonlyMap<React.Key, number>;
  maxTravel: number;
}): ArrivalMove[] | null {
  const drawn = [...drawnTops];
  const froms: (number | null)[] = drawn.map(([key, top]) => {
    if (previousKeys.has(key)) {
      const previousTop = previousTops.get(key);
      return previousTop === undefined ? 0 : previousTop - top;
    }
    return null;
  });
  const isArrival = froms.map((from) => from === null);
  if (!isArrival.includes(true) || !drawn.some(([key]) => previousTops.has(key))) return null;

  let below: number | null = null;
  for (let index = froms.length - 1; index >= 0; index -= 1) {
    if (froms[index] === null) froms[index] = below;
    else below = froms[index];
  }
  let above = 0;
  const moves = drawn.map(([key], index): ArrivalMove => {
    const from = froms[index] ?? above;
    above = from;
    return { key, from, isArrival: isArrival[index] };
  });
  return moves.some((move) => Math.abs(move.from) > maxTravel) ? null : moves;
}

export type BandTone = 'odd' | 'even';

/**
 * Gives each record the band it keeps for as long as it stays in the list.
 *
 * The tones alternate down the list from the first record that already had one, so an arrival above
 * it takes the tone opposite its neighbour and no record already drawn changes; only a record landing
 * mid-list turns the ones below it over. A list that keeps nothing starts afresh on `odd`.
 */
export function assignBandTones(
  keys: readonly React.Key[],
  previous: ReadonlyMap<React.Key, BandTone>,
): Map<React.Key, BandTone> {
  const anchor = keys.findIndex((key) => previous.has(key));
  const anchorTone = anchor < 0 ? 'odd' : previous.get(keys[anchor])!;
  const from = Math.max(0, anchor);
  const tones = new Map<React.Key, BandTone>();
  keys.forEach((key, index) => {
    const isSame = (index - from) % 2 === 0;
    tones.set(key, isSame === (anchorTone === 'odd') ? 'odd' : 'even');
  });
  return tones;
}
