/**
 * Calendar windows: units of the deployment's calendar rather than spans back from now.
 *
 * The server places them in the OMC Time Zone - local midnight, the Monday a week starts on, the
 * first of the month - so the browser only names them. Each unit is listed current first, then the
 * one before it, which is the pair a reader compares.
 */
export const CALENDAR_PRESETS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month'] as const;
export type CalendarPreset = (typeof CALENDAR_PRESETS)[number];

const CLOSED_CALENDAR_PRESETS: ReadonlySet<string> = new Set<CalendarPreset>(['yesterday', 'last_week', 'last_month']);

export function isCalendarPreset(value: string | undefined): value is CalendarPreset {
  return value !== undefined && (CALENDAR_PRESETS as readonly string[]).includes(value);
}

/** A previous unit has ended, so its numbers no longer move and nothing needs to poll it. */
export function isClosedCalendarPreset(value: string | undefined): boolean {
  return value !== undefined && CLOSED_CALENDAR_PRESETS.has(value);
}
