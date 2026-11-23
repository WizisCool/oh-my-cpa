import React from 'react';

import { usePreference } from '../../hooks/usePreference';
import type { DropSide } from '../../types/displayOrder';
import { isMotionReduced } from '../../utils/motionPreference';
import {
  animateColumnGlide,
  cancelColumnAnimations,
  captureColumnPositions,
  type ColumnPositions,
} from './requestColumnMotion';
import {
  COLUMN_MAP,
  DEFAULT_USAGE_EVENTS_COLUMNS_DOC,
  LIST_GRID_CHROME,
  REQUEST_COLUMNS,
  REQUEST_COLUMN_IDS,
  REQUEST_STACK_WIDTH,
  USAGE_EVENTS_COLUMNS_PREFERENCE,
  buildGridTemplateColumns,
  computeGridMinWidth,
  foldRequestColumns,
  isDefaultRequestColumnOrder,
  moveRequestColumn,
  orderedRequestColumns,
  parseUsageEventsColumnPreference,
  parseUsageEventsColumnsDoc,
  resolveSeamColumns,
  serializeUsageEventsColumns,
  setRequestColumnHidden,
  stepRequestColumn,
  type RequestColumnId,
  type RequestColumnWidths,
  type UsageEventsColumnsPreferenceDoc,
} from './requestColumns';

/**
 * The request list's column layout: operator-chosen visibility, order, and widths,
 * composed with the columns the list's measured width has room for, projected onto
 * one shared CSS grid track list.
 *
 * The header and the rows are separate grids on one track list. Neither reserves
 * a scrollbar gutter: the virtual list draws its own overlay scrollbar and loses
 * no width to a native one, so padding the header for one moves its tracks off
 * the rows'.
 *
 * Server preferences are written only after the initial read succeeds (`loaded`),
 * so a transient preference read failure never overwrites unread server state with
 * defaults; in that state controls remain usable for the current session only.
 */
