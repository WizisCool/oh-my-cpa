import React from 'react';
import clsx from 'clsx';

import { sharedResizeObserverHub } from '../../performance/resizeObserverHub';
import {
  DEFAULT_REQUEST_GROUP_HEADER_HEIGHT,
  DEFAULT_REQUEST_ROW_HEIGHT,
  REQUEST_VIRTUAL_OVERSCAN_PX,
  buildGroupSegments,
  computeGroupedVirtualWindow,
  computeVirtualWindow,
} from './requestVirtualWindow';
import './RequestVirtualList.css';

const SCROLL_IDLE_MS = 800;
const MIN_THUMB_PX = 24;
const INITIAL_VIEWPORT_HEIGHT = 640;
const STACKED_CONTAINER_MAX_WIDTH = 920;

export interface RequestListHandle {
  scrollTo: (options: { top: number }) => void;
}

export interface RequestGroupConfig<T> {
  key: (item: T) => string;
  title: (key: string, items: T[]) => React.ReactNode;
}

export interface RequestVirtualListProps<T> {
  items: readonly T[];
  getItemKey: (item: T) => React.Key;
  virtual: boolean;
  overscanPx?: number;
  group?: RequestGroupConfig<T>;
  className?: string;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  renderItem: (item: T, index: number) => React.ReactNode;
}

interface ThumbGeometry {
  trackHeight: number;
  thumbHeight: number;
  scrollRange: number;
}

function readThumbGeometry(viewport: HTMLElement, track: HTMLElement): ThumbGeometry | null {
  const scrollRange = viewport.scrollHeight - viewport.clientHeight;
  if (scrollRange <= 1) return null;
  const trackHeight = track.clientHeight;
  if (trackHeight <= 0) return null;
  const visibleHeight = Math.max(1, trackHeight);
  const contentHeight = Math.max(visibleHeight, scrollRange + visibleHeight);
  const thumbHeight = Math.max(
    MIN_THUMB_PX,
    Math.round((visibleHeight / contentHeight) * trackHeight),
  );
  return { trackHeight, thumbHeight, scrollRange };
}

function readBlockSize(entry: ResizeObserverEntry): number {
  const borderBox = entry.borderBoxSize?.[0]?.blockSize;
  return typeof borderBox === 'number' && borderBox > 0 ? borderBox : entry.contentRect.height;
}

