import type { MessageKey } from '../../i18n/catalog';
import { moveKey, type DropSide } from '../../types/displayOrder';

export type RequestColumnId =
  | 'time'
  | 'result'
  | 'provider'
  | 'model'
  | 'mode'
  | 'tps'
  | 'latency'
  | 'tokens'
  | 'cost'
  | 'cache'
  | 'key'
  | 'client';

export interface RequestColumnDefinition {
  id: RequestColumnId;
  labelKey: MessageKey;
  align: 'left' | 'right' | 'center';
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  flexGrow: number;
  resizable: boolean;
  /**
   * When the list is too narrow for every column, the order in which this one is
   * folded away: 1 goes first. Absent on the columns that say what the request
   * was and what it cost, which stay until the list becomes stacked records.
   */
  foldOrder?: number;
}

export const REQUEST_COLUMNS: readonly RequestColumnDefinition[] = [
  {
    id: 'time',
    labelKey: 'events.col_time',
    align: 'left',
    defaultWidth: 96,
    minWidth: 88,
    maxWidth: 200,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'result',
    labelKey: 'events.col_result',
    align: 'left',
    defaultWidth: 76,
    minWidth: 64,
    maxWidth: 130,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'provider',
    labelKey: 'events.provider',
    align: 'left',
    defaultWidth: 210,
    minWidth: 136,
    maxWidth: 480,
    flexGrow: 1,
    resizable: true,
  },
  {
    // A row reads as three groups: the request itself (time, verdict, provider,
    // model), how it performed (mode to cache rate), and who called (key, client).
    // The first is what a reader looks for, so its two names take all the row's
    // spare room, in equal shares, and the group holds the left and centre of the
    // row; the other two keep tight fixed tracks at the right. The model's column
    // opens with a space of its own, so the two names never run together
    // (`UsageEventsPage.css`).
    id: 'model',
    labelKey: 'events.col_model',
    align: 'left',
    defaultWidth: 250,
    minWidth: 126,
    maxWidth: 440,
    flexGrow: 1,
    resizable: true,
  },
  {
    // How the request was made, apart from which model answered it: the reasoning
    // effort and the marks for a non-streamed response. Rigid, because its content
    // is a badge and a couple of icons whose width does not depend on the record.
    // It opens the performance group at the group's left edge, and its track
    // leaves room after the marks so they never crowd the throughput beside it.
    id: 'mode',
    labelKey: 'events.col_mode',
    align: 'left',
    defaultWidth: 84,
    minWidth: 72,
    maxWidth: 180,
    flexGrow: 0,
    resizable: true,
    foldOrder: 4,
  },
  {
    id: 'tps',
    labelKey: 'events.col_tps',
    align: 'right',
    defaultWidth: 78,
    minWidth: 68,
    maxWidth: 140,
    flexGrow: 0,
    resizable: true,
    foldOrder: 5,
  },
  {
    // The total sits over the time to first token, the longer line: a
    // first token minutes late is `TTFT 1234.56 s` (84px at the 12px size), and the
    // track keeps it clear of the throughput beside it.
    id: 'latency',
    labelKey: 'events.col_latency',
    align: 'right',
    defaultWidth: 88,
    minWidth: 80,
    maxWidth: 140,
    flexGrow: 0,
    resizable: true,
  },
  {
    // Rigid like every other figure: its counts have a known width, and a share
    // of the spare room here would be taken from the provider and model names,
    // which are the two cells that actually truncate. The breakdown never wraps,
    // so the track holds its widest ordinary line at the 12px detail size
    // (`↑ 999.9K ↓ 99.9K` plus reasoning is 140px).
    id: 'tokens',
    labelKey: 'events.col_tokens',
    align: 'right',
    defaultWidth: 140,
    minWidth: 128,
    maxWidth: 280,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'cost',
    labelKey: 'events.col_cost',
    align: 'right',
    defaultWidth: 56,
    minWidth: 52,
    maxWidth: 140,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'cache',
    labelKey: 'events.col_cache_rate',
    align: 'right',
    defaultWidth: 52,
    minWidth: 48,
    maxWidth: 130,
    flexGrow: 0,
    resizable: true,
    foldOrder: 3,
  },
  {
    // Who called is secondary to what the request did, so the caller's key and
    // client keep fixed tracks and leave the spare room to the request's own
    // facts. The key's track holds a full key mask (20 characters at the 12px
    // size) after its leading space; a longer alias truncates with its full value
    // in the tooltip. The leading space is the seam after the right-aligned cache
    // rate, where a short alias would otherwise sit against the figure
    // (`UsageEventsPage.css`).
    id: 'key',
    labelKey: 'events.col_key',
    align: 'left',
    defaultWidth: 136,
    minWidth: 96,
    maxWidth: 320,
    flexGrow: 0,
    resizable: true,
    foldOrder: 2,
  },
  {
    // The client program named by its mark and product name; the User-Agent it was read from is
    // the cell's tooltip.
    id: 'client',
    labelKey: 'events.col_client',
    align: 'left',
    defaultWidth: 120,
    minWidth: 80,
    maxWidth: 320,
    flexGrow: 0,
    resizable: true,
    foldOrder: 1,
  },
] as const;

