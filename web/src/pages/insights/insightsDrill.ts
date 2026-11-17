/**
 * Where the Insights page leaves to: the request list behind a view, and a spreadsheet of it.
 *
 * Both are built from what the page already holds - the cube's resolved window and the reader's
 * filters - so the list opens on the records the figures summed and the file carries only what the
 * page displayed. Pure, so their escaping and vocabulary are asserted without a browser.
 */

import {
  anatomyCacheRate,
  filterRows,
  measuresAvgTtftMs,
  metricValue,
  rowValue,
  type InsightsCube,
  type InsightsFilters,
  type Measures,
  type TokenAnatomy,
} from '../../types/insightsCube';
import type { InsightsWindow } from '../../types/insights';
import { MAX_USAGE_EVENT_FILTER_VALUES } from '../../types/usageEvents';
import { requestFilterValues } from './insightsViewState';

/**
 * The request-list link for a view. The window is the one the server resolved, so a calendar
 * preset opens on the same instants; a window that follows the clock keeps following it. Filters
 * are spelled in the list's vocabulary (`readEventQuery`): a connection becomes the credentials that
 * served it, a key its group identity - a client-key fingerprint, or the label of traffic that carried
 * none - and a client program its normalised identifier. A read of its own (the client ranking) may
 * pass the window it was answered for. The `other` bucket names no one program, so
 * it adds no client filter.
 */
export function usageEventsHref(
  cube: InsightsCube,
  filters: InsightsFilters,
  clientAgent?: string,
  windowOverride?: InsightsWindow,
): string {
  const window = windowOverride ?? cube.window;
  const params = new URLSearchParams();
  params.set('from', String(window.from));
  if (!window.open_end) params.set('to', String(window.to));
  // One program's records replace the page's client filter rather than adding to it.
  const client = clientAgent?.trim();
  const scoped = client ? { ...filters, client: undefined } : filters;
  // A chosen key stays chosen even where this window never saw it: the list then opens empty, as
  // the page reads zero, rather than dropping the filter and listing everyone.
  for (const [name, values] of drillFilters(cube, scoped)) {
    for (const value of values) params.append(name, value);
  }
  if (client && client !== 'other') params.append('client_agent', client);
  return `/usage/events?${params.toString()}`;
}

/** A filter's values as the request list reads them: trimmed, each once, none blank. */
export function cleanValues(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

/** The request list's multi-value filters for a view, in its vocabulary. */
function drillFilters(cube: InsightsCube, filters: InsightsFilters): Array<readonly [string, string[]]> {
  const request = requestFilterValues(cube, filters);
  return [
    ['api_key', cleanValues(filters.key)],
    ['model_alias', cleanValues(filters.call_point)],
    ['model', cleanValues(filters.model)],
    ['provider', cleanValues(request.provider)],
    ['auth_index', cleanValues(request.credential)],
    ['client_agent', cleanValues(filters.client)],
  ];
}

/**
 * Whether the request list can open on exactly the page's records. It cannot past the server's
 * ceiling on one filter, and it cannot when a connection became the credentials that served it while
 * the view also holds its traffic that named no credential: the list has no "these credentials or
 * none" filter. Such a link is withheld rather than opened on fewer records than the page sums.
 */
export function canDrillUsageEvents(cube: InsightsCube, filters: InsightsFilters): boolean {
  const drill = drillFilters(cube, filters);
  if (drill.some(([, values]) => values.length > MAX_USAGE_EVENT_FILTER_VALUES)) return false;
  const isConvertedConnection = cleanValues(filters.provider).length > 0
    && cleanValues(filters.credential).length === 0
    && cleanValues(requestFilterValues(cube, filters).provider).length === 0;
  return !isConvertedConnection || filterRows(cube, cube.rows, filters).every((row) => rowValue(cube, row, 'credential') !== '');
}

/** One exported line: a key or a model, named as the page names it. */
export interface ExportEntity {
  dimension: string;
  name: string;
  /** The key's mask under its alias, a credential's provider; never the secret itself. */
  detail: string;
  measures: Measures;
  anatomy: TokenAnatomy;
}

/** Leading characters a spreadsheet would evaluate as a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * One CSV cell. Text is always quoted; text a spreadsheet would read as a formula - including after
 * leading blanks - is defused with a leading apostrophe first.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = FORMULA_LEAD.test(value) || FORMULA_LEAD.test(value.trimStart()) ? `'${value}` : value;
  return `"${text.replace(/"/g, '""')}"`;
}

const round = (value: number | null) => (value === null ? null : Math.round(value));

function entityCells(entity: ExportEntity): Array<string | number | null> {
  const { measures, anatomy } = entity;
  const cacheRate = anatomyCacheRate(anatomy);
  const cost = metricValue(measures, 'cost');
  return [
    entity.dimension,
    entity.name,
    entity.detail,
    measures.requests,
    measures.failures,
    anatomy.uncachedInput,
    anatomy.cacheRead,
    anatomy.cacheWrite,
    anatomy.regularOutput,
    anatomy.reasoningOutput,
    measures.totalTokens,
    anatomy.netTokens,
    cacheRate === null ? null : Number(cacheRate.toFixed(1)),
    round(measuresAvgTtftMs(measures)),
    round(metricValue(measures, 'latency')),
    cost === null ? null : Number(cost.toFixed(6)),
  ];
}

/** The export: a UTF-8 BOM so spreadsheet apps read the names right, a header, one line per entity. */
export function insightsCsv(header: readonly string[], entities: readonly ExportEntity[]): string {
  const lines = [header.map(csvCell).join(','), ...entities.map((entity) => entityCells(entity).map(csvCell).join(','))];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
