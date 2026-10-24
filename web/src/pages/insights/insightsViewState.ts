/**
 * The Insights page's view, kept in the URL.
 *
 * What the reader narrowed, grouped and measured is part of the link: an operator can send a colleague
 * "this key's spend by model, this week" and it opens as it was. The window is the exception - it is a
 * stored preference, like the dashboard's, so the page reopens on the span it was left at.
 */

import { INSIGHTS_BUCKETS, type InsightsBucketChoice } from '../../types/insights';
import { INSIGHTS_DIMENSIONS, INSIGHTS_METRICS, type InsightsDimension, type InsightsFilters, type InsightsMetric } from './insightsCube';

/** What the trend stacks by; `none` draws the whole selection as one series. */
export type InsightsGrouping = 'key' | 'model' | 'provider' | 'credential' | 'none';
export const INSIGHTS_GROUPINGS: readonly InsightsGrouping[] = ['model', 'key', 'provider', 'credential', 'none'];

export interface InsightsViewState {
  metric: InsightsMetric;
  grouping: InsightsGrouping;
  bucket: InsightsBucketChoice;
  isComparing: boolean;
  filters: InsightsFilters;
}

export const DEFAULT_INSIGHTS_VIEW: InsightsViewState = {
  metric: 'tokens', grouping: 'model', bucket: 'auto', isComparing: true, filters: {},
};

function oneOf<T extends string>(values: readonly T[], raw: string | null, fallback: T): T {
  return raw !== null && (values as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

export function readInsightsView(search: URLSearchParams): InsightsViewState {
  const filters: InsightsFilters = {};
  for (const dimension of INSIGHTS_DIMENSIONS) {
    const values = search.getAll(dimension).filter(Boolean);
    if (values.length > 0) filters[dimension] = [...new Set(values)];
  }
  return {
    metric: oneOf(INSIGHTS_METRICS, search.get('metric'), DEFAULT_INSIGHTS_VIEW.metric),
    grouping: oneOf(INSIGHTS_GROUPINGS, search.get('group'), DEFAULT_INSIGHTS_VIEW.grouping),
    bucket: oneOf(INSIGHTS_BUCKETS, search.get('bucket'), DEFAULT_INSIGHTS_VIEW.bucket),
    isComparing: search.get('compare') !== 'off',
    filters,
  };
}

/** Writes a view back, leaving defaults out so a plain link stays plain. */
export function writeInsightsView(view: InsightsViewState): URLSearchParams {
  const search = new URLSearchParams();
  if (view.metric !== DEFAULT_INSIGHTS_VIEW.metric) search.set('metric', view.metric);
  if (view.grouping !== DEFAULT_INSIGHTS_VIEW.grouping) search.set('group', view.grouping);
  if (view.bucket !== DEFAULT_INSIGHTS_VIEW.bucket) search.set('bucket', view.bucket);
  if (!view.isComparing) search.set('compare', 'off');
  for (const dimension of INSIGHTS_DIMENSIONS) {
    for (const value of view.filters[dimension] ?? []) search.append(dimension, value);
  }
  return search;
}

/** Adds or removes one value of one dimension's filter. */
export function toggleFilter(filters: InsightsFilters, dimension: InsightsDimension, value: string): InsightsFilters {
  const current = filters[dimension] ?? [];
  const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
  const result = { ...filters };
  if (next.length > 0) result[dimension] = next;
  else delete result[dimension];
  return result;
}

export function hasFilters(filters: InsightsFilters): boolean {
  return INSIGHTS_DIMENSIONS.some((dimension) => (filters[dimension]?.length ?? 0) > 0);
}
