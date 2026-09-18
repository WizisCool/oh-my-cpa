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
}

/**
 * The request list's column header row and its resize grips.
 *
 * The header is a sibling of the rows rather than part of them: the list scrolls
 * and the header must not, so the two are independent grids that agree only
 * because they read the same width map and the same measured scrollbar gutter.
 * The gripper is what makes a column's width the operator's decision, and every
 * one of them is operable from the keyboard as well as by pointer.
 */
export function RequestStreamHeader({
  colWidths,
  handleResizeStart,
  handleResetColumn,
  handleResizeKeyDown,
}: RequestStreamHeaderProps) {
  const t = useT();

  return (

          <div className="request-table-header">
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
