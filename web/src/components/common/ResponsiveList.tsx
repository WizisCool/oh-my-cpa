import React from 'react';
import { Empty, Pagination, Table } from 'antd';
import type { TableProps } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { PageLoading } from './PageLoading';
import { PhoneRow } from './PhoneRow';
import { phoneRowFields, renderedCell } from './phoneRowFields';

export interface ResponsiveListPhoneLayout {
  /** The column drawn as the row's headline. */
  identity: string;
  /** Columns whose rendered cells form the row's control strip, in order. */
  actions?: readonly string[];
  /** Further columns that are not fields, because the headline or the strip already shows them. */
  skip?: readonly string[];
}

export interface ResponsiveListProps<T extends object> {
  columns: ColumnsType<T>;
  dataSource: readonly T[];
  rowKey: Extract<keyof T, string> | ((record: T) => React.Key);
  /** True while the first read is in flight. Stale rows stay on screen during a refresh. */
  isLoading: boolean;
  /**
   * True when the read failed with nothing cached. The page's own error is then the only true
   * statement, and the empty copy - a claim about the source - is withheld.
   */
  isBlocked?: boolean;
  emptyText: React.ReactNode;
  /** Rows per page for both renderings; `false` draws the whole list. */
  pageSize?: number | false;
  /** A value that, when it changes, returns the reader to the first page (a filter, a search). */
  pageResetKey?: unknown;
  phone: ResponsiveListPhoneLayout;
  /** Passed to the wide rendering's table: its size, class and scroll behaviour. */
  tableProps?: Omit<TableProps<T>, 'columns' | 'dataSource' | 'rowKey' | 'loading' | 'pagination'>;
}

function keyOf<T extends object>(record: T, rowKey: ResponsiveListProps<T>['rowKey']): React.Key {
  return typeof rowKey === 'function' ? rowKey(record) : String(record[rowKey]);
}

/**
 * One dataset, rendered as a table on a wide viewport and as labelled rows on a phone (ADR 0012).
 *
 * Five pages carried their own copy of this switch, and the copies had drifted: one paged the
 * phone list and one did not, one showed a paginator for a single page, one claimed "empty" while
 * its read had failed. The decisions live here once:
 *
 *   - **Loading before emptiness.** The empty copy is a claim about the source, and it is not
 *     true while the first read is still in flight.
 *   - **Blocked is not empty.** With no cached rows, a failed read shows nothing here; the page's
 *     error alert is the one true statement.
 *   - **A page means the same thing at either width**, and the remembered page is clamped,
 *     because removing a row can shrink the list past it. A paginator for one page is not drawn.
 *   - **The row is derived from the columns** (`phoneRowFields`), so the table and the row cannot
 *     disagree about what a record shows, and a control is the column's own rendered cell.
 */
export function ResponsiveList<T extends object>({
  columns,
  dataSource,
  rowKey,
  isLoading,
  isBlocked = false,
  emptyText,
  pageSize = false,
  pageResetKey,
  phone,
  tableProps,
}: ResponsiveListProps<T>) {
  const isPhone = useIsPhoneViewport();
  const listRef = React.useRef<HTMLDivElement>(null);
  const [page, setPage] = React.useState(1);
  React.useEffect(() => {
    setPage(1);
  }, [pageResetKey]);

  const lastPage = pageSize === false ? 1 : Math.max(1, Math.ceil(dataSource.length / pageSize));
  const safePage = Math.min(page, lastPage);

  const changePage = (nextPage: number) => {
    setPage(nextPage);
    const list = listRef.current;
    if (list && list.getBoundingClientRect().top < 0) list.scrollIntoView({ block: 'start' });
  };

  const empty = isBlocked ? null : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />;

  if (!isPhone) {
    return (
      <div className="table-scroll" ref={listRef}>
        <Table<T>
          {...tableProps}
          columns={columns}
          dataSource={dataSource as T[]}
          rowKey={rowKey as TableProps<T>['rowKey']}
          loading={isLoading}
          pagination={pageSize === false ? false : { current: safePage, onChange: changePage, pageSize, showSizeChanger: false, hideOnSinglePage: true }}
          locale={{ ...tableProps?.locale, emptyText: empty ?? <span /> }}
        />
      </div>
    );
  }

  if (isLoading && dataSource.length === 0) return <PageLoading variant="block" />;
  if (dataSource.length === 0) return empty;

  const visible = pageSize === false
    ? dataSource
    : dataSource.slice((safePage - 1) * pageSize, safePage * pageSize);
  const actionKeys = phone.actions ?? [];
  const skip = [phone.identity, ...actionKeys, ...(phone.skip ?? [])];
  const offset = pageSize === false ? 0 : (safePage - 1) * pageSize;

  return (
    <div className="responsive-list" ref={listRef}>
      {visible.map((record, localIndex) => {
        const index = offset + localIndex;
        return (
          <PhoneRow
            key={keyOf(record, rowKey)}
            identity={renderedCell(columns, phone.identity, record, index)}
            fields={phoneRowFields(columns, record, { skip, index })}
            actions={actionKeys.length > 0
              ? actionKeys.map((key) => <React.Fragment key={key}>{renderedCell(columns, key, record, index)}</React.Fragment>)
              : undefined}
          />
        );
      })}
      {pageSize !== false && dataSource.length > pageSize && (
        <Pagination
          size="small"
          simple
          current={safePage}
          pageSize={pageSize}
          total={dataSource.length}
          onChange={changePage}
        />
      )}
    </div>
  );
}
