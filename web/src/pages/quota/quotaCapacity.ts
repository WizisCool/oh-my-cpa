import type { MessageKey } from '../../i18n/catalog';
import type { TFunc } from '../../i18n';
import { resolveCacheRateReadout } from '../../theme/cacheScale';
import { currencyReadout } from '../../types/currencyDisplay';
import type {
  QuotaCapacityCycle,
  QuotaForecastUnavailableReason,
  QuotaModelForecast,
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

const REASON_KEYS: Record<QuotaForecastUnavailableReason, MessageKey | null> = {
  scope_unknown: 'quota.capacity_reason_scope_unknown',
  history_unavailable: 'quota.capacity_reason_history_unavailable',
  usage_unavailable: 'quota.capacity_reason_usage_unavailable',
  boundary_unknown: 'quota.capacity_reason_boundary_unknown',
  expired: 'quota.capacity_reason_expired',
  no_reading: 'quota.capacity_reason_no_reading',
  low_usage: 'quota.capacity_reason_low_usage',
  mixed_models: 'quota.capacity_reason_mixed_models',
  no_traffic: 'quota.capacity_reason_no_traffic',
  reset_mid_cycle: 'quota.capacity_reason_reset_mid_cycle',
};

export function quotaForecastNote(reason: QuotaForecastUnavailableReason | undefined, t: TFunc): string | null {
  const key = reason ? REASON_KEYS[reason] : null;
  return key ? t(key) : null;
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

export interface ForecastCardReading {
  figures: CycleCardFigures;
  remainingRequests: string | null;
  remainingRequestsReadout?: RollingReadout;
}

/** A forecast contains no money and no model-independent window capacity. */
export function describeForecastCard(forecast: QuotaModelForecast | null, tokenStyle: TokenNumberStyle): ForecastCardReading {
  if (!forecast) return { figures: EMPTY_CYCLE_FIGURES, remainingRequests: null };
  const requests = Math.max(0, Math.floor(forecast.remaining_requests));
  const tokens = Math.max(0, Math.floor(forecast.remaining_tokens));
  return {
    remainingRequests: requests === 0 ? '0' : `≈ ${requests.toLocaleString()}`,
    remainingRequestsReadout: withPrefix(resolveCountFlowReadout(requests), requests > 0 ? '≈ ' : ''),
    figures: {
      ...EMPTY_CYCLE_FIGURES,
      requests: forecast.sample_requests.toLocaleString(),
      requestsReadout: resolveCountFlowReadout(forecast.sample_requests),
      tokens: tokens === 0 ? '0' : `≈ ${formatTokens(tokens, tokenStyle)}`,
      tokensReadout: withPrefix(resolveTokenFlowReadout(tokens, tokenStyle), tokens > 0 ? '≈ ' : ''),
      cacheRate: forecast.cache_rate,
      cacheRateReadout: resolveCacheRateReadout(forecast.cache_rate),
    },
  };
}