export const REQUEST_COLUMN_IDS: readonly RequestColumnId[] = Object.freeze(
  REQUEST_COLUMNS.map((column) => column.id),
);

export const CHEVRON_TRACK_WIDTH = 14;

/**
 * The space between neighbouring tracks, and the row's inline padding. Where the
 * right-aligned cache rate meets the left-aligned caller key, the key's column
 * adds a space of its own (`UsageEventsPage.css`).
 */
export const REQUEST_GRID_GAP = 16;
export const REQUEST_PAD_INLINE = 20;

/** The leading track that holds each row's selection checkbox. */
export const SELECT_TRACK_WIDTH = 20;

/** Which fixed tracks surround the data columns: the list has both, an exported sheet neither. */
export interface RequestGridChrome {
  hasSelection: boolean;
  hasChevron: boolean;
  /**
   * The selection track is shut to no width while no choice is under way. It stays in the track
   * list, so opening and closing it is a change of one width the grid can animate, and the first
   * data column pulls back over its gap (`.request-stream:not(.is-selecting)`), so a shut track
   * takes no room.
   */
  isSelectionClosed?: boolean;
}

export const LIST_GRID_CHROME: RequestGridChrome = { hasSelection: true, hasChevron: true };
export const SHEET_GRID_CHROME: RequestGridChrome = { hasSelection: false, hasChevron: false };

/**
 * The list width at and below which each record is a stacked card instead of a
 * row of columns. It is the `reqstream` container threshold in
 * `RequestList.css`; a stacked record labels every field, so nothing folds.
 */
export const REQUEST_STACK_WIDTH = 920;

export const USAGE_EVENTS_COLUMNS_PREFERENCE = 'usage_events_columns';

export type RequestColumnWidths = Partial<Record<RequestColumnId, number>>;

/**
 * Stored JSON document under `usage_events_columns`.
 *
 * Existing documents store per-column pixel widths at the top level (`{ provider: 220 }`).
 * Optional `hidden` and `order` arrays extend the same document backward-compatibly: older
 * documents omit both (all columns visible in default order), and older builds ignore them
 * while keeping saved widths intact.
 */
export type UsageEventsColumnsPreferenceDoc = RequestColumnWidths & {
  hidden?: RequestColumnId[];
  order?: RequestColumnId[];
};

export interface RequestColumnPreference {
  widths: RequestColumnWidths;
  hidden: readonly RequestColumnId[];
  order: readonly RequestColumnId[];
}

