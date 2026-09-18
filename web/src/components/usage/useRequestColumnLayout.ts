import React from 'react';

import { usePreference } from '../../hooks/usePreference';
import {
  COLUMN_MAP,
  USAGE_EVENTS_COLUMNS_PREFERENCE,
  buildGridTemplateColumns,
  computeGridMinWidth,
  parseUsageEventsColumns,
  type RequestColumnId,
  type RequestColumnWidths,
} from './requestColumns';

/**
 * The request list's column layout: the widths the operator dragged or nudged,
 * the grid those widths project to, and the scrollbar gutter the header has to
 * pad so its tracks line up with the rows'.
 *
 * It is one hook because the four are one mechanism: a width the operator set is
 * persisted by the same gesture that measured it, and the grid and the gutter are
 * derived from what is on screen rather than from the preference document.
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

  const gridTemplate = React.useMemo(
    () => buildGridTemplateColumns(colWidths),
    [colWidths],
  );
  const gridMinWidth = React.useMemo(() => computeGridMinWidth(colWidths), [colWidths]);

  // The row list scrolls vertically and therefore loses a scrollbar's worth of
  // inner width that the header never loses. Measuring the real gutter (rather
  // than assuming a platform width) lets the header pad exactly that much, so
  // column boundaries line up on Windows, macOS overlay scrollbars and touch.
  const [scrollbarGutter, setScrollbarGutter] = React.useState(0);
  React.useEffect(() => {
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:absolute;top:-9999px;left:-9999px;width:64px;height:64px;overflow:scroll;';
    document.body.appendChild(probe);
    setScrollbarGutter(Math.max(0, probe.offsetWidth - probe.clientWidth));
    probe.remove();
  }, []);

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
    scrollbarGutter,
    hasCustomWidths: Object.keys(colWidths).length > 0,
    handleResizeStart,
    handleResetColumn,
    handleResetAllColumns,
    handleResizeKeyDown,
  };
}
