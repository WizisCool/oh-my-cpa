/**
 * Deployment-wide automatic exchange-rate refresh schedule, stored as the
 * `omc_exchange_rate_refresh` preference (`internal/exchangerate/policy.go` owns
 * the bounds).
 */
export interface ExchangeRateRefreshSettings {
  /** Refresh display FX rates every N hours; 0 disables scheduled refreshes. */
  interval_hours: number;
}

export const EXCHANGE_RATE_REFRESH_PREFERENCE = 'omc_exchange_rate_refresh';

/** Mirrors `DefaultRefreshSettings`: daily refresh. */
export const DEFAULT_EXCHANGE_RATE_REFRESH: ExchangeRateRefreshSettings = {
  interval_hours: 24,
};

export const EXCHANGE_RATE_REFRESH_MIN_HOURS = 1;
export const EXCHANGE_RATE_REFRESH_MAX_HOURS = 168;

/** Preset options in hours; 0 turns automatic refresh off. */
export const EXCHANGE_RATE_REFRESH_INTERVALS = [0, 6, 12, 24, 72, 168] as const;

export function isExchangeRateRefreshInterval(hours: unknown): hours is number {
  return typeof hours === 'number'
    && Number.isInteger(hours)
    && (hours === 0 || (hours >= EXCHANGE_RATE_REFRESH_MIN_HOURS && hours <= EXCHANGE_RATE_REFRESH_MAX_HOURS));
}

export function parseExchangeRateRefresh(raw: unknown): ExchangeRateRefreshSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { interval_hours: intervalHours } = raw as Record<string, unknown>;
  if (!isExchangeRateRefreshInterval(intervalHours)) return undefined;
  return { interval_hours: intervalHours };
}
