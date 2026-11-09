import type { MessageKey } from '../../i18n/catalog';
import type { TFunc } from '../../i18n';
import type { QuotaCapacityUnavailableReason, QuotaWindow, QuotaWindowUsage } from '../../types/quota';
import { formatUsd } from '../../types/pricingDisplay';
import { formatTokens, type TokenNumberStyle } from '../../types/tokenDisplay';

type CapacityWindow = Pick<QuotaWindow, 'usage' | 'capacity' | 'capacity_unavailable'>;

/**
 * An estimate rounded to the digits its uncertainty supports. The figure is a division by a
 * share upstream rounds to whole points, so "$123.46" would print four digits the reading
 * cannot back; two significant digits are all a ±5% estimate carries, three below that.
 * Amounts under a hundred dollars keep the two decimals money is read in.
 */
export function formatEstimatedUsd(usd: number, errorPercent: number): string {
  if (!Number.isFinite(usd)) return '—';
  const digits = errorPercent >= 5 ? 2 : 3;
  const rounded = Number(usd.toPrecision(digits));
  if (rounded >= 100) return `$${rounded.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (rounded >= 1) return `$${rounded.toFixed(2)}`;
  return `$${rounded.toLocaleString('en-US', { maximumSignificantDigits: digits })}`;
}

// No used share leaves the bar itself empty; a second line saying so adds nothing.
const REASON_KEYS: Record<QuotaCapacityUnavailableReason, MessageKey | null> = {
  scope_unknown: 'quota.capacity_reason_scope_unknown',
  history_unavailable: 'quota.capacity_reason_history_unavailable',
  usage_unavailable: 'quota.capacity_reason_usage_unavailable',
  boundary_unknown: 'quota.capacity_reason_boundary_unknown',
  expired: 'quota.capacity_reason_expired',
  no_reading: null,
  low_usage: 'quota.capacity_reason_low_usage',
  no_traffic: 'quota.capacity_reason_no_traffic',
  reset_mid_cycle: 'quota.capacity_reason_reset_mid_cycle',
};

/** The share of requests that must be priced before a cost is stated; the server's rule too. */
const MIN_PRICED_SHARE = 0.95;

const NANOS_PER_USD = 1_000_000_000;

/** An amount in the reader's terms: its cost with the tokens beside it, or the tokens alone. */
export interface CapacityFigure {
  value: string;
  tokens: string | null;
}

export interface QuotaCapacityReading {
  /** The whole window's estimated size; null when there is no estimate yet. */
  capacity: CapacityFigure | null;
  /** What this gateway recorded in the cycle, shown while there is no estimate. */
  recorded: CapacityFigure | null;
  /** Why there is no estimate yet, already localized. */
  note: string | null;
}

/** "≈ $987 (196M tokens)": one line for a tooltip. */
export function formatCapacityFigure(amount: CapacityFigure, t: TFunc): string {
  return amount.tokens ? t('quota.capacity_figure', { value: amount.value, tokens: amount.tokens }) : amount.value;
}

/**
 * The reading of a window's estimate: its whole size, or what was recorded and why there is no
 * estimate yet. Returns null for a window the estimate does not apply to.
 *
 * What is left of the window is not stated even when the server derives it: the bar already shows
 * the remaining share, and a second, derived figure beside it read as a separate promise.
 */
export function describeQuotaCapacity(window: CapacityWindow, tokenStyle: TokenNumberStyle, t: TFunc): QuotaCapacityReading | null {
  const { usage, capacity, capacity_unavailable: reason } = window;
  const tokens = (count: number) => t('quota.capacity_tokens', { n: formatTokens(count, tokenStyle) });
  const estimate = (costNanos: number | undefined, tokenCount: number): CapacityFigure => costNanos == null
    ? { value: `≈ ${tokens(tokenCount)}`, tokens: null }
    : { value: `≈ ${formatEstimatedUsd(costNanos / NANOS_PER_USD, capacity?.error_percent ?? 0)}`, tokens: tokens(tokenCount) };

  const whole = capacity ? estimate(capacity.cost_nanos, capacity.tokens) : null;
  const recorded = !whole && usage && usage.requests > 0 ? recordedFigure(usage, tokenStyle, t) : null;
  const reasonKey = !capacity && reason ? REASON_KEYS[reason] : null;
  const note = reasonKey ? t(reasonKey) : null;

  if (!whole && !recorded && !note) return null;
  return { capacity: whole, recorded, note };
}

/** The list row's reading in its shortest form: the window's estimated size. The Drawer carries the rest. */
export function compactQuotaCapacity(window: CapacityWindow, tokenStyle: TokenNumberStyle, t: TFunc): string | null {
  const { capacity } = window;
  if (!capacity) return null;
  if (capacity.cost_nanos != null) return `≈${formatEstimatedUsd(capacity.cost_nanos / NANOS_PER_USD, capacity.error_percent)}`;
  return `≈${t('quota.capacity_tokens', { n: formatTokens(capacity.tokens, tokenStyle) })}`;
}

/** The same estimate as a tooltip line, with its tokens beside a cost. */
export function describeCompactQuotaCapacity(window: CapacityWindow, tokenStyle: TokenNumberStyle, t: TFunc): string | null {
  const reading = describeQuotaCapacity(window, tokenStyle, t);
  if (!reading?.capacity) return null;
  return `${t('quota.capacity_estimate')} ${formatCapacityFigure(reading.capacity, t)}`;
}

/** What a cycle recorded: its cost with the tokens beside it, or the tokens alone when too much is unpriced. */
export function recordedFigure(usage: QuotaWindowUsage, tokenStyle: TokenNumberStyle, t: TFunc): CapacityFigure {
  const tokens = t('quota.capacity_tokens', { n: formatTokens(usage.tokens, tokenStyle) });
  return usage.priced_requests >= usage.requests * MIN_PRICED_SHARE
    ? { value: formatUsd(usage.cost_nanos / NANOS_PER_USD), tokens }
    : { value: tokens, tokens: null };
}