function RequestVirtualListInner<T>(
  {
    items,
    getItemKey,
    virtual,
    overscanPx = REQUEST_VIRTUAL_OVERSCAN_PX,
    group,
    className,
    onScroll,
    renderItem,
  }: RequestVirtualListProps<T>,
  ref: React.ForwardedRef<RequestListHandle>,
) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const tailRef = React.useRef<HTMLDivElement>(null);
  const trackRef = React.useRef<HTMLDivElement>(null);
  const thumbRef = React.useRef<HTMLDivElement>(null);
  const drawThumbRef = React.useRef<(() => void) | null>(null);

  const scrollTopRef = React.useRef(0);
  const viewportHeightRef = React.useRef(INITIAL_VIEWPORT_HEIGHT);
  const defaultRowHeightRef = React.useRef(DEFAULT_REQUEST_ROW_HEIGHT);
  const isStackedRef = React.useRef<boolean | null>(null);

  const rowHeightsRef = React.useRef<Map<React.Key, number>>(new Map());
  const groupHeaderHeightsRef = React.useRef<Map<string, number>>(new Map());
  const elementKeyMapRef = React.useRef<WeakMap<Element, { kind: 'row'; key: React.Key } | { kind: 'group'; key: string }>>(new WeakMap());
  const rowRefCallbacksRef = React.useRef<Map<React.Key, (node: HTMLDivElement | null) => void>>(new Map());
  const groupRefCallbacksRef = React.useRef<Map<string, (node: HTMLDivElement | null) => void>>(new Map());
  const rowElementsRef = React.useRef<Map<React.Key, HTMLDivElement>>(new Map());
  const groupElementsRef = React.useRef<Map<string, HTMLDivElement>>(new Map());
  const itemObserverRef = React.useRef<ResizeObserver | null>(null);

  const [, setRenderTick] = React.useState(0);
  const renderedSignatureRef = React.useRef('');

  const segments = React.useMemo(
    () => (group ? buildGroupSegments(items, group.key) : []),
    [items, group],
  );

  const getRowHeightByIndex = React.useCallback(
    (index: number) => {
      const key = getItemKey(items[index]);
      return rowHeightsRef.current.get(key) ?? defaultRowHeightRef.current;
    },
    [getItemKey, items],
  );

  const getRowHeightByKey = React.useCallback(
    (key: React.Key) => rowHeightsRef.current.get(key) ?? defaultRowHeightRef.current,
    [],
  );

  const getHeaderHeight = React.useCallback(
    (groupKey: string) => groupHeaderHeightsRef.current.get(groupKey) ?? DEFAULT_REQUEST_GROUP_HEADER_HEIGHT,
    [],
  );

  const computeSignature = React.useCallback(
    (scrollTop: number, viewportHeight: number): string => {
      if (!virtual || items.length === 0) return 'all';
      if (group) {
        return computeGroupedVirtualWindow({
          segments,
          getItemKey,
          getHeaderHeight,
          getItemHeight: getRowHeightByKey,
          scrollTop,
          viewportHeight,
          overscanPx,
        }).rangeKey;
      }
      const win = computeVirtualWindow({
        itemCount: items.length,
        getRowHeight: getRowHeightByIndex,
        scrollTop,
        viewportHeight,
        overscanPx,
      });
      return `${win.startIndex}:${win.endIndex}`;
    },
    [getHeaderHeight, getItemKey, getRowHeightByIndex, getRowHeightByKey, group, items.length, overscanPx, segments, virtual],
  );

  const syncWindowIfChanged = React.useCallback(() => {
    if (!virtual) return;
    const nextSig = computeSignature(scrollTopRef.current, viewportHeightRef.current);
    if (nextSig !== renderedSignatureRef.current) {
      renderedSignatureRef.current = nextSig;
      setRenderTick((tick) => tick + 1);
    }
  }, [computeSignature, virtual]);

  React.useImperativeHandle(
    ref,
    () => ({
      scrollTo: ({ top }) => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        viewport.scrollTop = top;
        scrollTopRef.current = viewport.scrollTop;
        syncWindowIfChanged();
        drawThumbRef.current?.();
      },
    }),
    [syncWindowIfChanged],
  );

  // Observe mounted rows & group headers post-layout with zero synchronous reflow.
  React.useLayoutEffect(() => {
    if (!virtual || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      let hasChange = false;
      for (const entry of entries) {
        const meta = elementKeyMapRef.current.get(entry.target);
        if (!meta) continue;
        const size = Math.round(readBlockSize(entry));
        if (!(size > 0)) continue;
        if (meta.kind === 'row') {
          const prev = rowHeightsRef.current.get(meta.key) ?? defaultRowHeightRef.current;
          if (Math.abs(size - prev) >= 1) {
            rowHeightsRef.current.set(meta.key, size);
            hasChange = true;
          } else if (!rowHeightsRef.current.has(meta.key)) {
            rowHeightsRef.current.set(meta.key, size);
          }
        } else {
          const prev = groupHeaderHeightsRef.current.get(meta.key) ?? DEFAULT_REQUEST_GROUP_HEADER_HEIGHT;
          if (Math.abs(size - prev) >= 1) {
            groupHeaderHeightsRef.current.set(meta.key, size);
            hasChange = true;
          } else if (!groupHeaderHeightsRef.current.has(meta.key)) {
            groupHeaderHeightsRef.current.set(meta.key, size);
          }
        }
      }
      if (hasChange) {
        setRenderTick((tick) => tick + 1);
      }
    });
    itemObserverRef.current = observer;
    for (const element of rowElementsRef.current.values()) observer.observe(element);
    for (const element of groupElementsRef.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      itemObserverRef.current = null;
    };
  }, [virtual]);

  // Observe the scroll viewport once via the shared hub; only re-render when the
  // stride-quantized item window or stacked layout mode actually changes.
  React.useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const headerSpace = Number(viewport.closest<HTMLElement>('.request-events-page')?.dataset.headerSpace) || 0;
    viewport.style.scrollPaddingBottom = headerSpace > 0 ? `${headerSpace}px` : '';
    if (tailRef.current) {
      tailRef.current.style.height = headerSpace > 0 ? `${headerSpace}px` : '0px';
    }
    if (trackRef.current) {
      trackRef.current.style.bottom = headerSpace > 0 ? `${3 + headerSpace}px` : '3px';
    }
    if (viewport.clientHeight > 0) {
      viewportHeightRef.current = viewport.clientHeight;
    }
    return sharedResizeObserverHub.observe(
      viewport,
      (size) => {
        viewportHeightRef.current = size.height;
        const isStacked = size.width > 0 && size.width <= STACKED_CONTAINER_MAX_WIDTH;
        if (isStackedRef.current !== null && isStackedRef.current !== isStacked) {
          rowHeightsRef.current.clear();
          defaultRowHeightRef.current = isStacked ? 96 : DEFAULT_REQUEST_ROW_HEIGHT;
          isStackedRef.current = isStacked;
          setRenderTick((tick) => tick + 1);
          drawThumbRef.current?.();
          return;
        }
        isStackedRef.current = isStacked;
        defaultRowHeightRef.current = isStacked ? 96 : DEFAULT_REQUEST_ROW_HEIGHT;
        syncWindowIfChanged();
        drawThumbRef.current?.();
      },
      { freezeOnTransition: false, epsilonPx: 1 },
    );
  }, [syncWindowIfChanged]);

  // Overlay scrollbar thumb: driven directly in rAF without React state updates.
  React.useEffect(() => {
    const root = rootRef.current;
    const viewport = viewportRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!root || !viewport || !track || !thumb) return undefined;

    let frame = 0;
    let idleTimer = 0;

    const draw = () => {
      frame = 0;
      track.hidden = viewport.scrollHeight - viewport.clientHeight <= 1;
      const geometry = readThumbGeometry(viewport, track);
      if (!geometry) return;
      const travel = geometry.trackHeight - geometry.thumbHeight;
      const offset = Math.round((viewport.scrollTop / geometry.scrollRange) * travel);
      thumb.style.height = `${geometry.thumbHeight}px`;
      thumb.style.transform = `translateY(${offset}px)`;
    };
    const scheduleDraw = () => {
      if (frame === 0) frame = requestAnimationFrame(draw);
    };
    drawThumbRef.current = scheduleDraw;

    const handleThumbPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const geometry = readThumbGeometry(viewport, track);
      if (!geometry) return;
      event.preventDefault();
      event.stopPropagation();
      const startY = event.clientY;
      const startScrollTop = viewport.scrollTop;
      const scrollPerPixel = geometry.scrollRange / Math.max(1, geometry.trackHeight - geometry.thumbHeight);
      thumb.setPointerCapture(event.pointerId);
      root.dataset.dragging = '';
      const handleMove = (move: PointerEvent) => {
        viewport.scrollTop = startScrollTop + (move.clientY - startY) * scrollPerPixel;
      };
      const handleRelease = () => {
        delete root.dataset.dragging;
        thumb.removeEventListener('pointermove', handleMove);
        thumb.removeEventListener('pointerup', handleRelease);
        thumb.removeEventListener('pointercancel', handleRelease);
      };
      thumb.addEventListener('pointermove', handleMove);
      thumb.addEventListener('pointerup', handleRelease);
      thumb.addEventListener('pointercancel', handleRelease);
    };

    const handleTrackPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.target !== track) return;
      const isAboveThumb = event.clientY < thumb.getBoundingClientRect().top;
      viewport.scrollBy({ top: (isAboveThumb ? -1 : 1) * viewport.clientHeight * 0.9 });
    };

    const markScrolling = () => {
      scheduleDraw();
      root.dataset.scrolling = '';
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => delete root.dataset.scrolling, SCROLL_IDLE_MS);
    };

    viewport.addEventListener('scroll', markScrolling, { passive: true });
    thumb.addEventListener('pointerdown', handleThumbPointerDown);
    track.addEventListener('pointerdown', handleTrackPointerDown);
    scheduleDraw();

    return () => {
      drawThumbRef.current = null;
      viewport.removeEventListener('scroll', markScrolling);
      thumb.removeEventListener('pointerdown', handleThumbPointerDown);
      track.removeEventListener('pointerdown', handleTrackPointerDown);
      if (frame !== 0) cancelAnimationFrame(frame);
      window.clearTimeout(idleTimer);
      delete root.dataset.scrolling;
      delete root.dataset.dragging;
    };
  }, []);

  const getRowRef = (key: React.Key) => {
    let attachRow = rowRefCallbacksRef.current.get(key);
    if (!attachRow) {
      attachRow = (node: HTMLDivElement | null) => {
        const previous = rowElementsRef.current.get(key);
        if (previous && previous !== node) {
          itemObserverRef.current?.unobserve(previous);
          rowElementsRef.current.delete(key);
        }
        if (node) {
          elementKeyMapRef.current.set(node, { kind: 'row', key });
          rowElementsRef.current.set(key, node);
          itemObserverRef.current?.observe(node);
        } else {
          rowRefCallbacksRef.current.delete(key);
        }
      };
      rowRefCallbacksRef.current.set(key, attachRow);
    }
    return attachRow;
  };

  const getGroupRef = (groupKey: string) => {
    let attachGroup = groupRefCallbacksRef.current.get(groupKey);
    if (!attachGroup) {
      attachGroup = (node: HTMLDivElement | null) => {
        const previous = groupElementsRef.current.get(groupKey);
        if (previous && previous !== node) {
          itemObserverRef.current?.unobserve(previous);
          groupElementsRef.current.delete(groupKey);
        }
        if (node) {
          elementKeyMapRef.current.set(node, { kind: 'group', key: groupKey });
          groupElementsRef.current.set(groupKey, node);
          itemObserverRef.current?.observe(node);
        } else {
          groupRefCallbacksRef.current.delete(groupKey);
        }
      };
      groupRefCallbacksRef.current.set(groupKey, attachGroup);
    }
    return attachGroup;
  };

  const handleViewportScroll: React.UIEventHandler<HTMLDivElement> = React.useCallback(
    (event) => {
      scrollTopRef.current = event.currentTarget.scrollTop;
      syncWindowIfChanged();
      onScroll?.(event);
    },
    [onScroll, syncWindowIfChanged],
  );

  let content: React.ReactNode;
  let totalScrollHeight = 0;

  if (!virtual) {
    renderedSignatureRef.current = 'all';
    if (group) {
      content = segments.map((seg) => (
        <div key={seg.groupKey} className="request-group-section">
          <div className="request-group-header">{group.title(seg.groupKey, seg.items)}</div>
          {seg.entries.map(({ item, index }) => (
            <div key={getItemKey(item)} className="request-list-item">
              {renderItem(item, index)}
            </div>
          ))}
        </div>
      ));
    } else {
      content = items.map((item, index) => (
        <div key={getItemKey(item)} className="request-list-item">
          {renderItem(item, index)}
        </div>
      ));
    }
  } else if (group) {
    const groupedWin = computeGroupedVirtualWindow({
      segments,
      getItemKey,
      getHeaderHeight,
      getItemHeight: getRowHeightByKey,
      scrollTop: scrollTopRef.current,
      viewportHeight: viewportHeightRef.current,
      overscanPx,
    });
    renderedSignatureRef.current = groupedWin.rangeKey;
    totalScrollHeight = groupedWin.totalHeight;
    content = segments.map((seg, segIndex) => {
      const slice = groupedWin.slices[segIndex];
      const hasMounted = slice && slice.endIndex >= slice.startIndex;
      const mountedEntries = hasMounted
        ? seg.entries.slice(slice.startIndex, slice.endIndex + 1)
        : [];
      return (
        <div key={seg.groupKey} className="request-group-section">
          <div ref={getGroupRef(seg.groupKey)} className="request-group-header">
            {group.title(seg.groupKey, seg.items)}
          </div>
          <div className="request-group-body" style={{ height: slice?.bodyHeight ?? 0 }}>
            {mountedEntries.map(({ item, index }, offset) => {
              const key = getItemKey(item);
              const localIndex = slice.startIndex + offset;
              const rowTop = slice.offsets[localIndex] ?? 0;
              return (
                <div
                  key={key}
                  ref={getRowRef(key)}
                  className="request-list-item request-list-item-virtual"
                  style={{ transform: `translateY(${rowTop}px)` }}
                >
                  {renderItem(item, index)}
                </div>
              );
            })}
          </div>
        </div>
      );
    });
  } else {
    const win = computeVirtualWindow({
      itemCount: items.length,
      getRowHeight: getRowHeightByIndex,
      scrollTop: scrollTopRef.current,
      viewportHeight: viewportHeightRef.current,
      overscanPx,
    });
    renderedSignatureRef.current = `${win.startIndex}:${win.endIndex}`;
    totalScrollHeight = win.totalHeight;
    const mounted = win.endIndex >= win.startIndex ? items.slice(win.startIndex, win.endIndex + 1) : [];
    content = (
      <div className="request-list-spacer" style={{ height: win.totalHeight }}>
        {mounted.map((item, offset) => {
          const index = win.startIndex + offset;
          const key = getItemKey(item);
          const rowTop = win.offsets[index] ?? 0;
          return (
            <div
              key={key}
              ref={getRowRef(key)}
              className="request-list-item request-list-item-virtual"
              style={{ transform: `translateY(${rowTop}px)` }}
            >
              {renderItem(item, index)}
            </div>
          );
        })}
      </div>
    );
  }

  React.useLayoutEffect(() => {
    drawThumbRef.current?.();
  }, [items.length, totalScrollHeight, virtual]);

  return (
    <div ref={rootRef} className="request-virtual-root">
      <div
        ref={viewportRef}
        className={clsx('request-list', className)}
        onScroll={handleViewportScroll}
      >
        {content}
        <div ref={tailRef} className="request-list-tail" aria-hidden="true" />
      </div>
      <div ref={trackRef} className="request-scroll-track" aria-hidden="true" hidden>
        <div ref={thumbRef} className="request-scroll-thumb" />
      </div>
    </div>
  );
}

export const RequestVirtualList = React.forwardRef(RequestVirtualListInner) as <T>(
  props: RequestVirtualListProps<T> & { ref?: React.Ref<RequestListHandle> },
) => React.ReactElement;
