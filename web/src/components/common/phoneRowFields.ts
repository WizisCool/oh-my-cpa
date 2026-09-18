import type { Key, ReactNode } from 'react';

/**
 * A list's phone row, derived from the table it replaces.
 *
 * A list surface renders as a table on a wide viewport and as labelled rows on a phone. The
 * two must not be two descriptions of the same record: a column added to the table and
 * forgotten in the row is a field that silently disappears for every reader on a phone, and
 * nothing in the app would say so.
 *
 * So the row's content is *derived* from the column definitions rather than restated. The
 * columns stay the one description of what a record shows - in their order, with their own
 * labels and their own render functions - and this module turns them into the fields a row
 * prints:
 *
 *   - A column is a field when it can be identified (`key` or `dataIndex`) and is not named
 *     in `skip`.
 *   - Its label is the column's own `title`, so the row and the header cannot disagree and no
 *     new translation is needed.
 *   - Its value is the column's own `render`, called with the same arguments antd would pass
 *     it, so a cell and a field format a value identically.
 *   - Column order is field order, which is the order the table's reader already learned.
 *
 * `skip` is how a caller says a column is not a *field*: the identity column is drawn as the
 * row's headline, the actions column is drawn as controls, and a column whose content is
 * already part of the headline would otherwise print twice.
 */

/** The structural part of an antd `ColumnType` this module needs, so it can be tested alone. */
export interface PhoneRowSource<T> {
  key?: Key;
  /**
   * The path a column's value is read from. Typed loosely for the same reason as `title`: antd
   * constrains this to the record's own keys, which no independent structural type can express,
   * and this module only ever uses it to look a value up - so it reads whatever it is given
   * rather than requiring a reshape of real columns.
   */
  dataIndex?: unknown;
  /**
   * The column's own title.
   *
   * Typed loosely on purpose: antd allows a title to be a node *or* a function of the table's
   * own state, and this module has to accept a real column array rather than a reshape of it.
   * A function title is resolved to a node below rather than being skipped - a column dropped
   * for the shape of its title is exactly the silent omission this module exists to prevent.
   */
  title?: unknown;
  /**
   * The column's renderer. Its return type is antd's, which is a node *or* the
   * `{ children, props }` envelope a cell uses to control its own `colSpan`/`rowSpan`; the
   * envelope is unwrapped below rather than rendered, because React would receive an object.
   */
  render?: (value: unknown, record: T, index: number) => ReactNode | RenderedCellLike;
}

/** antd's `RenderedCell`'s structural part: a cell that spans, wrapping its own content. */
export interface RenderedCellLike {
  children?: ReactNode;
  props?: unknown;
}

/**
 * Unwraps a rendered cell into something React can draw.
 *
 * The discriminator is `$$typeof`, which every React element carries and a span envelope does
 * not: both are objects with `props`, so "has props" would classify a rendered element as an
 * envelope and print its children alone - losing the element itself.
 */
function renderedNode(rendered: ReactNode | RenderedCellLike | undefined): ReactNode | undefined {
  if (rendered === null || typeof rendered !== 'object') return rendered as ReactNode | undefined;
  if ('$$typeof' in rendered) return rendered as ReactNode;
  return (rendered as RenderedCellLike).children;
}

/** The props antd hands a function title. The console uses none, so an empty table is passed. */
const NO_TITLE_PROPS = { filters: undefined, sortOrder: undefined };

export interface PhoneRowField {
  /** Stable for React's key and for a test's assertion; the column's own identity. */
  key: string;
  /** The column's title. */
  label: ReactNode;
  /** The column's rendered cell. */
  value: ReactNode;
}

function columnIdentity<T>(column: PhoneRowSource<T>): string | undefined {
  if (column.key !== undefined) return String(column.key);
  if (typeof column.dataIndex === 'string') return column.dataIndex;
  // A path array is addressed by its first segment for the purpose of *naming* the field;
  // the value itself is still read through the whole path below.
  if (Array.isArray(column.dataIndex) && column.dataIndex.length > 0) return String(column.dataIndex[0]);
  return undefined;
}

/** The value antd would hand a column's `render` as its first argument. */
function cellValue<T>(column: PhoneRowSource<T>, record: T): unknown {
  if (column.dataIndex === undefined) return record;
  const path = Array.isArray(column.dataIndex) ? column.dataIndex : [column.dataIndex];
  let value: unknown = record;
  for (const segment of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[String(segment)];
  }
  return value;
}

/**
 * One column's rendered cell, for a caller that draws it outside the table.
 *
 * A row's controls live in columns too - a switch, an action cluster - and a phone row draws
 * them on their own line rather than as a field. This is how such a caller gets them without
 * writing the control a second time: the column's own `render` produces it, so the table's
 * switch and the row's switch cannot diverge in state, disabled-ness or label.
 */
export function renderedCell<T>(
  columns: readonly PhoneRowSource<T>[],
  columnKey: string,
  record: T,
  index: number,
): ReactNode | undefined {
  const column = columns.find((candidate) => columnIdentity(candidate) === columnKey);
  if (!column || !column.render) return undefined;
  return renderedNode(column.render(cellValue(column, record), record, index));
}

export function phoneRowFields<T>(
  columns: readonly PhoneRowSource<T>[],
  record: T,
  { skip = [], index }: { skip?: readonly string[]; index: number },
): PhoneRowField[] {
  const skipped = new Set(skip);
  const fields: PhoneRowField[] = [];
  for (const column of columns) {
    const key = columnIdentity(column);
    // A column with neither a key nor a dataIndex cannot be addressed, so it cannot be a
    // field: there would be nothing to name it or to look its value up by.
    if (key === undefined || skipped.has(key)) continue;
    // A column that only groups (`children`) or only draws a divider has no title to label a
    // field with, and one that carries no render and no dataIndex prints the record itself.
    if (column.title === undefined || column.title === null) continue;
    const label: ReactNode = typeof column.title === 'function'
      ? (column.title as (props: unknown) => ReactNode)(NO_TITLE_PROPS)
      : (column.title as ReactNode);
    // A column without a `render` prints its own value (antd does the same), so the fallback is
    // that value rather than the record.
    const value: ReactNode | undefined = column.render
      ? renderedNode(column.render(cellValue(column, record), record, index))
      : (cellValue(column, record) as ReactNode | undefined);
    if (value === undefined || value === null) continue;
    fields.push({ key, label, value });
  }
  return fields;
}
