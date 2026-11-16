/**
 * Where the Insights page leaves to: the request list behind a view, and a spreadsheet of it.
 *
 * Both are built from what the page already holds - the cube's resolved window and the reader's
 * filters - so the list opens on the records the figures summed and the file carries only what the
 * page displayed. Pure, so their escaping and vocabulary are asserted without a browser.
 */

import {
  anatomyCacheRate,
  measuresAvgTtftMs,
  metricValue,
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
  // A chosen key stays chosen even where this window never saw it: the list then opens empty, as
  // the page reads zero, rather than dropping the filter and listing everyone.
  for (const id of keyGroups(filters)) params.append('api_key', id);
  for (const value of filters.call_point ?? []) params.append('model_alias', value);
  for (const value of filters.model ?? []) params.append('model', value);
  const request = requestFilterValues(cube, filters);
  for (const value of request.provider) params.append('provider', value);
  for (const value of request.credential) params.append('auth_index', value);
  const client = clientAgent?.trim();
  if (client && client !== 'other') params.append('client_agent', client);
  return `/usage/events?${params.toString()}`;
}

function keyGroups(filters: InsightsFilters): string[] {
  return [...new Set((filters.key ?? []).map((id) => id.trim()).filter(Boolean))];
}

/**
 * Whether the request list can open on a view: every filter it would carry fits the server's ceiling.
 * Past it the link is withheld rather than cut short, so it never opens on a wider list than the page.
 */
export function canDrillUsageEvents(cube: InsightsCube, filters: InsightsFilters): boolean {
  const request = requestFilterValues(cube, filters);
  return [keyGroups(filters), filters.call_point ?? [], filters.model ?? [], request.provider, request.credential]
    .every((values) => values.length <= MAX_USAGE_EVENT_FILTER_VALUES);
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