/** Module-scope fallback so `usePreference` keeps one stable reference across renders. */
export const DEFAULT_USAGE_EVENTS_COLUMNS_DOC: UsageEventsColumnsPreferenceDoc = Object.freeze({});

export const COLUMN_MAP = new Map<RequestColumnId, RequestColumnDefinition>(
  REQUEST_COLUMNS.map((c) => [c.id, c]),
);

export function isRequestColumnId(value: unknown): value is RequestColumnId {
  return typeof value === 'string' && COLUMN_MAP.has(value as RequestColumnId);
}

export function isDefaultRequestColumnOrder(order: readonly RequestColumnId[]): boolean {
  return order.length === REQUEST_COLUMN_IDS.length
    && order.every((id, index) => id === REQUEST_COLUMN_IDS[index]);
}

/**
 * Normalizes a column sequence into a complete permutation of `REQUEST_COLUMN_IDS`:
 * unknown or repeated ids are dropped and any columns added later follow in default order.
 */
export function completeRequestColumnOrder(rawOrder: readonly RequestColumnId[] | undefined): readonly RequestColumnId[] {
  if (!rawOrder || rawOrder.length === 0) return REQUEST_COLUMN_IDS;
  const seen = new Set<RequestColumnId>();
  const complete: RequestColumnId[] = [];
  for (const id of rawOrder) {
    if (!COLUMN_MAP.has(id) || seen.has(id)) continue;
    seen.add(id);
    complete.push(id);
  }
  for (const id of REQUEST_COLUMN_IDS) {
    if (seen.has(id)) continue;
    seen.add(id);
    complete.push(id);
  }
  return isDefaultRequestColumnOrder(complete) ? REQUEST_COLUMN_IDS : complete;
}

/** Column definitions in the operator's chosen order. */
export function orderedRequestColumns(
  order: readonly RequestColumnId[] = REQUEST_COLUMN_IDS,
): readonly RequestColumnDefinition[] {
  const normalized = completeRequestColumnOrder(order);
  if (normalized === REQUEST_COLUMN_IDS) return REQUEST_COLUMNS;
  return normalized.map((id) => COLUMN_MAP.get(id)!);
}

/**
 * requestColumnAlignClass returns the alignment class for one column.
 *
 * The header and the body cell both read it from the column definition, so the
 * two can never drift apart: alignment used to be restated by hand in a header
 * selector list and again in a cell selector list, and `align` was written but
 * never used. Text-bearing columns are left-aligned and numeric columns are
 * right-aligned, which is the rule the definitions already encode.
 */
export function requestColumnAlignClass(id: RequestColumnId): string {
  return `is-align-${COLUMN_MAP.get(id)?.align ?? 'left'}`;
}

/**
 * parseUsageEventsColumns sanitizes column width overrides from preferences or input.
 * Unknown keys are stripped, values are clamped to each column's [minWidth, maxWidth],
 * and non-numbers are dropped.
 */
export function parseUsageEventsColumns(raw: unknown): RequestColumnWidths {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const rawRecord = raw as Record<string, unknown>;
  const result: RequestColumnWidths = {};

  for (const col of REQUEST_COLUMNS) {
    const overrideValue = rawRecord[col.id];
    if (typeof overrideValue === 'number' && Number.isFinite(overrideValue)) {
      const clamped = Math.round(Math.min(col.maxWidth, Math.max(col.minWidth, overrideValue)));
      result[col.id] = clamped;
    }
  }

  return result;
}

function normalizeHiddenColumns(raw: readonly unknown[]): RequestColumnId[] {
  const hiddenSet = new Set<RequestColumnId>();
  for (const entry of raw) {
    if (isRequestColumnId(entry)) hiddenSet.add(entry);
  }
  // At least one column must remain visible so the table never renders empty.
  if (hiddenSet.size === 0 || hiddenSet.size >= REQUEST_COLUMNS.length) return [];
  return REQUEST_COLUMN_IDS.filter((id) => hiddenSet.has(id));
}

