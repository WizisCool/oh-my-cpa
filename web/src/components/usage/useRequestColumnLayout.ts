import React from 'react';
import { flushSync } from 'react-dom';
import { isMotionReduced } from '../../utils/motionPreference';
import { captureColumnPositions, fadeDepartingColumns, animateColumnArrival, COLUMN_EXIT_DURATION } from './requestColumnTransition';

import { usePreference } from '../../hooks/usePreference';
import { useSortableList } from '../../hooks/useSortableList';
import {
  COLUMN_MAP,
  REQUEST_COLUMNS,
  LIST_GRID_CHROME,
  USAGE_EVENTS_COLUMNS_PREFERENCE,
  USAGE_EVENTS_HIDDEN_COLUMNS_PREFERENCE,
  USAGE_EVENTS_COLUMN_ORDER_PREFERENCE,
  computeGridMinWidth,
  buildGridTemplateColumns,
  foldRequestColumns,
  parseUsageEventsColumns,
  parseUsageEventsHiddenColumns,
  toggleRequestColumnVisibility,
  type RequestColumnId,
  type RequestColumnDefinition,
  type RequestColumnWidths,
} from './requestColumns';

const DEFAULT_HIDDEN_COLUMNS: RequestColumnId[] = [];
const columnKey = (column: RequestColumnDefinition) => column.id;
const sameHiddenColumns = (a: readonly RequestColumnId[], b: readonly RequestColumnId[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * The request list's column layout: the widths the operator dragged or nudged,
 * the columns the list's own width has room for, and the grid those project to.
 *
 * The header and the rows are separate grids on one track list. Neither reserves
 * a scrollbar gutter: the virtual list draws its own overlay scrollbar and loses
 * no width to a native one, so padding the header for one moves its tracks off
 * the rows'.
 *
 * It is one hook because a width the operator set is persisted by the same
 * gesture that measured it, and the grid is derived from what is on screen
 * rather than from the preference document.
 */
export function useRequestColumnLayout(isSelecting: boolean) {
  // A display-only preference. Hidden columns keep their saved positions.
  const { ordered: orderedColumns, reorder: columnReorder } = useSortableList(
    USAGE_EVENTS_COLUMN_ORDER_PREFERENCE,
    'columns',
    REQUEST_COLUMNS,
    columnKey,
  );
  const columnOrder = React.useMemo(() => orderedColumns.map(columnKey), [orderedColumns]);


  const {
    value: columnWidthsPref,
    ready: columnWidthsReady,
    set: setColumnWidthsPref,
  } = usePreference<RequestColumnWidths>(
    USAGE_EVENTS_COLUMNS_PREFERENCE,
    {},
    parseUsageEventsColumns,
  );

  const {
    value: hiddenColumnsPref,
    ready: hiddenColumnsReady,
    loaded: hiddenColumnsLoaded,
    set: setHiddenColumnsPref,
  } = usePreference<RequestColumnId[]>(
    USAGE_EVENTS_HIDDEN_COLUMNS_PREFERENCE,
    DEFAULT_HIDDEN_COLUMNS,
    parseUsageEventsHiddenColumns,
  );
  // React-controlled checkboxes need a synchronous local state update. Query's
  // preference cache notifies subscribers asynchronously, which otherwise lets
  // React restore the previous checked value before the write reaches the cache.
  const [hiddenColumns, setHiddenColumns] = React.useState<RequestColumnId[]>(DEFAULT_HIDDEN_COLUMNS);
  // Checkbox feedback is immediate; the painted grid can briefly retain
  // a departing field until its own cells have faded out.
  const [renderedHiddenColumns, setRenderedHiddenColumns] = React.useState<RequestColumnId[]>(DEFAULT_HIDDEN_COLUMNS);
  const hiddenColumnsRef = React.useRef(hiddenColumns);
  hiddenColumnsRef.current = hiddenColumns;
  const renderedHiddenRef = React.useRef(renderedHiddenColumns);
  renderedHiddenRef.current = renderedHiddenColumns;
  const streamNodeRef = React.useRef<HTMLElement | null>(null);
  const motionTimerRef = React.useRef<number | null>(null);
  const motionAnimationsRef = React.useRef<Animation[]>([]);
  const motionRevisionRef = React.useRef(0);

  const cancelColumnMotion = React.useCallback(() => {
    motionRevisionRef.current += 1;
    if (motionTimerRef.current !== null) {
      clearTimeout(motionTimerRef.current);
      motionTimerRef.current = null;
    }
    for (const animation of motionAnimationsRef.current) animation.cancel();
    motionAnimationsRef.current = [];
    if (streamNodeRef.current) delete streamNodeRef.current.dataset.columnGlide;
  }, []);
  React.useEffect(() => cancelColumnMotion, [cancelColumnMotion]);
  React.useEffect(() => {
    if (!hiddenColumnsReady || sameHiddenColumns(hiddenColumnsRef.current, hiddenColumnsPref)) return;
    // External changes and save rollbacks take precedence over local gestures.
    cancelColumnMotion();
    hiddenColumnsRef.current = hiddenColumnsPref;
    renderedHiddenRef.current = hiddenColumnsPref;
    setHiddenColumns(hiddenColumnsPref);
    setRenderedHiddenColumns(hiddenColumnsPref);
  }, [hiddenColumnsReady, hiddenColumnsPref, cancelColumnMotion]);
  const hiddenSet = React.useMemo(() => new Set(renderedHiddenColumns), [renderedHiddenColumns]);

  const [colWidths, setColWidths] = React.useState<RequestColumnWidths>({});

  React.useEffect(() => {
    if (columnWidthsReady) {
      setColWidths(columnWidthsPref);
    }
  }, [columnWidthsReady, columnWidthsPref]);

  // Which columns the list's width leaves out, as the space-separated ids the
  // stylesheet matches on. Held as that string rather than as the measured width
  // so a window being dragged re-renders the page only when a column actually
  // folds or returns, not on every pixel.
  const [foldedKey, setFoldedKey] = React.useState('');
  const streamWidth = React.useRef<number | null>(null);
  const widthsRef = React.useRef(colWidths);
  widthsRef.current = colWidths;
  const hiddenRef = React.useRef(hiddenSet);
  hiddenRef.current = hiddenSet;
  const refold = React.useCallback(() => {
    setFoldedKey([...foldRequestColumns(streamWidth.current, widthsRef.current, hiddenRef.current)].join(' '));
  }, []);
  const observer = React.useRef<ResizeObserver | null>(null);
  const streamRef = React.useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    streamNodeRef.current = node;
    if (!node) return;
    observer.current = new ResizeObserver(([entry]) => {
      // The list also changes height on every frame of the header's fold, and
      // only its width decides what fits.
      if (entry.contentRect.width === streamWidth.current) return;
      streamWidth.current = entry.contentRect.width;
      refold();
    });
    observer.current.observe(node);
  }, [refold]);
  // A dragged width changes what fits without the list itself resizing.
  React.useEffect(refold, [colWidths, hiddenSet, refold]);

  // Derive the responsive folds in the same render as a visibility change.
  // A delayed refold would move the tracks a second time mid-glide.
  const folded = React.useMemo(
    () => new Set<RequestColumnId>([
      ...hiddenSet,
      ...foldRequestColumns(streamWidth.current, colWidths, hiddenSet),
    ]),
    [hiddenSet, foldedKey, colWidths],
  );
  const foldedColumns = React.useMemo(() => [...folded].join(' '), [folded]);
  const firstVisibleColumn = orderedColumns.find((column) => !folded.has(column.id))?.id ?? 'time';
  // The selection track opens only while a choice is under way; at rest its width goes to the data.
  const chrome = React.useMemo(() => ({ ...LIST_GRID_CHROME, isSelectionClosed: !isSelecting }), [isSelecting]);
  const gridTemplate = React.useMemo(
    () => buildGridTemplateColumns(colWidths, chrome, folded, orderedColumns),
    [colWidths, chrome, folded, orderedColumns],
  );
  const gridMinWidth = React.useMemo(
    () => computeGridMinWidth(colWidths, undefined, undefined, chrome, folded),
    [colWidths, chrome, folded],
  );

  // The same FLIP-style technique as SSE record arrival, applied horizontally:
  // departing cells fade out, surviving cells glide to their new X positions,
  // and returning cells fade in. Only painted cells are animated. The column
  // chooser stays outside this grid and is never copied or composited.
  const showHiddenColumns = React.useCallback((next: RequestColumnId[]) => {
    setHiddenColumns(next);
    cancelColumnMotion();
    const stream = streamNodeRef.current;
    const painted = renderedHiddenRef.current;
    if (sameHiddenColumns(painted, next)) return;
    const header = stream?.querySelector<HTMLElement>('.request-table-header');
    if (!stream || !header || typeof window === 'undefined' || isMotionReduced()
      || getComputedStyle(header).display !== 'grid') {
      renderedHiddenRef.current = next;
      setRenderedHiddenColumns(next);
      return;
    }

    const revision = motionRevisionRef.current;
    const applyLayout = () => {
      if (motionRevisionRef.current !== revision) return;
      const previous = captureColumnPositions(stream);
      stream.dataset.columnGlide = '';
      renderedHiddenRef.current = next;
      flushSync(() => setRenderedHiddenColumns(next));
      const animations = animateColumnArrival(stream, previous);
      motionAnimationsRef.current = animations;
      if (!animations.length) {
        delete stream.dataset.columnGlide;
        return;
      }
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        if (motionRevisionRef.current !== revision) return;
        motionAnimationsRef.current = [];
        delete stream.dataset.columnGlide;
      });
    };

    const leaving = new Set(next.filter((id) => !painted.includes(id)));
    const exits = fadeDepartingColumns(stream, leaving);
    if (!exits.length) {
      applyLayout();
      return;
    }
    motionAnimationsRef.current = exits;
    motionTimerRef.current = window.setTimeout(() => {
      motionTimerRef.current = null;
      applyLayout();
      for (const animation of exits) animation.cancel();
    }, COLUMN_EXIT_DURATION);
  }, [cancelColumnMotion]);

  const setColumnVisible = React.useCallback((id: RequestColumnId, visible: boolean) => {
    if (!hiddenColumnsLoaded) return;
    const previous = hiddenColumnsRef.current;
    const next = toggleRequestColumnVisibility(previous, id, visible);
    if (next.length === previous.length && next.every((column, index) => column === previous[index])) return;
    hiddenColumnsRef.current = next;
    showHiddenColumns(next);
    void setHiddenColumnsPref(next);
  }, [hiddenColumnsLoaded, setHiddenColumnsPref, showHiddenColumns]);

  const restoreColumnVisibility = React.useCallback(() => {
    if (!hiddenColumnsLoaded || hiddenColumnsRef.current.length === 0) return;
    hiddenColumnsRef.current = DEFAULT_HIDDEN_COLUMNS;
    showHiddenColumns(DEFAULT_HIDDEN_COLUMNS);
    void setHiddenColumnsPref(DEFAULT_HIDDEN_COLUMNS);
  }, [hiddenColumnsLoaded, setHiddenColumnsPref, showHiddenColumns]);

  const handleResizeStart = React.useCallback(
    (colId: RequestColumnId, e: React.PointerEvent<HTMLSpanElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      const colDef = COLUMN_MAP.get(colId)!;
      const thElement = target.parentElement as HTMLElement;
      const startWidth = thElement
        ? thElement.getBoundingClientRect().width
        : (colWidths[colId] || colDef.defaultWidth);
      const startX = e.clientX;

      let latestWidth = startWidth;

      const onPointerMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX;
        latestWidth = Math.round(
          Math.min(colDef.maxWidth, Math.max(colDef.minWidth, startWidth + delta)),
        );
        setColWidths((prev) => ({
          ...prev,
          [colId]: latestWidth,
        }));
      };

      const onPointerUp = (upEvent: PointerEvent) => {
        try {
          target.releasePointerCapture(upEvent.pointerId);
        } catch {}
        target.removeEventListener('pointermove', onPointerMove);
        target.removeEventListener('pointerup', onPointerUp);
        target.removeEventListener('pointercancel', onPointerUp);

        setColWidths((prev) => {
          const next = { ...prev, [colId]: latestWidth };
          setColumnWidthsPref(next);
          return next;
        });
      };

      target.addEventListener('pointermove', onPointerMove);
      target.addEventListener('pointerup', onPointerUp);
      target.addEventListener('pointercancel', onPointerUp);
    },
    [colWidths, setColumnWidthsPref],
  );

  const handleResetColumn = React.useCallback(
    (colId: RequestColumnId) => {
      setColWidths((prev) => {
        const next = { ...prev };
        delete next[colId];
        setColumnWidthsPref(next);
        return next;
      });
    },
    [setColumnWidthsPref],
  );

  const handleResetAllColumns = React.useCallback(() => {
    setColWidths({});
    setColumnWidthsPref({});
  }, [setColumnWidthsPref]);

  const handleResizeKeyDown = React.useCallback(
    (colId: RequestColumnId, e: React.KeyboardEvent) => {
      const colDef = COLUMN_MAP.get(colId)!;
      const currentWidth = colWidths[colId] ?? colDef.defaultWidth;
      let nextWidth: number | null = null;
      if (e.key === 'ArrowLeft') {
        nextWidth = Math.max(colDef.minWidth, currentWidth - 10);
      } else if (e.key === 'ArrowRight') {
        nextWidth = Math.min(colDef.maxWidth, currentWidth + 10);
      } else if (e.key === 'Enter' || e.key === 'Escape') {
        handleResetColumn(colId);
        return;
      }
      if (nextWidth !== null) {
        e.preventDefault();
        const finalWidth = nextWidth;
        setColWidths((prev) => {
          const next = { ...prev, [colId]: finalWidth };
          setColumnWidthsPref(next);
          return next;
        });
      }
    },
    [colWidths, handleResetColumn, setColumnWidthsPref],
  );

  return {
    colWidths,
    orderedColumns,
    columnOrder,
    columnReorder,
    gridTemplate,
    gridMinWidth,
    foldedColumns,
    firstVisibleColumn,
    hiddenColumns,
    hiddenColumnsLoaded,
    setColumnVisible,
    restoreColumnVisibility,
    streamRef,
    hasCustomWidths: Object.keys(colWidths).length > 0,
    handleResizeStart,
    handleResetColumn,
    handleResetAllColumns,
    handleResizeKeyDown,
  };
}
