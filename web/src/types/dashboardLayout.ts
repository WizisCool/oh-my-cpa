import type { MessageKey } from '../i18n/catalog';
/**
 * The dashboard as a set of widgets, and the operator's arrangement of them.
 *
 * The page ships a fixed catalog - the six KPI tiles, the two model panels, the live routing map,
 * the activity grid, credential quota and the provider list - but which of them a deployment reads,
 * in what order and how wide is not fixed: an operator who never prices anything has no use for the
 * spend tile, and one who runs a single credential has no use for the quota list beside the grid.
 * The model lives here rather than in the page so every rule about a stored arrangement is a pure
 * function the logic suite can pin without a browser.
 *
 * The stored document lists every widget it knows with its width, its height and whether it is
 * hidden. A widget
 * a later release adds is not in an older document, and it is placed where the default arrangement
 * puts it - after the widget that precedes it there - and shown, so a new panel never arrives
 * switched off.
 */

/** Columns of the dashboard board on a wide viewport. Narrower viewports collapse spans in CSS. */
export const DASHBOARD_COLUMNS = 4;

/**
 * The board's rows: a widget is a whole number of them tall. A row is a short track and the gap
 * between rows is the board's gap, so one step of height is `ROW + GAP` and a widget `n` rows tall
 * is `n * ROW + (n - 1) * GAP`. Short rows make a fine step, so a height can follow the content.
 *
 * A height is the box the widget fills, and it always holds the widget's content: a widget is never
 * given fewer rows than its content needs, so every row stays `ROW` tall and widgets side by side
 * end on the same line. A row still grows if content outgrows its box at a narrower window than the
 * one it was sized at, so nothing is cut off. The phone ignores heights and lets each widget take its
 * content's.
 */
export const DASHBOARD_ROW_PX = 24;
export const DASHBOARD_GAP_PX = 16;
export const DASHBOARD_MAX_ROWS = 24;

/** The fewest rows whose box holds `height` pixels of content. */
export function rowsForHeight(height: number): number {
  // A sub-pixel overshoot from layout rounding is not another row.
  return Math.max(1, Math.ceil((height + DASHBOARD_GAP_PX) / (DASHBOARD_ROW_PX + DASHBOARD_GAP_PX) - 0.02));
}

export type DashboardWidgetSpan = 1 | 2 | 3 | 4;

export type DashboardWidgetId =
  | 'requests'
  | 'tokens'
  | 'rpm'
  | 'tpm'
  | 'cache_rate'
  | 'cost'
  | 'routing'
  | 'model_trend'
  | 'model_usage'
  | 'token_activity'
  | 'credential_quota'
  | 'providers';

export interface DashboardWidgetSpec {
  id: DashboardWidgetId;
  /** The translation key the editor names the widget by. */
  labelKey: MessageKey;
  defaultSpan: DashboardWidgetSpan;
  /** The default height in board rows: the fewest that hold the widget's content on a wide board. */
  defaultRows: number;
  /**
   * The widths the widget reads at, narrowest first. A map that needs its three columns, or a list
   * whose rows carry four readings, is not offered a quarter of the board it cannot use.
   */
  spans: readonly DashboardWidgetSpan[];
  /** A widget a phone does not mount at all, so the phone editor does not list it either. */
  isPhoneOmitted?: boolean;
  /** True for the six KPI tiles, which read the page's own window response. */
  isMetric?: boolean;
}

const ANY_SPAN: readonly DashboardWidgetSpan[] = [1, 2, 3, 4];
const HALF_OR_WIDER: readonly DashboardWidgetSpan[] = [2, 3, 4];