/**
 * parseUsageEventsColumnPreference reads widths, user-hidden columns, and column order from
 * the stored `usage_events_columns` preference document.
 */
export function parseUsageEventsColumnPreference(raw: unknown): RequestColumnPreference {
  const widths = parseUsageEventsColumns(raw);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { widths, hidden: [], order: REQUEST_COLUMN_IDS };
  }
  const rawRecord = raw as Record<string, unknown>;
  const hidden = Array.isArray(rawRecord.hidden) ? normalizeHiddenColumns(rawRecord.hidden) : [];
  const order = Array.isArray(rawRecord.order)
    ? completeRequestColumnOrder(rawRecord.order.filter(isRequestColumnId))
    : REQUEST_COLUMN_IDS;
  return { widths, hidden, order };
}

/**
 * serializeUsageEventsColumns encodes column widths, visibility, and order into the compact
 * wire document stored under `usage_events_columns`. Empty `hidden` and default `order` are
 * omitted so default documents remain identical to width-only maps.
 */
export function serializeUsageEventsColumns(
  widths: RequestColumnWidths,
  hidden: readonly RequestColumnId[] = [],
  order: readonly RequestColumnId[] = REQUEST_COLUMN_IDS,
): UsageEventsColumnsPreferenceDoc {
  const doc: UsageEventsColumnsPreferenceDoc = { ...parseUsageEventsColumns(widths) };
  const normalizedHidden = normalizeHiddenColumns(hidden);
  if (normalizedHidden.length > 0) doc.hidden = normalizedHidden;
  const normalizedOrder = completeRequestColumnOrder(order);
  if (!isDefaultRequestColumnOrder(normalizedOrder)) doc.order = [...normalizedOrder];
  return doc;
}

/** Parser passed to `usePreference` for `usage_events_columns`. */
export function parseUsageEventsColumnsDoc(raw: unknown): UsageEventsColumnsPreferenceDoc | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { widths, hidden, order } = parseUsageEventsColumnPreference(raw);
  return serializeUsageEventsColumns(widths, hidden, order);
}

/** True when hiding `colId` would still leave at least one visible column. */
export function canHideRequestColumn(
  hidden: ReadonlySet<RequestColumnId> | readonly RequestColumnId[],
  colId: RequestColumnId,
): boolean {
  if (!COLUMN_MAP.has(colId)) return false;
  const hiddenSet = hidden instanceof Set ? hidden : new Set(hidden);
  if (hiddenSet.has(colId)) return true;
  let validHiddenCount = 0;
  for (const id of hiddenSet) {
    if (COLUMN_MAP.has(id)) validHiddenCount += 1;
  }
  return REQUEST_COLUMNS.length - validHiddenCount > 1;
}

/** Toggles one column's hidden state while enforcing the at-least-one-visible invariant. */
export function setRequestColumnHidden(
  hidden: readonly RequestColumnId[],
  colId: RequestColumnId,
  isHidden: boolean,
): RequestColumnId[] {
  const normalized = normalizeHiddenColumns(hidden);
  if (!COLUMN_MAP.has(colId)) return normalized;
  if (isHidden) {
    if (normalized.includes(colId) || !canHideRequestColumn(normalized, colId)) return normalized;
    return normalizeHiddenColumns([...normalized, colId]);
  }
  return normalized.filter((id) => id !== colId);
}

/** Moves `movingId` beside `targetId` in the column sequence. */
export function moveRequestColumn(
  order: readonly RequestColumnId[],
  movingId: RequestColumnId,
  targetId: RequestColumnId,
  side: DropSide,
): readonly RequestColumnId[] {
  const current = completeRequestColumnOrder(order);
  const moved = moveKey(current, movingId, targetId, side) as readonly RequestColumnId[];
  return moved === current ? current : completeRequestColumnOrder(moved);
}

