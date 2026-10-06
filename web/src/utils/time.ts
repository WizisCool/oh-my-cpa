import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

// Keep protocol instants unchanged; only calendar interpretation and presentation use this zone.
dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);
let effectiveTimezone = 'UTC';
let serverTimezone = 'UTC';
const LISTENERS = new Set<() => void>();
export function getTimeZone(): string { return effectiveTimezone; }
export function subscribeTimeZone(listener: () => void): () => void {
  LISTENERS.add(listener);
  return () => { LISTENERS.delete(listener); };
}
export function configureTimeZone(selected: string, server = 'UTC'): void {
  const next = selected || server;
  // Validate before replacing a working configuration.
  new Intl.DateTimeFormat('en', { timeZone: next }).format(0);
  const hasChanged = next !== effectiveTimezone || server !== serverTimezone;
  effectiveTimezone = next;
  serverTimezone = server;
  dayjs.tz.setDefault(next);
  if (hasChanged) LISTENERS.forEach((listener) => listener());
}
export function parseTimeZone(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value) return '';
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return value; } catch { return undefined; }
}
const zonedDate = ((input?: dayjs.ConfigType, format?: dayjs.OptionType, locale?: string, strict?: boolean) => {
  if (typeof input === 'string' && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(input)) {
    return typeof format === 'string' ? dayjs.tz(input, format, effectiveTimezone) : dayjs.tz(input, effectiveTimezone);
  }
  return dayjs(input, format, locale, strict).tz(effectiveTimezone);
}) as typeof dayjs;
Object.assign(zonedDate, dayjs);
zonedDate.unix = (seconds: number) => dayjs.unix(seconds).tz(effectiveTimezone);
export default zonedDate;
export type { Dayjs } from 'dayjs';

export function formatGatewayTimestamp(value: string): string {
  try {
    const instant = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? dayjs(value) : dayjs.tz(value, serverTimezone);
    return instant.isValid() ? instant.tz(effectiveTimezone).format('YYYY-MM-DD HH:mm:ss') : value;
  } catch { return value; }
}

const OFFSET_CACHE = new Map<string, { minute: number; offset: string }>();
export function formatTimeZoneOffset(zone: string, at = Date.now()): string {
  const minute = Math.floor(at / 60_000);
  const cached = OFFSET_CACHE.get(zone);
  if (cached?.minute === minute) return cached.offset;
  let offset = '';
  try {
    const value = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(at).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
    offset = value === 'GMT' ? 'UTC+0' : value.replace('GMT', 'UTC');
  } catch {
    // The server's zone database can be newer than the browser's; keep the stored zone editable.
  }
  OFFSET_CACHE.set(zone, { minute, offset });
  return offset;
}
let availableTimeZones: string[] | undefined;
export function timeZoneOptions(server: string | undefined, selected: string, serverLabel: string, at = Date.now()) {
  availableTimeZones ??= (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone')
    ?? ['Asia/Shanghai', 'Asia/Kuala_Lumpur', 'America/New_York', 'Europe/London'];
  const zones = Array.from(new Set([...(server ? [server] : []), 'UTC', ...(selected ? [selected] : []), ...availableTimeZones]));
  return zones.sort((left, right) => left === server ? -1 : right === server ? 1 : left.localeCompare(right)).map((zone) => {
    const offset = formatTimeZoneOffset(zone, at);
    const label = `${zone}${offset ? ` (${offset})` : ''}${zone === server ? ` (${serverLabel})` : ''}`;
    return { value: zone, label, offset, searchText: label.replace(/_/g, ' ').toLowerCase() };
  });
}
