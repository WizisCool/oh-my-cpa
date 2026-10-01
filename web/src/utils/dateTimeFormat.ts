const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
const MAX_CACHED_FORMATTERS = 32;

// Formatter construction loads locale and timezone rules; a grid must not repeat that per cell.
export function getDateTimeFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify([locale, Object.entries(options).sort(([left], [right]) => left.localeCompare(right))]);
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
  // A civil date is not an instant in the browser's zone, where midnight may not even exist.
  return getDateTimeFormatter(locale, { ...options, timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
}
