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

/**
 * MANAGEMENT_PATH_FRAGMENTS mark the lines this console itself produces. A CPA v8
 * gateway serves this console's reads on /v8/management, so both trees count.
 */
export const MANAGEMENT_PATH_FRAGMENTS = ['/v0/management', '/v8/management'];

const LINE_PREFIX =
  /^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]\s+\[([^\]]*)\]\s+\[([a-zA-Z]+)\s*\]\s*(?:\[([^\]]*)\]\s*)?(.*)$/;
const LEVEL_WORDS: Record<string, LogLevel> = {
  trace: 'trace',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  fatal: 'fatal',
};
export const LOG_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type LogMethod = (typeof LOG_METHODS)[number];
const HTTP_METHODS: readonly string[] = LOG_METHODS;
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
    const iso = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s+(.*)$/);
    if (iso) return { raw, timestamp: iso[1], message: iso[2], level: levelOf(inferLevelWord(iso[2])) };
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
  return MANAGEMENT_PATH_FRAGMENTS.some((fragment) => line.includes(fragment));
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
  methods: LogMethod[];
  /** Request paths without their query string; a line matches when its path is one of them. */
  paths: string[];
  wrapLines: boolean;
}

export const DEFAULT_LOG_FILTERS: LogFilters = {
  hideManagement: true,
  levels: [],
  statusClass: 'all',
  methods: [],
  paths: [],
  wrapLines: false,
};

/** MAX_LOG_PATH_FILTERS bounds the stored selection; the preference is a small JSON blob. */
export const MAX_LOG_PATH_FILTERS = 20;
/** MAX_LOG_PATH_OPTIONS bounds the offered paths to the busiest ones in the buffer. */
export const MAX_LOG_PATH_OPTIONS = 50;
const MAX_LOG_PATH_LENGTH = 512;

function isLogMethod(value: string | undefined): value is LogMethod {
  return value !== undefined && HTTP_METHODS.includes(value);
}

/**
 * logPathKey is the path a line is filtered and counted under.
 *
 * The query string is dropped: `/v1/models?key=...` and `/v1/models` are one route to the
 * reader, and a query can carry a credential that must not be written into a stored
 * preference.
 */
export function logPathKey(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const key = path.split(/[?#]/, 1)[0];
  return key || undefined;
}

function normalizeLogPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const paths: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length > MAX_LOG_PATH_LENGTH) continue;
    const key = logPathKey(entry.trim());
    if (key && !paths.includes(key)) paths.push(key);
    if (paths.length === MAX_LOG_PATH_FILTERS) break;
  }
  return paths;
}

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
    methods: Array.isArray(value.methods) ? LOG_METHODS.filter((method) => (value.methods as unknown[]).includes(method)) : [],
    paths: normalizeLogPaths(value.paths),
    wrapLines: value.wrapLines === true,
  };
}

export function matchesStatusClass(status: number | undefined, wanted: LogStatusClass): boolean {
  if (wanted === 'all') return true;
  if (status === undefined) return false;
  if (wanted === 'success') return status < 400;
  if (wanted === 'client') return status >= 400 && status < 500;
  return status >= 500;
}

/**
 * matchesLogFilters decides whether a line survives the view's filters.
 *
 * A method or path filter excludes every line that is not a request: choosing "POST" asks
 * for POST requests, and a startup message is not one.
 */
export function matchesLogFilters(line: LogLineParts, filters: LogFilters, needle = ''): boolean {
  if (filters.hideManagement && isManagementLine(line.raw)) return false;
  if (needle && !line.raw.toLowerCase().includes(needle)) return false;
  if (filters.levels.length > 0 && (!line.level || !filters.levels.includes(line.level))) return false;
  if (!matchesStatusClass(line.status, filters.statusClass)) return false;
  if (filters.methods.length > 0 && !(filters.methods as string[]).includes(line.method ?? '')) return false;
  if (filters.paths.length > 0 && !filters.paths.includes(logPathKey(line.path) ?? '')) return false;
  return true;
}

export interface LogPathOption {
  path: string;
  count: number;
}

export interface LogFacets {
  methods: Partial<Record<LogMethod, number>>;
  /** Busiest first; a selected path stays listed even when no buffered line carries it. */
  paths: LogPathOption[];
}

/**
 * countLogFacets counts the buffer per method and per path.
 *
 * Each facet is counted with every other filter applied but not its own, so a count is
 * what choosing that value would show rather than what the current choice already hides.
 */
export function countLogFacets(lines: readonly LogLineParts[], filters: LogFilters, needle = ''): LogFacets {
  const withoutMethods: LogFilters = { ...filters, methods: [] };
  const withoutPaths: LogFilters = { ...filters, paths: [] };
  const methods: Partial<Record<LogMethod, number>> = {};
  const pathCounts = new Map<string, number>();
  for (const line of lines) {
    if (isLogMethod(line.method) && matchesLogFilters(line, withoutMethods, needle)) {
      methods[line.method] = (methods[line.method] ?? 0) + 1;
    }
    const path = logPathKey(line.path);
    if (path && matchesLogFilters(line, withoutPaths, needle)) {
      pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
    }
  }
  const paths = [...pathCounts]
    .map(([path, count]) => ({ path, count }))
    .sort((left, right) => right.count - left.count || left.path.localeCompare(right.path))
    .slice(0, MAX_LOG_PATH_OPTIONS);
  for (const path of filters.paths) {
    if (!paths.some((option) => option.path === path)) paths.push({ path, count: pathCounts.get(path) ?? 0 });
  }
  return { methods, paths };
}

/**
 * shouldExitLogFullscreen leaves Escape to whatever is open inside the viewer first: a
 * dropdown or a confirmation closes on the first press, the viewer on the next.
 */
export function shouldExitLogFullscreen(key: string, isDefaultPrevented: boolean, hasOpenOverlay: boolean): boolean {
  return key === 'Escape' && !isDefaultPrevented && !hasOpenOverlay;
}

/** One record of Oh My CPA's own service log, already redacted by the server. */
export interface ServiceLogRecord {
  seq: number;
  logged_at_ms: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  attrs?: { key: string; value: string }[];
}

export interface ServiceLogPage {
  /** False when this server keeps no copy of its log; the page then says so instead of polling. */
  capturing: boolean;
  records: ServiceLogRecord[];
  latest_seq?: number;
  oldest_seq?: number;
  /** Records after the reader's position were evicted or skipped before this read. */
  gap?: boolean;
  capacity?: number;
  started_at_ms?: number;
}

export const SERVICE_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
