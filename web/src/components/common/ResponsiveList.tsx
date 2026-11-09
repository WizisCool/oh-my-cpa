import React from 'react';
import { Table } from 'antd';
import type { TableProps } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { FilterTransition, useFilterItemMotion } from '../../motion/filter';
import { m } from '../../motion';
import { ListLoading } from './PageLoading';
import { TablePlaceholder } from './ContentPlaceholder';
import { PhoneRow } from './PhoneRow';
import { phoneRowFields, renderedCell } from './phoneRowFields';
import { EmptyState } from './EmptyState';
import { Pager } from './Pager';

export interface ResponsiveListPhoneFields {
  /** The column drawn as the row's headline. */
  identity: string;
  /** Columns whose rendered cells form the row's control strip, in order. */
  actions?: readonly string[];
  /** Further columns that are not fields, because the headline or the strip already shows them. */
  skip?: readonly string[];
}

/**
 * A row laid out by the list's own page, for a record whose facts read better arranged than
 * labelled. `cell` is the named column's own rendered cell, so the card and the table still cannot
 * disagree about what a record shows.
 */
export interface ResponsiveListPhoneCard<T> {
  render: (record: T, cell: (columnKey: string) => React.ReactNode) => React.ReactNode;
}

export type ResponsiveListPhoneLayout<T> = ResponsiveListPhoneFields | ResponsiveListPhoneCard<T>;

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
  phone: ResponsiveListPhoneLayout<T>;
  /**
   * Wraps each phone row, for a list whose rows do more than render (the wide table's counterpart
   * is a body row in `tableProps.components`).
   */
  phoneRowWrapper?: React.ComponentType<{ rowKey: string; children: React.ReactNode }>;
  /** Passed to the wide rendering's table: its size, class and scroll behaviour. */
  tableProps?: Omit<TableProps<T>, 'columns' | 'dataSource' | 'rowKey' | 'loading' | 'pagination'>;
  /**
   * True when a search or a filter narrows this list: its rows then glide to the place the shorter
   * list gives them and a row that starts to match fades in, rather than the list being replaced.
   * A list whose rows stream in, such as a log tail, leaves it off.
   */
  isFilterAnimated?: boolean;
}

function keyOf<T extends object>(record: T, rowKey: ResponsiveListProps<T>['rowKey']): React.Key {
  return typeof rowKey === 'function' ? rowKey(record) : String(record[rowKey]);
}

/**
 * One dataset, rendered as a table on a wide viewport and as labelled rows on a phone.
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
  phoneRowWrapper: PhoneRowWrapper,
  tableProps,
  isFilterAnimated = false,
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

  const empty = isBlocked ? null : <EmptyState size="compact" title={emptyText} />;
  const isFirstRead = isLoading && dataSource.length === 0;
  // The rows drawn, which is what the transition watches: the table's own paginator draws one page
  // of `dataSource`, and a page turn replaces every row rather than narrowing the list.
  const drawn = pageSize === false
    ? dataSource
    : dataSource.slice((safePage - 1) * pageSize, safePage * pageSize);
  const drawnKeys = drawn.map((record) => String(keyOf(record, rowKey)));
  // A caller that draws its own rows has already given them their motion; the default rows take it
  // from here. A table that scrolls its body itself replaces `body` with a component, which is not
  // a row to wrap.
  const ownBody = tableProps?.components?.body;
  const ownRow = ownBody && typeof ownBody === 'object' ? ownBody.row : undefined;
  const tableComponents = isFilterAnimated && !ownRow
    ? { ...tableProps?.components, body: { ...(ownBody && typeof ownBody === 'object' ? ownBody : undefined), row: MotionBodyRow } }
    : tableProps?.components;

  if (!isPhone) {
    // A first read keeps the column header and draws rows under it, where a spinner over an empty
    // table would show a frame of the wrong height. A later read keeps its rows on screen.
    const table = (
      <div className="table-scroll data-table" ref={listRef}>
        <Table<T>
          {...tableProps}
          components={tableComponents}
          columns={columns}
          dataSource={dataSource as T[]}
          rowKey={rowKey as TableProps<T>['rowKey']}
          pagination={pageSize === false ? false : { current: safePage, onChange: changePage, pageSize, showSizeChanger: false, hideOnSinglePage: true }}
          locale={{ ...tableProps?.locale, emptyText: isFirstRead ? <TablePlaceholder rows={5} /> : empty ?? <span /> }}
        />
      </div>
    );
    // A list that does not animate never loads the animation's features.
    return isFilterAnimated ? <FilterTransition itemKeys={drawnKeys}>{table}</FilterTransition> : table;
  }

  if (isFirstRead) return <ListLoading />;
  if (dataSource.length === 0) return empty;

  const visible = drawn;
  const offset = pageSize === false ? 0 : (safePage - 1) * pageSize;

  const rows = (
    <div className="responsive-list" ref={listRef}>
      {visible.map((record, localIndex) => {
        const index = offset + localIndex;
        const key = keyOf(record, rowKey);
        const row = 'render' in phone
          ? <React.Fragment key={key}>{phone.render(record, (columnKey) => renderedCell(columns, columnKey, record, index))}</React.Fragment>
          : <FieldsPhoneRow key={key} columns={columns} record={record} index={index} layout={phone} />;
        if (PhoneRowWrapper) return <PhoneRowWrapper key={key} rowKey={String(key)}>{row}</PhoneRowWrapper>;
        return isFilterAnimated
          ? <MotionPhoneRow key={key} rowKey={String(key)}>{row}</MotionPhoneRow>
          : row;
      })}
      {pageSize !== false && (
        <Pager variant="stepped" page={safePage} pageSize={pageSize} total={dataSource.length} onChange={changePage} />
      )}
    </div>
  );
  return isFilterAnimated ? <FilterTransition itemKeys={drawnKeys}>{rows}</FilterTransition> : rows;
}

/**
 * A row that the list narrows around. The props are the table's own, minus the handlers Motion
 * inherits, so a row keeps its selection, its class and its data attributes.
 */
type MotionRowProps = Omit<React.HTMLAttributes<HTMLTableRowElement>,
  'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart' | 'onAnimationEnd' | 'onAnimationIteration'>;

function MotionBodyRow(props: MotionRowProps) {
  const filterMotion = useFilterItemMotion();
  return <m.tr {...filterMotion} {...props} />;
}

function MotionPhoneRow({ rowKey, children }: { rowKey: string; children: React.ReactNode }) {
  const filterMotion = useFilterItemMotion();
  return <m.div {...filterMotion} data-row-key={rowKey}>{children}</m.div>;
}

function FieldsPhoneRow<T extends object>({ columns, record, index, layout }: {
  columns: ColumnsType<T>;
  record: T;
  index: number;
  layout: ResponsiveListPhoneFields;
}) {
  const actionKeys = layout.actions ?? [];
  const skip = [layout.identity, ...actionKeys, ...(layout.skip ?? [])];
  return (
    <PhoneRow
      identity={renderedCell(columns, layout.identity, record, index)}
      fields={phoneRowFields(columns, record, { skip, index })}
      actions={actionKeys.length > 0
        ? actionKeys.map((key) => <React.Fragment key={key}>{renderedCell(columns, key, record, index)}</React.Fragment>)
        : undefined}
    />
  );
}
