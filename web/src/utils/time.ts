/**
 * Zero-dependency IANA-zoned calendar & timestamp utility built on native Intl.DateTimeFormat.
 *
 * Replaces dayjs + utc + timezone + customParseFormat plugins while preserving exact wall-clock
 * arithmetic across DST transitions (23h spring-forward / 25h fall-back days) and sub-hour
 * zones such as Asia/Kathmandu (+05:45).
 */

let effectiveTimezone = 'UTC';
let notifiedTimezone = 'UTC';
const LISTENERS = new Set<() => void>();

const DTF_CACHE = new Map<string, Intl.DateTimeFormat>();

function getPartsFormatter(zone: string): Intl.DateTimeFormat {
  let fmt = DTF_CACHE.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    DTF_CACHE.set(zone, fmt);
  }
  return fmt;
}

interface WallFields {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  minute: number; // 0..59
  second: number; // 0..59
  millisecond: number; // 0..999
}

function instantToWall(epochMs: number, zone: string): WallFields {
  const parts = getPartsFormatter(zone).formatToParts(epochMs);
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    const v = Number(part.value);
    switch (part.type) {
      case 'year': year = v; break;
      case 'month': month = v; break;
      case 'day': day = v; break;
      case 'hour': hour = v === 24 ? 0 : v; break;
      case 'minute': minute = v; break;
      case 'second': second = v; break;
      default: break;
    }
  }
  const millisecond = ((epochMs % 1000) + 1000) % 1000;
  return { year, month, day, hour, minute, second, millisecond };
}

function wallAsUtc(w: WallFields): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.millisecond);
}

/** Offset in minutes (east of UTC positive, e.g. +345 for UTC+5:45) at an exact UTC instant. */
function zoneOffsetMinutesAt(epochMs: number, zone: string): number {
  const w = instantToWall(epochMs, zone);
  return Math.round((wallAsUtc(w) - epochMs) / 60_000);
}

const DST_WINDOW_MS = 3 * 3_600_000;

/**
 * Solves wall-clock fields in `zone` to the UTC epoch millisecond.
 *
 * - Normal instants resolve directly.
 * - Fall-back overlaps (repeated hours) select the first occurrence (`offBefore`).
 * - Spring-forward gaps (nonexistent wall times, including 00:00 transitions such as
 *   `America/Santiago`) advance monotonically to the exact transition instant where valid
 *   wall clocks resume, never slipping backward into the preceding hour or previous civil day.
 */
function wallToInstant(w: WallFields, zone: string): number {
  const naiveUtc = wallAsUtc(w);
  const offset0 = zoneOffsetMinutesAt(naiveUtc, zone);
  const est = naiveUtc - offset0 * 60_000;
  const offBefore = zoneOffsetMinutesAt(est - DST_WINDOW_MS, zone);
  const offAfter = zoneOffsetMinutesAt(est + DST_WINDOW_MS, zone);
  if (offBefore === offAfter) return naiveUtc - offBefore * 60_000;

  const candBefore = naiveUtc - offBefore * 60_000;
  if (wallAsUtc(instantToWall(candBefore, zone)) === naiveUtc) return candBefore;

  const candAfter = naiveUtc - offAfter * 60_000;
  if (wallAsUtc(instantToWall(candAfter, zone)) === naiveUtc) return candAfter;

  // Nonexistent spring-forward gap: locate the exact transition boundary inside (candAfter, candBefore].
  let lo = Math.floor(Math.min(candAfter, candBefore) / 1000);
  let hi = Math.ceil(Math.max(candAfter, candBefore) / 1000);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (zoneOffsetMinutesAt(mid * 1000, zone) === offAfter) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo * 1000;
}

const PAD2 = (n: number) => String(n).padStart(2, '0');
const PAD3 = (n: number) => String(n).padStart(3, '0');
const PAD4 = (n: number) => String(n).padStart(4, '0');