/** Moves `colId` one step earlier (`-1`) or later (`1`) in the column sequence. */
export function stepRequestColumn(
  order: readonly RequestColumnId[],
  colId: RequestColumnId,
  direction: -1 | 1,
): readonly RequestColumnId[] {
  const current = completeRequestColumnOrder(order);
  const index = current.indexOf(colId);
  const neighbour = current[index + direction];
  if (index < 0 || neighbour === undefined) return current;
  return moveRequestColumn(current, colId, neighbour, direction < 0 ? 'before' : 'after');
}

const NO_COLUMNS: ReadonlySet<RequestColumnId> = new Set();

/**
 * buildGridTemplateColumns constructs the CSS grid-template-columns specification
 * for the data columns plus the fixed selection and action chevron tracks.
 * If a column has a manual override, it renders as a fixed pixel track (e.g. 210px).
 * If no override exists and flexGrow > 0, it renders as minmax(minWidth, flexGrow fr) for adaptive sizing.
 * If no override exists and flexGrow === 0, it renders as defaultWidth px.
 * A hidden or folded column contributes no track. When no visible data column is flexible,
 * the trailing chevron track absorbs spare width so the chevron stays anchored to the row's
 * trailing edge rather than floating mid-row.
 */
export function buildGridTemplateColumns(
  widths: RequestColumnWidths = {},
  chrome: RequestGridChrome = LIST_GRID_CHROME,
  excluded: ReadonlySet<RequestColumnId> = NO_COLUMNS,
  order: readonly RequestColumnId[] = REQUEST_COLUMN_IDS,
): string {
  let hasFlexibleDataTrack = false;
  const tracks = orderedRequestColumns(order)
    .filter((col) => !excluded.has(col.id))
    .map((col) => {
      const manualWidth = widths[col.id];
      if (manualWidth !== undefined && Number.isFinite(manualWidth)) {
        const clamped = Math.min(col.maxWidth, Math.max(col.minWidth, manualWidth));
        return `${Math.round(clamped)}px`;
      }
      if (col.flexGrow > 0) {
        hasFlexibleDataTrack = true;
        return `minmax(${col.minWidth}px, ${col.flexGrow}fr)`;
      }
      return `${col.defaultWidth}px`;
    });

  if (chrome.hasSelection) tracks.unshift(`${chrome.isSelectionClosed ? 0 : SELECT_TRACK_WIDTH}px`);
  if (chrome.hasChevron) {
    tracks.push(hasFlexibleDataTrack ? `${CHEVRON_TRACK_WIDTH}px` : `minmax(${CHEVRON_TRACK_WIDTH}px, 1fr)`);
  }
  return tracks.join(' ');
}

/**
 * computeGridMinWidth returns the narrowest total inline size (in px) that the
 * header/row grid can occupy before its tracks start clipping content: every
 * flexible track contributes its minWidth, fixed tracks contribute their width,
 * plus the inter-column gaps and the horizontal row padding.
 *
 * Using this measured floor instead of `min-width: max-content` keeps the header
 * and the virtualized rows on one shared track list, lets long provider/model
 * names ellipsize instead of pushing the executor column out of view, and only
 * scrolls horizontally when the user's own column widths genuinely demand it.
 */
export function computeGridMinWidth(
  widths: RequestColumnWidths = {},
  gap = REQUEST_GRID_GAP,
  paddingInline = REQUEST_PAD_INLINE,
  chrome: RequestGridChrome = LIST_GRID_CHROME,
  excluded: ReadonlySet<RequestColumnId> = NO_COLUMNS,
): number {
  const columns = REQUEST_COLUMNS.filter((col) => !excluded.has(col.id));
  const total = columns.reduce((sum, col) => {
    const manual = widths[col.id];
    if (manual !== undefined && Number.isFinite(manual)) {
      return sum + Math.min(col.maxWidth, Math.max(col.minWidth, manual));
    }
    return sum + (col.flexGrow > 0 ? col.minWidth : col.defaultWidth);
  }, 0);
  const fixedTracks = [
    chrome.hasSelection && !chrome.isSelectionClosed ? SELECT_TRACK_WIDTH : null,
    chrome.hasChevron ? CHEVRON_TRACK_WIDTH : null,
  ].filter((width): width is number => width !== null);
  // One gap between each pair of neighbouring tracks, data and fixed alike.
  const gaps = Math.max(0, columns.length + fixedTracks.length - 1) * gap;
  const fixed = fixedTracks.reduce((sum, width) => sum + width, 0);
  return Math.round(total + fixed + gaps + paddingInline * 2);
}

