import type { MessageKey } from '../../i18n/catalog';
import type { TFunc } from '../../i18n';
import { resolveCacheRateReadout } from '../../theme/cacheScale';
import { currencyReadout } from '../../types/currencyDisplay';
import type {
  QuotaCapacityCycle,
  QuotaCapacityUnavailableReason,
  QuotaItem,
  QuotaPlan,
  QuotaSubscriptionProjectionUnavailableReason,
  QuotaWindow,
  QuotaWindowCapacity,
} from '../../types/quota';
import { formatUsd } from '../../types/pricingDisplay';
import type { RollingReadout } from '../../types/rollingNumber';
import {
  formatTokens,
  resolveCountFlowReadout,
  resolveTokenFlowReadout,
  type TokenNumberStyle,
} from '../../types/tokenDisplay';

/** Stored request amounts retain their API-equivalent pricing basis. */
const NANOS_PER_USD = 1_000_000_000;

function withPrefix(readout: RollingReadout | undefined, prefix: string): RollingReadout | undefined {
  return readout ? { ...readout, prefix: `${prefix}${readout.prefix ?? ''}` } : undefined;
}

const REASON_KEYS: Record<QuotaCapacityUnavailableReason, MessageKey | null> = {
  scope_unknown: 'quota.capacity_reason_scope_unknown',
  history_unavailable: 'quota.capacity_reason_history_unavailable',
  usage_unavailable: 'quota.capacity_reason_usage_unavailable',
  boundary_unknown: 'quota.capacity_reason_boundary_unknown',
  expired: 'quota.capacity_reason_expired',
  no_reading: 'quota.capacity_reason_no_reading',
  low_usage: 'quota.capacity_reason_low_usage',
  no_traffic: 'quota.capacity_reason_no_traffic',
  reset_mid_cycle: 'quota.capacity_reason_reset_mid_cycle',
};

export function quotaCapacityNote(reason: QuotaCapacityUnavailableReason | undefined, t: TFunc): string | null {
  const key = reason ? REASON_KEYS[reason] : null;
  return key ? t(key) : null;
}

const SUBSCRIPTION_REASON_KEYS: Record<QuotaSubscriptionProjectionUnavailableReason, MessageKey> = {
  no_traffic: 'quota.capacity_reason_no_traffic',
  insufficient_elapsed: 'quota.subscription_reason_insufficient_elapsed',
  usage_unavailable: 'quota.capacity_reason_usage_unavailable',
};

export function subscriptionProjectionNote(
  reason: QuotaSubscriptionProjectionUnavailableReason | undefined,
  t: TFunc,
): string | null {
  return reason ? t(SUBSCRIPTION_REASON_KEYS[reason]) : null;
}

type SubscriptionPeriodPlan = Pick<QuotaPlan, 'starts_at_ms' | 'expires_at_ms' | 'expires_source' | 'billing_period'>;

/**
 * Returns a stable cache identity for the credential's verified upstream
 * subscription billing period covering `nowMS`, or `null` when unavailable.
 */
export function activeSubscriptionPeriodKey(
  plan: SubscriptionPeriodPlan | undefined,
  nowMS: number,
): string | null {
  if (!plan || plan.expires_source === 'credential_snapshot') return null;
  const start = plan.starts_at_ms;
  const end = plan.expires_at_ms;
  if (start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start <= 0 || start > nowMS || nowMS >= end) return null;
  return `${start}:${end}:${plan.billing_period ?? ''}`;
}

/**
 * Returns the verified active subscription billing-period identity for an
 * observed, non-error quota reading, or `null` when unavailable.
 */
export function quotaSubscriptionPeriodKey(
  item: (Pick<QuotaItem, 'auth_index' | 'observed_at_ms' | 'status'> & { plan?: SubscriptionPeriodPlan }) | undefined,
  nowMS: number,
): string | null {
  if (!item || !item.auth_index || item.observed_at_ms <= 0 || item.status === 'idle' || item.status === 'error') {
    return null;
  }
  return activeSubscriptionPeriodKey(item.plan, nowMS);
}