/** The catalog, in the default reading order. */
export const DASHBOARD_WIDGETS: readonly DashboardWidgetSpec[] = Object.freeze([
  { id: 'requests', labelKey: 'dash.total_requests', defaultSpan: 2, defaultRows: 7, spans: ANY_SPAN, isMetric: true },
  { id: 'tokens', labelKey: 'dash.total_tokens', defaultSpan: 2, defaultRows: 7, spans: ANY_SPAN, isMetric: true },
  { id: 'rpm', labelKey: 'dash.rpm', defaultSpan: 1, defaultRows: 7, spans: ANY_SPAN, isMetric: true },
  { id: 'tpm', labelKey: 'dash.tpm', defaultSpan: 1, defaultRows: 7, spans: ANY_SPAN, isMetric: true },
  { id: 'cache_rate', labelKey: 'dash.cache_rate', defaultSpan: 1, defaultRows: 7, spans: ANY_SPAN, isMetric: true },
  { id: 'cost', labelKey: 'dash.total_cost', defaultSpan: 1, defaultRows: 7, spans: ANY_SPAN, isMetric: true },
  { id: 'model_trend', labelKey: 'dash.models.trend_title', defaultSpan: 2, defaultRows: 12, spans: HALF_OR_WIDER },
  { id: 'model_usage', labelKey: 'dash.models.usage_title', defaultSpan: 2, defaultRows: 12, spans: HALF_OR_WIDER },
  { id: 'routing', labelKey: 'routing.title', defaultSpan: 4, defaultRows: 8, spans: [3, 4], isPhoneOmitted: true },
  { id: 'token_activity', labelKey: 'dash.heatmap.title', defaultSpan: 2, defaultRows: 7, spans: HALF_OR_WIDER },
  { id: 'credential_quota', labelKey: 'dash.quota.title', defaultSpan: 2, defaultRows: 7, spans: HALF_OR_WIDER },
  { id: 'providers', labelKey: 'dash.providers', defaultSpan: 4, defaultRows: 3, spans: HALF_OR_WIDER },
] satisfies DashboardWidgetSpec[]);

const SPEC_BY_ID: ReadonlyMap<string, DashboardWidgetSpec> = new Map(DASHBOARD_WIDGETS.map((spec) => [spec.id, spec]));

export function dashboardWidgetSpec(id: DashboardWidgetId): DashboardWidgetSpec {
  return SPEC_BY_ID.get(id)!;
}

export function isDashboardWidgetId(value: unknown): value is DashboardWidgetId {
  return typeof value === 'string' && SPEC_BY_ID.has(value);
}

export interface DashboardLayoutItem {
  id: DashboardWidgetId;
  span: DashboardWidgetSpan;
  /** Height in board rows, `1..DASHBOARD_MAX_ROWS`. */
  rows: number;
  hidden: boolean;
}

/** Every catalog widget exactly once, in reading order. */
export type DashboardLayout = readonly DashboardLayoutItem[];

/** The stored preference key holding the arrangement. */
export const DASHBOARD_LAYOUT_PREFERENCE = 'omc_dashboard_layout';
/** The display order of rows inside the dashboard's lists, one named list per widget. */
export const DASHBOARD_ORDER_PREFERENCE = 'omc_dashboard_order';
/**
 * The provider widget's order, as a rank per row key. A configured provider's key carries its
 * positional id, so the server re-keys this document when a delete or move shifts later entries.
 */
export const DASHBOARD_PROVIDER_ORDER_PREFERENCE = 'dashboard_provider_order';

/** Module-scope so `usePreference` sees one stable fallback reference. */
export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayout = Object.freeze(
  DASHBOARD_WIDGETS.map((spec) => Object.freeze({ id: spec.id, span: spec.defaultSpan, rows: spec.defaultRows, hidden: false })),
);

/** The nearest width the widget offers, so a stored width a release narrowed still lands somewhere sane. */
function fitSpan(spec: DashboardWidgetSpec, span: unknown): DashboardWidgetSpan {
  if (typeof span !== 'number' || !Number.isInteger(span)) return spec.defaultSpan;
  if (spec.spans.includes(span as DashboardWidgetSpan)) return span as DashboardWidgetSpan;
  let nearest = spec.spans[0];
  for (const candidate of spec.spans) {
    if (Math.abs(candidate - span) < Math.abs(nearest - span)) nearest = candidate;
  }
  return nearest;
}

/** A stored height as a whole number of rows; a document written before heights reads the default. */
function fitRows(spec: DashboardWidgetSpec, rows: unknown): number {
  if (typeof rows !== 'number' || !Number.isInteger(rows)) return spec.defaultRows;
  return Math.min(Math.max(rows, 1), DASHBOARD_MAX_ROWS);
}

/**
 * completeDashboardLayout places every catalog widget the given items leave out where the default
 * arrangement puts it: directly after the nearest widget that precedes it there, or first when none
 * does. That is what lets a release add a panel without displacing an arrangement someone made.
 */
