/** Shapes and pure helpers for the CPA log tail. */

export interface LogLineParts {
  /** The line exactly as CPA sent it. */
  raw: string;
  timestamp?: string;
  requestId?: string;
  level?: LogLevel;
  source?: string;
  status?: number;
  latency?: string;
  ip?: string;
  method?: string;
  path?: string;
  /** Whatever is left after the recognised fields; what the eye actually reads. */
  message: string;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

/**
 * MAX_LOG_BUFFER_LINES bounds what the page keeps.
 *
 * The buffer is what search and the filters run over, so it is a memory/
 * usefulness trade paid in the browser, not a transport limit: CPA answers at
 * most its own page size regardless.
 */
export const MAX_LOG_BUFFER_LINES = 10000;

/** MANAGEMENT_PATH_FRAGMENT marks the lines this console itself produces. */
export const MANAGEMENT_PATH_FRAGMENT = '/v0/management';

const LINE_PREFIX =
  /^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\s+\[([^\]]*)\]\s+\[([a-zA-Z]+)\s*\]\s*(?:\[([^\]]*)\]\s*)?(.*)$/;
const LEVEL_WORDS: Record<string, LogLevel> = {
  trace: 'trace',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  fatal: 'fatal',
};
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const LATENCY = /^[\d.]+\s*(?:µs|us|ms|s|m)$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const EMPTY_REQUEST_ID = /^-+$/;

function levelOf(value: string | undefined): LogLevel | undefined {
  return value ? LEVEL_WORDS[value.trim().toLowerCase()] : undefined;
}

/**
 * parseLogLine reads one CPA log line.
 *
 * CPA's file logger is regular — `[time] [req] [level] [source] rest`, with
 * request lines continuing as `status | latency | ip | METHOD "path"` — so this
 * recognises that shape by position and classifies the pipe segments by what
 * they look like rather than by which column they sit in. Anything that does not
 * match still comes back with its raw text intact: an unrecognised line must be
 * readable, not dropped, because the unrecognised one is usually the interesting
 * one.
 */
export function parseLogLine(raw: string): LogLineParts {
  const match = raw.match(LINE_PREFIX);
  if (!match) {
    return { raw, message: raw, level: levelOf(inferLevelWord(raw)) };
  }
  const [, timestamp, requestId, level, source, rest] = match;
  const parts: LogLineParts = {
    raw,
    timestamp,
    level: levelOf(level),
    message: rest ?? '',
  };
  if (requestId && !EMPTY_REQUEST_ID.test(requestId)) parts.requestId = requestId;
  if (source) parts.source = source;

  if (!rest || !rest.includes('|')) return parts;

  const messageParts: string[] = [];
  for (const segment of rest.split('|').map((value) => value.trim())) {
    if (!segment) continue;
    if (/^[1-5]\d{2}$/.test(segment)) {
      parts.status = Number.parseInt(segment, 10);
      continue;
    }
    if (LATENCY.test(segment)) {
      parts.latency = segment.replace(/\s+/g, '');
      continue;
    }
    if (IPV4.test(segment)) {
      parts.ip = segment;
      continue;
    }
    const request = segment.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+"?([^"\s]+)"?$/);
    if (request && HTTP_METHODS.includes(request[1])) {
      parts.method = request[1];
      parts.path = request[2];
      continue;
    }
    messageParts.push(segment);
  }
  parts.message = messageParts.join(' | ');
  return parts;
}

function inferLevelWord(line: string): string | undefined {
  const lowered = line.toLowerCase();
  for (const level of LOG_LEVELS) {
    if (new RegExp(`\\b${level}\\b`).test(lowered)) return level;
  }
  if (lowered.includes('warning')) return 'warn';
  return undefined;
}

export function isManagementLine(line: string): boolean {
  return line.includes(MANAGEMENT_PATH_FRAGMENT);
}

/**
 * statusTone maps an HTTP status to the palette's semantic colour.
 *
 * 4xx is the caller's mistake and 5xx is ours; both are louder than 2xx, but
 * only 5xx is a problem the operator owns.
 */
export function statusTone(status?: number): 'success' | 'warn' | 'danger' | undefined {
  if (!status) return undefined;
  if (status >= 500) return 'danger';
  if (status >= 400) return 'warn';
  return 'success';
}

export interface LogMerge {
  lines: string[];
  /** Lines pushed out of the front of the buffer. */
  dropped: number;
}

/**
 * mergeLogLines appends a fresh page without duplicating the overlap.
 *
 * The `after` cursor is deliberately re-sent one second back so a line sharing
 * its timestamp with the boundary is not lost, which means the head of a page
 * can repeat the tail of the buffer. Repeating is fixable here; dropping is not.
 */
export function mergeLogLines(buffer: string[], incoming: string[], cap = MAX_LOG_BUFFER_LINES): LogMerge {
  if (incoming.length === 0) return { lines: buffer, dropped: 0 };
  const probe = Math.min(buffer.length, incoming.length, 64);
  let overlap = 0;
  for (let size = probe; size > 0; size -= 1) {
    let same = true;
    for (let index = 0; index < size; index += 1) {
      if (buffer[buffer.length - size + index] !== incoming[index]) {
        same = false;
        break;
      }
    }
    if (same) {
      overlap = size;
      break;
    }
  }
  const merged = overlap > 0 ? buffer.concat(incoming.slice(overlap)) : buffer.concat(incoming);
  const dropped = Math.max(0, merged.length - cap);
  return { lines: dropped > 0 ? merged.slice(merged.length - cap) : merged, dropped };
}

export interface ErrorLogFile {
  name: string;
  size: number;
  modified: number;
}

/**
 * Log view filters, persisted as a server-side preference.
 *
 * They are stored next to the dashboard window rather than in localStorage: an
 * operator who works with management traffic hidden should not have to re-set
 * it after a reload, and one mechanism for "what the console remembers" is
 * easier to trust than two.
 */
export const LOG_FILTERS_PREFERENCE = 'log_filters';

export const LOG_STATUS_CLASSES = ['all', 'success', 'client', 'server'] as const;
export type LogStatusClass = (typeof LOG_STATUS_CLASSES)[number];

export interface LogFilters {
  hideManagement: boolean;
  levels: LogLevel[];
  statusClass: LogStatusClass;
}

export const DEFAULT_LOG_FILTERS: LogFilters = { hideManagement: true, levels: [], statusClass: 'all' };

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * parseLogFilters validates a stored filter set.
 *
 * The value comes back from a JSON blob the browser wrote, so it is input: a
 * hand-edited or stale entry must fall back to the defaults, not decide what the
 * operator gets to see.
 */
export function parseLogFilters(raw: unknown): LogFilters | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const statusClass = LOG_STATUS_CLASSES.includes(value.statusClass as LogStatusClass)
    ? (value.statusClass as LogStatusClass)
    : 'all';
  const levels = Array.isArray(value.levels) ? value.levels.filter(isLogLevel) : [];
  return {
    // Absent means "never chosen", which is the default, not "off".
    hideManagement: value.hideManagement !== false,
    levels,
    statusClass,
  };
}

export function matchesStatusClass(status: number | undefined, wanted: LogStatusClass): boolean {
  if (wanted === 'all') return true;
  if (status === undefined) return false;
  if (wanted === 'success') return status < 400;
  if (wanted === 'client') return status >= 400 && status < 500;
  return status >= 500;
}
