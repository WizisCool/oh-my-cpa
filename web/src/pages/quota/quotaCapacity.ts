import type { MessageKey } from '../../i18n/catalog';
import type { TFunc } from '../../i18n';
import { resolveCacheRateReadout } from '../../theme/cacheScale';
import { currencyReadout } from '../../types/currencyDisplay';
import type {
  QuotaCapacityCycle,
  QuotaForecastUnavailableReason,
  QuotaModelForecast,
  QuotaWindow,
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

function forecastCostReading(forecast: QuotaModelForecast, t: TFunc): Pick<CycleCardFigures, 'cost' | 'costReadout' | 'costHint'> {
  if (forecast.remaining_cost_nanos == null || !Number.isFinite(forecast.remaining_cost_nanos)) {
    return { cost: null, costReadout: undefined, costHint: null };
  }
  const nanos = Math.max(0, forecast.remaining_cost_nanos);
  const usd = nanos / NANOS_PER_USD;
  const priced = forecast.sample_priced_requests;
  const isPartial = priced != null && priced < forecast.sample_requests;
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
        total: forecast.sample_requests.toLocaleString(),
      }),
    };
  }
  return { cost: null, costReadout: undefined, costHint: null };
}

/** Compact reading shown beside a quota bar when a model forecast is available. */
export function compactQuotaForecast(
  window: Pick<QuotaWindow, 'model_forecasts'>,
  tokenStyle: TokenNumberStyle,
  t: TFunc,
): string | null {
  const forecast = window.model_forecasts?.[0];
  if (!forecast) return null;
  const { cost } = forecastCostReading(forecast, t);
  if (cost) return cost;
  const tokens = Math.max(0, Math.floor(forecast.remaining_tokens));
  return tokens === 0 ? t('quota.capacity_open_details') : `≈ ${formatTokens(tokens, tokenStyle)}`;
}

/** Formats remaining cost, requests, tokens, and cache rate for the forecast card. */
export function describeForecastCard(
  forecast: QuotaModelForecast | null,
  tokenStyle: TokenNumberStyle,
  t: TFunc,
): CycleCardFigures {
  if (!forecast) return EMPTY_CYCLE_FIGURES;
  const requests = Math.max(0, Math.floor(forecast.remaining_requests));
  const tokens = Math.max(0, Math.floor(forecast.remaining_tokens));
  return {
    ...forecastCostReading(forecast, t),
    requests: requests === 0 ? '0' : `≈ ${requests.toLocaleString()}`,
    requestsReadout: withPrefix(resolveCountFlowReadout(requests), requests > 0 ? '≈ ' : ''),
    tokens: tokens === 0 ? '0' : `≈ ${formatTokens(tokens, tokenStyle)}`,
    tokensReadout: withPrefix(resolveTokenFlowReadout(tokens, tokenStyle), tokens > 0 ? '≈ ' : ''),
    cacheRate: forecast.cache_rate,
    cacheRateReadout: resolveCacheRateReadout(forecast.cache_rate),
  };
}
