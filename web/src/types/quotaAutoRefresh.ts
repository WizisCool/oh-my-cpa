/**
 * The deployment-wide automatic quota refresh policy, stored as the `omc_quota_auto_refresh`
 * preference and read by the server's background loop on every tick (`internal/quota/auto_refresh.go`
 * owns the rules; the server refuses any document outside them).
 */
export interface QuotaAutoRefreshSettings {
  /** Re-read credentials whose reading is this old; 0 turns the schedule off. */
  interval_minutes: number;
  /** Re-read a credential once a window its reading reported has reset. */
  refresh_on_reset: boolean;
}

export const QUOTA_AUTO_REFRESH_PREFERENCE = 'omc_quota_auto_refresh';

/** Mirrors `DefaultAutoRefreshSettings`: reset-driven reads on, and a six-hour schedule. */
export const DEFAULT_QUOTA_AUTO_REFRESH: QuotaAutoRefreshSettings = { interval_minutes: 360, refresh_on_reset: true };

export const QUOTA_AUTO_REFRESH_MIN_MINUTES = 5;
export const QUOTA_AUTO_REFRESH_MAX_MINUTES = 24 * 60;

/** The intervals the settings page offers; 0 is "off". Another stored value is still shown. */
export const QUOTA_AUTO_REFRESH_INTERVALS = [0, 15, 30, 60, 180, 360] as const;

export function isQuotaAutoRefreshInterval(minutes: unknown): minutes is number {
  return typeof minutes === 'number'
    && Number.isInteger(minutes)
    && (minutes === 0 || (minutes >= QUOTA_AUTO_REFRESH_MIN_MINUTES && minutes <= QUOTA_AUTO_REFRESH_MAX_MINUTES));
}

export function parseQuotaAutoRefresh(raw: unknown): QuotaAutoRefreshSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { interval_minutes: intervalMinutes, refresh_on_reset: refreshOnReset } = raw as Record<string, unknown>;
  if (!isQuotaAutoRefreshInterval(intervalMinutes) || typeof refreshOnReset !== 'boolean') return undefined;
  return { interval_minutes: intervalMinutes, refresh_on_reset: refreshOnReset };
}