function completeDashboardLayout(items: DashboardLayoutItem[]): DashboardLayout {
  const result = [...items];
  const present = new Set(result.map((item) => item.id));
  DASHBOARD_WIDGETS.forEach((spec, defaultIndex) => {
    if (present.has(spec.id)) return;
    let insertAt = 0;
    for (let previous = defaultIndex - 1; previous >= 0; previous -= 1) {
      const anchor = result.findIndex((item) => item.id === DASHBOARD_WIDGETS[previous].id);
      if (anchor >= 0) {
        insertAt = anchor + 1;
        break;
      }
    }
    result.splice(insertAt, 0, { id: spec.id, span: spec.defaultSpan, rows: spec.defaultRows, hidden: false });
    present.add(spec.id);
  });
  return result;
}

/**
 * parseDashboardLayout validates a stored arrangement.
 *
 * The value is JSON the browser wrote, so it is input rather than state: an entry naming no catalog
 * widget is dropped, a repeated one keeps its first position, an unusable width falls back to the
 * nearest one the widget offers, a missing or unusable height reads the widget's default, and anything that is not an array of entries is no arrangement at
 * all - the page then reads the default.
 */
export function parseDashboardLayout(raw: unknown): DashboardLayout | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items: DashboardLayoutItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, span, rows, hidden } = entry as Record<string, unknown>;
    if (!isDashboardWidgetId(id) || seen.has(id)) continue;
    seen.add(id);
    const spec = dashboardWidgetSpec(id);
    items.push({ id, span: fitSpan(spec, span), rows: fitRows(spec, rows), hidden: hidden === true });
  }
  return completeDashboardLayout(items);
}

export type DropSide = 'before' | 'after';

/** Moves `id` next to `targetId`. A drop onto itself, or naming an unknown widget, changes nothing. */
export function moveDashboardWidget(layout: DashboardLayout, id: DashboardWidgetId, targetId: DashboardWidgetId, side: DropSide): DashboardLayout {
  if (id === targetId) return layout;
  const moving = layout.find((item) => item.id === id);
  if (!moving || !layout.some((item) => item.id === targetId)) return layout;
  const rest = layout.filter((item) => item.id !== id);
  const targetIndex = rest.findIndex((item) => item.id === targetId);
  const next = [...rest];
  next.splice(side === 'before' ? targetIndex : targetIndex + 1, 0, moving);
  return next.every((item, index) => item === layout[index]) ? layout : next;
}

/**
 * Steps `id` one place earlier or later among the widgets on screen.
 *
 * Hidden widgets, and the ones this viewport does not mount, keep their places: stepping past one
 * the operator cannot see would look like a control that did nothing.
 */
export function stepDashboardWidget(
  layout: DashboardLayout,
  id: DashboardWidgetId,
  direction: -1 | 1,
  isShown: (item: DashboardLayoutItem) => boolean,
): DashboardLayout {
  const shown = layout.filter(isShown);
  const index = shown.findIndex((item) => item.id === id);
  const neighbour = shown[index + direction];
  if (index < 0 || !neighbour) return layout;
  return moveDashboardWidget(layout, id, neighbour.id, direction < 0 ? 'before' : 'after');
}

export function resizeDashboardWidget(
  layout: DashboardLayout,
  id: DashboardWidgetId,
  size: { span?: DashboardWidgetSpan; rows?: number },
): DashboardLayout {
  const spec = dashboardWidgetSpec(id);
  if (size.span !== undefined && !spec.spans.includes(size.span)) return layout;
  if (size.rows !== undefined && (!Number.isInteger(size.rows) || size.rows < 1 || size.rows > DASHBOARD_MAX_ROWS)) return layout;
  let isChanged = false;
  const next = layout.map((item) => {
    if (item.id !== id) return item;
    const span = size.span ?? item.span;
    const rows = size.rows ?? item.rows;
    if (span === item.span && rows === item.rows) return item;
    isChanged = true;
    return { ...item, span, rows };
  });
  return isChanged ? next : layout;
}

export function setDashboardWidgetHidden(layout: DashboardLayout, id: DashboardWidgetId, hidden: boolean): DashboardLayout {
  return layout.map((item) => (item.id === id && item.hidden !== hidden ? { ...item, hidden } : item));
}

export function sameDashboardLayout(left: DashboardLayout, right: DashboardLayout): boolean {
  return left.length === right.length
    && left.every((item, index) => item.id === right[index].id && item.span === right[index].span
      && item.rows === right[index].rows && item.hidden === right[index].hidden);
}
