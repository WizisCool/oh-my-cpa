import React from 'react';

import { useT } from '../../i18n';
import {
  REQUEST_COLUMNS,
  requestColumnAlignClass,
  type RequestColumnId,
  type RequestColumnWidths,
} from './requestColumns';

interface RequestStreamHeaderProps {
  colWidths: RequestColumnWidths;
  handleResizeStart: (colId: RequestColumnId, event: React.PointerEvent<HTMLSpanElement>) => void;
  handleResetColumn: (colId: RequestColumnId) => void;
  handleResizeKeyDown: (colId: RequestColumnId, event: React.KeyboardEvent) => void;
  /** How the loaded rows stand against the selection. */
  selectionState: 'none' | 'some' | 'all';
  onToggleAll: (isSelected: boolean) => void;
}

/**
 * The request list's column header row and its resize grips.
 *
 * The header is a sibling of the rows rather than part of them: the list scrolls
 * and the header must not, so the two are independent grids that agree only
 * because they read the same width map.
 * The gripper is what makes a column's width the operator's decision, and every
 * one of them is operable from the keyboard as well as by pointer.
 */
export function RequestStreamHeader({
  colWidths,
  handleResizeStart,
  handleResetColumn,
  handleResizeKeyDown,
  selectionState,
  onToggleAll,
}: RequestStreamHeaderProps) {
  const t = useT();
  // `indeterminate` is a property with no attribute, so it is set on the element.
  const selectAllRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectionState === 'some';
  }, [selectionState]);

  return (

          <div className="request-table-header">
            <label className="req-th req-select req-th-select">
              <input
                ref={selectAllRef}
                type="checkbox"
                className="req-select-box"
                checked={selectionState === 'all'}
                aria-label={t('events.select_all')}
                // A partial selection completes rather than clears: the rows already
                // ticked are the ones the operator chose, and losing them to one click
                // on the header would undo their work.
                onChange={() => onToggleAll(selectionState !== 'all')}
              />
            </label>
            {REQUEST_COLUMNS.map((col) => (
              <div
                key={col.id}
                className={`req-th req-th-${col.id} ${requestColumnAlignClass(col.id)}`}
              >
                <span className="req-th-label">{t(col.labelKey)}</span>
                {col.resizable && (
                  <span
                    className="req-col-resizer"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={t('events.col_resizer')}
                    aria-valuenow={colWidths[col.id] ?? col.defaultWidth}
                    aria-valuemin={col.minWidth}
                    aria-valuemax={col.maxWidth}
                    tabIndex={0}
                    onPointerDown={(e) => handleResizeStart(col.id, e)}
                    onDoubleClick={() => handleResetColumn(col.id)}
                    onKeyDown={(e) => handleResizeKeyDown(col.id, e)}
                  />
                )}
              </div>
            ))}
            <span className="req-th req-th-chevron" />
          </div>
  );
}