function formatOffsetToken(offsetMin: number): string {
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${sign}${PAD2(Math.floor(abs / 60))}:${PAD2(abs % 60)}`;
}

export type TimeUnit = 'day' | 'days' | 'hour' | 'hours' | 'minute' | 'minutes' | 'second' | 'seconds' | 'millisecond' | 'milliseconds';

export class ZonedDate {
  readonly #ms: number;
  readonly #zone: string;

  constructor(epochMs: number, zone: string) {
    this.#ms = epochMs;
    this.#zone = zone;
  }

  isValid(): boolean {
    return Number.isFinite(this.#ms);
  }

  valueOf(): number {
    return this.#ms;
  }

  tz(zone: string): ZonedDate {
    return new ZonedDate(this.#ms, zone);
  }

  utcOffset(): number {
    if (!this.isValid()) return 0;
    return zoneOffsetMinutesAt(this.#ms, this.#zone);
  }

  #wall(): WallFields {
    return instantToWall(this.#ms, this.#zone);
  }

  year(): number {
    return this.#wall().year;
  }

  month(): number {
    return this.#wall().month - 1;
  }

  date(): number {
    return this.#wall().day;
  }

  hour(): number;
  hour(value: number): ZonedDate;
  hour(value?: number): number | ZonedDate {
    const w = this.#wall();
    if (value === undefined) return w.hour;
    return new ZonedDate(wallToInstant({ ...w, hour: value }, this.#zone), this.#zone);
  }

  minute(): number;
  minute(value: number): ZonedDate;
  minute(value?: number): number | ZonedDate {
    const w = this.#wall();
    if (value === undefined) return w.minute;
    return new ZonedDate(wallToInstant({ ...w, minute: value }, this.#zone), this.#zone);
  }

  second(): number;
  second(value: number): ZonedDate;
  second(value?: number): number | ZonedDate {
    const w = this.#wall();
    if (value === undefined) return w.second;
    return new ZonedDate(wallToInstant({ ...w, second: value }, this.#zone), this.#zone);
  }

  millisecond(): number;
  millisecond(value: number): ZonedDate;
  millisecond(value?: number): number | ZonedDate {
    const w = this.#wall();
    if (value === undefined) return w.millisecond;
    return new ZonedDate(wallToInstant({ ...w, millisecond: value }, this.#zone), this.#zone);
  }

  startOf(unit: 'day'): ZonedDate {
    if (!this.isValid()) return this;
    if (unit === 'day') {
      const w = this.#wall();
      return new ZonedDate(
        wallToInstant({ ...w, hour: 0, minute: 0, second: 0, millisecond: 0 }, this.#zone),
        this.#zone,
      );
    }
    return this;
  }

  endOf(unit: 'day'): ZonedDate {
    if (!this.isValid()) return this;
    if (unit === 'day') {
      const w = this.#wall();
      return new ZonedDate(
        wallToInstant({ ...w, hour: 23, minute: 59, second: 59, millisecond: 999 }, this.#zone),
        this.#zone,
      );
    }
    return this;
  }

  add(amount: number, unit: TimeUnit): ZonedDate {
    if (!this.isValid()) return this;
    if (unit === 'day' || unit === 'days') {
      const w = this.#wall();
      const shifted = new Date(Date.UTC(w.year, w.month - 1, w.day + amount));
      return new ZonedDate(
        wallToInstant(
          {
            year: shifted.getUTCFullYear(),
            month: shifted.getUTCMonth() + 1,
            day: shifted.getUTCDate(),
            hour: w.hour,
            minute: w.minute,
            second: w.second,
            millisecond: w.millisecond,
          },
          this.#zone,
        ),
        this.#zone,
      );
    }
    const mult =
      unit === 'hour' || unit === 'hours'
        ? 3_600_000
        : unit === 'minute' || unit === 'minutes'
          ? 60_000
          : unit === 'second' || unit === 'seconds'
            ? 1_000
            : 1;
    return new ZonedDate(this.#ms + amount * mult, this.#zone);
  }

  subtract(amount: number, unit: TimeUnit): ZonedDate {
    return this.add(-amount, unit);
  }

  isSame(other: ConfigType, unit?: 'day'): boolean {
    const target = parseZonedInput(other, this.#zone);
    if (!this.isValid() || !target.isValid()) return false;
    if (unit === 'day') {
      const a = this.#wall();
      const b = target.#wall();
      return a.year === b.year && a.month === b.month && a.day === b.day;
    }
    return this.#ms === target.valueOf();
  }

  format(pattern = 'YYYY-MM-DDTHH:mm:ssZ'): string {
    if (!this.isValid()) return 'Invalid Date';
    const w = this.#wall();
    const offset = this.utcOffset();
    return pattern.replace(/YYYY|MM|DD|HH|mm|ss|SSS|Z/g, (token) => {
      switch (token) {
        case 'YYYY': return PAD4(w.year);
        case 'MM': return PAD2(w.month);
        case 'DD': return PAD2(w.day);
        case 'HH': return PAD2(w.hour);
        case 'mm': return PAD2(w.minute);
        case 'ss': return PAD2(w.second);
        case 'SSS': return PAD3(w.millisecond);
        case 'Z': return formatOffsetToken(offset);
        default: return token;
      }
    });
  }
}

export type Dayjs = ZonedDate;
export type ConfigType = number | string | Date | ZonedDate | null | undefined;

const WALL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;
const WALL_CLOCK_ONLY_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function parseZonedInput(input: ConfigType, zone: string): ZonedDate {
  if (input === undefined) return new ZonedDate(Date.now(), zone);
  if (input === null) return new ZonedDate(Number.NaN, zone);
  if (input instanceof ZonedDate) return input.tz(zone);
  if (input instanceof Date) return new ZonedDate(input.getTime(), zone);
  if (typeof input === 'number') return new ZonedDate(input, 'UTC').tz(zone);

  const trimmed = input.trim();
  if (!trimmed) return new ZonedDate(Number.NaN, zone);

  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
    const normalized = trimmed.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T');
    return new ZonedDate(Date.parse(normalized), zone);
  }

  const dtMatch = WALL_DATETIME_RE.exec(trimmed);
  if (dtMatch) {
    const msRaw = dtMatch[7] ?? '0';
    return new ZonedDate(
      wallToInstant(
        {
          year: Number(dtMatch[1]),
          month: Number(dtMatch[2]),
          day: Number(dtMatch[3]),
          hour: Number(dtMatch[4] ?? 0),
          minute: Number(dtMatch[5] ?? 0),
          second: Number(dtMatch[6] ?? 0),
          millisecond: Number(msRaw.padEnd(3, '0')),
        },
        zone,
      ),
      zone,
    );
  }

  const clockMatch = WALL_CLOCK_ONLY_RE.exec(trimmed);
  if (clockMatch) {
    const today = instantToWall(Date.now(), zone);
    return new ZonedDate(
      wallToInstant(
        {
          ...today,
          hour: Number(clockMatch[1]),
          minute: Number(clockMatch[2]),
          second: Number(clockMatch[3] ?? 0),
          millisecond: 0,
        },
        zone,
      ),
      zone,
    );
  }

  return new ZonedDate(Date.parse(trimmed), zone);
}

export function getTimeZone(): string {
  return effectiveTimezone;
}

export function subscribeTimeZone(listener: () => void): () => void {
  LISTENERS.add(listener);
  return () => {
    LISTENERS.delete(listener);
  };
}

export function primeTimeZone(selected: string, server = 'UTC'): string {
  const next = selected || server;
  new Intl.DateTimeFormat('en', { timeZone: next }).format(0);
  if (next !== effectiveTimezone) {
    effectiveTimezone = next;
  }
  return effectiveTimezone;
}

export function configureTimeZone(selected: string, server = 'UTC'): void {
  const next = primeTimeZone(selected, server);
  if (next !== notifiedTimezone) {
    notifiedTimezone = next;
    LISTENERS.forEach((listener) => listener());
  }
}

export function parseTimeZone(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value) return '';
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return value;
  } catch {
    return undefined;
  }
}

interface ZonedDateFactory {
  (input?: ConfigType, format?: string): ZonedDate;
  unix(seconds: number): ZonedDate;
}

const zonedDate: ZonedDateFactory = Object.assign(
  (input?: ConfigType, _format?: string) => parseZonedInput(input, effectiveTimezone),
  {
    unix: (seconds: number) => new ZonedDate(seconds * 1000, effectiveTimezone),
  },
);

export default zonedDate;

export function formatGatewayTimestamp(value: string): string {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return value;
  try {
    const instant = zonedDate(value);
    return instant.isValid() ? instant.format('YYYY-MM-DD HH:mm:ss') : value;
  } catch {
    return value;
  }
}

const OFFSET_CACHE = new Map<string, { minute: number; offset: string }>();

export function formatTimeZoneOffset(zone: string, at = Date.now()): string {
  const minute = Math.floor(at / 60_000);
  const cached = OFFSET_CACHE.get(zone);
  if (cached?.minute === minute) return cached.offset;
  let offset = '';
  try {
    const value =
      new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
        .formatToParts(at)
        .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
    offset = value === 'GMT' ? 'UTC+0' : value.replace('GMT', 'UTC');
  } catch {
    // Unsupported browser zone: preserve empty offset rather than fabricating UTC.
  }
  OFFSET_CACHE.set(zone, { minute, offset });
  return offset;
}

let availableTimeZones: string[] | undefined;

export function timeZoneOptions(server: string | undefined, selected: string, serverLabel: string, at = Date.now()) {
  availableTimeZones ??=
    (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [
      'Asia/Shanghai',
      'Asia/Kuala_Lumpur',
      'America/New_York',
      'Europe/London',
    ];
  const zones = Array.from(new Set([...(server ? [server] : []), 'UTC', ...(selected ? [selected] : []), ...availableTimeZones]));
  return zones
    .sort((left, right) => (left === server ? -1 : right === server ? 1 : left.localeCompare(right)))
    .map((zone) => {
      const offset = formatTimeZoneOffset(zone, at);
      const label = `${zone}${offset ? ` (${offset})` : ''}${zone === server ? ` (${serverLabel})` : ''}`;
      return { value: zone, label, offset, searchText: label.replace(/_/g, ' ').toLowerCase() };
    });
}
