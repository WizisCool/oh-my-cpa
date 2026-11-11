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
