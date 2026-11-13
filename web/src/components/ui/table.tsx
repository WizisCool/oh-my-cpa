import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Pager } from '@/components/common/Pager';

function TableRoot({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <table
      data-slot="table"
      className={cn('w-full caption-bottom border-collapse text-base', className)}
      {...props}
    />
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return (
    <thead
      data-slot="table-header"
      className={cn('[&_tr]:border-b-[length:var(--hairline)] [&_tr]:border-b-border-soft', className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-b-0', className)} {...props} />;
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b-[length:var(--hairline)] border-b-border-soft transition-colors hover:bg-[color-mix(in_srgb,var(--fg)_3%,transparent)]',
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-9 px-4 text-left align-middle text-sm font-medium whitespace-nowrap text-muted-foreground select-none',
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn('px-4 py-3 align-middle text-base text-foreground', className)}
      {...props}
    />
  );
}

export interface ColumnDef<T> {
  key?: React.Key;
  dataIndex?: keyof T | string | readonly (string | number)[];
  title?: React.ReactNode | ((props: Record<string, never>) => React.ReactNode);
  width?: number | string;
  minWidth?: number | string;
  align?: 'left' | 'center' | 'right';
  ellipsis?: boolean | { showTitle?: boolean };
  fixed?: 'left' | 'right' | 'start' | 'end' | boolean;
  className?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render?: (value: any, record: T, index: number) => React.ReactNode | { children?: React.ReactNode; props?: React.TdHTMLAttributes<HTMLTableCellElement> };
}

export type ColumnsType<T> = readonly ColumnDef<T>[];

export interface DataTablePagination {
  current?: number;
  pageSize?: number;
  onChange?: (page: number, pageSize: number) => void;
  showSizeChanger?: boolean;
  hideOnSinglePage?: boolean;
}

export interface DataTableProps<T extends object> {
  columns: ColumnsType<T>;
  dataSource?: readonly T[];
  rowKey: Extract<keyof T, string> | ((record: T) => React.Key);
  size?: 'small' | 'middle' | 'large';
  loading?: boolean;
  pagination?: false | DataTablePagination;
  scroll?: { x?: number | string | true; y?: number | string };
  locale?: { emptyText?: React.ReactNode };
  tableLayout?: 'auto' | 'fixed';
  onRow?: (record: T, index?: number) => React.HTMLAttributes<HTMLTableRowElement>;
  components?: {
    body?: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      row?: React.ComponentType<any>;
    };
  };
  className?: string;
  style?: React.CSSProperties;
}

function readDataPath<T extends object>(record: T, dataIndex: ColumnDef<T>['dataIndex']): unknown {
  if (dataIndex === undefined || dataIndex === null) return record;
  if (Array.isArray(dataIndex)) {
    let cursor: unknown = record;
    for (const seg of dataIndex) {
      if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
      cursor = (cursor as Record<string | number, unknown>)[seg];
    }
    return cursor;
  }
  return (record as Record<string, unknown>)[String(dataIndex)];
}

function resolveKey<T extends object>(record: T, rowKey: DataTableProps<T>['rowKey'], idx: number): React.Key {
  if (typeof rowKey === 'function') return rowKey(record);
  const raw = (record as Record<string, unknown>)[rowKey];
  return raw !== undefined && raw !== null ? String(raw) : idx;
}

function DataTable<T extends object>({
  columns,
  dataSource = [],
  rowKey,
  size = 'middle',
  loading = false,
  pagination = false,
  scroll,
  locale,
  tableLayout,
  onRow,
  components,
  className,
  style,
}: DataTableProps<T>) {
  const currentPage = pagination ? (pagination.current ?? 1) : 1;
  const pageSize = pagination ? (pagination.pageSize ?? 20) : dataSource.length || 1;
  const rows = pagination
    ? dataSource.slice((currentPage - 1) * pageSize, currentPage * pageSize)
    : dataSource;

  const BodyRowComp = components?.body?.row ?? 'tr';
  const isCompact = size === 'small';
  const headHidden = className?.includes('data-table-head-hidden');

  const scrollStyle: React.CSSProperties = {};
  if (scroll?.x) {
    scrollStyle.overflowX = 'auto';
  }
  if (scroll?.y !== undefined) {
    scrollStyle.maxHeight = typeof scroll.y === 'number' ? `${scroll.y}px` : scroll.y;
    scrollStyle.overflowY = 'auto';
  }

  const tableMinWidth =
    typeof scroll?.x === 'number'
      ? `${scroll.x}px`
      : typeof scroll?.x === 'string'
        ? scroll.x
        : undefined;

  return (
    <div data-slot="data-table" className={cn('relative w-full', className)} style={style}>
      {loading ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-background/55">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : null}
      <div className="w-full" style={scrollStyle}>
        <table
          data-slot="table"
          style={{
            minWidth: tableMinWidth,
            tableLayout: tableLayout ?? (columns.some((c) => c.ellipsis) && !scroll?.x ? 'fixed' : undefined),
          }}
          className="w-full border-collapse text-base"
        >
          {!headHidden ? (
            <thead data-slot="table-header">
              <tr className="border-b-[length:var(--hairline)] border-b-border-soft bg-surface">
                {columns.map((col, colIdx) => {
                  const colKey = col.key ?? (typeof col.dataIndex === 'string' ? col.dataIndex : colIdx);
                  const titleNode = typeof col.title === 'function' ? col.title({}) : col.title;
                  const pinnedEnd = col.fixed === 'right' || col.fixed === 'end';
                  const pinnedStart = col.fixed === 'left' || col.fixed === 'start' || col.fixed === true;
                  return (
                    <th
                      key={String(colKey)}
                      style={{
                        width: col.width,
                        minWidth: col.minWidth,
                        textAlign: col.align ?? 'left',
                      }}
                      className={cn(
                        'font-medium text-sm whitespace-nowrap text-muted-foreground select-none',
                        isCompact ? 'h-8 px-3 py-1.5' : 'h-9 px-4 py-2',
                        scroll?.y !== undefined && 'sticky top-0 z-[2] bg-surface',
                        pinnedEnd && 'sticky right-0 z-[1] bg-surface',
                        pinnedStart && 'sticky left-0 z-[1] bg-surface',
                        col.className,
                      )}
                    >
                      {titleNode}
                    </th>
                  );
                })}
              </tr>
            </thead>
          ) : null}
          <tbody data-slot="table-body">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={Math.max(1, columns.length)} className="px-4 py-6 text-center text-base text-muted-foreground">
                  {locale?.emptyText ?? '—'}
                </td>
              </tr>
            ) : (
              rows.map((record, localIdx) => {
                const absIdx = pagination ? (currentPage - 1) * pageSize + localIdx : localIdx;
                const key = resolveKey(record, rowKey, absIdx);
                const extraRowProps = onRow?.(record, absIdx) ?? {};
                return (
                  <BodyRowComp
                    key={key}
                    data-slot="table-row"
                    data-row-key={key}
                    {...extraRowProps}
                    className={cn(
                      'border-b-[length:var(--hairline)] border-b-border-soft transition-colors last:border-b-0 hover:bg-[color-mix(in_srgb,var(--fg)_3%,transparent)]',
                      extraRowProps.onClick && 'cursor-pointer',
                      extraRowProps.className,
                    )}
                  >
                    {columns.map((col, colIdx) => {
                      const colKey = col.key ?? (typeof col.dataIndex === 'string' ? col.dataIndex : colIdx);
                      const rawValue = readDataPath(record, col.dataIndex);
                      const rendered = col.render ? col.render(rawValue, record, absIdx) : (rawValue as React.ReactNode);
                      const isEnvelope =
                        rendered !== null &&
                        typeof rendered === 'object' &&
                        !React.isValidElement(rendered) &&
                        ('children' in rendered || 'props' in rendered);
                      const cellChildren = isEnvelope
                        ? (rendered as { children?: React.ReactNode }).children
                        : (rendered as React.ReactNode);
                      const cellExtraProps = isEnvelope
                        ? ((rendered as { props?: React.TdHTMLAttributes<HTMLTableCellElement> }).props ?? {})
                        : {};
                      if (cellExtraProps.colSpan === 0 || cellExtraProps.rowSpan === 0) return null;
                      const pinnedEnd = col.fixed === 'right' || col.fixed === 'end';
                      const pinnedStart = col.fixed === 'left' || col.fixed === 'start' || col.fixed === true;
                      const isEllipsis = Boolean(col.ellipsis);
                      const showEllipsisTip =
                        isEllipsis &&
                        (typeof col.ellipsis !== 'object' || col.ellipsis.showTitle !== false) &&
                        (typeof cellChildren === 'string' || typeof cellChildren === 'number');
                      return (
                        <td
                          key={String(colKey)}
                          {...cellExtraProps}
                          data-tip={showEllipsisTip ? String(cellChildren) : undefined}
                          data-tip-overflow={showEllipsisTip ? '' : undefined}
                          style={{
                            width: col.width,
                            minWidth: col.minWidth,
                            textAlign: col.align ?? 'left',
                            ...cellExtraProps.style,
                          }}
                          className={cn(
                            'align-middle text-base text-foreground',
                            isCompact ? 'px-3 py-2' : 'px-4 py-3',
                            isEllipsis && 'max-w-0 truncate',
                            pinnedEnd && 'sticky right-0 z-[1] bg-background',
                            pinnedStart && 'sticky left-0 z-[1] bg-background',
                            col.className,
                            cellExtraProps.className,
                          )}
                        >
                          {cellChildren}
                        </td>
                      );
                    })}
                  </BodyRowComp>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {pagination ? (
        <div className="mt-3 flex justify-end px-3 pb-2">
          <Pager
            page={currentPage}
            pageSize={pageSize}
            total={dataSource.length}
            onChange={(next) => pagination.onChange?.(next, pageSize)}
          />
        </div>
      ) : null}
    </div>
  );
}

export {
  DataTable,
  DataTable as Table,
  TableRoot,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
};
