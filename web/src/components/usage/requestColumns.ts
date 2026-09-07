export type RequestColumnId =
  | 'time'
  | 'provider'
  | 'model'
  | 'latency'
  | 'tps'
  | 'tokens'
  | 'cache'
  | 'executor';

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
    defaultWidth: 115,
    minWidth: 95,
    maxWidth: 220,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'provider',
    labelKey: 'events.provider',
    align: 'left',
    defaultWidth: 180,
    minWidth: 130,
    maxWidth: 450,
    flexGrow: 1.3,
    resizable: true,
  },
  {
    id: 'model',
    labelKey: 'events.col_model',
    align: 'left',
    defaultWidth: 160,
    minWidth: 120,
    maxWidth: 450,
    flexGrow: 1.2,
    resizable: true,
  },
  {
    id: 'latency',
    labelKey: 'events.col_latency',
    align: 'right',
    defaultWidth: 85,
    minWidth: 70,
    maxWidth: 160,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'tps',
    labelKey: 'events.col_tps',
    align: 'right',
    defaultWidth: 90,
    minWidth: 75,
    maxWidth: 160,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'tokens',
    labelKey: 'events.col_tokens',
    align: 'right',
    defaultWidth: 140,
    minWidth: 110,
    maxWidth: 240,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'cache',
    labelKey: 'events.col_cache_rate',
    align: 'right',
    defaultWidth: 75,
    minWidth: 60,
    maxWidth: 140,
    flexGrow: 0,
    resizable: true,
  },
  {
    id: 'executor',
    labelKey: 'events.col_executor',
    align: 'left',
    defaultWidth: 105,
    minWidth: 85,
    maxWidth: 220,
    flexGrow: 0,
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
 * for the 8 data columns plus the fixed action chevron track.
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
