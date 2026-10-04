/**
 * The rules behind the time range picker's custom side.
 *
 * Everything here works on civil dates (`YYYY-MM-DD`) and wall-clock times (`HH:mm`), and
 * becomes an instant in exactly one place. A calendar built on instants has to decide which
 * zone each cell's midnight belongs to, and gets a skipped or repeated day wherever a zone
 * moves its clock at midnight; a calendar built on civil dates has no such cell.
 */
import dayjs from '../../../utils/time';

export type CivilDay = string;

/** `day` resolves whole days; `minute` adds a wall-clock time to each end. */
export type RangeGranularity = 'day' | 'minute';

export interface RangeDraft {
  startDay?: CivilDay;
  endDay?: CivilDay;
  startTime: string;
  endTime: string;
  /** The end tracks the current time instead of being picked. */
  isOpenEnded: boolean;
}

export interface RangeWindow {
  from?: number;
  /** `null` is an open-ended window; `undefined` means no custom window at all. */
  to?: number | null;
}

export type RangeDraftError = 'incomplete' | 'reversed' | 'future';

export interface ResolvedRange {
  from?: number;
  to?: number | null;
  error?: RangeDraftError;
}

export const CALENDAR_CELLS = 42;
const DAY_MS = 86_400_000;
const DEFAULT_START_TIME = '00:00';
const DEFAULT_END_TIME = '23:59';

function utcDay(day: CivilDay): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function civilDay(utcMs: number): CivilDay {
  return new Date(utcMs).toISOString().slice(0, 10);
}

export function shiftDay(day: CivilDay, delta: number): CivilDay {
  return civilDay(utcDay(day) + delta * DAY_MS);
}

export function monthOf(day: CivilDay): string {
  return day.slice(0, 7);
}

export function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber - 1 + delta, 1)).toISOString().slice(0, 7);
}

/**
 * buildMonthGrid returns the six weeks a month is drawn in, leading and trailing days
 * included.
 *
 * The grid is always six rows. A month that needs only five would otherwise make the panel
 * one row shorter, and the controls under the calendar would move under the pointer between
 * two presses of the month arrow.
 */
export function buildMonthGrid(month: string, firstWeekday: number): CivilDay[] {
  const first = `${month}-01`;
  const lead = (new Date(utcDay(first)).getUTCDay() - firstWeekday + 7) % 7;
  return Array.from({ length: CALENDAR_CELLS }, (_, cell) => shiftDay(first, cell - lead));
}

/** The weekday a locale's week starts on, 0 for Sunday. Monday where the runtime cannot say. */
export function firstWeekdayOf(locale: string): number {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const firstDay = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay;
    return typeof firstDay === 'number' ? firstDay % 7 : 1;
  } catch {
    return 1;
  }
}

/** The draft a committed window opens as; a preset opens an empty one. */
export function draftFromWindow(window: RangeWindow): RangeDraft {
  if (window.from === undefined) {
    return { startTime: DEFAULT_START_TIME, endTime: DEFAULT_END_TIME, isOpenEnded: false };
  }
  const start = dayjs(window.from);
  const end = typeof window.to === 'number' ? dayjs(window.to) : undefined;
  return {
    startDay: start.format('YYYY-MM-DD'),
    startTime: start.format('HH:mm'),
    endDay: end?.format('YYYY-MM-DD'),
    endTime: end?.format('HH:mm') ?? DEFAULT_END_TIME,
    isOpenEnded: end === undefined,
  };
}

/**
 * pickDay is what one press on the calendar means.
 *
 * A range is two presses, and the third starts a new range rather than moving an end: which
 * end a third press "meant" is a guess, and a wrong guess silently widens a window the reader
 * believed they had narrowed. A second press before the start swaps the ends, so the order of
 * the two presses never matters.
 */
export function pickDay(draft: RangeDraft, day: CivilDay): RangeDraft {
  if (draft.isOpenEnded) return { ...draft, startDay: day, endDay: undefined };
  if (draft.startDay === undefined || draft.endDay !== undefined) {
    return { ...draft, startDay: day, endDay: undefined };
  }
  return day < draft.startDay
    ? { ...draft, startDay: day, endDay: draft.startDay }
    : { ...draft, endDay: day };
}

/** Whether the next press on the calendar completes a range rather than starting one. */
export function isPickingEnd(draft: RangeDraft): boolean {
  return !draft.isOpenEnded && draft.startDay !== undefined && draft.endDay === undefined;
}

/**
 * The end day the draft resolves to. A start with no end is that one day, so a single press
 * followed by Apply is a complete answer to "show me the 14th".
 */
export function effectiveEndDay(draft: RangeDraft): CivilDay | undefined {
  return draft.isOpenEnded ? undefined : draft.endDay ?? draft.startDay;
}

/**
 * clampEndTime keeps a minute-granular end out of the future when the end day is today.
 *
 * The default end is the last minute of the day, which on today is later than now. Refusing
 * that with an error would make the most common range - "from then until just now" - an
 * invalid one on its first press.
 */
export function clampEndTime(draft: RangeDraft, now: number): RangeDraft {
  const current = dayjs(now);
  if (effectiveEndDay(draft) !== current.format('YYYY-MM-DD')) return draft;
  const currentTime = current.format('HH:mm');
  return draft.endTime > currentTime ? { ...draft, endTime: currentTime } : draft;
}

const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * formatClockInput shapes typed digits into `HH:mm` as they arrive, so the reader types
 * `1405` and never has to place the colon. What it returns may still be incomplete;
 * `resolveDraft` is what refuses a time that is not one.
 */
export function formatClockInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
}

function wallClockInstant(day: CivilDay, clock: string): number {
  // An offset-less string is read as wall-clock fields in the console's zone, so the offset
  // in force on that date is the one applied - not today's.
  return dayjs(`${day} ${clock}`).valueOf();
}

/**
 * resolveDraft turns the draft into the window Apply would commit, or says why it cannot.
 *
 * A picked end is inclusive at the picker's own granularity: through that day, or through
 * that minute. A minute-granular end that includes the current minute stops at `now`, because
 * the server bounds an absolute window at the present.
 *
 * `now` is a parameter so the rule is testable at a fixed instant.
 */
export function resolveDraft(draft: RangeDraft, granularity: RangeGranularity, now: number): ResolvedRange {
  if (draft.startDay === undefined) return { error: 'incomplete' };
  const isMinute = granularity === 'minute';
  if (isMinute && !CLOCK_PATTERN.test(draft.startTime)) return { error: 'incomplete' };
  const from = wallClockInstant(draft.startDay, isMinute ? `${draft.startTime}:00.000` : '00:00:00.000');
  if (from > now) return { error: 'future' };
  const endDay = effectiveEndDay(draft);
  if (endDay === undefined) return { from, to: null };
  if (!isMinute) {
    const to = wallClockInstant(endDay, '23:59:59.999');
    return to > from ? { from, to } : { error: 'reversed' };
  }
  if (!CLOCK_PATTERN.test(draft.endTime)) return { error: 'incomplete' };
  const endMinute = wallClockInstant(endDay, `${draft.endTime}:00.000`);
  if (endMinute > now) return { error: 'future' };
  const to = Math.min(endMinute + 59_999, now);
  return to > from ? { from, to } : { error: 'reversed' };
}
