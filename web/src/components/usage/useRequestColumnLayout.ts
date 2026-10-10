import React from 'react';

import { usePreference } from '../../hooks/usePreference';
import {
  COLUMN_MAP,
  USAGE_EVENTS_COLUMNS_PREFERENCE,
  buildGridTemplateColumns,
  computeGridMinWidth,
  foldRequestColumns,
  parseUsageEventsColumns,
  type RequestColumnId,
  type RequestColumnWidths,
} from './requestColumns';

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
export function useRequestColumnLayout() {

  const {
    value: columnWidthsPref,
    ready: columnWidthsReady,
    set: setColumnWidthsPref,
  } = usePreference<RequestColumnWidths>(
    USAGE_EVENTS_COLUMNS_PREFERENCE,
    {},
    parseUsageEventsColumns,
  );

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
  const refold = React.useCallback(() => {
    setFoldedKey([...foldRequestColumns(streamWidth.current, widthsRef.current)].join(' '));
  }, []);
  const observer = React.useRef<ResizeObserver | null>(null);
  const streamRef = React.useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    observer.current = new ResizeObserver(([entry]) => {
      streamWidth.current = entry.contentRect.width;
      refold();
    });
    observer.current.observe(node);
  }, [refold]);
  // A dragged width changes what fits without the list itself resizing.
  React.useEffect(refold, [colWidths, refold]);

  const folded = React.useMemo(
    () => new Set(foldedKey ? (foldedKey.split(' ') as RequestColumnId[]) : []),
    [foldedKey],
  );
  const gridTemplate = React.useMemo(
    () => buildGridTemplateColumns(colWidths, undefined, folded),
    [colWidths, folded],
  );
  const gridMinWidth = React.useMemo(
    () => computeGridMinWidth(colWidths, undefined, undefined, undefined, folded),
    [colWidths, folded],
  );

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
    gridTemplate,
    gridMinWidth,
    foldedColumns: foldedKey,
    streamRef,
    hasCustomWidths: Object.keys(colWidths).length > 0,
    handleResizeStart,
    handleResetColumn,
    handleResetAllColumns,
    handleResizeKeyDown,
  };
}
