export type RequestColumnId =
  | 'time'
  | 'result'
  | 'provider'
  | 'model'
  | 'latency'
  | 'tps'
  | 'tokens'
  | 'cache'
  | 'executor'
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
    defaultWidth: 100,
    minWidth: 92,
    maxWidth: 220,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'result',
    labelKey: 'events.col_result',
    align: 'left',
    defaultWidth: 92,
    minWidth: 80,
    maxWidth: 140,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'provider',
    labelKey: 'events.provider',
    align: 'left',
    defaultWidth: 180,
    minWidth: 118,
    maxWidth: 460,
    flexGrow: 1.3,
    resizable: true,
  },
  {
    id: 'model',
    labelKey: 'events.col_model',
    align: 'left',
    defaultWidth: 160,
    minWidth: 108,
    maxWidth: 460,
    flexGrow: 1.2,
    resizable: true,
  },
  {
    id: 'latency',
    labelKey: 'events.col_latency',
    align: 'right',
    defaultWidth: 76,
    minWidth: 70,
    maxWidth: 160,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'tps',
    labelKey: 'events.col_tps',
    align: 'right',
    defaultWidth: 82,
    minWidth: 72,
    maxWidth: 160,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'tokens',
    labelKey: 'events.col_tokens',
    align: 'right',
    defaultWidth: 122,
    minWidth: 112,
    maxWidth: 240,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'cache',
    labelKey: 'events.col_cache_rate',
    align: 'right',
    defaultWidth: 64,
    minWidth: 58,
    maxWidth: 140,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'executor',
    labelKey: 'events.col_executor',
    align: 'left',
    defaultWidth: 92,
    minWidth: 84,
    maxWidth: 220,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'key',
    labelKey: 'events.col_key',
    align: 'left',
    // Wide enough for the stored display mask (sk-12345xxxxxxx7890, 19 chars):
    // truncating the tail would hide the part that tells two keys apart, so the
    // minimum is the width the mask needs rather than a squeeze point.
    defaultWidth: 145,
    minWidth: 145,
    maxWidth: 280,
    flexGrow: 0.6,
    resizable: true,
  },
  {
    id: 'ua',
    labelKey: 'events.col_ua',
    align: 'left',
    defaultWidth: 110,
    minWidth: 88,
    maxWidth: 260,
    flexGrow: 0.6,
    resizable: true,
  },
] as const;

export const CHEVRON_TRACK_WIDTH = 14;

export const USAGE_EVENTS_COLUMNS_PREFERENCE = 'usage_events_columns';

export type RequestColumnWidths = Partial<Record<RequestColumnId, number>>;

export const COLUMN_MAP = new Map<RequestColumnId, RequestColumnDefinition>(
  REQUEST_COLUMNS.map((c) => [c.id, c]),
);

/**
 * parseUsageEventsColumns sanitizes column width overrides from preferences or input.
 * Unknown keys are stripped, values are clamped to each column's [minWidth, maxWidth],
 * and non-numbers are dropped.
 */
export function parseUsageEventsColumns(raw: unknown): RequestColumnWidths {
  if (typeof raw !== 'object' || raw === null) return {};
  const obj = raw as Record<string, unknown>;
  const result: RequestColumnWidths = {};

  for (const col of REQUEST_COLUMNS) {
    const val = obj[col.id];
    if (typeof val === 'number' && Number.isFinite(val)) {
      const clamped = Math.round(Math.min(col.maxWidth, Math.max(col.minWidth, val)));
      result[col.id] = clamped;
    }
  }

  return result;
}

/**
 * buildGridTemplateColumns constructs the CSS grid-template-columns specification
 * for the 11 data columns plus the fixed action chevron track.
 * If a column has a manual override, it renders as a fixed pixel track (e.g. 210px).
 * If no override exists and flexGrow > 0, it renders as minmax(minWidth, flexGrow fr) for adaptive sizing.
 * If no override exists and flexGrow === 0, it renders as defaultWidth px.
 */
export function buildGridTemplateColumns(widths: RequestColumnWidths = {}): string {
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

  tracks.push(`${CHEVRON_TRACK_WIDTH}px`);
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
  gap = 12,
  paddingInline = 12,
): number {
  const total = REQUEST_COLUMNS.reduce((sum, col) => {
    const manual = widths[col.id];
    if (manual !== undefined && Number.isFinite(manual)) {
      return sum + Math.min(col.maxWidth, Math.max(col.minWidth, manual));
    }
    return sum + (col.flexGrow > 0 ? col.minWidth : col.defaultWidth);
  }, CHEVRON_TRACK_WIDTH);
  const gaps = REQUEST_COLUMNS.length * gap; // 11 gaps between 12 tracks
  return Math.round(total + gaps + paddingInline * 2);
}