export function useRequestColumnLayout(isSelecting: boolean) {
  const {
    value: prefDoc,
    ready: isReady,
    loaded: isLoaded,
    set: setPrefDoc,
  } = usePreference<UsageEventsColumnsPreferenceDoc>(
    USAGE_EVENTS_COLUMNS_PREFERENCE,
    DEFAULT_USAGE_EVENTS_COLUMNS_DOC,
    parseUsageEventsColumnsDoc,
  );

  // Session-only fallback used only when the initial preference read failed (`ready && !loaded`).
  const [localDoc, setLocalDoc] = React.useState<UsageEventsColumnsPreferenceDoc | null>(null);
  const effectiveDoc = isLoaded ? prefDoc : (localDoc ?? prefDoc);

  const parsed = React.useMemo(() => parseUsageEventsColumnPreference(effectiveDoc), [effectiveDoc]);
  const [dragWidth, setDragWidth] = React.useState<{ colId: RequestColumnId; width: number } | null>(null);

  const colWidths = React.useMemo<RequestColumnWidths>(
    () => (dragWidth ? { ...parsed.widths, [dragWidth.colId]: dragWidth.width } : parsed.widths),
    [parsed.widths, dragWidth],
  );
  const hiddenColumns = parsed.hidden;
  const columnOrder = parsed.order;

  const userHiddenSet = React.useMemo<ReadonlySet<RequestColumnId>>(
    () => new Set(hiddenColumns),
    [hiddenColumns],
  );
  const orderedColumns = React.useMemo(
    () => orderedRequestColumns(columnOrder),
    [columnOrder],
  );

  // Latest committed state ref so pointer-up and rapid callbacks compose onto current values.
  const latestRef = React.useRef({
    widths: parsed.widths,
    hidden: hiddenColumns,
    order: columnOrder,
    isReady,
    isLoaded,
  });

  // Which additional columns the list's width leaves out, held as a joined string so
  // resizing only re-renders when a column actually folds or unfolds, not on every pixel.
  const [foldedKey, setFoldedKey] = React.useState('');
  const [isStacked, setIsStacked] = React.useState(false);
  const streamNodeRef = React.useRef<HTMLElement | null>(null);
  const streamWidth = React.useRef<number | null>(null);
  const widthsRef = React.useRef(colWidths);
  const userHiddenRef = React.useRef(userHiddenSet);
  const pendingMotionPositionsRef = React.useRef<ColumnPositions | null>(null);
  const activeColumnAnimationsRef = React.useRef<Animation[]>([]);

  const snapshotColumnsForMotion = React.useCallback(() => {
    if (pendingMotionPositionsRef.current) return;
    const stream = streamNodeRef.current;
    if (!stream || isMotionReduced()) return;
    const captured = captureColumnPositions(stream);
    if (captured.size > 0) {
      pendingMotionPositionsRef.current = captured;
    }
  }, []);

  const commitDoc = React.useCallback(
    (next: UsageEventsColumnsPreferenceDoc, options?: { animate?: boolean }) => {
      if (!latestRef.current.isReady) return Promise.resolve({ ok: false });
      if (options?.animate) snapshotColumnsForMotion();
      // Update latestRef synchronously so back-to-back toggles or keyboard steps in the
      // same render tick compose onto the newest intent rather than overwriting each other.
      const nextParsed = parseUsageEventsColumnPreference(next);
      latestRef.current = {
        ...latestRef.current,
        widths: nextParsed.widths,
        hidden: nextParsed.hidden,
        order: nextParsed.order,
      };
      if (!latestRef.current.isLoaded) {
        setLocalDoc(next);
        return Promise.resolve({ ok: true });
      }
      return setPrefDoc(next);
    },
    [setPrefDoc, snapshotColumnsForMotion],
  );

  const refold = React.useCallback(() => {
    const width = streamWidth.current;
    setIsStacked(width !== null && width > 0 && width <= REQUEST_STACK_WIDTH);
    setFoldedKey([...foldRequestColumns(width, widthsRef.current, userHiddenRef.current)].join(' '));
  }, []);

  const observer = React.useRef<ResizeObserver | null>(null);
  const streamRef = React.useCallback((node: HTMLElement | null) => {
    streamNodeRef.current = node;
    observer.current?.disconnect();
    observer.current = null;
    if (!node) {
      cancelColumnAnimations(activeColumnAnimationsRef.current);
      activeColumnAnimationsRef.current = [];
      pendingMotionPositionsRef.current = null;
      return;
    }
    if (typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver(([entry]) => {
      // The list also changes height on every frame of the header's fold, and
      // only its width decides what fits.
      if (entry.contentRect.width === streamWidth.current) return;
      streamWidth.current = entry.contentRect.width;
      refold();
    });
    observer.current.observe(node);
  }, [refold]);

  React.useEffect(
    () => () => {
      cancelColumnAnimations(activeColumnAnimationsRef.current);
      activeColumnAnimationsRef.current = [];
      pendingMotionPositionsRef.current = null;
    },
    [],
  );

  const autoFoldedColumns = React.useMemo<ReadonlySet<RequestColumnId>>(
    () => new Set(foldedKey ? (foldedKey.split(' ') as RequestColumnId[]) : []),
    [foldedKey],
  );
  const effectiveHiddenSet = React.useMemo<ReadonlySet<RequestColumnId>>(() => {
    if (autoFoldedColumns.size === 0) return userHiddenSet;
    if (userHiddenSet.size === 0) return autoFoldedColumns;
    const merged = new Set(userHiddenSet);
    for (const id of autoFoldedColumns) merged.add(id);
    return merged;
  }, [userHiddenSet, autoFoldedColumns]);

  const hiddenColumnsAttr = React.useMemo(
    () => [...effectiveHiddenSet].join(' '),
    [effectiveHiddenSet],
  );
  const seamColumnsAttr = React.useMemo(
    () => resolveSeamColumns(effectiveHiddenSet, columnOrder).join(' '),
    [effectiveHiddenSet, columnOrder],
  );

  // The selection track opens only while a choice is under way; at rest its width goes to the data.
  const chrome = React.useMemo(() => ({ ...LIST_GRID_CHROME, isSelectionClosed: !isSelecting }), [isSelecting]);
  const gridTemplate = React.useMemo(
    () => buildGridTemplateColumns(colWidths, chrome, effectiveHiddenSet, columnOrder),
    [colWidths, chrome, effectiveHiddenSet, columnOrder],
  );
  const gridMinWidth = React.useMemo(
    () => computeGridMinWidth(colWidths, undefined, undefined, chrome, effectiveHiddenSet),
    [colWidths, chrome, effectiveHiddenSet],
  );

  // Keep refs synchronized after commit (never during render), reconcile responsive folding
  // before paint so hiding a column immediately unfolds newly fitting columns in the same frame,
  // and run the single-move FLIP glide once tracks have settled.
  React.useLayoutEffect(() => {
    latestRef.current = {
      widths: parsed.widths,
      hidden: hiddenColumns,
      order: columnOrder,
      isReady,
      isLoaded,
    };
    widthsRef.current = colWidths;
    userHiddenRef.current = userHiddenSet;

    const nextFoldedKey = [...foldRequestColumns(streamWidth.current, colWidths, userHiddenSet)].join(' ');
    if (nextFoldedKey !== foldedKey) {
      setFoldedKey(nextFoldedKey);
      return;
    }

    const previous = pendingMotionPositionsRef.current;
    if (!previous) return;
    pendingMotionPositionsRef.current = null;
    cancelColumnAnimations(activeColumnAnimationsRef.current);
    activeColumnAnimationsRef.current = [];
    const stream = streamNodeRef.current;
    if (!stream || isMotionReduced()) return;
    activeColumnAnimationsRef.current = animateColumnGlide(stream, previous);
  }, [
    parsed.widths,
    hiddenColumns,
    columnOrder,
    isReady,
    isLoaded,
    colWidths,
    userHiddenSet,
    foldedKey,
    effectiveDoc,
    gridTemplate,
    hiddenColumnsAttr,
  ]);

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

      let latestWidth = Math.round(Math.min(colDef.maxWidth, Math.max(colDef.minWidth, startWidth)));

      const onPointerMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX;
        latestWidth = Math.round(
          Math.min(colDef.maxWidth, Math.max(colDef.minWidth, startWidth + delta)),
        );
        setDragWidth({ colId, width: latestWidth });
      };

      const onPointerUp = (upEvent: PointerEvent) => {
        try {
          target.releasePointerCapture(upEvent.pointerId);
        } catch {}
        target.removeEventListener('pointermove', onPointerMove);
        target.removeEventListener('pointerup', onPointerUp);
        target.removeEventListener('pointercancel', onPointerUp);

        setDragWidth(null);
        const current = latestRef.current;
        const nextWidths = { ...current.widths, [colId]: latestWidth };
        void commitDoc(serializeUsageEventsColumns(nextWidths, current.hidden, current.order));
      };

      target.addEventListener('pointermove', onPointerMove);
      target.addEventListener('pointerup', onPointerUp);
      target.addEventListener('pointercancel', onPointerUp);
    },
    [colWidths, commitDoc],
  );

  const handleResetColumn = React.useCallback(
    (colId: RequestColumnId) => {
      const current = latestRef.current;
      if (current.widths[colId] === undefined) return;
      const nextWidths = { ...current.widths };
      delete nextWidths[colId];
      void commitDoc(serializeUsageEventsColumns(nextWidths, current.hidden, current.order), { animate: true });
    },
    [commitDoc],
  );

  const handleResetAllWidths = React.useCallback(() => {
    const current = latestRef.current;
    if (Object.keys(current.widths).length === 0) return;
    void commitDoc(serializeUsageEventsColumns({}, current.hidden, current.order), { animate: true });
  }, [commitDoc]);

  const handleToggleColumn = React.useCallback(
    (colId: RequestColumnId, isVisible: boolean) => {
      const current = latestRef.current;
      const nextHidden = setRequestColumnHidden(current.hidden, colId, !isVisible);
      if (
        nextHidden.length === current.hidden.length
        && nextHidden.every((id, index) => id === current.hidden[index])
      ) {
        return;
      }
      void commitDoc(serializeUsageEventsColumns(current.widths, nextHidden, current.order), { animate: true });
    },
    [commitDoc],
  );

  const handleShowAllColumns = React.useCallback(() => {
    const current = latestRef.current;
    if (current.hidden.length === 0) return;
    void commitDoc(serializeUsageEventsColumns(current.widths, [], current.order), { animate: true });
  }, [commitDoc]);

  const handleMoveColumn = React.useCallback(
    (colId: RequestColumnId, targetId: RequestColumnId, side: DropSide) => {
      const current = latestRef.current;
      const nextOrder = moveRequestColumn(current.order, colId, targetId, side);
      if (nextOrder === current.order) return undefined;
      return commitDoc(serializeUsageEventsColumns(current.widths, current.hidden, nextOrder), { animate: true });
    },
    [commitDoc],
  );

  const handleStepColumn = React.useCallback(
    (colId: RequestColumnId, direction: -1 | 1) => {
      const current = latestRef.current;
      const nextOrder = stepRequestColumn(current.order, colId, direction);
      if (nextOrder === current.order) return undefined;
      return commitDoc(serializeUsageEventsColumns(current.widths, current.hidden, nextOrder), { animate: true });
    },
    [commitDoc],
  );

  const handleResetColumnOrder = React.useCallback(() => {
    const current = latestRef.current;
    if (isDefaultRequestColumnOrder(current.order)) return;
    void commitDoc(serializeUsageEventsColumns(current.widths, current.hidden, REQUEST_COLUMN_IDS), { animate: true });
  }, [commitDoc]);

  const handleResizeKeyDown = React.useCallback(
    (colId: RequestColumnId, e: React.KeyboardEvent) => {
      const colDef = COLUMN_MAP.get(colId)!;
      const current = latestRef.current;
      const currentWidth = current.widths[colId] ?? colDef.defaultWidth;
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
        const nextWidths = { ...current.widths, [colId]: nextWidth };
        void commitDoc(serializeUsageEventsColumns(nextWidths, current.hidden, current.order));
      }
    },
    [commitDoc, handleResetColumn],
  );

  return {
    isReady,
    isStacked,
    colWidths,
    orderedColumns,
    columnOrder,
    hiddenColumns,
    userHiddenSet,
    autoFoldedColumns,
    visibleCount: REQUEST_COLUMNS.length - hiddenColumns.length,
    totalCount: REQUEST_COLUMNS.length,
    gridTemplate,
    gridMinWidth,
    hiddenColumnsAttr,
    seamColumnsAttr,
    streamRef,
    hasCustomWidths: Object.keys(colWidths).length > 0,
    hasHiddenColumns: hiddenColumns.length > 0,
    hasCustomOrder: !isDefaultRequestColumnOrder(columnOrder),
    handleToggleColumn,
    handleShowAllColumns,
    handleMoveColumn,
    handleStepColumn,
    handleResetColumnOrder,
    handleResizeStart,
    handleResetColumn,
    handleResetAllWidths,
    handleResizeKeyDown,
  };
}
