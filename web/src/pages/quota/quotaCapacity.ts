import type { MessageKey } from '../../i18n/catalog';
import type { TFunc } from '../../i18n';
import { resolveCacheRateReadout } from '../../theme/cacheScale';
import { currencyReadout } from '../../types/currencyDisplay';
import type {
  QuotaCapacityCycle,
  QuotaCapacityUnavailableReason,
  QuotaModelProjection,
  QuotaWindow,
  QuotaWindowUsage,
} from '../../types/quota';
import { formatUsd } from '../../types/pricingDisplay';
import type { RollingReadout } from '../../types/rollingNumber';
import {
  formatTokens,
  resolveCountFlowReadout,
  resolveTokenFlowReadout,
  type TokenNumberStyle,
} from '../../types/tokenDisplay';

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

export function estimatedUsdReadout(usd: number | undefined, errorPercent: number, approxPrefix = '≈ $'): RollingReadout | undefined {
  if (usd == null || !Number.isFinite(usd)) return undefined;
  if (usd <= 0) {
    return { number: 0, prefix: '$', suffix: '', format: { minimumFractionDigits: 2, maximumFractionDigits: 2 } };
  }
  const digits = errorPercent >= 5 ? 2 : 3;
  const rounded = Number(usd.toPrecision(digits));
  if (rounded >= 100) {
    return { number: Math.round(rounded), prefix: approxPrefix, suffix: '', format: { maximumFractionDigits: 0 } };
  }
  if (rounded >= 1) {
    return { number: rounded, prefix: approxPrefix, suffix: '', format: { minimumFractionDigits: 2, maximumFractionDigits: 2 } };
  }
  return { number: rounded, prefix: approxPrefix, suffix: '', format: { maximumSignificantDigits: digits } };
}

