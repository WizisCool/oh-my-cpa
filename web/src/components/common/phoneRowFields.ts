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
export interface PhoneRowSource {
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
   * The column's renderer, typed loosely for the same reason as `title` and `dataIndex`: antd
   * types a cell's value as `any` and each column narrows it to what it expects, so a strict
   * signature here would reject every real column. `CellRenderer` below is the shape this module
   * calls one through, and the single cast in `renderCell` is where the two meet.
   */
  render?: unknown;
}

/**
 * A cell renderer, as this module calls it. Generic in the record, because that is the part this
 * module does constrain: it hands the renderer the record it was given.
 *
 * antd's return type is a node *or* the `{ children, props }` envelope a cell uses to control its
 * own `colSpan`/`rowSpan`; the envelope is unwrapped rather than rendered, because React would
 * receive an object.
 */
type CellRenderer<T> = (value: unknown, record: T, index: number) => ReactNode | RenderedCellLike;

/** antd's column array, seen as the renderers this module calls. */
function rendererOf<T>(column: PhoneRowSource): CellRenderer<T> | undefined {
  return typeof column.render === 'function' ? (column.render as CellRenderer<T>) : undefined;
}

/** antd's `RenderedCell`'s structural part: a cell that spans, wrapping its own content. */
export interface RenderedCellLike {
  children?: ReactNode;
  props?: unknown;
}

/**
 * Unwraps a rendered cell into something React can draw.
 *
 * Three shapes have to be told apart, and the first two are objects:
 *
 *   - **An array of nodes.** A row of tags or a mapped list is one of the commonest things a renderer
 *     returns, and it is a node in its own right. Treating every non-element object as a span
 *     envelope turned it into `undefined`, so the table showed the value and the phone row silently
 *     dropped the field - the divergence this module exists to prevent.
 *   - **A rendered element**, discriminated by `$$typeof`, which every element carries and an
 *     envelope does not. "Has props" would not do: an element has props too, so that test would
 *     classify an element as an envelope and print its children alone.
 *   - **antd's span envelope** (`{ children, props }`), which is unwrapped so React is not handed a
 *     bare object.
 *
 * Anything else is passed through untouched rather than replaced by `undefined`: dropping content is
 * the one outcome that must not happen silently, and React will say so itself if it cannot draw it.
 */
function renderedNode(rendered: ReactNode | RenderedCellLike | undefined): ReactNode | undefined {
  if (rendered === null || typeof rendered !== 'object') return rendered as ReactNode | undefined;
  if (Array.isArray(rendered)) return rendered as ReactNode;
  if ('$$typeof' in rendered) return rendered as ReactNode;
  if ('props' in rendered || 'children' in rendered) return (rendered as RenderedCellLike).children;
  return rendered as ReactNode;
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

function columnIdentity(column: PhoneRowSource): string | undefined {
  if (column.key !== undefined) return String(column.key);
  if (typeof column.dataIndex === 'string') return column.dataIndex;
  // The whole path, joined, because this identity is used as a React key and to find the column
  // again in `renderedCell`. Two columns reading `['nested', 'count']` and `['nested', 'total']`
  // would both answer `nested` if only the first segment were taken, and the second would then be
  // unreachable while the first silently stood in for it.
  if (Array.isArray(column.dataIndex) && column.dataIndex.length > 0) {
    return column.dataIndex.map(String).join('.');
  }
  return undefined;
}

/** The value antd would hand a column's `render` as its first argument. */
function cellValue<T>(column: PhoneRowSource, record: T): unknown {
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
  columns: readonly PhoneRowSource[],
  columnKey: string,
  record: T,
  index: number,
): ReactNode | undefined {
  const column = columns.find((candidate) => columnIdentity(candidate) === columnKey);
  if (!column) return undefined;
  const render = rendererOf(column);
  if (!render) return undefined;
  return renderedNode(render(cellValue(column, record), record, index));
}

export function phoneRowFields<T>(
  columns: readonly PhoneRowSource[],
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
    const render = rendererOf(column);
    const value: ReactNode | undefined = render
      ? renderedNode(render(cellValue(column, record), record, index))
      : (cellValue(column, record) as ReactNode | undefined);
    if (value === undefined || value === null) continue;
    fields.push({ key, label, value });
  }
  return fields;
}