/**
 * True only when the credential carries verified upstream start and expiry
 * instants covering `nowMS`.
 */
export function hasActiveSubscriptionPeriod(
  plan: SubscriptionPeriodPlan | undefined,
  nowMS: number,
): boolean {
  return activeSubscriptionPeriodKey(plan, nowMS) !== null;
}

/** Subscription billing-cycle tab requires verified billing boundaries and a plan-level window. */
export function supportsSubscriptionCycleTab(
  window: Pick<QuotaWindow, 'scope'> | undefined,
  hasSubscriptionCycle: boolean,
): boolean {
  return hasSubscriptionCycle && (window == null || window.scope === 'standard');
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
  if (usage.requests > 0 && usage.priced_requests === usage.requests) {
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

function capacityCostReading(capacity: QuotaWindowCapacity, t: TFunc): Pick<CycleCardFigures, 'cost' | 'costReadout' | 'costHint'> {
  if (capacity.cost_nanos == null || !Number.isFinite(capacity.cost_nanos)) {
    return { cost: null, costReadout: undefined, costHint: null };
  }
  const nanos = Math.max(0, capacity.cost_nanos);
  const usd = nanos / NANOS_PER_USD;
  const priced = capacity.sample_priced_requests;
  const isPartial = priced != null && priced < capacity.sample_requests;
  if (!isPartial) {
    return {
      cost: nanos === 0 ? formatUsd(0) : `≈ ${formatUsd(usd)}`,
      costReadout: withPrefix(currencyReadout(usd), nanos > 0 ? '≈ ' : ''),
      costHint: null,
    };
  }
  if (priced > 0 && nanos > 0) {
    return {
      cost: `≥ ${formatUsd(usd)}`,
      costReadout: withPrefix(currencyReadout(usd), '≥ '),
      costHint: t('quota.capacity_partial_priced_hint', {
        priced: priced.toLocaleString(),
        total: capacity.sample_requests.toLocaleString(),
      }),
    };
  }
  return { cost: null, costReadout: undefined, costHint: null };
}

/** Compact reading shown beside a quota bar when an estimated full-window capacity is available. */
export function compactQuotaCapacity(
  window: Pick<QuotaWindow, 'capacity'>,
  tokenStyle: TokenNumberStyle,
  t: TFunc,
): string | null {
  const { capacity } = window;
  if (!capacity) return null;
  const { cost } = capacityCostReading(capacity, t);
  if (cost) return cost;
  const tokens = Math.max(0, Math.round(capacity.tokens));
  return tokens === 0 ? t('quota.capacity_open_details') : `≈ ${formatTokens(tokens, tokenStyle)}`;
}

/** Formats estimated full-window cost, requests, tokens, and cache rate for the capacity card. */
export function describeCapacityCard(
  capacity: QuotaWindowCapacity | null,
  tokenStyle: TokenNumberStyle,
  t: TFunc,
): CycleCardFigures {
  if (!capacity) return EMPTY_CYCLE_FIGURES;
  const requests = Math.max(0, Math.round(capacity.requests));
  const tokens = Math.max(0, Math.round(capacity.tokens));
  return {
    ...capacityCostReading(capacity, t),
    requests: requests === 0 ? '0' : `≈ ${requests.toLocaleString()}`,
    requestsReadout: withPrefix(resolveCountFlowReadout(requests), requests > 0 ? '≈ ' : ''),
    tokens: tokens === 0 ? '0' : `≈ ${formatTokens(tokens, tokenStyle)}`,
    tokensReadout: withPrefix(resolveTokenFlowReadout(tokens, tokenStyle), tokens > 0 ? '≈ ' : ''),
    cacheRate: capacity.cache_rate,
    cacheRateReadout: resolveCacheRateReadout(capacity.cache_rate),
  };
}