function withPrefix(readout: RollingReadout | undefined, prefix: string): RollingReadout | undefined {
  if (!readout) return undefined;
  return { ...readout, prefix: `${prefix}${readout.prefix ?? ''}` };
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

/** What a cycle recorded: its cost with the tokens beside it, or the tokens alone when too much is unpriced. */
export function recordedFigure(usage: QuotaWindowUsage, tokenStyle: TokenNumberStyle, t: TFunc): CapacityFigure {
  const tokens = t('quota.capacity_tokens', { n: formatTokens(usage.tokens, tokenStyle) });
  return usage.priced_requests >= usage.requests * MIN_PRICED_SHARE
    ? { value: formatUsd(usage.cost_nanos / NANOS_PER_USD), tokens }
    : { value: tokens, tokens: null };
}

export interface CycleCardFigures {
  cost: string | null;
  costReadout?: RollingReadout;
  costHint: string | null;
  requests: string | null;
  requestsReadout?: RollingReadout;
  tokens: string | null;
  tokensReadout?: RollingReadout;
  cacheRate: number | undefined;
  cacheRateReadout?: RollingReadout;
}

export const EMPTY_CYCLE_FIGURES: CycleCardFigures = {
  cost: null,
  costReadout: undefined,
  costHint: null,
  requests: null,
  requestsReadout: undefined,
  tokens: null,
  tokensReadout: undefined,
  cacheRate: undefined,
  cacheRateReadout: undefined,
};

/**
 * Formats one recorded cycle's card figures. When some requests had prices and others did not,
 * the recorded sum is prefixed with "≥" and carries a priced-count hint rather than hiding behind
 * a dash or masquerading as complete.
 */
export function formatCycleCardFigures(cycle: QuotaCapacityCycle | null, tokenStyle: TokenNumberStyle, t: TFunc): CycleCardFigures {
  const usage = cycle?.usage;
  if (!usage) return EMPTY_CYCLE_FIGURES;
  let cost: string | null = null;
  let costReadout: RollingReadout | undefined;
  let costHint: string | null = null;
  const usd = usage.cost_nanos / NANOS_PER_USD;
  if (usage.requests > 0 && usage.priced_requests >= usage.requests * MIN_PRICED_SHARE) {
    cost = formatUsd(usd);
    costReadout = currencyReadout(usd);
  } else if (usage.priced_requests > 0 && usage.cost_nanos > 0) {
    cost = `≥ ${formatUsd(usd)}`;
    costReadout = withPrefix(currencyReadout(usd), '≥ ');
    costHint = t('quota.capacity_partial_priced_hint', {
      priced: usage.priced_requests.toLocaleString(),
      total: usage.requests.toLocaleString(),
    });
  }
  return {
    cost,
    costReadout,
    costHint,
    requests: usage.requests.toLocaleString(),
    requestsReadout: resolveCountFlowReadout(usage.requests),
    tokens: formatTokens(usage.tokens, tokenStyle),
    tokensReadout: resolveTokenFlowReadout(usage.tokens, tokenStyle),
    cacheRate: usage.cache_rate,
    cacheRateReadout: resolveCacheRateReadout(usage.cache_rate),
  };
}

export interface ForecastCardReading {
  figures: CycleCardFigures;
  model: string | null;
}

function formatApproxUsd(nanos: number | undefined, errorPercent: number): string | null {
  if (nanos == null || !Number.isFinite(nanos)) return null;
  if (nanos <= 0) return '$0.00';
  return `≈ ${formatEstimatedUsd(nanos / NANOS_PER_USD, errorPercent)}`;
}

function formatApproxCount(count: number | undefined): string | null {
  if (count == null || !Number.isFinite(count)) return null;
  const rounded = Math.max(0, Math.round(count));
  return rounded === 0 ? '0' : `≈ ${rounded.toLocaleString()}`;
}

function approxCountReadout(count: number | undefined): RollingReadout | undefined {
  if (count == null || !Number.isFinite(count)) return undefined;
  const rounded = Math.max(0, Math.round(count));
  if (rounded === 0) return resolveCountFlowReadout(0);
  return withPrefix(resolveCountFlowReadout(rounded), '≈ ');
}

function formatApproxTokens(count: number | undefined, tokenStyle: TokenNumberStyle): string | null {
  if (count == null || !Number.isFinite(count)) return null;
  const rounded = Math.max(0, Math.round(count));
  return rounded === 0 ? '0' : `≈ ${formatTokens(rounded, tokenStyle)}`;
}

function approxTokenReadout(count: number | undefined, tokenStyle: TokenNumberStyle): RollingReadout | undefined {
  if (count == null || !Number.isFinite(count)) return undefined;
  const rounded = Math.max(0, Math.round(count));
  if (rounded === 0) return resolveTokenFlowReadout(0, tokenStyle);
  return withPrefix(resolveTokenFlowReadout(rounded, tokenStyle), '≈ ');
}

/**
 * Derives the forecast card's figures: the total window budget, requests and tokens for the
 * current period window (with the remaining allowance converted onto the selected or dominant
 * recent model).
 */
export function describeForecastCard(
  window: Pick<QuotaWindow, 'capacity'>,
  currentCycle: QuotaCapacityCycle | null,
  tokenStyle: TokenNumberStyle,
  selectedProjection?: QuotaModelProjection | null,
): ForecastCardReading {
  const { capacity } = window;
  if (!capacity) {
    return {
      figures: EMPTY_CYCLE_FIGURES,
      model: null,
    };
  }
  const projection = selectedProjection ?? capacity.projection;
  const cacheRate = projection?.cache_rate ?? currentCycle?.usage?.cache_rate;
  const totalRequests = projection?.requests ?? capacity.requests;
  const totalTokens = projection?.tokens ?? capacity.tokens;
  const usd = capacity.cost_nanos == null ? undefined : capacity.cost_nanos / NANOS_PER_USD;

  return {
    figures: {
      cost: formatApproxUsd(capacity.cost_nanos, capacity.error_percent),
      costReadout: estimatedUsdReadout(usd, capacity.error_percent),
      costHint: null,
      requests: formatApproxCount(totalRequests),
      requestsReadout: approxCountReadout(totalRequests),
      tokens: formatApproxTokens(totalTokens, tokenStyle),
      tokensReadout: approxTokenReadout(totalTokens, tokenStyle),
      cacheRate,
      cacheRateReadout: resolveCacheRateReadout(cacheRate),
    },
    model: projection?.model ?? null,
  };
}
