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
