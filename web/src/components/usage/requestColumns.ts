export type RequestColumnId =
  | 'time'
  | 'result'
  | 'provider'
  | 'model'
  | 'latency'
  | 'tps'
  | 'tokens'
  | 'cost'
  | 'cache'
  | 'key'
  | 'ua';

export interface RequestColumnDefinition {
  id: RequestColumnId;
  labelKey: string;
  align: 'left' | 'right' | 'center';
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  flexGrow: number;
  resizable: boolean;
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
    defaultWidth: 88,
    minWidth: 78,
    maxWidth: 130,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'provider',
    labelKey: 'events.provider',
    align: 'left',
    defaultWidth: 210,
    minWidth: 140,
    maxWidth: 480,
    flexGrow: 1.6,
    resizable: true,
  },
  {
    id: 'model',
    labelKey: 'events.col_model',
    align: 'left',
    defaultWidth: 175,
    minWidth: 130,
    maxWidth: 440,
    flexGrow: 1.3,
    resizable: true,
  },
  {
    id: 'latency',
    labelKey: 'events.col_latency',
    align: 'right',
    defaultWidth: 76,
    minWidth: 68,
    maxWidth: 140,
    flexGrow: 0,
    resizable: true,
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
  },
  {
    id: 'tokens',
    labelKey: 'events.col_tokens',
    align: 'right',
    defaultWidth: 140,
    minWidth: 125,
    maxWidth: 280,
    flexGrow: 1,
    resizable: true,
  },
  {
    id: 'cost',
    labelKey: 'events.col_cost',
    align: 'right',
    defaultWidth: 72,
    minWidth: 64,
    maxWidth: 140,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'cache',
    labelKey: 'events.col_cache_rate',
    align: 'right',
    defaultWidth: 64,
    minWidth: 58,
    maxWidth: 130,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'key',
    labelKey: 'events.col_key',
    align: 'left',
    defaultWidth: 135,
    minWidth: 125,
    maxWidth: 220,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'ua',
    labelKey: 'events.col_ua',
    align: 'left',
    defaultWidth: 76,
    minWidth: 60,
    maxWidth: 180,
    flexGrow: 0,
    resizable: true,
  },
] as const;

export const CHEVRON_TRACK_WIDTH = 14;

/**
 * The space between neighbouring tracks, and the row's inline padding. A
 * right-aligned figure ends where its track ends and a left-aligned label starts
 * where the next begins, so this gap is all that separates the cache rate from
 * the caller key beside it; at 12px the two read as one value.
 */
export const REQUEST_GRID_GAP = 16;
export const REQUEST_PAD_INLINE = 12;

/** The leading track that holds each row's selection checkbox. */
export const SELECT_TRACK_WIDTH = 20;

/** Which fixed tracks surround the data columns: the list has both, an exported sheet neither. */
export interface RequestGridChrome {
  hasSelection: boolean;
  hasChevron: boolean;
}

export const LIST_GRID_CHROME: RequestGridChrome = { hasSelection: true, hasChevron: true };
export const SHEET_GRID_CHROME: RequestGridChrome = { hasSelection: false, hasChevron: false };

export const USAGE_EVENTS_COLUMNS_PREFERENCE = 'usage_events_columns';

export type RequestColumnWidths = Partial<Record<RequestColumnId, number>>;

export const COLUMN_MAP = new Map<RequestColumnId, RequestColumnDefinition>(
  REQUEST_COLUMNS.map((c) => [c.id, c]),
);

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
  if (typeof raw !== 'object' || raw === null) return {};
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

/**
 * buildGridTemplateColumns constructs the CSS grid-template-columns specification
 * for the 11 data columns plus the fixed selection and action chevron tracks.
 * If a column has a manual override, it renders as a fixed pixel track (e.g. 210px).
 * If no override exists and flexGrow > 0, it renders as minmax(minWidth, flexGrow fr) for adaptive sizing.
 * If no override exists and flexGrow === 0, it renders as defaultWidth px.
 */
export function buildGridTemplateColumns(
  widths: RequestColumnWidths = {},
  chrome: RequestGridChrome = LIST_GRID_CHROME,
): string {
  const tracks = REQUEST_COLUMNS.map((col) => {
    const manualWidth = widths[col.id];
    if (manualWidth !== undefined && Number.isFinite(manualWidth)) {
      const clamped = Math.min(col.maxWidth, Math.max(col.minWidth, manualWidth));
      return `${Math.round(clamped)}px`;
    }
    if (col.flexGrow > 0) {
      return `minmax(${col.minWidth}px, ${col.flexGrow}fr)`;
    }
    return `${col.defaultWidth}px`;
  });

  if (chrome.hasSelection) tracks.unshift(`${SELECT_TRACK_WIDTH}px`);
  if (chrome.hasChevron) tracks.push(`${CHEVRON_TRACK_WIDTH}px`);
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
): number {
  const total = REQUEST_COLUMNS.reduce((sum, col) => {
    const manual = widths[col.id];
    if (manual !== undefined && Number.isFinite(manual)) {
      return sum + Math.min(col.maxWidth, Math.max(col.minWidth, manual));
    }
    return sum + (col.flexGrow > 0 ? col.minWidth : col.defaultWidth);
  }, 0);
  const fixedTracks = [
    chrome.hasSelection ? SELECT_TRACK_WIDTH : null,
    chrome.hasChevron ? CHEVRON_TRACK_WIDTH : null,
  ].filter((width): width is number => width !== null);
  // One gap between each pair of neighbouring tracks, data and fixed alike.
  const gaps = (REQUEST_COLUMNS.length + fixedTracks.length - 1) * gap;
  const fixed = fixedTracks.reduce((sum, width) => sum + width, 0);
  return Math.round(total + fixed + gaps + paddingInline * 2);
}




