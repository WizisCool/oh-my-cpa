/**
 * Response shapes for the dashboard's two model-level panels: the per-model token trend and the
 * model-usage ring.
 *
 * Both read one response, because they are two views of one ranking. A second endpoint would let the
 * trend's lines and the ring's slices disagree about which models exist and in what order, and the
 * colour of a model is assigned from that order.
 */

/** One bucket of one group's token volume. */
export interface DashboardModelPoint {
  /** Bucket start in epoch milliseconds, on the same grid for every group. */
  t: number;
  tokens: number;
}

/**
 * One group: a named model, or the folded remainder.
 *
 * `folded` is a discriminator rather than a reserved name. The panel's label for the remainder is
 * translated, so the API cannot know which string would have to be reserved - and a deployment may
 * legitimately serve a model whose name equals whatever that label is. Grouping by the flag is what
 * keeps such a model out of the remainder.
 */
export interface DashboardModelUsage {
  model: string;
  folded: boolean;
  tokens: number;
  requests: number;
  /**
   * The group's own token volume across the window, zero-filled. Every group's series is the same
   * length and bucket i is the same instant in all of them: a model that went quiet halfway through
   * must draw a line down to the axis rather than a line that stops, which would read as missing data
   * rather than as a model that stopped being used.
   */
  series: DashboardModelPoint[];
}

export interface DashboardModelsResponse {
  window: {
    preset?: string;
    from: number;
    to: number;
    bucket_ms: number;
    minutes: number;
    complete: boolean;
    open_end: boolean;
  };
  /**
   * The window's own token total, summed from the same rows the groups were built from.
   *
   * It is deliberately not the KPI tile's total: these panels read on their own cadence, so the two
   * can legitimately describe slightly different instants, and borrowing the tile's number would let
   * the ring's centre disagree with the slices drawn around it.
   */
  total_tokens: number;
  /** Ranked by token volume, descending, with the folded remainder last when there is one. */
  models: DashboardModelUsage[];
  partial_errors: string[];
}

/**
 * The query key prefix the dashboard's refresh button invalidates.
 *
 * A prefix rather than a full key, for the reason the heatmap's own prefix exists: a refresh that
 * failed must keep the panels that were on screen, and invalidation re-runs the existing entry
 * instead of creating a new one that would have no previous data to hold.
 */
export const DASHBOARD_MODELS_QUERY_KEY = 'dashboard-models';

/**
 * dashboardModelsRefreshMs is the panels' own cadence.
 *
 * A minute, not the tiles' tail cadence. The tiles poll as often as every five seconds because a
 * windowed aggregate visibly moves; a per-model ranking does not - the model list changes when a
 * caller switches models, which is not a second-by-second event - and this read walks the detail rows
 * rather than the rollup, which is the expensive half of what the page does. Polling it at the tail's
 * pace would multiply the page's heaviest query by twelve to redraw a ranking that has not changed.
 */
export const DASHBOARD_MODELS_REFRESH_MS = 60_000;

/**
 * formatModelShare renders a group's share of the window as a percentage.
 *
 * The share is derived here rather than sent by the server so the ring's slices, its centre total and
 * the legend's percentages cannot disagree: all three come from one set of numbers.
 *
 * The precision is chosen against the reading. A share of a few percent is common - a deployment's
 * long tail of models is mostly small numbers - and rounding one to "0%" would state that a model
 * carried nothing, which is a different claim from "very little". So small shares keep a decimal
 * until they are small enough to need two, and a share that rounds to zero is reported as under the
 * smallest step rather than as zero.
 */
export function formatModelShare(tokens: number, total: number): string {
  if (total <= 0) return '—';
  const share = (tokens / total) * 100;
  if (share > 0 && share < 0.05) return '<0.1%';
  if (share < 10) return `${share.toFixed(1)}%`;
  return `${share.toFixed(0)}%`;
}

/**
 * formatModelTokens renders a group's volume compactly.
 *
 * Compact because the legend prints a token count beside a percentage for every entry, and a full
 * seven-digit number there would push the percentage out of the reading column. The tooltip's
 * accessible name carries the exact count, so nothing is lost - it is only rounded where it is
 * scanned rather than read.
 */
const MODEL_TOKEN_FORMAT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

export function formatModelTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return '—';
  return MODEL_TOKEN_FORMAT.format(tokens);
}
