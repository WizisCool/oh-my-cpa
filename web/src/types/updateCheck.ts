/**
 * Deployment-wide scheduled update check intervals for OMC/CPA releases and
 * the plugin store, stored as the `omc_update_check` preference (`internal/release/policy.go`
 * owns the bounds; the server refuses any document outside them).
 */
export interface UpdateCheckSettings {
  /** Check OMC and CPA releases at this interval in minutes; 0 turns scheduled checks off. */
  interval_minutes: number;
  /** Check installed plugins against the plugin store at this interval in minutes; 0 turns scheduled checks off. */
  plugin_interval_minutes: number;
}

export const UPDATE_CHECK_PREFERENCE = 'omc_update_check';

/** Mirrors `DefaultUpdateCheckSettings`: hourly checks for both products and plugins. */
export const DEFAULT_UPDATE_CHECK: UpdateCheckSettings = {
  interval_minutes: 60,
  plugin_interval_minutes: 60,
};

export const UPDATE_CHECK_MIN_MINUTES = 15;
export const UPDATE_CHECK_MAX_MINUTES = 24 * 60;

/**
 * The intervals the settings page offers, ascending; 0 disables scheduled sweeps while
 * keeping manual checks available. Any valid stored value outside these presets stays selectable.
 */
export const UPDATE_CHECK_INTERVALS = [0, 15, 30, 60, 120, 180, 360, 720, 1440] as const;

export function isUpdateCheckInterval(minutes: unknown): minutes is number {
  return typeof minutes === 'number'
    && Number.isInteger(minutes)
    && (minutes === 0 || (minutes >= UPDATE_CHECK_MIN_MINUTES && minutes <= UPDATE_CHECK_MAX_MINUTES));
}

/** Read the stored update-check schedule, mirroring legacy single-field documents onto plugins. */
export function parseUpdateCheck(raw: unknown): UpdateCheckSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const intervalMinutes = record.interval_minutes;
  if (!isUpdateCheckInterval(intervalMinutes)) return undefined;

  if (!('plugin_interval_minutes' in record) || record.plugin_interval_minutes === undefined) {
    return { interval_minutes: intervalMinutes, plugin_interval_minutes: intervalMinutes };
  }
  const pluginMinutes = record.plugin_interval_minutes;
  if (pluginMinutes === null) {
    return { interval_minutes: intervalMinutes, plugin_interval_minutes: DEFAULT_UPDATE_CHECK.plugin_interval_minutes };
  }
  if (!isUpdateCheckInterval(pluginMinutes)) return undefined;
  return { interval_minutes: intervalMinutes, plugin_interval_minutes: pluginMinutes };
}
