import React from 'react';
import { DataTable, type ColumnsType, type DataTableProps } from '@/components/ui/table';
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
  identity: string;
  actions?: readonly string[];
  skip?: readonly string[];
}

export interface ResponsiveListPhoneCard<T> {
  render: (record: T, cell: (columnKey: string) => React.ReactNode) => React.ReactNode;
}

export type ResponsiveListPhoneLayout<T> = ResponsiveListPhoneFields | ResponsiveListPhoneCard<T>;

export interface ResponsiveListProps<T extends object> {
  columns: ColumnsType<T>;
  dataSource: readonly T[];
  rowKey: Extract<keyof T, string> | ((record: T) => React.Key);
  isLoading: boolean;
  isBlocked?: boolean;
  emptyText: React.ReactNode;
  pageSize?: number | false;
  pageResetKey?: unknown;
  phone: ResponsiveListPhoneLayout<T>;
  phoneRowWrapper?: React.ComponentType<{ rowKey: string; children: React.ReactNode }>;
  tableProps?: Omit<DataTableProps<T>, 'columns' | 'dataSource' | 'rowKey' | 'loading' | 'pagination'>;
  isFilterAnimated?: boolean;
}

function keyOf<T extends object>(record: T, rowKey: ResponsiveListProps<T>['rowKey']): React.Key {
  return typeof rowKey === 'function' ? rowKey(record) : String(record[rowKey]);
}

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
  const drawn = pageSize === false
    ? dataSource
    : dataSource.slice((safePage - 1) * pageSize, safePage * pageSize);
  const drawnKeys = drawn.map((record) => String(keyOf(record, rowKey)));
  const ownBody = tableProps?.components?.body;
  const ownRow = ownBody && typeof ownBody === 'object' ? ownBody.row : undefined;
  const tableComponents = isFilterAnimated && !ownRow
    ? { ...tableProps?.components, body: { ...(ownBody && typeof ownBody === 'object' ? ownBody : undefined), row: MotionBodyRow } }
    : tableProps?.components;

  if (!isPhone) {
    const table = (
      <div className="table-scroll data-table" ref={listRef}>
        <DataTable<T>
          {...tableProps}
          components={tableComponents}
          columns={columns}
          dataSource={dataSource}
          rowKey={rowKey}
          pagination={pageSize === false ? false : { current: safePage, onChange: changePage, pageSize, showSizeChanger: false, hideOnSinglePage: true }}
          locale={{ ...tableProps?.locale, emptyText: isFirstRead ? <TablePlaceholder rows={5} /> : empty ?? <span /> }}
        />
      </div>
    );
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
