import type { RequestColumnId } from './requestColumns';

/**
 * The most rows one exported image holds.
 *
 * A row is 68px tall at the sheet's width, so a hundred of them is already a
 * seven-thousand-pixel image; past that the picture stops being something a
 * person reads and browsers start refusing the canvas.
 */
export const EXPORT_ROW_LIMIT = 100;

/**
 * The canvas area every current engine will allocate. Safari's ceiling is the
 * lowest, and a canvas past it comes back blank rather than failing.
 */
const MAX_CANVAS_AREA = 16_000_000;

/**
 * What a sheet can redact: a whole column, or one of the three values inside a
 * cell that identify someone - the OAuth account that answered, the provider
 * key that answered, and the request id.
 */
export type RequestMaskId = RequestColumnId | 'provider_account' | 'provider_key' | 'request_id';

/**
 * The identifying details an operator withholds without giving up a column.
 *
 * They are named for what a reader of the picture could learn, not for where
 * the value sits: "keys" is both the caller's key and the provider key that
 * answered, because someone hiding one means to hide the other.
 */
export const SENSITIVE_DETAILS = ['account', 'keys', 'request_id'] as const;
export type SensitiveDetail = (typeof SENSITIVE_DETAILS)[number];

const DETAIL_MASKS: Record<SensitiveDetail, readonly RequestMaskId[]> = {
  account: ['provider_account'],
  keys: ['key', 'provider_key'],
  request_id: ['request_id'],
};

/**
 * Withheld until the operator says otherwise. A picture of requests is shared to
 * show what a model or a source did - latency, throughput, cost - so the source
 * stays, and what goes is what names a person: the account's address and the keys.
 */
export const DEFAULT_SENSITIVE_DETAILS: readonly SensitiveDetail[] = ['account', 'keys'];

/** effectiveMasks resolves the operator's choices into what the sheet redacts. */
export function effectiveMasks(
  details: readonly SensitiveDetail[],
  columns: readonly RequestColumnId[],
): Set<RequestMaskId> {
  const resolved = new Set<RequestMaskId>(columns);
  for (const detail of details) {
    for (const mask of DETAIL_MASKS[detail]) resolved.add(mask);
  }
  return resolved;
}

interface SelectableRecord {
  id: number;
  timestamp_ms: number;
}

/**
 * toggleSelection applies one checkbox click to the selection.
 *
 * A plain click flips the row. A range click extends from the anchor - the row
 * last clicked without Shift - to the row clicked now, and gives every row
 * between them the state the clicked row is moving to, so Shift can deselect a
 * run as well as select one. When the anchor has left the loaded rows (a poll or
 * a page change removed it) there is no run to extend, and the click is plain.
 */
export function toggleSelection<Row extends SelectableRecord>(
  selection: ReadonlyMap<number, Row>,
  rows: readonly Row[],
  id: number,
  anchorId: number | null,
  isRange: boolean,
): Map<number, Row> {
  const next = new Map(selection);
  const targetIndex = rows.findIndex((row) => row.id === id);
  if (targetIndex < 0) return next;
  const isSelecting = !selection.has(id);
  const anchorIndex = isRange && anchorId !== null ? rows.findIndex((row) => row.id === anchorId) : -1;
  const from = anchorIndex < 0 ? targetIndex : Math.min(anchorIndex, targetIndex);
  const to = anchorIndex < 0 ? targetIndex : Math.max(anchorIndex, targetIndex);
  for (let index = from; index <= to; index += 1) {
    const row = rows[index];
    if (isSelecting) next.set(row.id, row);
    else next.delete(row.id);
  }
  return next;
}

/**
 * How the loaded rows stand against the selection, which is what the header
 * checkbox shows. Rows selected on another page do not count: the header
 * checkbox speaks for the rows under it.
 */
export function loadedSelectionState(
  selection: ReadonlyMap<number, unknown>,
  rows: readonly SelectableRecord[],
): 'none' | 'some' | 'all' {
  if (rows.length === 0) return 'none';
  const selectedCount = rows.reduce((count, row) => count + (selection.has(row.id) ? 1 : 0), 0);
  if (selectedCount === 0) return 'none';
  return selectedCount === rows.length ? 'all' : 'some';
}

/** setLoadedSelection selects or clears every loaded row and leaves other pages' rows as they were. */
export function setLoadedSelection<Row extends SelectableRecord>(
  selection: ReadonlyMap<number, Row>,
  rows: readonly Row[],
  isSelected: boolean,
): Map<number, Row> {
  const next = new Map(selection);
  for (const row of rows) {
    if (isSelected) next.set(row.id, row);
    else next.delete(row.id);
  }
  return next;
}

/**
 * exportRows orders the selection the way the list orders it - newest request
 * first, the id breaking ties - and keeps the newest rows when there are more
 * than one image holds.
 */
export function exportRows<Row extends SelectableRecord>(
  selection: ReadonlyMap<number, Row>,
  limit = EXPORT_ROW_LIMIT,
): Row[] {
  return [...selection.values()]
    .sort((left, right) => right.timestamp_ms - left.timestamp_ms || right.id - left.id)
    .slice(0, limit);
}

/**
 * exportPixelRatio picks the density the sheet is drawn at: twice its CSS size
 * so text stays sharp when the image is zoomed, backed off only as far as the
 * canvas ceiling demands for a tall selection.
 */
export function exportPixelRatio(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 1;
  const fitting = Math.sqrt(MAX_CANVAS_AREA / (width * height));
  return Math.max(0.5, Math.min(2, Math.floor(fitting * 100) / 100));
}