/**
 * resolveSeamColumns picks visible columns that need extra leading breathing room so adjacent
 * columns never visually collide: a left-aligned text column immediately after a right-aligned
 * numeric column, or the two flexible name columns (`provider` and `model`) sitting side by side.
 * The first visible column never receives a seam.
 */
export function resolveSeamColumns(
  excluded: ReadonlySet<RequestColumnId> = NO_COLUMNS,
  order: readonly RequestColumnId[] = REQUEST_COLUMN_IDS,
): RequestColumnId[] {
  const visible = orderedRequestColumns(order).filter((col) => !excluded.has(col.id));
  const seams: RequestColumnId[] = [];
  for (let index = 1; index < visible.length; index += 1) {
    const prev = visible[index - 1];
    const curr = visible[index];
    const isNumberToText = prev.align === 'right' && curr.align === 'left';
    const isAdjacentNamePair =
      (prev.id === 'provider' && curr.id === 'model') || (prev.id === 'model' && curr.id === 'provider');
    if (isNumberToText || isAdjacentNamePair) seams.push(curr.id);
  }
  return seams;
}

/** The foldable columns, the first to go first. */
const FOLD_SEQUENCE: readonly RequestColumnId[] = REQUEST_COLUMNS.filter((col) => col.foldOrder !== undefined)
  .sort((left, right) => left.foldOrder! - right.foldOrder!)
  .map((col) => col.id);

/**
 * foldRequestColumns decides which additional columns a list of the given width
 * leaves out on top of any columns the operator already hid.
 *
 * A list too narrow for its columns used to scroll sideways, which hides the
 * right-hand columns just the same but behind a gesture, and takes the header's
 * alignment with it on the way. Folding instead keeps every remaining column
 * whole: the least-scanned ones go first, one at a time, until the grid's floor
 * fits. Hiding other columns frees space so previously folded columns can return,
 * and folding always leaves at least one visible column.
 *
 * Nothing folds before the width is measured, or at the stacked-card width, where
 * each record labels all of its fields. The columns without a `foldOrder` never
 * fold; if they alone do not fit - only possible with widths the operator dragged
 * out - the list scrolls sideways as before.
 */
export function foldRequestColumns(
  availableWidth: number | null,
  widths: RequestColumnWidths = {},
  userHidden: ReadonlySet<RequestColumnId> = NO_COLUMNS,
): ReadonlySet<RequestColumnId> {
  const folded = new Set<RequestColumnId>();
  if (availableWidth === null || availableWidth <= REQUEST_STACK_WIDTH) return folded;
  const excluded = new Set<RequestColumnId>();
  for (const id of userHidden) {
    if (COLUMN_MAP.has(id)) excluded.add(id);
  }
  // Room is kept for the selection track even while it is hidden, so starting a choice never folds a column.
  for (const id of FOLD_SEQUENCE) {
    if (excluded.has(id)) continue;
    if (REQUEST_COLUMNS.length - excluded.size <= 1) break;
    if (computeGridMinWidth(widths, REQUEST_GRID_GAP, REQUEST_PAD_INLINE, LIST_GRID_CHROME, excluded) <= availableWidth) break;
    excluded.add(id);
    folded.add(id);
  }
  return folded;
}

