const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
const MAX_CACHED_FORMATTERS = 32;
const CALENDAR_DAY_CACHE = new Map<string, string>();
const MAX_CACHED_CALENDAR_DAYS = 2048;
const OPTIONS_KEY_CACHE = new WeakMap<Intl.DateTimeFormatOptions, Map<string, string>>();

const KEYED_OPTIONS = new Set([
  'timeZone',
  'dateStyle',
  'timeStyle',
  'year',
  'month',
  'day',
  'weekday',
  'era',
  'hour',
  'minute',
  'second',
  'fractionalSecondDigits',
  'hourCycle',
  'hour12',
  'timeZoneName',
]);

function serializeOptionsKey(locale: string, options: Intl.DateTimeFormatOptions): string {
  const byLocale = OPTIONS_KEY_CACHE.get(options);
  const existing = byLocale?.get(locale);
  if (existing !== undefined) return existing;

  for (const name in options) {
    if (!KEYED_OPTIONS.has(name)) {
      const fallbackKey = `${locale}|${JSON.stringify(Object.entries(options).sort(([a], [b]) => a.localeCompare(b)))}`;
      const map = byLocale ?? new Map<string, string>();
      map.set(locale, fallbackKey);
      if (!byLocale) OPTIONS_KEY_CACHE.set(options, map);
      return fallbackKey;
    }
  }
  const extended = options as Intl.DateTimeFormatOptions & {
    dateStyle?: string;
    timeStyle?: string;
    fractionalSecondDigits?: number;
    hourCycle?: string;
  };
  const computed = [
    locale,
    options.timeZone ?? '',
    extended.dateStyle ?? '',
    extended.timeStyle ?? '',
    options.year ?? '',
    options.month ?? '',
    options.day ?? '',
    options.weekday ?? '',
    options.era ?? '',
    options.hour ?? '',
    options.minute ?? '',
    options.second ?? '',
    extended.fractionalSecondDigits ?? '',
    extended.hourCycle ?? '',
    options.hour12 === undefined ? '' : String(options.hour12),
    options.timeZoneName ?? '',
  ].join('|');
  const map = byLocale ?? new Map<string, string>();
  map.set(locale, computed);
  if (!byLocale) OPTIONS_KEY_CACHE.set(options, map);
  return computed;
}

// Formatter construction loads locale and timezone rules; a grid must not repeat that per cell.
export function getDateTimeFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = serializeOptionsKey(locale, options);
  const cached = FORMATTER_CACHE.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(locale, options);
  if (FORMATTER_CACHE.size >= MAX_CACHED_FORMATTERS) {
    const oldest = FORMATTER_CACHE.keys().next().value;
    if (oldest !== undefined) FORMATTER_CACHE.delete(oldest);
  }
  FORMATTER_CACHE.set(key, formatter);
  return formatter;
}

export function formatCalendarDay(day: string, locale: string, options: Intl.DateTimeFormatOptions): string {
  const optionsKey = serializeOptionsKey(locale, options);
  const cacheKey = `${optionsKey}|${day}`;
  const hit = CALENDAR_DAY_CACHE.get(cacheKey);
  if (hit !== undefined) return hit;

  // A civil date is not an instant in the browser's zone, where midnight may not even exist.
  const formatted = getDateTimeFormatter(locale, { ...options, timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
  if (CALENDAR_DAY_CACHE.size >= MAX_CACHED_CALENDAR_DAYS) {
    const oldest = CALENDAR_DAY_CACHE.keys().next().value;
    if (oldest !== undefined) CALENDAR_DAY_CACHE.delete(oldest);
  }
  CALENDAR_DAY_CACHE.set(cacheKey, formatted);
  return formatted;
}

/** Fixed-width minute labels, with the closing midnight belonging to the day it closes. */
export function formatMinuteSpan(fromMs: number, toMs: number, timeZone: string): string {
  const formatter = getDateTimeFormatter('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const readParts = (timestamp: number) => {
    const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
    for (const part of formatter.formatToParts(timestamp)) parts[part.type] = part.value;
    return { day: `${parts.year}-${parts.month}-${parts.day}`, stamp: `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`, time: `${parts.hour}:${parts.minute}` };
  };
  const start = readParts(fromMs);
  const end = readParts(toMs);
  const isSameDay = toMs - fromMs < 86_400_000 && start.day === readParts(toMs - 1).day;
  return `${start.stamp} – ${isSameDay ? end.time : end.stamp}`;
}
