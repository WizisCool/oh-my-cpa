import type { TFunc } from '../../i18n';
import type { QuotaCapacityUnavailableReason, QuotaWindow } from '../../types/quota';
import { formatUsd, nanosToUsd } from '../../types/pricingDisplay';
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

/** "±2.5%", without a trailing ".0" for a whole number. */
export function formatCapacityError(errorPercent: number): string {
  return `±${Number(errorPercent.toFixed(1))}%`;
}

const REASON_KEYS: Record<QuotaCapacityUnavailableReason, string | null> = {
  boundary_unknown: 'quota.capacity_reason_boundary_unknown',
  expired: 'quota.capacity_reason_expired',
  stale: 'quota.capacity_reason_stale',
  // No used share means the bar itself is empty; a second line saying so adds nothing.
  no_reading: null,
  low_usage: 'quota.capacity_reason_low_usage',
  no_traffic: 'quota.capacity_reason_no_traffic',
  reset_mid_cycle: 'quota.capacity_reason_reset_mid_cycle',
};

export interface QuotaCapacityReading {
  /** What was recorded in the cycle, e.g. "$1.20 · 480K tokens"; null when nothing was. */
  recorded: string | null;
  /** The estimate, e.g. "≈ $24 · 9.6M tokens"; null when it is withheld. */
  estimate: string | null;
  /** The estimate's uncertainty, e.g. "±10%". */
  error: string | null;
  /** Why the estimate is withheld, already localized. */
  note: string | null;
}

/**
 * The Drawer's reading of a window's recorded usage and estimated capacity. Returns null for a
 * window the estimate does not apply to, so the caller renders no line at all.
 */
export function describeQuotaCapacity(
  window: CapacityWindow,
  tokenStyle: TokenNumberStyle,
  t: TFunc,
): QuotaCapacityReading | null {
  const { usage, capacity, capacity_unavailable: reason } = window;
  if (!usage && !capacity && !reason) return null;

  const tokens = (count: number) => t('quota.capacity_tokens', { n: formatTokens(count, tokenStyle) });

  let recorded: string | null = null;
  if (usage && usage.requests > 0) {
    const parts: string[] = [];
    if (usage.priced_requests > 0) parts.push(formatUsd(nanosToUsd(usage.cost_nanos)));
    parts.push(tokens(usage.tokens));
    // A partly priced cycle's cost is a floor, and the share says how much of one.
    if (usage.priced_requests > 0 && usage.priced_requests < usage.requests) {
      parts.push(t('quota.capacity_priced_share', { percent: Math.floor((usage.priced_requests / usage.requests) * 100) }));
    }
    recorded = parts.join(' · ');
  }

  let estimate: string | null = null;
  let error: string | null = null;
  if (capacity) {
    const parts: string[] = [];
    if (capacity.cost_nanos != null) parts.push(formatEstimatedUsd(capacity.cost_nanos / 1_000_000_000, capacity.error_percent));
    parts.push(tokens(capacity.tokens));
    estimate = `≈ ${parts.join(' · ')}`;
    error = formatCapacityError(capacity.error_percent);
  }

  const reasonKey = !capacity && reason ? REASON_KEYS[reason] : null;
  const note = reasonKey ? t(reasonKey) : null;

  if (!recorded && !estimate && !note) return null;
  return { recorded, estimate, error, note };
}

/**
 * The list row's reading: the estimate alone, in its shortest form. A row has no room for the
 * recorded usage or for a reason, both of which the Drawer carries.
 */
export function compactQuotaCapacity(window: CapacityWindow, tokenStyle: TokenNumberStyle, t: TFunc): string | null {
  const { capacity } = window;
  if (!capacity) return null;
  if (capacity.cost_nanos != null) {
    return `≈${formatEstimatedUsd(capacity.cost_nanos / 1_000_000_000, capacity.error_percent)}`;
  }
  return `≈${t('quota.capacity_tokens', { n: formatTokens(capacity.tokens, tokenStyle) })}`;
}
