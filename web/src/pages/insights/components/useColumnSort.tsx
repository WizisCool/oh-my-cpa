import React from 'react';
import type { ColumnDef, ColumnsType } from '@/components/ui/table';
import { ArrowDownOutlined, ArrowUpOutlined } from '../../../components/icons';
import styles from '../insights.module.css';

export interface SortableColumn<T> extends ColumnDef<T> {
  /** A column with a value sorts by it; a missing value sorts last either way. */
  sortValue?: (record: T) => number | null;
}

type Sort = { key: React.Key; order: 'ascending' | 'descending' } | null;

/**
 * Sortable headers for an Insights table. The header text becomes a button that orders the rows
 * by the column - largest first, then smallest, then back to the page's ranking - and only the
 * column in force carries `aria-sort`.
 */
export function useColumnSort<T>(columns: readonly SortableColumn<T>[], data: readonly T[]): { columns: ColumnsType<T>; data: readonly T[] } {
  const [sort, setSort] = React.useState<Sort>(null);
  const active = sort ? columns.find((column) => column.key === sort.key && column.sortValue) : undefined;
  const sorted = React.useMemo(() => {
    if (!sort || !active?.sortValue) return data;
    const pick = active.sortValue;
    const sign = sort.order === 'ascending' ? 1 : -1;
    return [...data].sort((left, right) => {
      const a = pick(left);
      const b = pick(right);
      if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
      return (a - b) * sign;
    });
  }, [active, data, sort]);
  const headed = columns.map(({ sortValue, ...column }): ColumnDef<T> => {
    if (!sortValue || column.key === undefined) return column;
    const order = sort?.key === column.key ? sort.order : undefined;
    const next = () => setSort(order === undefined
      ? { key: column.key!, order: 'descending' }
      : order === 'descending' ? { key: column.key!, order: 'ascending' } : null);
    return {
      ...column,
      sortOrder: order,
      title: (
        <button type="button" className={styles['sort-head']} onClick={next}>
          {typeof column.title === 'function' ? column.title({}) : column.title}
          {order === 'descending' && <ArrowDownOutlined aria-hidden="true" />}
          {order === 'ascending' && <ArrowUpOutlined aria-hidden="true" />}
        </button>
      ),
    };
  });
  return { columns: headed, data: sorted };
}
