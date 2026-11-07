/**
 * The deployment-wide scheduled update check interval, stored as the `omc_update_check`
 * preference and read by the server's sweep on every tick (`internal/release/policy.go` owns
 * the bounds; the server refuses any document outside them).
 */
export interface UpdateCheckSettings {
  /** The sweep reads the release feeds and the plugin store at this interval. */
  interval_minutes: number;
}

export const UPDATE_CHECK_PREFERENCE = 'omc_update_check';

/** Mirrors `DefaultUpdateCheckSettings`: hourly. */
export const DEFAULT_UPDATE_CHECK: UpdateCheckSettings = { interval_minutes: 60 };

export const UPDATE_CHECK_MIN_MINUTES = 15;
export const UPDATE_CHECK_MAX_MINUTES = 24 * 60;

/**
 * The intervals the settings page offers, ascending. The steps are dense where an operator is
 * trading freshness against GitHub's budget (15 and 30 minutes, hourly, two and three hours)
 * and sparse once the schedule is no longer what makes a notice late (6, 12 and 24 hours).
 * A stored value outside them is still shown.
 */
export const UPDATE_CHECK_INTERVALS = [15, 30, 60, 120, 180, 360, 720, 1440] as const;

export function parseUpdateCheck(raw: unknown): UpdateCheckSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { interval_minutes: intervalMinutes } = raw as Record<string, unknown>;
  if (typeof intervalMinutes !== 'number' || !Number.isInteger(intervalMinutes)) return undefined;
  if (intervalMinutes < UPDATE_CHECK_MIN_MINUTES || intervalMinutes > UPDATE_CHECK_MAX_MINUTES) return undefined;
  return { interval_minutes: intervalMinutes };
}
