import React from 'react';
import clsx from 'clsx';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';

import { useT } from '../../i18n';
import type { DropSide } from '../../types/displayOrder';
import { Count } from '../common/Count';
import { ReorderHandle, RowReorder, useReorderList, useReorderRow } from '../common/RowReorder';
import { Tooltip } from '../common/Tooltip';
import { ColumnsOutlined } from '../icons';
import {
  canHideRequestColumn,
  type RequestColumnDefinition,
  type RequestColumnId,
} from './requestColumns';
import styles from './RequestColumnsPopover.module.css';

export interface RequestColumnsPopoverProps {
  orderedColumns: readonly RequestColumnDefinition[];
  userHidden: ReadonlySet<RequestColumnId>;
  autoFolded: ReadonlySet<RequestColumnId>;
  visibleCount: number;
  totalCount: number;
  isReady: boolean;
  hasHiddenColumns: boolean;
  hasCustomOrder: boolean;
  hasCustomWidths: boolean;
  onToggle: (colId: RequestColumnId, isVisible: boolean) => void;
  onShowAll: () => void;
  onMove: (colId: RequestColumnId, targetId: RequestColumnId, side: DropSide) => unknown;
  onStep: (colId: RequestColumnId, direction: -1 | 1) => void;
  onResetOrder: () => void;
  onResetWidths: () => void;
}

const columnKey = (column: RequestColumnDefinition) => column.id;

/**
 * Popover for managing request-table column visibility, order, and widths.
 *
 * Stays open while toggling checkboxes or reordering rows so multiple adjustments happen in one
 * visit. Visibility, order, and width resets stay independent so restoring one never silently
 * discards the others.
 */
export const RequestColumnsPopover = React.memo(function RequestColumnsPopover({
  orderedColumns,
  userHidden,
  autoFolded,
  visibleCount,
  totalCount,
  isReady,
  hasHiddenColumns,
  hasCustomOrder,
  hasCustomWidths,
  onToggle,
  onShowAll,
  onMove,
  onStep,
  onResetOrder,
  onResetWidths,
}: RequestColumnsPopoverProps) {
  const t = useT();
  const [isOpen, setIsOpen] = React.useState(false);

  const handleMove = React.useCallback(
    (key: string, target: string, side: DropSide) => onMove(key as RequestColumnId, target as RequestColumnId, side),
    [onMove],
  );
  const handleStep = React.useCallback(
    (key: string, direction: -1 | 1) => onStep(key as RequestColumnId, direction),
    [onStep],
  );
  const reorder = useReorderList(orderedColumns, columnKey, handleMove);
  const orderedIds = React.useMemo(() => reorder.ordered.map(columnKey), [reorder.ordered]);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger
        render={
          <Button
            variant={isOpen ? 'active' : 'secondary'}
            icon={<ColumnsOutlined />}
            disabled={!isReady}
            className={styles['trigger']}
            data-testid="request-columns-trigger"
          >
            <span>{t('events.columns')}</span>
            {hasHiddenColumns && <Count size="small">{`${visibleCount}/${totalCount}`}</Count>}
          </Button>
        }
      />
      <PopoverContent placement="bottomRight" className={styles['popover']} data-testid="request-columns-popover">
        <div className={styles['head']}>
          <PopoverTitle className={styles['title']}>
            <span>{t('events.columns')}</span>
            <Count size="small">{`${visibleCount}/${totalCount}`}</Count>
          </PopoverTitle>
          <Button
            size="sm"
            variant="ghost"
            disabled={!isReady || !hasHiddenColumns}
            onClick={onShowAll}
            data-testid="request-columns-show-all"
          >
            {t('events.columns_show_all')}
          </Button>
        </div>
        <div className={styles['list']} role="group" aria-label={t('events.columns')}>
          <RowReorder items={orderedIds} isEnabled={isReady} onMove={reorder.move} onStep={handleStep}>
            {reorder.ordered.map((column) => (
              <ColumnOptionRow
                key={column.id}
                column={column}
                isVisible={!userHidden.has(column.id)}
                isFolded={!userHidden.has(column.id) && autoFolded.has(column.id)}
                isLastVisible={!userHidden.has(column.id) && !canHideRequestColumn(userHidden, column.id)}
                isReady={isReady}
                onToggle={onToggle}
              />
            ))}
          </RowReorder>
        </div>
        <div className={styles['foot']}>
          <Button
            size="sm"
            variant="ghost"
            disabled={!isReady || !hasCustomOrder}
            onClick={onResetOrder}
            data-testid="request-columns-reset-order"
          >
            {t('events.columns_reset_order')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!isReady || !hasCustomWidths}
            onClick={onResetWidths}
            data-testid="request-columns-reset-widths"
          >
            {t('events.columns_reset_widths')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
});

const ColumnOptionRow: React.FC<{
  column: RequestColumnDefinition;
  isVisible: boolean;
  isFolded: boolean;
  isLastVisible: boolean;
  isReady: boolean;
  onToggle: (colId: RequestColumnId, isVisible: boolean) => void;
}> = ({ column, isVisible, isFolded, isLastVisible, isReady, onToggle }) => {
  const t = useT();
  const { row, handle } = useReorderRow(column.id);
  const label = t(column.labelKey);

  const checkbox = (
    <Checkbox
      className={styles['checkbox']}
      checked={isVisible}
      disabled={!isReady || isLastVisible}
      onCheckedChange={(checked) => onToggle(column.id, checked)}
    >
      {label}
    </Checkbox>
  );

  return (
    <div
      {...row}
      className={clsx(styles['row'], !isVisible && styles['is-hidden'])}
      data-column-row={column.id}
    >
      <ReorderHandle {...handle} name={label} variant="inline" className={styles['handle']} />
      {isLastVisible ? (
        <Tooltip title={t('events.columns_min_one')}>
          <span className={styles['checkbox-wrap']}>{checkbox}</span>
        </Tooltip>
      ) : (
        <span className={styles['checkbox-wrap']}>{checkbox}</span>
      )}
      {isFolded && (
        <Tooltip title={t('events.columns_folded_hint')}>
          <span className={styles['folded']} data-testid={`request-column-folded-${column.id}`}>
            {t('events.columns_folded')}
          </span>
        </Tooltip>
      )}
    </div>
  );
};
